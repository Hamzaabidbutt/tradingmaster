import { BarExcursion, Candle, DeltaExcursionResult, ExcursionVerdict } from "./types";

export type { BarExcursion, DeltaExcursionResult, ExcursionVerdict };

/**
 * What the delta did *inside* the bar, not just where it ended.
 *
 * A bar's closing delta is a net figure, and netting destroys the interesting
 * part. A bar that closes at +200 might have been +200 all the way through —
 * steady, unopposed buying — or it might have run to +5,000 and been handed
 * back. Those are opposite facts about who is in control, and the closing
 * number is identical for both.
 *
 * The second one is absorption, and it is the single most useful thing a
 * footprint terminal shows that a candle chart cannot: aggressive buyers paid
 * up five thousand contracts' worth and finished the bar with nothing to show
 * for it, which means someone was selling into every one of those lifts and
 * had more size than the buyers did. Price does not need to fall for that to
 * be bearish — it only needs to fail to rise.
 *
 * ## Why this needs sub-candles
 *
 * Max and min delta are *paths*, and a path cannot be recovered from its
 * endpoint. Binance publishes one taker-buy figure per bar, which is the
 * endpoint. So when no lower-timeframe series is supplied this engine reports
 * that it has nothing to say rather than modelling a path — a modelled
 * excursion would be a picture of the model's assumptions about intrabar
 * order, and absorption is exactly the thing such a model would invent.
 */

/** Sub-bars needed inside a bar before its path is worth reading. */
const MIN_SUBS = 4;
/** Bars of context for judging whether an excursion was large. */
const CONTEXT = 40;
/** An excursion must reach this multiple of the window's typical one. */
const MIN_EXCURSION_X = 1.5;
/** Close in the bottom (or top) of this share of the range to corroborate. */
const CLOSE_BAND = 0.4;
/** Handing back this share of the peak is what makes it absorption. */
const GIVE_BACK_SHARE = 0.6;
/** Each side must reach this share of the larger run before both count as having run. */
const SIDE_SHARE = 0.25;

function unavailable(reason: string): DeltaExcursionResult {
  return {
    available: false,
    bars: [],
    latestAbsorption: null,
    sourceTimeframe: null,
    headline: reason,
    caveats: [
      "Max and min delta describe the path the delta took inside a bar, and a path cannot be recovered from a bar-level total. Without lower-timeframe candles there is nothing to measure, and a modelled path would be inventing the very thing this looks for.",
    ],
  };
}

/** Taker buy volume, clamped into the bar's own total. */
function buyOf(candle: Candle): number {
  const raw = candle.takerBuyVolume ?? candle.volume / 2;
  return Math.min(Math.max(raw, 0), candle.volume);
}

/**
 * Reconstruct each bar's delta path from lower-timeframe candles.
 *
 * Pure and synchronous. Returns `available: false` — never a guess — when the
 * sub-series is missing or too sparse to carry a path.
 */
export function analyzeDeltaExcursion(
  candles: Candle[],
  subCandles: Candle[] | null,
  opts: { count?: number; sourceTimeframe?: string } = {}
): DeltaExcursionResult {
  if (!subCandles || subCandles.length === 0) {
    return unavailable("No lower-timeframe series supplied — intrabar delta path unavailable.");
  }
  if (candles.length < 2) {
    return unavailable("Not enough bars to reconstruct an intrabar path.");
  }

  const count = opts.count ?? CONTEXT;
  const start = Math.max(0, candles.length - count);
  const subs = [...subCandles].sort((a, b) => a.time - b.time);

  const bars: BarExcursion[] = [];

  for (let i = start; i < candles.length; i++) {
    const c = candles[i];
    const next = candles[i + 1];
    const inside = subs.filter((s) => s.time >= c.time && (!next || s.time < next.time));
    if (inside.length < MIN_SUBS) continue;

    let running = 0;
    let maxDelta = 0;
    let minDelta = 0;
    for (const s of inside) {
      const buy = buyOf(s);
      running += buy - (s.volume - buy);
      if (running > maxDelta) maxDelta = running;
      if (running < minDelta) minDelta = running;
    }

    const span = c.high - c.low;
    const closePosition = span > 0 ? (c.close - c.low) / span : 0.5;

    bars.push({
      time: c.time,
      index: i,
      closeDelta: Number(running.toFixed(2)),
      maxDelta: Number(maxDelta.toFixed(2)),
      minDelta: Number(minDelta.toFixed(2)),
      gaveBackUp: Number(Math.max(0, maxDelta - running).toFixed(2)),
      gaveBackDown: Number(Math.max(0, running - minDelta).toFixed(2)),
      closePosition: Number(closePosition.toFixed(3)),
      samples: inside.length,
      verdict: "two_sided",
      note: "",
    });
  }

  if (bars.length === 0) {
    return unavailable(
      `Lower-timeframe candles supplied, but fewer than ${MIN_SUBS} land inside any bar — too sparse to carry a path.`
    );
  }

  /* Scale. "A big excursion" only means anything against the excursions this
     market has been printing; an absolute figure would call every bar of a
     quiet session clean and every bar of a busy one absorbed. */
  const spans = bars.map((b) => Math.max(b.maxDelta, -b.minDelta)).sort((a, b) => a - b);
  const typical = spans[Math.floor(spans.length / 2)];

  for (const b of bars) {
    b.verdict = classify(b, typical);
    b.note = noteFor(b);
  }

  const absorptions = bars.filter(
    (b) => b.verdict === "absorbed_buying" || b.verdict === "absorbed_selling"
  );
  const latestAbsorption = absorptions.length > 0 ? absorptions[absorptions.length - 1] : null;
  const last = bars[bars.length - 1];

  return {
    available: true,
    bars,
    latestAbsorption,
    sourceTimeframe: opts.sourceTimeframe ?? null,
    headline: latestAbsorption
      ? `${latestAbsorption.verdict === "absorbed_buying" ? "Buying" : "Selling"} absorbed ${bars.length - 1 - bars.indexOf(latestAbsorption)} bar${bars.length - 1 - bars.indexOf(latestAbsorption) === 1 ? "" : "s"} ago: the delta ran to ${latestAbsorption.verdict === "absorbed_buying" ? latestAbsorption.maxDelta.toFixed(0) : latestAbsorption.minDelta.toFixed(0)} and closed at ${latestAbsorption.closeDelta.toFixed(0)}.`
      : `No absorption in the last ${bars.length} bars; the current bar's delta path is ${last.verdict.replace(/_/g, " ")}.`,
    caveats: [
      "The path is reconstructed from lower-timeframe candles, so it is sequenced to that resolution rather than trade by trade. A run and a give-back inside a single sub-bar net out before this sees them.",
      "Absorption says one side pressed and did not get paid for it. It does not say price reverses — the same print appears when a large seller is simply finished and steps away.",
    ],
  };
}

