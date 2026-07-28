import {
  Bias,
  Candle,
  MarketStructureResult,
  StructureEvent,
  SwingPoint,
} from "./types";

/**
 * Detect fractal swing points. A swing high is a candle whose high is the
 * highest within `lookback` candles on both sides (symmetric fractal).
 */
export function findSwings(
  candles: Candle[],
  lookback: number,
  degree: "major" | "minor"
): SwingPoint[] {
  const swings: SwingPoint[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= c.high) isHigh = false;
      if (candles[j].low <= c.low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) swings.push({ index: i, time: c.time, price: c.high, kind: "high", degree });
    if (isLow) swings.push({ index: i, time: c.time, price: c.low, kind: "low", degree });
  }
  return swings.sort((a, b) => a.index - b.index);
}

/** Label swings HH/HL/LH/LL relative to the previous swing of the same kind. */
function labelSwings(swings: SwingPoint[], tolerance: number): void {
  let prevHigh: SwingPoint | undefined;
  let prevLow: SwingPoint | undefined;
  for (const s of swings) {
    if (s.kind === "high") {
      if (prevHigh) {
        const diff = (s.price - prevHigh.price) / prevHigh.price;
        s.label = Math.abs(diff) <= tolerance ? "EQH" : diff > 0 ? "HH" : "LH";
      }
      prevHigh = s;
    } else {
      if (prevLow) {
        const diff = (s.price - prevLow.price) / prevLow.price;
        s.label = Math.abs(diff) <= tolerance ? "EQL" : diff > 0 ? "HL" : "LL";
      }
      prevLow = s;
    }
  }
}

/**
 * Walk the candles chronologically detecting BOS (break of structure in trend
 * direction) and CHOCH (change of character — first break against the
 * prevailing trend). Uses candle CLOSES beyond the swing level, which filters
 * pure liquidity wicks (those are handled by the liquidity engine).
 */
function detectEvents(
  candles: Candle[],
  swings: SwingPoint[],
  scope: "internal" | "external"
): { events: StructureEvent[]; trend: Bias } {
  const events: StructureEvent[] = [];
  let trend: Bias = "neutral";
  let lastBrokenHigh: SwingPoint | undefined;
  let lastBrokenLow: SwingPoint | undefined;

  const highs = swings.filter((s) => s.kind === "high");
  const lows = swings.filter((s) => s.kind === "low");
  let hi = 0;
  let li = 0;
  let activeHigh: SwingPoint | undefined;
  let activeLow: SwingPoint | undefined;

  for (let i = 0; i < candles.length; i++) {
    // Activate swings once price action has moved past their formation window.
    while (hi < highs.length && highs[hi].index < i) {
      activeHigh = highs[hi];
      hi++;
    }
    while (li < lows.length && lows[li].index < i) {
      activeLow = lows[li];
      li++;
    }
    const c = candles[i];

    if (activeHigh && c.close > activeHigh.price && activeHigh !== lastBrokenHigh) {
      const type = trend === "bearish" ? "CHOCH" : "BOS";
      events.push({
        type,
        scope,
        direction: "bullish",
        time: c.time,
        price: activeHigh.price,
        brokenSwingTime: activeHigh.time,
      });
      trend = "bullish";
      lastBrokenHigh = activeHigh;
    }
    if (activeLow && c.close < activeLow.price && activeLow !== lastBrokenLow) {
      const type = trend === "bullish" ? "CHOCH" : "BOS";
      events.push({
        type,
        scope,
        direction: "bearish",
        time: c.time,
        price: activeLow.price,
        brokenSwingTime: activeLow.time,
      });
      trend = "bearish";
      lastBrokenLow = activeLow;
    }
  }
  return { events, trend };
}

export interface StructureOptions {
  majorLookback?: number;
  minorLookback?: number;
  equalTolerance?: number;
}

export function analyzeMarketStructure(
  candles: Candle[],
  opts: StructureOptions = {}
): MarketStructureResult {
  const majorLookback = opts.majorLookback ?? 8;
  const minorLookback = opts.minorLookback ?? 3;
  const tolerance = opts.equalTolerance ?? 0.0015;

  const majorSwings = findSwings(candles, majorLookback, "major");
  const minorSwings = findSwings(candles, minorLookback, "minor");
  labelSwings(majorSwings, tolerance);
  labelSwings(minorSwings, tolerance);

  const external = detectEvents(candles, majorSwings, "external");
  const internal = detectEvents(candles, minorSwings, "internal");
  const events = [...external.events, ...internal.events].sort((a, b) => a.time - b.time);

  const lastHigherHigh = [...majorSwings].reverse().find((s) => s.label === "HH");
  const lastHigherLow = [...majorSwings].reverse().find((s) => s.label === "HL");
  const lastLowerHigh = [...majorSwings].reverse().find((s) => s.label === "LH");
  const lastLowerLow = [...majorSwings].reverse().find((s) => s.label === "LL");

  // Range detection: recent major swings confined within a tight band.
  const recentSwings = majorSwings.slice(-6);
  let isRange = false;
  if (recentSwings.length >= 4) {
    const highsArr = recentSwings.filter((s) => s.kind === "high").map((s) => s.price);
    const lowsArr = recentSwings.filter((s) => s.kind === "low").map((s) => s.price);
    if (highsArr.length >= 2 && lowsArr.length >= 2) {
      const highSpread = (Math.max(...highsArr) - Math.min(...highsArr)) / Math.max(...highsArr);
      const lowSpread = (Math.max(...lowsArr) - Math.min(...lowsArr)) / Math.max(...lowsArr);
      isRange = highSpread < 0.01 && lowSpread < 0.01;
    }
  }

  // Reversal vs continuation probability from event history.
  const recentEvents = events.slice(-8);
  const chochCount = recentEvents.filter((e) => e.type === "CHOCH").length;
  const alignedBos = recentEvents.filter(
    (e) => e.type === "BOS" && e.direction === external.trend
  ).length;
  let reversalProbability = 30 + chochCount * 12 - alignedBos * 6;
  reversalProbability = Math.min(85, Math.max(10, reversalProbability));
  const continuationProbability = 100 - reversalProbability;

  const summary: string[] = [];
  if (external.trend === "bullish") summary.push("External market structure is bullish — price is printing higher highs and higher lows.");
  else if (external.trend === "bearish") summary.push("External market structure is bearish — price is printing lower highs and lower lows.");
  else summary.push("No decisive external structure yet — price is balancing.");
  if (internal.trend !== external.trend && internal.trend !== "neutral") {
    summary.push(`Internal structure has shifted ${internal.trend} against the external trend — early warning of a possible reversal.`);
  }
  if (isRange) summary.push("Price is compressing inside a range; expect liquidity engineering at both extremes.");
  const lastEvent = events[events.length - 1];
  if (lastEvent) {
    summary.push(
      `Most recent structure event: ${lastEvent.scope} ${lastEvent.type} to the ${lastEvent.direction} side at ${lastEvent.price.toFixed(4)}.`
    );
  }

  return {
    swings: [...majorSwings, ...minorSwings.filter((m) => !majorSwings.some((M) => M.index === m.index && M.kind === m.kind))],
    events,
    trend: external.trend,
    internalTrend: internal.trend,
    isRange,
    lastHigherHigh,
    lastHigherLow,
    lastLowerHigh,
    lastLowerLow,
    reversalProbability,
    continuationProbability,
    summary,
  };
}
