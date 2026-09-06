import { analyzeMarketStructure, findSwings } from "./marketStructure";
import { detectSupportResistance } from "./supportResistance";
import { Candle, CandleCloseExpansionResult, SRLevel } from "./types";

/**
 * Candle Close Expansion Analyst.
 *
 * The premise: expansion is announced by a CLOSE, not by a touch. Price
 * pokes through levels constantly — wicks through highs, spikes through
 * lows — and almost none of it matters. What matters is a candle that
 * *settles* beyond a level the market has been respecting.
 *
 * So this engine does five things in order:
 *   1. find the horizontal level that actually governs price right now
 *   2. find the most recent candle that CLOSED through it
 *   3. judge how convincing that close was — penetration, body, close
 *      location, participation, follow-through, and how well-established
 *      the level was beforehand
 *   4. check that the close was *confirmed*: it took out the previous
 *      candle's close, and structure broke the same way
 *   5. check the level's own track record: if closes through this level have
 *      historically snapped back, that history suppresses the probability
 *
 * A crossing on its own scores nothing. That is the entire point: genuine
 * expansion, weak breaks and false breakouts have to come out different.
 *
 * ## Why step four exists
 *
 * A close through a level says price left the area. It does not say price left
 * with intent, and those are different events that look identical on a bare
 * level chart. Two things separate them:
 *
 *   **The previous close.** A breaking candle that also settles beyond the
 *   prior bar's close took the last bar's participants out with it. One that
 *   drifts past the level while closing inside the previous bar's body has
 *   crossed a line on a chart and done nothing else.
 *
 *   **Structure.** A level broken *inside an unchanged market* is a level
 *   being tested. A level broken as structure itself breaks — a BOS or CHOCH
 *   in the same direction — is the market changing its mind. Only the second
 *   is expansion.
 *
 * Neither is scored as a bonus; their absence is scored as a discount. A close
 * with neither confirmation is heavily marked down rather than a confirmed one
 * being marked up, so the score cannot be inflated past what the base
 * decisiveness earned.
 */

/** Bars searched for the most recent close through the level. */
const BREAK_LOOKBACK = 60;
/** Bars allowed for a break to prove itself before it counts as failed. */
const RESOLUTION_BARS = 5;
/** Minimum distance beyond the previous close, in ATR, to count as taking it. */
const PRIOR_CLOSE_ATR = 0.25;
/**
 * How high in its own range the breaking candle must close.
 *
 * This is the discriminating half of the confirmation. A break bar almost
 * always closes beyond the previous close — that is what a break is — but a
 * bar that closes near its high has held everything it took, while one that
 * closes mid-range gave half of it back to sellers before the bell.
 */
const CLOSE_STRENGTH_MIN = 0.55;

