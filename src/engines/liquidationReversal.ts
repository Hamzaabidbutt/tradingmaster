import { analyzeLiquidationDelta } from "./liquidationDelta";
import { Candle, LiquidationReversalSetup, LiquidationSpike } from "./types";

/**
 * Liquidation-spike reversal detector.
 *
 * The question this answers is narrow: **has a burst of forced flow just
 * printed at an extreme, and what happened next?**
 *
 * It matters because forced flow is price-insensitive. A liquidation engine
 * does not decide the coin is expensive; it closes because margin ran out. That
 * supply (or demand) is finite by construction, so when it lands at the low of a
 * move and price holds, the pressure that produced the low has been spent.
 * Voluntary selling at a low carries no such promise — the seller can always
 * sell more tomorrow.
 *
 * Two things are reported that a plain "liquidation happened" indicator does
 * not give you:
 *
 *   * **Location.** A flush at the extreme of the window is exhaustion; the
 *     same flush halfway down is just a fast leg of a decline. Only the first
 *     qualifies here.
 *   * **What followed.** The % reversal since the spike, both current and peak,
 *     so a spike that produced nothing is visibly distinguishable from one that
 *     produced 6%.
 *
 * ## On "forced"
 *
 * Binance serves no historical forced-order data over REST, so for a swept
 * universe the forced volume is *estimated* from the bar's signature — outsized
 * range, outsized volume, one-sided taker aggression. That is reported as
 * `inferred` and never as measured. `confirmed` is reserved for bars where live
 * `@forceOrder` prints were actually observed and passed in; the terminal has
 * them, a background sweep does not. The distinction is kept in the data rather
 * than in a footnote because acting on an inferred cascade and a confirmed one
 * are different-sized bets.
 */

/** Bars scanned for the spike. */
const SPIKE_WINDOW = 30;
/** Bars of context used to size what "big" means. */
const CONTEXT_WINDOW = 60;
/** Within this % of the window extreme counts as "at the extreme". */
const EXTREME_TOLERANCE_PCT = 1.2;
const QUALIFY_SCORE = 60;

/** A live forced-order print, from the `@forceOrder` websocket. */
export interface ForcedPrint {
  /** unix seconds */
  time: number;
  side: "long" | "short";
  /** base-asset quantity */
  qty: number;
}

function fmt(v: number): string {
  return v.toFixed(v >= 1000 ? 2 : v >= 1 ? 4 : 6).replace(/0+$/, "").replace(/\.$/, "");
}

