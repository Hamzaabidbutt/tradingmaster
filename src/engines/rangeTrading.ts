import { findSwings } from "./marketStructure";
import { Bias, Candle, RangeTradingResult } from "./types";

/**
 * Range Trading Strategy Analyst.
 *
 * The failure mode this engine is built to avoid: drawing two lines around
 * any sideways-looking stretch of chart and calling it a range. A horizontal
 * structure is only tradeable if price has demonstrably RESPECTED both
 * boundaries — repeatedly, with closes contained inside, and without a net
 * drift that says "this is a trend resting".
 *
 * So range detection runs as a set of explicit gates, and every gate is
 * reported. If the evidence isn't there the answer is "Unclear" or
 * "Trending" and NO mean-reversion setup is emitted — buying a low that has
 * already broken is the single most expensive mistake in range trading.
 *
 * When the range does validate, setups only appear at the boundaries, on
 * evidence of rejection. Mid-range is explicitly a no-trade zone: there is
 * no edge in the middle, only two-way risk.
 */

/** Window lengths tried when fitting a range; the best-validated one wins. */
const WINDOWS = [40, 60, 90, 130];
/** Bars a break gets to prove itself before a return inside counts as false. */
const RESOLUTION_BARS = 5;

interface RangeCandidate {
  bars: number;
  offset: number;
  high: number;
  low: number;
  height: number;
  highTouches: number;
  lowTouches: number;
  containment: number;
  highSlopePct: number;
  lowSlopePct: number;
  driftRatio: number;
  traversals: number;
  gates: { label: string; passed: boolean; detail: string }[];
  passedCount: number;
  score: number;
}