export function analyzeCandleCloseExpansion(
  candles: Candle[],
  timeframeOrigin = "cce",
  deepCandles?: Candle[] | null
): CandleCloseExpansionResult {
  const price = candles[candles.length - 1]?.close ?? 0;
  if (candles.length < 40) return emptyResult(price);

  const atr = averageTrueRange(candles.slice(-Math.min(100, candles.length)));
  if (atr <= 0) return emptyResult(price);

  /* ---------------- 1. The level that governs price ---------------- */
  const level = pickKeyLevel(candles, timeframeOrigin, atr);
  if (!level) return emptyResult(price, "No horizontal level has been tested often enough to treat as significant.");

  const lvl = level.price;
  // Wide enough that noise doesn't register as a close through the level.
  const tol = Math.max(0.15 * atr, lvl * 0.0008);
  const sideOf = (close: number): -1 | 0 | 1 =>
    close > lvl + tol ? 1 : close < lvl - tol ? -1 : 0;

  const lastClose = candles[candles.length - 1];
  const currentSide = sideOf(lastClose.close);
  const candleClose: CandleCloseExpansionResult["candleClose"] =
    currentSide === 1 ? "above" : currentSide === -1 ? "below" : "inside";

  /* ---------------- 2. The most recent close THROUGH the level ------------ */
  // History for the level's track record; the recent slice for the live break.
  const history = deepCandles && deepCandles.length > candles.length ? deepCandles : candles;
  const breaks = findLevelBreaks(candles, sideOf);
  const recentCutoff = candles.length - Math.min(BREAK_LOOKBACK, candles.length);
  const liveBreak = breaks.filter((b) => b.index >= recentCutoff).pop() ?? null;

  /* ---------------- 3. Was that close convincing? ---------------- */
  const decisiveness = liveBreak
    ? judgeClose(candles, liveBreak.index, liveBreak.direction, lvl, atr, level.rejections)
    : noClose();

  const breakoutDirection: CandleCloseExpansionResult["breakoutDirection"] =
    !liveBreak || decisiveness.verdict === "weak"
      ? "none"
      : liveBreak.direction === 1
        ? "bullish"
        : "bearish";

  /* ---------------- 4. Was the close confirmed? ---------------- */
  const confirmation = judgeConfirmation(candles, liveBreak, atr);

  /* ---------------- 5. This level's track record ---------------- */
  const historicalBreaks = findLevelBreaks(history, sideOf);
  const precedents = historicalBreaks
    // The live break hasn't had time to resolve — judging it here would be circular.
    .filter((b) => b.index + RESOLUTION_BARS < history.length)
    .map((b) => {
      const forward = history.slice(b.index + 1, b.index + 1 + RESOLUTION_BARS);
      const anchor = history[b.index].close;
      const failed = forward.some((c) =>
        b.direction === 1 ? c.close < lvl - tol : c.close > lvl + tol
      );
      const extreme =
        b.direction === 1
          ? Math.max(...forward.map((c) => c.high))
          : Math.min(...forward.map((c) => c.low));
      const followThroughPct = ((extreme - anchor) / anchor) * 100 * b.direction;
      const d = judgeClose(history, b.index, b.direction, lvl, atr, level.rejections);
      return {
        time: history[b.index].time,
        direction: (b.direction === 1 ? "above" : "below") as "above" | "below",
        decisive: d.score >= 55,
        followThroughPct: Number(followThroughPct.toFixed(2)),
        failed,
        note: `Closed ${b.direction === 1 ? "above" : "below"} ${lvl.toFixed(4)} on a ${d.verdict} candle; over the next ${RESOLUTION_BARS} bars it ran ${followThroughPct >= 0 ? "+" : ""}${followThroughPct.toFixed(2)}% in that direction and ${failed ? "then closed back through the level — a false break." : "never closed back through — the break held."}`,
      };
    });

  const resolved = precedents.length;
  const failedCount = precedents.filter((p) => p.failed).length;
  const falseBreakRate = resolved > 0 ? failedCount / resolved : 0;

  /* ---------------- Expansion probability ---------------- */
  // Start from how convincing the close was, then discount by the level's
  // own history of faking people out.
  let expansionScore = decisiveness.score * (1 - 0.55 * falseBreakRate);
  /* Confirmation as a discount rather than a bonus, so a confirmed close can
     never score above what its own decisiveness earned. A close through a
     level that took out neither the previous close nor structure is the
     textbook false break, and it is marked down hard. */
  if (liveBreak) {
    expansionScore *= confirmation.aligned
      ? 1
      : confirmation.brokeStructure
        ? 0.88
        : confirmation.brokePriorClose
          ? 0.7
          : 0.5;
  }
  // A close back inside the band is not expansion, whatever came before it.
  if (candleClose === "inside" && liveBreak) expansionScore *= 0.4;
  // Price having already re-crossed the break direction is a failed break.
  if (liveBreak && currentSide !== 0 && currentSide !== liveBreak.direction) expansionScore *= 0.25;
  if (!liveBreak) expansionScore = 0;
  expansionScore = Math.round(clamp(expansionScore, 0, 95));

  const expansionProbability: CandleCloseExpansionResult["expansionProbability"] =
    expansionScore >= 62 ? "High" : expansionScore >= 38 ? "Medium" : "Low";

  const expectedDirection: CandleCloseExpansionResult["expectedDirection"] =
    breakoutDirection === "none" || expansionScore < 38
      ? "uncertain"
      : breakoutDirection === "bullish"
        ? "up"
        : "down";

  /* ---------------- Target & invalidation ---------------- */
  let expansionTarget: number | null = null;
  let invalidationLevel: number | null = null;
  if (liveBreak && expectedDirection !== "uncertain") {
    // Measured move: the height of the structure price was coiling in before
    // the break, projected from the level.
    const pre = candles.slice(Math.max(0, liveBreak.index - 30), liveBreak.index);
    const preHigh = pre.length ? Math.max(...pre.map((c) => c.high)) : lvl + 2 * atr;
    const preLow = pre.length ? Math.min(...pre.map((c) => c.low)) : lvl - 2 * atr;
    const height = Math.max(preHigh - preLow, 2 * atr);
    expansionTarget = liveBreak.direction === 1 ? lvl + height : lvl - height;
    // A close back through the level ends the thesis — that is the line.
    invalidationLevel = lvl;
  }

  /* ---------------- Narrative ---------------- */
  const reason: string[] = [];
  reason.push(
    `${level.kind === "support" ? "Support" : "Resistance"} at ${lvl.toFixed(4)} has been touched ${level.touches} time(s) with ${level.rejections} of those closing back away from it — ${
      level.rejections >= 3
        ? "a well-established level, so a close through it means something."
        : level.rejections >= 2
          ? "reasonably established."
          : "only lightly tested, so treat any break through it as low-information."
    }`
  );

  if (!liveBreak) {
    reason.push(
      `No candle has closed through ${lvl.toFixed(4)} in the last ${Math.min(BREAK_LOOKBACK, candles.length)} bars. Price is ${candleClose === "inside" ? "sitting on the level" : `holding ${candleClose} it`} without a fresh decision, so there is no breakout to trade — only a level to watch.`
    );
  } else {
    const bc = candles[liveBreak.index];
    reason.push(
      `The last candle to close through the level did so ${liveBreak.direction === 1 ? "above" : "below"} it at ${bc.close.toFixed(4)}, ${decisiveness.penetrationAtr.toFixed(2)} ATR beyond, with ${(decisiveness.bodyRatio * 100).toFixed(0)}% of its range as body and the close ${(decisiveness.closeLocation * 100).toFixed(0)}% up its own range on ${decisiveness.volumeMultiple.toFixed(1)}x volume.`
    );
    reason.push(
      decisiveness.verdict === "decisive"
        ? `That is a decisive close — it settled well beyond the level rather than wicking through it, which is what distinguishes real expansion from a probe.`
        : decisiveness.verdict === "marginal"
          ? `That is a marginal close: it is through the level but not emphatically, so it deserves a smaller position and a retest before trust.`
          : `That is a weak close — the kind that crosses a level without committing. Not treated as a breakout here.`
    );
    for (const line of confirmation.detail) reason.push(line);
    reason.push(
      decisiveness.followThroughBars > 0
        ? `${decisiveness.followThroughBars} subsequent candle(s) have closed on the same side, so the break is being held rather than immediately rejected.`
        : `Nothing has followed through yet — subsequent closes have not extended the break, which is the first warning sign of a failure.`
    );
  }

  if (resolved > 0) {
    reason.push(
      `Track record of this level: ${resolved} prior close(s) through it, of which ${failedCount} snapped back inside within ${RESOLUTION_BARS} bars — a ${(falseBreakRate * 100).toFixed(0)}% false-break rate. ${
        falseBreakRate >= 0.6
          ? "This level fakes out more often than it breaks, so the probability is discounted heavily."
          : falseBreakRate <= 0.25
            ? "Breaks of this level have generally stuck, which supports the read."
            : "Mixed history — some breaks held, some failed."
      }`
    );
  } else {
    reason.push(
      `No prior resolved break of this level exists in the available history, so there is no track record to lean on either way.`
    );
  }

  if (currentSide !== 0 && liveBreak && currentSide !== liveBreak.direction) {
    reason.push(
      `Price has already closed back through the level in the opposite direction — this is a false breakout, not an expansion setup.`
    );
  }

  const summary =
    !liveBreak
      ? `Price is ${candleClose} ${lvl.toFixed(4)} with no confirmed close through it. No expansion signal — wait for a candle to settle beyond the level.`
      : expectedDirection === "up"
        ? `${expansionProbability} probability of bullish expansion: a ${decisiveness.verdict} close above ${lvl.toFixed(4)} projects ${expansionTarget?.toFixed(4)}, and a close back below ${lvl.toFixed(4)} kills it.`
        : expectedDirection === "down"
          ? `${expansionProbability} probability of bearish expansion: a ${decisiveness.verdict} close below ${lvl.toFixed(4)} projects ${expansionTarget?.toFixed(4)}, and a close back above ${lvl.toFixed(4)} kills it.`
          : `A close through ${lvl.toFixed(4)} occurred but does not qualify as expansion (${decisiveness.verdict} close${falseBreakRate >= 0.5 ? `, and this level has a ${(falseBreakRate * 100).toFixed(0)}% false-break history` : ""}). Treated as a probe, not a breakout.`;

  return {
    keyLevel: {
      price: lvl,
      kind: level.kind,
      touches: level.touches,
      respects: level.rejections,
      historicalFalseBreakRate: Number(falseBreakRate.toFixed(3)),
      note: `${lvl.toFixed(4)} — ${level.touches} touches, ${level.rejections} respected closes, strength ${level.strength}/100${resolved > 0 ? `, ${(falseBreakRate * 100).toFixed(0)}% of prior breaks failed` : ""}.`,
    },
    candleClose,
    closePrice: lastClose.close,
    closeTime: lastClose.time,
    breakoutDirection,
    decisiveness,
    confirmation,
    expansionProbability,
    expansionScore,
    expectedDirection,
    expansionTarget,
    invalidationLevel,
    reason,
    historicalPrecedents: precedents.slice(-8),
    summary,
  };
}