function classify(b: BarExcursion, typical: number): ExcursionVerdict {
  const floor = Math.max(typical * MIN_EXCURSION_X, 1e-9);
  const up = b.maxDelta;
  const down = -b.minDelta;
  const ranUp = up >= floor;
  const ranDown = down >= floor;

  // Absorption: the run happened, almost none of it survived, and price ended
  // the bar at the wrong end of its own range. All three, or it is not this.
  if (ranUp && b.gaveBackUp >= b.maxDelta * GIVE_BACK_SHARE && b.closePosition <= CLOSE_BAND) {
    return "absorbed_buying";
  }
  if (ranDown && b.gaveBackDown >= -b.minDelta * GIVE_BACK_SHARE && b.closePosition >= 1 - CLOSE_BAND) {
    return "absorbed_selling";
  }
  /* Below here the question is the *shape* of the path, not its size, so the
     absolute floor is dropped. Requiring 1.5× the typical excursion before a
     bar could be called clean meant that on a stretch where every bar looked
     alike nothing cleared its own median and every one of them was reported
     two-sided — including bars whose delta rose steadily and never once went
     negative. "Both sides had a go" is then a false statement about the tape,
     not a cautious one, which is worse than saying nothing.

     The size floor stays on absorption above, where it belongs: absorption is
     a claim that a run happened and was given back, and that claim should not
     fire on noise. */
  const larger = Math.max(up, down);
  if (larger <= 0) return "two_sided";
  const bothRan = up >= larger * SIDE_SHARE && down >= larger * SIDE_SHARE;
  if (!bothRan) {
    if (up > down && b.closeDelta > 0) return "clean_buying";
    if (down > up && b.closeDelta < 0) return "clean_selling";
  }
  return "two_sided";
}

function noteFor(b: BarExcursion): string {
  switch (b.verdict) {
    case "absorbed_buying":
      return (
        `Delta reached +${b.maxDelta.toFixed(0)} inside the bar and closed at ${b.closeDelta >= 0 ? "+" : ""}${b.closeDelta.toFixed(0)}, ` +
        `with the bar finishing in the lower ${(b.closePosition * 100).toFixed(0)}% of its range. ` +
        `Buyers crossed the spread for that whole excursion and kept none of it, which means someone sold into every lift with more size than the buyers had. ` +
        `Price did not have to fall for that to matter — failing to rise is the point.`
      );
    case "absorbed_selling":
      return (
        `Delta reached ${b.minDelta.toFixed(0)} inside the bar and closed at ${b.closeDelta >= 0 ? "+" : ""}${b.closeDelta.toFixed(0)}, ` +
        `with the bar finishing in the upper ${((1 - b.closePosition) * 100).toFixed(0)}% of its range. ` +
        `Sellers hit the bid throughout and finished with nothing, so a passive bid took everything they had.`
      );
    case "clean_buying":
      return `Delta rose to +${b.maxDelta.toFixed(0)} and held it into the close. Unopposed buying: nobody was on the other side in size.`;
    case "clean_selling":
      return `Delta fell to ${b.minDelta.toFixed(0)} and held it into the close. Unopposed selling.`;
    case "two_sided": {
      /* Only claim both sides ran when both actually did. The same verdict
         also covers a bar that ran one way and ended the other without
         qualifying as absorption, and describing that as "both sides had a
         go" would be inventing a seller that never showed up. */
      const up = b.maxDelta;
      const down = -b.minDelta;
      const larger = Math.max(up, down);
      const bothRan = larger > 0 && up >= larger * SIDE_SHARE && down >= larger * SIDE_SHARE;
      const path = `Delta ran to +${b.maxDelta.toFixed(0)} and ${b.minDelta.toFixed(0)} within the bar, closing at ${b.closeDelta >= 0 ? "+" : ""}${b.closeDelta.toFixed(0)}.`;
      if (bothRan) return `${path} Both sides had a go and neither kept it.`;
      if (larger <= 0) return `${path} Neither side moved the delta at all.`;
      return `${path} One side led the bar and finished without keeping it, but not by enough — or not closing far enough against itself — to call it absorption.`;
    }
  }
}