export function analyzeRangeTrading(candles: Candle[]): RangeTradingResult {
  if (candles.length < 60) return emptyResult("Fewer than 60 candles — not enough history to establish a range.");

  const atr = averageTrueRange(candles.slice(-Math.min(100, candles.length)));
  if (atr <= 0) return emptyResult("Flat series — no volatility to measure a range against.");

  /* ---------------- Fit the best-supported range ---------------- */
  const candidate = bestCandidate(candles, atr);
  if (!candidate) return emptyResult("No horizontal structure could be fitted to recent price action.");

  const { high: rangeHigh, low: rangeLow, height } = candidate;
  const midpoint = (rangeHigh + rangeLow) / 2;
  const tol = Math.max(0.25 * atr, height * 0.04);
  const last = candles[candles.length - 1];
  const price = last.close;

  /* ---------------- Boundary reactions ---------------- */
  const reactions = collectReactions(candles, candidate, atr, tol);

  /* ---------------- Breakout state ---------------- */
  const breakout = classifyBreakout(candles, candidate, atr, tol);
  const rangeBroken = breakout.stage === "confirmed" || breakout.stage === "retest";

  /* ---------------- Market condition ---------------- */
  // Gates decide whether this is a range at all; a confirmed break overrides
  // them, because a range that has broken is no longer a range.
  let marketCondition: RangeTradingResult["marketCondition"];
  if (rangeBroken) marketCondition = "Trending";
  else if (candidate.passedCount === candidate.gates.length) marketCondition = "Ranging";
  else if (candidate.driftRatio > 0.7 || candidate.passedCount <= 3) marketCondition = "Trending";
  else marketCondition = "Unclear";

  /* ---------------- Where price sits ---------------- */
  const pos = (price - rangeLow) / Math.max(height, 1e-9);
  const currentPosition: RangeTradingResult["currentPosition"] =
    price > rangeHigh + tol || price < rangeLow - tol
      ? "Outside"
      : pos >= 0.7
        ? "Near High"
        : pos <= 0.3
          ? "Near Low"
          : "Mid Range";

  /* ---------------- Recent rejection evidence ---------------- */
  const recentCut = candles[Math.max(0, candles.length - 6)].time;
  const freshLowRejection = reactions.some(
    (r) => r.boundary === "low" && r.time >= recentCut && r.kind !== "decisive_close_outside"
  );
  const freshHighRejection = reactions.some(
    (r) => r.boundary === "high" && r.time >= recentCut && r.kind !== "decisive_close_outside"
  );
  const falseBreakHistory = reactions.filter((r) => r.kind === "failed_breakout").length;

  /* ---------------- Setup ---------------- */
  let rangeSetup: RangeTradingResult["rangeSetup"] = "No Trade";
  let bias: Bias = "neutral";
  let potentialEntry: number | null = null;
  let target1: number | null = null;
  let target2: number | null = null;
  let invalidation: number | null = null;
  const reason: string[] = [];

  if (rangeBroken) {
    // Explicitly refuse the mean-reversion trade. This is the spec's hard rule.
    rangeSetup = "Breakout";
    bias = breakout.direction === "up" ? "bullish" : "bearish";
    const up = breakout.direction === "up";
    const boundary = up ? rangeHigh : rangeLow;
    // How far past the boundary price has already travelled, in range heights.
    // A break that ran three heights ago is history, not a setup, and quoting
    // the old measured move as a live target would be quoting the past.
    const extension = Math.abs(price - boundary) / Math.max(height, 1e-9);
    const t1 = up ? boundary + height * 0.5 : boundary - height * 0.5;
    const t2 = up ? boundary + height : boundary - height;
    const reached = (t: number) => (up ? price >= t : price <= t);

    // A retest is only a plan while price is still within reach of the
    // boundary. Half a range height out, waiting for one means waiting for the
    // whole move to be handed back.
    potentialEntry = extension <= 0.5 ? boundary : null;
    target1 = reached(t1) ? null : t1;
    target2 = reached(t2) ? null : t2;
    // Back to the midpoint means the break was a lie.
    invalidation = midpoint;
    reason.push(
      `The range has broken: ${breakout.note} This is no longer a range-trading environment, so buying ${rangeLow.toFixed(4)} or selling ${rangeHigh.toFixed(4)} is off the table — those levels have lost their meaning.`
    );
    if (potentialEntry !== null) {
      reason.push(
        `The trade here is the ${up ? "breakout" : "breakdown"} itself: wait for a retest of ${boundary.toFixed(4)} to hold, then look for continuation toward ${(target2 ?? t2).toFixed(4)}. A close back to ${midpoint.toFixed(4)} invalidates the break and puts the range back in play.`
      );
    } else if (target2 === null) {
      reason.push(
        `The break is already extended: price is ${extension.toFixed(1)} range-height(s) past ${boundary.toFixed(4)} and the full measured move to ${t2.toFixed(4)} is complete. There is no range trade and no unfilled objective left here — the next setup has to come from structure built above, not from this range. A close back to ${midpoint.toFixed(4)} would be the signal the break has failed.`
      );
    } else {
      reason.push(
        `Price is already ${extension.toFixed(1)} range-height(s) past ${boundary.toFixed(4)}, so a retest entry is too far behind the market to plan around${target1 === null ? ` and the first objective at ${t1.toFixed(4)} is already met` : ""}. What is left of the measured move runs to ${target2.toFixed(4)}. A close back to ${midpoint.toFixed(4)} invalidates the break.`
      );
    }
  } else if (marketCondition !== "Ranging") {
    rangeSetup = "No Trade";
    bias = "neutral";
    reason.push(
      `The horizontal structure between ${rangeLow.toFixed(4)} and ${rangeHigh.toFixed(4)} does not meet the evidence bar for a tradeable range (${candidate.passedCount}/${candidate.gates.length} checks passed). ${
        candidate.driftRatio > 0.7
          ? `Net drift across the window is ${(candidate.driftRatio * 100).toFixed(0)}% of the structure's own height — this is a trend pausing, not balance.`
          : `Boundaries have not been respected often or cleanly enough to lean on.`
      }`
    );
    reason.push(
      `No mean-reversion setup is offered. The failed checks are listed below — assuming a range here is exactly how range traders get run over.`
    );
  } else if (currentPosition === "Near Low") {
    if (freshLowRejection) {
      rangeSetup = "Long";
      bias = "bullish";
      potentialEntry = rangeLow + 0.3 * atr;
      target1 = midpoint;
      target2 = rangeHigh;
      // A decisive close below the low, not a wick, is what kills this.
      invalidation = rangeLow - 1.2 * atr;
      reason.push(
        `Price is ${(pos * 100).toFixed(0)}% up the range, at the lower boundary, and the last few bars show a rejection off ${rangeLow.toFixed(4)} rather than acceptance below it.`
      );
      reason.push(
        `That is the range-long condition: enter near ${potentialEntry.toFixed(4)}, first target the midpoint at ${midpoint.toFixed(4)}, second target the opposite boundary at ${rangeHigh.toFixed(4)}. Invalidated by a decisive close below ${invalidation.toFixed(4)} — a wick through the low is not enough to abandon it, a close is.`
      );
    } else {
      reason.push(
        `Price is at the lower boundary (${(pos * 100).toFixed(0)}% up the range) but no rejection has printed yet — no bullish reaction candle, no failed breakdown. Being at the low is a location, not a signal.`
      );
      reason.push(
        `Waiting for evidence the boundary is holding before the long is valid. If price instead closes decisively below ${rangeLow.toFixed(4)}, the range is breaking and the setup flips to a breakdown.`
      );
    }
  } else if (currentPosition === "Near High") {
    if (freshHighRejection) {
      rangeSetup = "Short";
      bias = "bearish";
      potentialEntry = rangeHigh - 0.3 * atr;
      target1 = midpoint;
      target2 = rangeLow;
      invalidation = rangeHigh + 1.2 * atr;
      reason.push(
        `Price is ${(pos * 100).toFixed(0)}% up the range, at the upper boundary, and the last few bars show a rejection off ${rangeHigh.toFixed(4)} rather than acceptance above it.`
      );
      reason.push(
        `That is the range-short condition: enter near ${potentialEntry.toFixed(4)}, first target the midpoint at ${midpoint.toFixed(4)}, second target the opposite boundary at ${rangeLow.toFixed(4)}. Invalidated by a decisive close above ${invalidation.toFixed(4)}.`
      );
    } else {
      reason.push(
        `Price is at the upper boundary (${(pos * 100).toFixed(0)}% up the range) but no rejection has printed yet. Being at the high is a location, not a signal.`
      );
      reason.push(
        `Waiting for evidence the boundary is capping before the short is valid. If price instead closes decisively above ${rangeHigh.toFixed(4)}, the range is breaking and the setup flips to a breakout.`
      );
    }
  } else if (currentPosition === "Outside") {
    reason.push(
      `Price is trading outside the structure at ${price.toFixed(4)} but the break is not yet confirmed (${breakout.stage.replace("_", " ")}). ${breakout.note}`
    );
    reason.push(
      `Nothing to do at the extremes of an unresolved break — either it confirms and becomes a breakout trade, or it fails and price returns inside, which is itself one of the highest-quality range entries.`
    );
  } else {
    reason.push(
      `Price sits ${(pos * 100).toFixed(0)}% up the range — mid-range, roughly ${Math.abs(price - midpoint) < 0.5 * atr ? "on" : "near"} the ${midpoint.toFixed(4)} midpoint.`
    );
    reason.push(
      `This is a low-quality location by definition: the stop is far from the entry in both directions and there is no boundary to lean on. No trade until price reaches ${rangeLow.toFixed(4)} or ${rangeHigh.toFixed(4)} and reacts.`
    );
  }

  /* ---------------- Supporting evidence in the narrative ---------------- */
  reason.push(
    `Structure: ${rangeLow.toFixed(4)} – ${rangeHigh.toFixed(4)} (${((height / midpoint) * 100).toFixed(2)}% wide, ${(height / atr).toFixed(1)} ATR) over ${candidate.bars} bars, with ${candidate.highTouches} touches of the high and ${candidate.lowTouches} of the low. ${(candidate.containment * 100).toFixed(0)}% of candle bodies closed inside the boundaries.`
  );
  if (candidate.traversals > 0) {
    reason.push(
      `Price has crossed the range end-to-end ${candidate.traversals} time(s), which is what makes the boundaries tradeable rather than incidental.`
    );
  }
  if (falseBreakHistory > 0) {
    reason.push(
      `${falseBreakHistory} failed breakout(s) recorded at the boundaries — price pushed through and closed back inside. Failed breaks are the strongest confirmation a range is real, and they raise confidence here.`
    );
  }

  /* ---------------- Confidence ---------------- */
  const touchScore = clamp((candidate.highTouches + candidate.lowTouches - 4) / 6, 0, 1);
  const containScore = clamp((candidate.containment - 0.7) / 0.25, 0, 1);
  const gateScore = candidate.passedCount / candidate.gates.length;
  const rejectionScore = freshLowRejection || freshHighRejection ? 1 : 0;
  const falseBreakScore = clamp(falseBreakHistory / 2, 0, 1);
  const raw =
    0.26 * touchScore +
    0.2 * containScore +
    0.24 * gateScore +
    0.16 * rejectionScore +
    0.14 * falseBreakScore;
  // Same tanh squash used across the platform: confluence approaches, never arrives.
  let confidence = Math.round(clamp(15 + Math.tanh(raw * 1.9) * 66, 5, 90));
  // A rejected range shouldn't advertise confidence in a setup it isn't giving.
  if (marketCondition === "Unclear") confidence = Math.round(confidence * 0.6);
  if (marketCondition === "Trending" && !rangeBroken) confidence = Math.round(confidence * 0.45);
  const confidenceLabel: RangeTradingResult["confidenceLabel"] =
    confidence >= 70 ? "Very High" : confidence >= 55 ? "High" : confidence >= 38 ? "Moderate" : "Low";

  return {
    marketCondition,
    rangeHigh,
    rangeLow,
    rangeMidpoint: midpoint,
    rangeWidthPct: Number(((height / midpoint) * 100).toFixed(3)),
    rangeBars: candidate.bars,
    highTouches: candidate.highTouches,
    lowTouches: candidate.lowTouches,
    containment: Number(candidate.containment.toFixed(3)),
    currentPosition,
    rangeSetup,
    bias,
    confidence,
    confidenceLabel,
    potentialEntry,
    target1,
    target2,
    invalidation,
    validation: candidate.gates,
    boundaryReactions: reactions.slice(-10),
    breakout,
    reason,
  };
}

/* ------------------------------------------------------------------ *
 * Range fitting
 * ------------------------------------------------------------------ */

/** Try several window lengths and keep the one with the strongest evidence. */
function bestCandidate(candles: Candle[], atr: number): RangeCandidate | null {
  let best: RangeCandidate | null = null;
  for (const w of WINDOWS) {
    if (w + 5 > candles.length) continue;
    const c = fitRange(candles, w, atr);
    if (!c) continue;
    if (
      !best ||
      c.passedCount > best.passedCount ||
      (c.passedCount === best.passedCount && c.score > best.score)
    ) {
      best = c;
    }
  }
  return best;
}

function fitRange(candles: Candle[], bars: number, atr: number): RangeCandidate | null {
  const offset = candles.length - bars;
  const win = candles.slice(offset);
  const swings = findSwings(win, 3, "minor");
  const swingHighs = swings.filter((s) => s.kind === "high");
  const swingLows = swings.filter((s) => s.kind === "low");
  if (swingHighs.length < 2 || swingLows.length < 2) return null;

  // Boundaries are the average of the swings clustered at each extreme, not
  // the single spike high/low — a range boundary is an area price agreed on.
  //
  // The reference span comes from swing structure rather than the window's raw
  // high/low on purpose. A breakout excursion sits far outside the range, and
  // if it set the reference then the range price actually respected could no
  // longer be fitted at all — a broken range would report "no structure"
  // instead of "broken", which is the one answer this engine must not lose.
  const swingPrices = [...swingHighs, ...swingLows].map((s) => s.price).sort((a, b) => a - b);
  const structureSpan = quantile(swingPrices, 0.9) - quantile(swingPrices, 0.1);
  if (structureSpan <= 0 && atr <= 0) return null;
  const band = Math.max(0.18 * structureSpan, 0.6 * atr);
  const topCluster = boundaryCluster(swingHighs, band, "high");
  const botCluster = boundaryCluster(swingLows, band, "low");
  if (topCluster.length === 0 || botCluster.length === 0) return null;

  const high = topCluster.reduce((s, p) => s + p.price, 0) / topCluster.length;
  const low = botCluster.reduce((s, p) => s + p.price, 0) / botCluster.length;
  const height = high - low;
  if (height <= 0) return null;

  const tol = Math.max(0.25 * atr, height * 0.04);
  const highTouches = win.filter((c) => c.high >= high - tol && c.high <= high + 2 * tol).length;
  const lowTouches = win.filter((c) => c.low <= low + tol && c.low >= low - 2 * tol).length;

  // Containment measured on BODIES: wicks outside a range are normal, closes
  // outside are not.
  const inside = win.filter(
    (c) => Math.max(c.open, c.close) <= high + tol && Math.min(c.open, c.close) >= low - tol
  ).length;
  const containment = inside / win.length;

  const fitH = fitLine(topCluster.map((s) => ({ x: s.index, y: s.price })));
  const fitL = fitLine(botCluster.map((s) => ({ x: s.index, y: s.price })));
  // Total drift of each boundary across the window, as a share of the height.
  const highSlopePct = Math.abs(fitH.slope * bars) / height;
  const lowSlopePct = Math.abs(fitL.slope * bars) / height;

  const drift = Math.abs(win[win.length - 1].close - win[0].open);
  const driftRatio = drift / height;

  // How many times price walked all the way from one boundary to the other.
  let traversals = 0;
  let lastEnd: 1 | -1 | 0 = 0;
  for (const c of win) {
    const atTop = c.high >= high - tol;
    const atBottom = c.low <= low + tol;
    if (atTop && lastEnd !== 1) {
      if (lastEnd === -1) traversals++;
      lastEnd = 1;
    } else if (atBottom && lastEnd !== -1) {
      if (lastEnd === 1) traversals++;
      lastEnd = -1;
    }
  }

  const gates = [
    {
      label: "Upper boundary respected",
      passed: highTouches >= 2 && topCluster.length >= 2,
      detail: `${highTouches} bar(s) reached ${high.toFixed(4)} across ${topCluster.length} distinct swing high(s) — needs ≥ 2 of each.`,
    },
    {
      label: "Lower boundary respected",
      passed: lowTouches >= 2 && botCluster.length >= 2,
      detail: `${lowTouches} bar(s) reached ${low.toFixed(4)} across ${botCluster.length} distinct swing low(s) — needs ≥ 2 of each.`,
    },
    {
      label: "Closes contained inside",
      passed: containment >= 0.75,
      detail: `${(containment * 100).toFixed(0)}% of candle bodies stayed between the boundaries — needs ≥ 75%.`,
    },
    {
      label: "Boundaries are horizontal",
      passed: highSlopePct <= 0.4 && lowSlopePct <= 0.4,
      detail: `Boundaries drift ${(highSlopePct * 100).toFixed(0)}% / ${(lowSlopePct * 100).toFixed(0)}% of the range height across the window — needs ≤ 40% each, otherwise it's a channel.`,
    },
    {
      label: "Range is wide enough to trade",
      passed: height >= 1.5 * atr,
      detail: `Height is ${(height / atr).toFixed(1)} ATR — needs ≥ 1.5 ATR for the boundaries to be far enough apart to matter.`,
    },
    {
      label: "No net trend across the window",
      passed: driftRatio <= 0.7,
      detail: `Price ended ${(driftRatio * 100).toFixed(0)}% of the range height away from where it started — needs ≤ 70%, otherwise this is a trend resting.`,
    },
    {
      label: "Price has worked both sides",
      passed: traversals >= 1,
      detail: `${traversals} full traversal(s) between the boundaries — needs ≥ 1 to show both edges are live.`,
    },
  ];
  const passedCount = gates.filter((g) => g.passed).length;

  return {
    bars,
    offset,
    high,
    low,
    height,
    highTouches,
    lowTouches,
    containment,
    highSlopePct,
    lowSlopePct,
    driftRatio,
    traversals,
    gates,
    passedCount,
    score: highTouches + lowTouches + containment * 8 + traversals * 3,
  };
}