/* ------------------------------------------------------------------ *
 * Level selection
 * ------------------------------------------------------------------ */

/**
 * The governing level is the one price is actually interacting with — near,
 * well-tested, and ideally straddled by recent bars. Strength alone would
 * pick a level 20% away that nobody is trading against.
 */
function pickKeyLevel(candles: Candle[], timeframeOrigin: string, atr: number): SRLevel | null {
  const levels = detectSupportResistance(candles, timeframeOrigin);
  const candidates = levels.length > 0 ? levels : swingFallbackLevels(candles, timeframeOrigin);
  if (candidates.length === 0) return null;

  const price = candles[candles.length - 1].close;
  const recent = candles.slice(-Math.min(20, candles.length));

  let best: SRLevel | null = null;
  let bestScore = -Infinity;
  for (const l of candidates) {
    const distAtr = Math.abs(price - l.price) / Math.max(atr, 1e-9);
    // Proximity decays smoothly; a level 6 ATR away is barely relevant.
    let score = l.strength * Math.exp(-distAtr / 3);
    // Bars straddling the level mean it is the live decision point.
    const straddled = recent.filter((c) => c.low <= l.price && c.high >= l.price).length;
    score += straddled * 6;
    if (score > bestScore) {
      bestScore = score;
      best = l;
    }
  }
  return best;
}