export function detectLiquidationReversal(
  symbol: string,
  timeframe: string,
  candles: Candle[],
  forcedPrints: ForcedPrint[] = []
): LiquidationReversalSetup {
  const price = candles[candles.length - 1]?.close ?? 0;
  const base: LiquidationReversalSetup = {
    symbol,
    timeframe,
    price,
    spike: null,
    location: "none",
    reversalPct: 0,
    peakReversalPct: 0,
    forced: "unlikely",
    forcedNote:
      "No bar in this window carries a forced-flow signature — the trade here has been orderly and voluntary.",
    score: 0,
    qualified: false,
    grade: "none",
    invalidation: null,
    target: null,
    headline: "No liquidation spike",
    explanation: ["No liquidation delta spike detected in the recent window."],
  };
  if (candles.length < 30 || price <= 0) {
    return { ...base, headline: "Not enough history to detect a spike" };
  }

  const context = candles.slice(-CONTEXT_WINDOW);
  const liq = analyzeLiquidationDelta(candles, CONTEXT_WINDOW);
  const byTime = new Map(liq.series.map((p) => [p.time, p]));

  const scanned = candles.slice(-SPIKE_WINDOW);
  const flows = liq.series.map((p) => p.longLiquidated + p.shortLiquidated);
  const meanFlow = flows.reduce((s, v) => s + v, 0) / Math.max(flows.length, 1);

  // The spike is the single largest forced print in the scanned window, not a
  // cumulative total: a cascade is one violent bar, and summing a window would
  // let thirty ordinary bars impersonate one.
  let spikeBar: Candle | null = null;
  let spikeSide: "long" | "short" = "long";
  let spikeVolume = 0;
  for (const c of scanned) {
    const p = byTime.get(c.time);
    if (!p) continue;
    const side = p.longLiquidated >= p.shortLiquidated ? "long" : "short";
    const vol = Math.max(p.longLiquidated, p.shortLiquidated);
    if (vol > spikeVolume) {
      spikeVolume = vol;
      spikeBar = c;
      spikeSide = side;
    }
  }

  if (!spikeBar || spikeVolume <= 0) return base;

  const spikeIdx = candles.findIndex((c) => c.time === spikeBar!.time);
  const since = candles.slice(spikeIdx);
  const barsAgo = candles.length - 1 - spikeIdx;

  // A long flush prints its damage at the low, a short squeeze at the high.
  const flush = spikeSide === "long";
  const extreme = flush ? spikeBar.low : spikeBar.high;
  const windowLow = Math.min(...context.map((c) => c.low));
  const windowHigh = Math.max(...context.map((c) => c.high));
  const distanceFromExtremePct = flush
    ? ((extreme - windowLow) / Math.max(windowLow, 1e-9)) * 100
    : ((windowHigh - extreme) / Math.max(windowHigh, 1e-9)) * 100;
  const atExtreme = distanceFromExtremePct <= EXTREME_TOLERANCE_PCT;

  const spike: LiquidationSpike = {
    time: spikeBar.time,
    side: spikeSide,
    volume: Number(spikeVolume.toFixed(2)),
    multiple: Number((spikeVolume / Math.max(meanFlow, 1e-9)).toFixed(2)),
    price: spikeBar.close,
    extreme,
    atExtreme,
    distanceFromExtremePct: Number(distanceFromExtremePct.toFixed(3)),
    barsAgo,
  };

  const location: LiquidationReversalSetup["location"] = !atExtreme
    ? "mid"
    : flush
      ? "bottom"
      : "top";

  // Reversal is measured off the spike's own extreme, so it is the move the
  // liquidation actually produced rather than a move it happened to precede.
  const peakSince = Math.max(...since.map((c) => c.high));
  const troughSince = Math.min(...since.map((c) => c.low));
  const reversalPct = flush
    ? ((price - extreme) / extreme) * 100
    : ((extreme - price) / extreme) * 100;
  const peakReversalPct = flush
    ? ((peakSince - extreme) / extreme) * 100
    : ((extreme - troughSince) / extreme) * 100;

  /* ---- Forced or not ---- */
  const confirmedQty = forcedPrints
    .filter((p) => p.side === spikeSide && p.time >= spikeBar!.time && p.time < spikeBar!.time + barDurationGuess(candles))
    .reduce((s, p) => s + p.qty, 0);

  const avgVol = context.reduce((s, c) => s + c.volume, 0) / context.length;
  const avgRange = context.reduce((s, c) => s + (c.high - c.low), 0) / context.length;
  const volX = spikeBar.volume / Math.max(avgVol, 1e-9);
  const rangeX = (spikeBar.high - spikeBar.low) / Math.max(avgRange, 1e-9);
  const buy = spikeBar.takerBuyVolume ?? spikeBar.volume / 2;
  const dominance = flush
    ? (spikeBar.volume - buy) / Math.max(spikeBar.volume, 1e-9)
    : buy / Math.max(spikeBar.volume, 1e-9);

  let forced: LiquidationReversalSetup["forced"];
  let forcedNote: string;
  if (confirmedQty > 0) {
    forced = "confirmed";
    forcedNote = `Live forced-order prints totalling ${fmt(confirmedQty)} were observed on this bar — this is measured liquidation, not an inference from the candle.`;
  } else if (volX >= 2.2 && rangeX >= 2 && dominance >= 0.62) {
    forced = "inferred";
    forcedNote = `No forced-order feed for this bar, but the signature is unambiguous: ${volX.toFixed(1)}× average volume in ${rangeX.toFixed(1)}× the average range with ${(dominance * 100).toFixed(0)}% of the flow on the ${flush ? "sell" : "buy"} side. Discretionary traders do not all arrive in the same second; margin engines do. Treat the size as an estimate.`;
  } else if (volX >= 1.6 && rangeX >= 1.6) {
    forced = "inferred";
    forcedNote = `The bar is outsized (${volX.toFixed(1)}× volume, ${rangeX.toFixed(1)}× range) but the aggression is only ${(dominance * 100).toFixed(0)}% one-sided, so part of this was probably voluntary. Forced size is estimated from the candle, not measured.`;
  } else {
    forced = "unlikely";
    forcedNote = `The bar is not outsized enough (${volX.toFixed(1)}× volume, ${rangeX.toFixed(1)}× range) to read as a liquidation cascade — this looks like ordinary two-sided trade.`;
  }

  /* ---- Did the flush get absorbed? ---- */
  // Flow *after* the spike is what says whether the other side showed up. A
  // long flush followed by more selling is a cascade in progress; one followed
  // by buying is the cascade being absorbed.
  const after = since.slice(1);
  const afterDelta = after.reduce((s, c) => {
    const b = c.takerBuyVolume ?? c.volume / 2;
    return s + (b - (c.volume - b));
  }, 0);
  const absorbed = flush ? afterDelta > 0 : afterDelta < 0;
  const reclaimedMid = flush
    ? price > (spikeBar.high + spikeBar.low) / 2
    : price < (spikeBar.high + spikeBar.low) / 2;

  /* ---- Scoring ---- */
  let score = 18; // a spike exists at all
  if (atExtreme) score += 22;
  if (forced === "confirmed") score += 16;
  else if (forced === "inferred") score += volX >= 2.2 ? 11 : 6;
  score += Math.min(16, Math.max(0, reversalPct) * 4);
  if (reclaimedMid) score += 12;
  if (absorbed) score += 12;
  score += Math.min(6, Math.max(0, spike.multiple - 1) * 2);
  score += barsAgo <= 5 ? 6 : barsAgo <= 12 ? 3 : 0;
  score = Math.round(Math.max(0, Math.min(100, score)));

  // Location is not negotiable: a spike in the middle of a move is not a
  // reversal setup regardless of how big it was.
  const qualified = atExtreme && reversalPct > 0 && forced !== "unlikely" && score >= QUALIFY_SCORE;
  const grade: LiquidationReversalSetup["grade"] = qualified
    ? score >= 80
      ? "prime"
      : "strong"
    : score >= 40
      ? "forming"
      : "none";

  const invalidation = extreme;
  const target = flush
    ? Math.max(...context.slice(0, Math.max(1, context.length - 5)).map((c) => c.high)) > price
      ? Math.max(...context.map((c) => c.high))
      : null
    : Math.min(...context.map((c) => c.low)) < price
      ? Math.min(...context.map((c) => c.low))
      : null;

  const headline = qualified
    ? `${grade === "prime" ? "Prime" : "Strong"} ${flush ? "long flush at the low" : "short squeeze at the high"} — ${reversalPct.toFixed(2)}% reversal so far`
    : !atExtreme
      ? `Liquidation spike ${spike.distanceFromExtremePct.toFixed(1)}% off the window extreme — mid-move, not exhaustion`
      : forced === "unlikely"
        ? "Spike bar does not carry a forced-flow signature"
        : `${flush ? "Long flush" : "Short squeeze"} at the ${flush ? "low" : "high"}, ${reversalPct > 0 ? `${reversalPct.toFixed(2)}% reversal` : "no reversal yet"} — score ${score} below the ${QUALIFY_SCORE} threshold`;

  const explanation: string[] = [
    headline,
    `${flush ? "Longs were" : "Shorts were"} forced out ${barsAgo === 0 ? "on the current bar" : `${barsAgo} bar${barsAgo === 1 ? "" : "s"} ago`} at ${fmt(extreme)}, an estimated ${fmt(spike.volume)} of forced ${flush ? "selling" : "buying"} — ${spike.multiple.toFixed(1)}× the average forced flow in this window.`,
    forcedNote,
    atExtreme
      ? `The spike printed at the ${flush ? "low" : "high"} of the window (${spike.distanceFromExtremePct.toFixed(2)}% from it), which is where forced flow means exhaustion rather than continuation.`
      : `The spike printed ${spike.distanceFromExtremePct.toFixed(2)}% away from the window ${flush ? "low" : "high"} — price kept going afterwards, so this was a leg of the move, not the end of it.`,
    reversalPct > 0
      ? `Price has reversed ${reversalPct.toFixed(2)}% off the spike extreme, with a peak of ${peakReversalPct.toFixed(2)}%.${peakReversalPct - reversalPct > 1 ? " Much of that has already been given back, so the best of the move is behind." : ""}`
      : `Price has not reversed off the spike extreme (${reversalPct.toFixed(2)}%), so the cascade has not yet been rejected.`,
    absorbed
      ? `Taker flow since the spike is net ${flush ? "buying" : "selling"} — the other side stepped in, which is what turns a flush into a low rather than a waypoint.`
      : `Taker flow since the spike is still net ${flush ? "selling" : "buying"} — nobody has taken the other side yet, so the cascade may not be finished.`,
    `The spike extreme at ${fmt(invalidation)} is the level that must hold; a close beyond it says the forced flow was not exhaustion.${target != null ? ` First objective is the window ${flush ? "high" : "low"} at ${fmt(target)}.` : ""}`,
  ];

  return {
    symbol,
    timeframe,
    price,
    spike,
    location,
    reversalPct: Number(reversalPct.toFixed(3)),
    peakReversalPct: Number(peakReversalPct.toFixed(3)),
    forced,
    forcedNote,
    score,
    qualified,
    grade,
    invalidation,
    target,
    headline,
    explanation,
  };
}

/** Bar duration in seconds, read off the candles rather than the timeframe string. */
function barDurationGuess(candles: Candle[]): number {
  if (candles.length < 2) return 60;
  return Math.max(1, candles[candles.length - 1].time - candles[candles.length - 2].time);
}