/* ------------------------------------------------------------------ *
 * Boundary behaviour
 * ------------------------------------------------------------------ */

function collectReactions(
  candles: Candle[],
  cand: RangeCandidate,
  atr: number,
  tol: number
): RangeTradingResult["boundaryReactions"] {
  const out: RangeTradingResult["boundaryReactions"] = [];
  const { high, low } = cand;

  for (let i = cand.offset; i < candles.length; i++) {
    const c = candles[i];
    const range = Math.max(c.high - c.low, 1e-9);
    const bodyRatio = Math.abs(c.close - c.open) / range;

    /* --- upper boundary --- */
    if (c.close > high + tol) {
      if (bodyRatio >= 0.5 && c.close - high >= 0.5 * atr) {
        out.push({
          boundary: "high",
          time: c.time,
          kind: "decisive_close_outside",
          price: c.close,
          note: `Closed ${(c.close - high).toFixed(4)} above the range high on a ${(bodyRatio * 100).toFixed(0)}%-body candle — acceptance above the boundary, not a probe.`,
        });
      }
    } else if (c.high > high + 0.3 * atr) {
      out.push({
        boundary: "high",
        time: c.time,
        kind: "failed_breakout",
        price: c.high,
        note: `Pushed ${(c.high - high).toFixed(4)} above the range high at ${high.toFixed(4)} and closed back inside at ${c.close.toFixed(4)} — a failed breakout, which strengthens the boundary.`,
      });
    } else if (c.high >= high - tol && c.close < high - 0.3 * atr && c.high - Math.max(c.open, c.close) > Math.abs(c.close - c.open)) {
      out.push({
        boundary: "high",
        time: c.time,
        kind: "rejection",
        price: c.high,
        note: `Tagged ${high.toFixed(4)} and closed ${(high - c.close).toFixed(4)} lower with the wick above the body — sellers defended the boundary.`,
      });
    }

    /* --- lower boundary --- */
    if (c.close < low - tol) {
      if (bodyRatio >= 0.5 && low - c.close >= 0.5 * atr) {
        out.push({
          boundary: "low",
          time: c.time,
          kind: "decisive_close_outside",
          price: c.close,
          note: `Closed ${(low - c.close).toFixed(4)} below the range low on a ${(bodyRatio * 100).toFixed(0)}%-body candle — acceptance below the boundary, not a probe.`,
        });
      }
    } else if (c.low < low - 0.3 * atr) {
      out.push({
        boundary: "low",
        time: c.time,
        kind: "failed_breakout",
        price: c.low,
        note: `Pushed ${(low - c.low).toFixed(4)} below the range low at ${low.toFixed(4)} and closed back inside at ${c.close.toFixed(4)} — a failed breakdown, which strengthens the boundary.`,
      });
    } else if (c.low <= low + tol && c.close > low + 0.3 * atr && Math.min(c.open, c.close) - c.low > Math.abs(c.close - c.open)) {
      out.push({
        boundary: "low",
        time: c.time,
        kind: "rejection",
        price: c.low,
        note: `Tagged ${low.toFixed(4)} and closed ${(c.close - low).toFixed(4)} higher with the wick below the body — buyers defended the boundary.`,
      });
    }
  }

  return out;
}