/** When clustering finds nothing, fall back to the plain recent swing extremes. */
function swingFallbackLevels(candles: Candle[], timeframeOrigin: string): SRLevel[] {
  const swings = findSwings(candles.slice(-120), 4, "minor");
  const last = candles[candles.length - 1];
  return swings.slice(-6).map((s) => ({
    id: `sr-fallback-${timeframeOrigin}-${s.price.toFixed(6)}`,
    price: s.price,
    kind: (s.price < last.close ? "support" : "resistance") as "support" | "resistance",
    timeframeOrigin,
    touches: 1,
    rejections: 1,
    strength: 35,
    breakProbability: 50,
    bounceProbability: 50,
    volumeConfirmed: false,
    firstTouch: s.time,
    lastTouch: s.time,
  }));
}

/* ------------------------------------------------------------------ *
 * Break detection & judgement
 * ------------------------------------------------------------------ */

/**
 * Every index where a close flipped from one side of the level to the other.
 * Bars closing inside the tolerance band are skipped rather than treated as
 * a side, so drifting through the band doesn't manufacture breaks.
 */
function findLevelBreaks(
  candles: Candle[],
  sideOf: (close: number) => -1 | 0 | 1
): { index: number; direction: 1 | -1 }[] {
  const out: { index: number; direction: 1 | -1 }[] = [];
  let lastSide: -1 | 0 | 1 = 0;
  for (let i = 0; i < candles.length; i++) {
    const side = sideOf(candles[i].close);
    if (side === 0) continue;
    if (lastSide !== 0 && side !== lastSide) {
      out.push({ index: i, direction: side });
    }
    lastSide = side;
  }
  return out;
}

/**
 * Score a single closing candle on how convincingly it broke the level.
 * Six independent checks — a candle has to earn most of them to be decisive.
 */
function judgeClose(
  candles: Candle[],
  index: number,
  direction: 1 | -1,
  lvl: number,
  atr: number,
  respects: number
): CandleCloseExpansionResult["decisiveness"] {
  const c = candles[index];
  const range = Math.max(c.high - c.low, 1e-9);
  const penetrationAtr = Math.abs(c.close - lvl) / Math.max(atr, 1e-9);
  const bodyRatio = Math.abs(c.close - c.open) / range;
  const closeLocation = (c.close - c.low) / range;
  // For a downside break, closing near the LOW is the strong outcome.
  const closeStrength = direction === 1 ? closeLocation : 1 - closeLocation;

  const priorVol = candles.slice(Math.max(0, index - 20), index);
  const avgVol = priorVol.length
    ? priorVol.reduce((s, x) => s + x.volume, 0) / priorVol.length
    : c.volume;
  const volumeMultiple = c.volume / Math.max(avgVol, 1e-9);

  // Consecutive closes that stayed on the break side after the break candle.
  let followThroughBars = 0;
  for (let i = index + 1; i < candles.length; i++) {
    const onSide = direction === 1 ? candles[i].close > lvl : candles[i].close < lvl;
    if (!onSide) break;
    followThroughBars++;
  }

  const pen = clamp(penetrationAtr / 1.0, 0, 1);
  const body = clamp((bodyRatio - 0.3) / 0.5, 0, 1);
  const loc = clamp((closeStrength - 0.5) * 2, 0, 1);
  const vol = clamp((volumeMultiple - 1) / 1.0, 0, 1);
  const follow = clamp(followThroughBars / 3, 0, 1);
  const established = clamp((respects - 2) / 4, 0, 1);

  const score = Math.round(
    clamp(pen * 28 + body * 18 + loc * 14 + vol * 14 + follow * 16 + established * 10, 0, 100)
  );

  const checks = [
    {
      label: "Settled beyond the level",
      passed: penetrationAtr >= 0.5,
      detail: `Close is ${penetrationAtr.toFixed(2)} ATR past ${lvl.toFixed(4)} (needs ≥ 0.50 to be more than a probe).`,
    },
    {
      label: "Body, not a wick",
      passed: bodyRatio >= 0.5,
      detail: `${(bodyRatio * 100).toFixed(0)}% of the candle's range is body (needs ≥ 50%).`,
    },
    {
      label: "Closed at the extreme",
      passed: closeStrength >= 0.65,
      detail: `Close sat ${(closeStrength * 100).toFixed(0)}% toward the ${direction === 1 ? "high" : "low"} of its range (needs ≥ 65%).`,
    },
    {
      label: "Volume expansion",
      passed: volumeMultiple >= 1.3,
      detail: `${volumeMultiple.toFixed(1)}x the prior 20-bar average (needs ≥ 1.3x).`,
    },
    {
      label: "Follow-through",
      passed: followThroughBars >= 2,
      detail: `${followThroughBars} consecutive close(s) held the break side (needs ≥ 2).`,
    },
    {
      label: "Level was established",
      passed: respects >= 3,
      detail: `${respects} prior close(s) respected this level (needs ≥ 3 for a break to carry weight).`,
    },
  ];

  return {
    score,
    penetrationAtr: Number(penetrationAtr.toFixed(3)),
    bodyRatio: Number(bodyRatio.toFixed(3)),
    closeLocation: Number(closeLocation.toFixed(3)),
    volumeMultiple: Number(volumeMultiple.toFixed(2)),
    followThroughBars,
    verdict: score >= 65 ? "decisive" : score >= 45 ? "marginal" : "weak",
    checks,
  };
}

/**
 * Did the breaking candle take out the previous close, and did structure go
 * with it?
 *
 * Structure is read over the bars up to and including the break, never past
 * it: including later bars would let the engine confirm a break using
 * information that did not exist when the candle closed, which is how a
 * backtest ends up looking far better than the live engine ever does.
 */