/**
 * Where the current excursion outside the range stands.
 *
 * `attempt` is deliberately the default for anything not yet proven: a single
 * close outside is a claim, not a confirmation.
 */
function classifyBreakout(
  candles: Candle[],
  cand: RangeCandidate,
  atr: number,
  tol: number
): RangeTradingResult["breakout"] {
  const { high, low } = cand;
  const sideOf = (close: number): -1 | 0 | 1 =>
    close > high + tol ? 1 : close < low - tol ? -1 : 0;

  // Find the start of the most recent run of closes outside the boundaries.
  let runStart = -1;
  for (let i = candles.length - 1; i >= cand.offset; i--) {
    if (sideOf(candles[i].close) === 0) break;
    runStart = i;
  }

  if (runStart === -1) {
    // Nothing outside right now — was there a rejected attempt just before?
    let lastOutside = -1;
    for (let i = candles.length - 1; i >= cand.offset; i--) {
      if (sideOf(candles[i].close) !== 0) {
        lastOutside = i;
        break;
      }
    }
    if (lastOutside >= 0 && candles.length - 1 - lastOutside <= RESOLUTION_BARS) {
      const dir = sideOf(candles[lastOutside].close) === 1 ? "up" : "down";
      return {
        active: false,
        direction: dir,
        stage: "false_breakout",
        note: `Price closed ${dir === "up" ? "above" : "below"} the boundary ${candles.length - 1 - lastOutside} bar(s) ago and has already closed back inside — a false breakout. Failed breaks like this are the range reasserting itself.`,
      };
    }
    return {
      active: false,
      direction: null,
      stage: "none",
      note: `All recent closes are inside ${low.toFixed(4)} – ${high.toFixed(4)}; no breakout attempt in progress.`,
    };
  }

  const dirNum = sideOf(candles[runStart].close);
  const direction: "up" | "down" = dirNum === 1 ? "up" : "down";
  const boundary = direction === "up" ? high : low;
  const first = candles[runStart];
  const range = Math.max(first.high - first.low, 1e-9);
  const bodyRatio = Math.abs(first.close - first.open) / range;
  const penetration = Math.abs(first.close - boundary) / Math.max(atr, 1e-9);
  const decisive = bodyRatio >= 0.5 && penetration >= 0.5;
  const runLength = candles.length - runStart;
  const priceNow = candles[candles.length - 1].close;
  // Pulled back to within a tolerance of the boundary but still holding outside.
  const retesting = runLength >= 3 && Math.abs(priceNow - boundary) <= 1.2 * tol;

  if (decisive && runLength >= 2 && retesting) {
    return {
      active: true,
      direction,
      stage: "retest",
      note: `A decisive close ${direction === "up" ? "above" : "below"} ${boundary.toFixed(4)} (${penetration.toFixed(2)} ATR, ${(bodyRatio * 100).toFixed(0)}% body) is now being retested from the outside at ${priceNow.toFixed(4)}. A hold here is the continuation entry; a close back inside turns it into a false break.`,
    };
  }
  if (decisive && runLength >= 2) {
    return {
      active: true,
      direction,
      stage: "confirmed",
      note: `${runLength} consecutive closes ${direction === "up" ? "above" : "below"} ${boundary.toFixed(4)}, opened by a decisive candle (${penetration.toFixed(2)} ATR beyond, ${(bodyRatio * 100).toFixed(0)}% body) — the range has broken.`,
    };
  }
  return {
    active: true,
    direction,
    stage: "attempt",
    note: `Price is ${direction === "up" ? "above" : "below"} ${boundary.toFixed(4)} for ${runLength} bar(s) but the break is unproven — ${
      !decisive
        ? `the breaking candle was not decisive (${penetration.toFixed(2)} ATR beyond, ${(bodyRatio * 100).toFixed(0)}% body)`
        : `only ${runLength} close has held so far`
    }. Treated as an attempt, not a breakout.`,
  };
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * The outermost group of swings that has company, walking inward.
 *
 * "Has company" is the whole point: a boundary is a price other swings agreed
 * on. A single excursion — the spike of a breakout, or one stop run — is one
 * swing on its own and gets skipped, so the boundary stays where price
 * actually turned repeatedly. If nothing has company the extreme swing is
 * returned alone and the ≥ 2 touches gate fails honestly.
 */
function boundaryCluster(
  swings: { index: number; price: number }[],
  band: number,
  side: "high" | "low"
): { index: number; price: number }[] {
  const sorted = [...swings].sort((a, b) => (side === "high" ? b.price - a.price : a.price - b.price));
  let fallback: { index: number; price: number }[] = [];
  for (const anchor of sorted) {
    // Strictly within the band on both sides, so a spike above the anchor
    // cannot drag the average out with it.
    const members = sorted.filter((s) => Math.abs(s.price - anchor.price) <= band);
    if (fallback.length === 0) fallback = members;
    if (members.length >= 2) return members;
  }
  return fallback;
}

/** Linear-interpolated quantile over an ascending-sorted array. */
function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const pos = clamp(q, 0, 1) * (sortedAsc.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

function fitLine(pts: { x: number; y: number }[]): { slope: number; intercept: number } {  const n = pts.length;
  const sx = pts.reduce((s, p) => s + p.x, 0);
  const sy = pts.reduce((s, p) => s + p.y, 0);
  const sxx = pts.reduce((s, p) => s + p.x * p.x, 0);
  const sxy = pts.reduce((s, p) => s + p.x * p.y, 0);
  const d = n * sxx - sx * sx;
  if (Math.abs(d) < 1e-12) return { slope: 0, intercept: sy / n };
  const slope = (n * sxy - sx * sy) / d;
  return { slope, intercept: (sy - slope * sx) / n };
}

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

function emptyResult(why: string): RangeTradingResult {
  return {
    marketCondition: "Unclear",
    rangeHigh: null,
    rangeLow: null,
    rangeMidpoint: null,
    rangeWidthPct: null,
    rangeBars: 0,
    highTouches: 0,
    lowTouches: 0,
    containment: 0,
    currentPosition: "Mid Range",
    rangeSetup: "No Trade",
    bias: "neutral",
    confidence: 5,
    confidenceLabel: "Low",
    potentialEntry: null,
    target1: null,
    target2: null,
    invalidation: null,
    validation: [{ label: "Range detectable", passed: false, detail: why }],
    boundaryReactions: [],
    breakout: { active: false, direction: null, stage: "none", note: "No range to break." },
    reason: [why],
  };
}