function judgeConfirmation(
  candles: Candle[],
  liveBreak: { index: number; direction: 1 | -1 } | null,
  atr: number
): CandleCloseExpansionResult["confirmation"] {
  if (!liveBreak || liveBreak.index < 1) {
    return {
      brokePriorClose: false,
      priorCloseGapAtr: 0,
      closeStrength: 0,
      brokeStructure: false,
      structureEvent: null,
      aligned: false,
      detail: [],
    };
  }

  const bar = candles[liveBreak.index];
  const prev = candles[liveBreak.index - 1];
  const up = liveBreak.direction === 1;

  const gap = (bar.close - prev.close) * liveBreak.direction;
  const priorCloseGapAtr = atr > 0 ? gap / atr : 0;
  const range = Math.max(bar.high - bar.low, 1e-12);
  const closeStrength = up ? (bar.close - bar.low) / range : (bar.high - bar.close) / range;

  /* "Broke the previous close" needs care, because on a level break it is
     nearly true by construction: the break bar is by definition the first to
     close through a level the previous bar closed short of, so its close is
     almost always beyond that one. Testing only that would pass on essentially
     every break and confirm nothing.

     What is actually informative is whether the candle took out the whole of
     the previous bar and *closed high in its own range* while doing it. A bar
     that spikes through, gives most of it back and settles mid-range has not
     broken the previous close in any sense worth acting on — it has printed a
     wick with a close attached. */
  const tookPriorExtreme = up ? bar.close > prev.high : bar.close < prev.low;
  const brokePriorClose =
    priorCloseGapAtr >= PRIOR_CLOSE_ATR &&
    tookPriorExtreme &&
    closeStrength >= CLOSE_STRENGTH_MIN;

  /* Structure over the bars available at the moment of the close. The window
     is generous because the swing detector is a fractal and needs pivots on
     both sides; a break bar right at the end of a short window would leave it
     nothing to work with. */
  const upTo = candles.slice(0, liveBreak.index + 1);
  let structureEvent: CandleCloseExpansionResult["confirmation"]["structureEvent"] = null;
  if (upTo.length >= 40) {
    const structure = analyzeMarketStructure(upTo);
    const wanted = up ? "bullish" : "bearish";
    // Within a few bars of the close: a BOS twenty bars earlier is a
    // different event that happens to point the same way.
    const nearTimes = new Set(upTo.slice(-6).map((c) => c.time));
    const match = structure.events
      .filter((e) => e.direction === wanted && nearTimes.has(e.time))
      .pop();
    if (match) {
      structureEvent = {
        type: match.type,
        direction: match.direction,
        time: match.time,
        price: match.price,
      };
    }
  }
  const brokeStructure = structureEvent != null;
  const aligned = brokePriorClose && brokeStructure;

  const detail: string[] = [];
  detail.push(
    brokePriorClose
      ? `The breaking candle closed ${priorCloseGapAtr.toFixed(2)} ATR beyond the previous close, past that bar's ${up ? "high" : "low"} entirely, and finished ${(closeStrength * 100).toFixed(0)}% ${up ? "up" : "down"} its own range — it took the last bar out with it rather than drifting past the level.`
      : tookPriorExtreme
        ? `The breaking candle cleared the previous bar but closed only ${(closeStrength * 100).toFixed(0)}% ${up ? "up" : "down"} its own range — it gave most of the move back before the close, which is a wick with a close attached rather than a decision.`
        : `The breaking candle did not clear the previous bar's ${up ? "high" : "low"}. It crossed the level while staying inside the prior bar's range, which is a line being crossed rather than a decision being made.`
  );
  detail.push(
    brokeStructure
      ? `Structure broke the same way at that close (${structureEvent!.type} ${structureEvent!.direction} at ${structureEvent!.price.toFixed(4)}) — the market changed its mind, rather than a level being tested inside an unchanged one.`
      : `No structure break accompanied the close. The level gave way without the swing sequence changing, which is what a test looks like from the outside.`
  );
  detail.push(
    aligned
      ? `Both confirmations present: this is the form of the setup worth trading.`
      : `Without both confirmations the score is discounted — a close through a level is where false breaks start, not where expansion is proven.`
  );

  return {
    brokePriorClose,
    priorCloseGapAtr: Number(priorCloseGapAtr.toFixed(3)),
    closeStrength: Number(closeStrength.toFixed(3)),
    brokeStructure,
    structureEvent,
    aligned,
    detail,
  };
}

function noClose(): CandleCloseExpansionResult["decisiveness"] {
  return {
    score: 0,
    penetrationAtr: 0,
    bodyRatio: 0,
    closeLocation: 0,
    volumeMultiple: 0,
    followThroughBars: 0,
    verdict: "none",
    checks: [
      {
        label: "Confirmed close through the level",
        passed: false,
        detail: "No candle has closed beyond the level in the lookback window.",
      },
    ],
  };
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function averageTrueRange(candles: Candle[]): number {
  if (candles.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    sum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  return sum / (candles.length - 1);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function emptyResult(price: number, why?: string): CandleCloseExpansionResult {
  const reason =
    why ?? "Fewer than 40 candles are available — not enough history to establish levels or judge closes.";
  return {
    keyLevel: null,
    candleClose: "inside",
    closePrice: price,
    closeTime: 0,
    breakoutDirection: "none",
    decisiveness: noClose(),
    confirmation: {
      brokePriorClose: false,
      priorCloseGapAtr: 0,
      closeStrength: 0,
      brokeStructure: false,
      structureEvent: null,
      aligned: false,
      detail: [],
    },
    expansionProbability: "Low",
    expansionScore: 0,
    expectedDirection: "uncertain",
    expansionTarget: null,
    invalidationLevel: null,
    reason: [reason],
    historicalPrecedents: [],
    summary: reason,
  };
}
