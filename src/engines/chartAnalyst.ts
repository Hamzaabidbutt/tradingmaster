import { detectCandlePatterns } from "./candlestick";
import { findSwings } from "./marketStructure";
import {
  Bias,
  Candle,
  ChartAnalystResult,
  ChartShape,
  HistoricalAnalogue,
  SwingPoint,
} from "./types";

/**
 * Chart Analyst — the chart, and nothing but the chart.
 *
 * Every other module in this platform reasons about order flow, liquidity,
 * liquidations or indicators. This one deliberately does not. It reads the
 * screen the way a discretionary trader does:
 *   • what shape is price drawing right now (candlesticks + geometry)
 *   • when has the chart looked like this before
 *   • what happened next on those occasions
 *
 * The historical match is a normalized analogue search: the current window
 * is z-scored so the comparison is scale- and price-level-independent, then
 * slid across deep history. Each match's ACTUAL forward return is measured,
 * so the expected next move is a distribution of outcomes rather than an
 * assertion. Confidence falls when those outcomes disagree.
 *
 * Inputs are candles only. That is the whole point — no indicators, no news,
 * no order book, no funding, no liquidity data.
 */

/** Bars of recent action used to define the current shape. */
const SHAPE_BARS = 70;
/** Analogues considered after overlap-deduplication. */
const TOP_K = 8;

export function analyzeChart(
  candles: Candle[],
  deepCandles?: Candle[] | null
): ChartAnalystResult {
  const price = candles[candles.length - 1]?.close ?? 0;
  // Prefer the deep series when it actually adds history.
  const history =
    deepCandles && deepCandles.length > candles.length ? deepCandles : candles;

  // Query window: long enough to have a shape, short enough to be "now".
  const windowBars = clamp(Math.floor(candles.length / 8), 12, 30);

  if (candles.length < 30) return emptyResult(price, windowBars, history.length);

  const atr = averageTrueRange(candles.slice(-Math.min(100, candles.length)));

  /* ---------------- 1. What the chart is drawing now ---------------- */
  const candlestick = detectCandlePatterns(candles, 15);
  const shapes = detectChartShapes(candles, atr);
  const priceAction = describePriceAction(candles, atr);

  /* ---------------- 2. When has it looked like this before ---------------- */
  const horizonBars = Math.max(5, Math.round(windowBars / 2));
  const matches = findAnalogues(candles, history, windowBars, horizonBars);

  /* ---------------- 3. What happened next ---------------- */
  const forwards = matches.map((m) => m.forwardReturnPct);
  const medianForward = median(forwards);
  const upCount = matches.filter((m) => m.forwardDirection === "bullish").length;
  const downCount = matches.filter((m) => m.forwardDirection === "bearish").length;
  const decided = upCount + downCount;
  // Agreement among the analogues that actually moved. 0.5 = a coin flip.
  const agreement = decided > 0 ? Math.max(upCount, downCount) / decided : 0.5;
  const avgSimilarity =
    matches.length > 0 ? matches.reduce((s, m) => s + m.similarity, 0) / matches.length : 0;

  // A direction is only claimed when the analogues broadly agree on one.
  let direction: Bias = "neutral";
  if (matches.length >= 3 && agreement >= 0.6) {
    if (medianForward > 0 && upCount > downCount) direction = "bullish";
    else if (medianForward < 0 && downCount > upCount) direction = "bearish";
  }

  // Typical adverse excursion of the analogues sets a realistic invalidation.
  const medianMaxUp = median(matches.map((m) => m.maxUpPct));
  const medianMaxDown = median(matches.map((m) => m.maxDownPct));
  // With no direction claimed there is nothing to aim at and nothing to be
  // wrong about, so both are null rather than the current price — a target
  // equal to spot reads as a broken number, not as an abstention.
  const target =
    direction === "bearish"
      ? price * (1 + Math.min(medianForward, 0) / 100)
      : direction === "bullish"
        ? price * (1 + Math.max(medianForward, 0) / 100)
        : null;
  const invalidation =
    direction === "bullish"
      ? price * (1 + Math.min(medianMaxDown, -0.1) / 100)
      : direction === "bearish"
        ? price * (1 + Math.max(medianMaxUp, 0.1) / 100)
        : null;

  /* ---------------- Confidence ---------------- */
  const leadShape = shapes[0];
  const simScore = clamp((avgSimilarity - 30) / 45, 0, 1);
  const agreeScore = clamp((agreement - 0.5) * 2, 0, 1);
  const patternScore = leadShape ? leadShape.strength / 100 : 0.25;
  const sampleScore = clamp(matches.length / TOP_K, 0, 1);
  const raw =
    0.4 * simScore + 0.35 * agreeScore + 0.15 * patternScore + 0.1 * sampleScore;
  // tanh squash: stacked evidence gets you closer to certain, never there.
  const confidence = Math.round(clamp(18 + Math.tanh(raw * 1.7) * 62, 5, 88));
  const confidenceLabel: ChartAnalystResult["confidenceLabel"] =
    confidence >= 70 ? "Very High" : confidence >= 55 ? "High" : confidence >= 38 ? "Moderate" : "Low";

  /* ---------------- Scenarios ---------------- */
  const recent = candles.slice(-SHAPE_BARS);
  const swingHigh = Math.max(...recent.map((c) => c.high));
  const swingLow = Math.min(...recent.map((c) => c.low));
  const bullTrigger = leadShape && leadShape.upperBoundary > price ? leadShape.upperBoundary : swingHigh;
  const bearTrigger = leadShape && leadShape.lowerBoundary < price ? leadShape.lowerBoundary : swingLow;
  const bullMeasured =
    leadShape && leadShape.direction === "bullish"
      ? leadShape.measuredTarget
      : bullTrigger + (swingHigh - swingLow) * 0.6;
  const bearMeasured =
    leadShape && leadShape.direction === "bearish"
      ? leadShape.measuredTarget
      : bearTrigger - (swingHigh - swingLow) * 0.6;

  // Probabilities come from the analogue outcomes, so they sum to 100.
  const bullProbability =
    decided > 0 ? Math.round((upCount / decided) * 100) : 50;
  const bearProbability = 100 - bullProbability;

  const bullishScenario = {
    trigger: `Accepted close above ${bullTrigger.toFixed(4)}`,
    target: bullMeasured,
    probability: bullProbability,
    note: leadShape && leadShape.direction === "bullish"
      ? `${leadShape.name} resolves the way it conventionally does: a close above ${bullTrigger.toFixed(4)} projects the formation's height to roughly ${bullMeasured.toFixed(4)}.`
      : `A close above ${bullTrigger.toFixed(4)} takes out the recent structure high and opens the measured move toward ${bullMeasured.toFixed(4)}. ${upCount} of the ${matches.length} closest historical analogues resolved upward.`,
  };
  const bearishScenario = {
    trigger: `Accepted close below ${bearTrigger.toFixed(4)}`,
    target: bearMeasured,
    probability: bearProbability,
    note: leadShape && leadShape.direction === "bearish"
      ? `${leadShape.name} resolves the way it conventionally does: a close below ${bearTrigger.toFixed(4)} projects the formation's height to roughly ${bearMeasured.toFixed(4)}.`
      : `A close below ${bearTrigger.toFixed(4)} breaks the recent structure low and opens the measured move toward ${bearMeasured.toFixed(4)}. ${downCount} of the ${matches.length} closest historical analogues resolved downward.`,
  };

  /* ---------------- Narrative ---------------- */
  const headline = leadShape
    ? `${leadShape.name} — ${leadShape.maturity >= 70 ? "mature" : leadShape.maturity >= 40 ? "developing" : "early"} formation`
    : candlestick.length > 0
      ? `${candlestick[candlestick.length - 1].name} into ${describeTrendWord(candles)}`
      : describeTrendWord(candles);

  const rationale: string[] = [];
  if (matches.length > 0) {
    rationale.push(
      `The ${windowBars}-bar shape currently on screen has ${matches.length} close analogue(s) in the last ${history.length} bars, averaging ${avgSimilarity.toFixed(0)}/100 similarity.`
    );
    rationale.push(
      `${upCount} of them resolved higher and ${downCount} lower over the following ${horizonBars} bars; the median outcome was ${medianForward >= 0 ? "+" : ""}${medianForward.toFixed(2)}%.`
    );
    rationale.push(
      `Typical excursion after those matches: ${medianMaxUp >= 0 ? "+" : ""}${medianMaxUp.toFixed(2)}% up and ${medianMaxDown.toFixed(2)}% down.${
        direction === "neutral"
          ? " The analogues are too evenly split to point either way, so no target or invalidation is projected from them."
          : " That is where the target and invalidation come from."
      }`
    );
  } else {
    rationale.push(
      `No sufficiently similar shape was found in the ${history.length} bars of history available, so there is no precedent to lean on here.`
    );
  }
  if (leadShape) rationale.push(leadShape.note);

  const patternExplanation: string[] = [];
  if (leadShape) {
    patternExplanation.push(
      `Price is drawing a ${leadShape.name.toLowerCase()} between ${leadShape.lowerBoundary.toFixed(4)} and ${leadShape.upperBoundary.toFixed(4)}. ${leadShape.note}`
    );
  } else {
    patternExplanation.push(
      `No clean geometric formation is present — the boundaries drawn over recent swings do not converge or run parallel tightly enough to call a pattern. Reading this purely as price action instead.`
    );
  }
  patternExplanation.push(...priceAction);
  if (candlestick.length > 0) {
    const last = candlestick[candlestick.length - 1];
    patternExplanation.push(
      `Most recent candlestick signal: ${last.name} (${last.direction}) — ${last.context}`
    );
  }
  if (matches.length > 0) {
    const best = matches[0];
    patternExplanation.push(
      `The closest historical match (${best.similarity.toFixed(0)}/100) began ${new Date(best.startTime * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC and went ${best.forwardReturnPct >= 0 ? "+" : ""}${best.forwardReturnPct.toFixed(2)}% over the next ${horizonBars} bars.`
    );
  }
  if (direction === "neutral") {
    patternExplanation.push(
      matches.length < 3
        ? `Too few analogues to call a direction honestly — treat this as a no-read rather than a neutral forecast.`
        : `The analogues split roughly evenly (${upCount} up / ${downCount} down), so the chart alone does not justify a directional call here.`
    );
  }

  return {
    windowBars,
    historyBars: history.length,
    currentPattern: { headline, candlestick, shapes, priceAction },
    historicalMatches: matches,
    expectedNextMove: {
      direction,
      magnitudePct: Number(medianForward.toFixed(3)),
      target,
      invalidation,
      horizonBars,
      rationale,
    },
    bullishScenario,
    bearishScenario,
    confidence,
    confidenceLabel,
    patternExplanation,
  };
}

/* ------------------------------------------------------------------ *
 * Analogue search
 * ------------------------------------------------------------------ */

/**
 * Slide the current window across history looking for the same shape.
 *
 * Closes are z-scored per window so a $0.30 move on UNI and a $300 move on
 * BTC compare on equal terms; highs/lows are normalized with the SAME
 * mean/std so wick structure is compared too, at a lower weight.
 */
function findAnalogues(
  candles: Candle[],
  history: Candle[],
  windowBars: number,
  horizonBars: number
): HistoricalAnalogue[] {
  const query = candles.slice(-windowBars);
  if (query.length < windowBars) return [];

  const qNorm = normalizeWindow(query);
  if (!qNorm) return [];

  // A candidate needs forward bars to measure, and must not overlap the
  // query window — an overlapping window matches itself trivially.
  const maxStart = Math.min(
    history.length - windowBars - horizonBars,
    history.length - 2 * windowBars
  );
  if (maxStart < 0) return [];

  const scored: (HistoricalAnalogue & { distance: number })[] = [];
  for (let s = 0; s <= maxStart; s++) {
    const cand = history.slice(s, s + windowBars);
    const cNorm = normalizeWindow(cand);
    if (!cNorm) continue;

    let closeSq = 0;
    let rangeSq = 0;
    for (let i = 0; i < windowBars; i++) {
      const dc = qNorm.closes[i] - cNorm.closes[i];
      closeSq += dc * dc;
      const dh = qNorm.highs[i] - cNorm.highs[i];
      const dl = qNorm.lows[i] - cNorm.lows[i];
      rangeSq += dh * dh + dl * dl;
    }
    const closeRmse = Math.sqrt(closeSq / windowBars);
    const rangeRmse = Math.sqrt(rangeSq / (windowBars * 2));
    const distance = closeRmse + 0.35 * rangeRmse;

    const anchor = history[s + windowBars - 1].close;
    const exit = history[s + windowBars - 1 + horizonBars].close;
    const forward = history.slice(s + windowBars, s + windowBars + horizonBars);
    const forwardReturnPct = ((exit - anchor) / anchor) * 100;
    const maxUpPct = forward.length
      ? ((Math.max(...forward.map((c) => c.high)) - anchor) / anchor) * 100
      : 0;
    const maxDownPct = forward.length
      ? ((Math.min(...forward.map((c) => c.low)) - anchor) / anchor) * 100
      : 0;

    scored.push({
      distance,
      startIndex: s,
      startTime: history[s].time,
      endTime: history[s + windowBars - 1].time,
      similarity: Math.round(100 * Math.exp(-distance)),
      forwardReturnPct: Number(forwardReturnPct.toFixed(3)),
      forwardDirection:
        forwardReturnPct > 0.05 ? "bullish" : forwardReturnPct < -0.05 ? "bearish" : "neutral",
      maxUpPct: Number(maxUpPct.toFixed(3)),
      maxDownPct: Number(maxDownPct.toFixed(3)),
      note: "",
    });
  }

  scored.sort((a, b) => a.distance - b.distance);

  // Neighbouring start indices describe the same stretch of chart. Keep the
  // best of each cluster so K matches means K independent precedents.
  const picked: (HistoricalAnalogue & { distance: number })[] = [];
  const minGap = Math.max(2, Math.floor(windowBars / 2));
  for (const m of scored) {
    if (picked.length >= TOP_K) break;
    if (picked.some((p) => Math.abs(p.startIndex - m.startIndex) < minGap)) continue;
    // Below ~35/100 the "match" is noise; better to return fewer.
    if (m.similarity < 35) continue;
    picked.push(m);
  }

  return picked.map((m) => ({
    startIndex: m.startIndex,
    startTime: m.startTime,
    endTime: m.endTime,
    similarity: m.similarity,
    forwardReturnPct: m.forwardReturnPct,
    forwardDirection: m.forwardDirection,
    maxUpPct: m.maxUpPct,
    maxDownPct: m.maxDownPct,
    note: `${m.similarity}/100 similar; resolved ${m.forwardReturnPct >= 0 ? "+" : ""}${m.forwardReturnPct.toFixed(2)}% over the next ${horizonBars} bars (peak ${m.maxUpPct >= 0 ? "+" : ""}${m.maxUpPct.toFixed(2)}%, trough ${m.maxDownPct.toFixed(2)}%).`,
  }));
}

/** Z-score a window's closes, and normalize its highs/lows on the same scale. */
function normalizeWindow(
  win: Candle[]
): { closes: number[]; highs: number[]; lows: number[] } | null {
  const n = win.length;
  const mean = win.reduce((s, c) => s + c.close, 0) / n;
  const variance = win.reduce((s, c) => s + (c.close - mean) ** 2, 0) / n;
  const sd = Math.sqrt(variance);
  // A perfectly flat window has no shape to compare.
  if (!Number.isFinite(sd) || sd < 1e-9) return null;
  return {
    closes: win.map((c) => (c.close - mean) / sd),
    highs: win.map((c) => (c.high - mean) / sd),
    lows: win.map((c) => (c.low - mean) / sd),
  };
}

/* ------------------------------------------------------------------ *
 * Geometry: trendline formations over recent swings
 * ------------------------------------------------------------------ */

function detectChartShapes(candles: Candle[], atr: number): ChartShape[] {
  const window = candles.slice(-Math.min(SHAPE_BARS, candles.length));
  if (window.length < 25) return [];
  const offset = candles.length - window.length;

  const swings = findSwings(window, 3, "minor");
  const highs = swings.filter((s) => s.kind === "high");
  const lows = swings.filter((s) => s.kind === "low");
  const shapes: ChartShape[] = [];

  const price = window[window.length - 1].close;
  const lastX = window.length - 1;

  if (highs.length >= 2 && lows.length >= 2) {
    const fitH = fitLine(highs.map((s) => ({ x: s.index, y: s.price })));
    const fitL = fitLine(lows.map((s) => ({ x: s.index, y: s.price })));
    const upper = fitH.slope * lastX + fitH.intercept;
    const lower = fitL.slope * lastX + fitL.intercept;
    const height = upper - lower;

    if (height > 0) {
      // "Flat" means the boundary drifts less than an eighth of an ATR per bar.
      const flat = 0.12 * atr;
      const firstX = Math.min(highs[0].index, lows[0].index);
      const startHeight =
        fitH.slope * firstX + fitH.intercept - (fitL.slope * firstX + fitL.intercept);
      const gapSlope = fitH.slope - fitL.slope;
      const converging = gapSlope < 0 && startHeight > 0 && height / startHeight < 0.72;

      const risingH = fitH.slope > flat;
      const fallingH = fitH.slope < -flat;
      const risingL = fitL.slope > flat;
      const fallingL = fitL.slope < -flat;

      let kind: ChartShape["kind"] | null = null;
      let direction: Bias = "neutral";
      if (!risingH && !fallingH && risingL) {
        kind = "ascending_triangle";
        direction = "bullish";
      } else if (fallingH && !risingL && !fallingL) {
        kind = "descending_triangle";
        direction = "bearish";
      } else if (fallingH && risingL) {
        kind = "symmetrical_triangle";
        direction = priorTrend(candles);
      } else if (risingH && risingL) {
        kind = converging ? "rising_wedge" : "ascending_channel";
        direction = converging ? "bearish" : "bullish";
      } else if (fallingH && fallingL) {
        kind = converging ? "falling_wedge" : "descending_channel";
        direction = converging ? "bullish" : "bearish";
      } else if (!risingH && !fallingH && !risingL && !fallingL) {
        kind = "rectangle";
        direction = "neutral";
      }

      if (kind) {
        // A tight consolidation right after a strong impulse is a flag.
        const impulse = impulseBefore(candles, offset, atr);
        if (
          (kind === "descending_channel" || kind === "rectangle") &&
          impulse === "bullish"
        ) {
          kind = "bull_flag";
          direction = "bullish";
        } else if (
          (kind === "ascending_channel" || kind === "rectangle") &&
          impulse === "bearish"
        ) {
          kind = "bear_flag";
          direction = "bearish";
        }

        const touches = highs.length + lows.length;
        const residual =
          (meanAbsResidual(highs, fitH) + meanAbsResidual(lows, fitL)) / 2;
        const quality = clamp(1 - residual / Math.max(atr, 1e-9), 0, 1);
        const maturity = Math.round(
          clamp(
            converging
              ? (1 - height / Math.max(startHeight, 1e-9)) * 130
              : (window.length / SHAPE_BARS) * 100,
            5,
            100
          )
        );
        const strength = Math.round(
          clamp(30 + touches * 5 + quality * 32 + maturity * 0.12, 0, 100)
        );
        const measuredTarget =
          direction === "bullish" ? upper + height : direction === "bearish" ? lower - height : price;

        shapes.push({
          name: SHAPE_NAMES[kind],
          kind,
          direction,
          maturity,
          strength,
          upperBoundary: upper,
          lowerBoundary: lower,
          measuredTarget,
          startTime: window[Math.max(0, firstX)].time,
          note: shapeNote(kind, upper, lower, measuredTarget, touches, maturity),
        });
      }
    }
  }

  const reversal = detectReversalShapes(window, highs, lows, atr);
  shapes.push(...reversal);

  return shapes.sort((a, b) => b.strength - a.strength).slice(0, 3);
}

/** Head & shoulders and double top/bottom, read off the swing sequence. */
function detectReversalShapes(
  window: Candle[],
  highs: SwingPoint[],
  lows: SwingPoint[],
  atr: number
): ChartShape[] {
  const out: ChartShape[] = [];
  const tolerance = 1.2 * atr;

  if (highs.length >= 3 && lows.length >= 2) {
    const [a, b, c] = highs.slice(-3);
    const between = lows.filter((l) => l.index > a.index && l.index < c.index);
    if (b.price > a.price && b.price > c.price && Math.abs(a.price - c.price) < tolerance && between.length >= 2) {
      const neckline = between.reduce((s, l) => s + l.price, 0) / between.length;
      const height = b.price - neckline;
      out.push({
        name: "Head & Shoulders",
        kind: "head_and_shoulders",
        direction: "bearish",
        maturity: window[window.length - 1].close < neckline ? 100 : 70,
        strength: Math.round(clamp(58 + (height / Math.max(atr, 1e-9)) * 4, 0, 92)),
        upperBoundary: b.price,
        lowerBoundary: neckline,
        measuredTarget: neckline - height,
        startTime: a.time,
        note: `Two shoulders at ${a.price.toFixed(4)} / ${c.price.toFixed(4)} around a head at ${b.price.toFixed(4)}. The neckline sits at ${neckline.toFixed(4)}; a close beneath it projects ${(neckline - height).toFixed(4)}. Until that close happens the pattern is only potential.`,
      });
    }
  }

  if (lows.length >= 3 && highs.length >= 2) {
    const [a, b, c] = lows.slice(-3);
    const between = highs.filter((h) => h.index > a.index && h.index < c.index);
    if (b.price < a.price && b.price < c.price && Math.abs(a.price - c.price) < tolerance && between.length >= 2) {
      const neckline = between.reduce((s, h) => s + h.price, 0) / between.length;
      const height = neckline - b.price;
      out.push({
        name: "Inverse Head & Shoulders",
        kind: "inverse_head_and_shoulders",
        direction: "bullish",
        maturity: window[window.length - 1].close > neckline ? 100 : 70,
        strength: Math.round(clamp(58 + (height / Math.max(atr, 1e-9)) * 4, 0, 92)),
        upperBoundary: neckline,
        lowerBoundary: b.price,
        measuredTarget: neckline + height,
        startTime: a.time,
        note: `Two shoulders at ${a.price.toFixed(4)} / ${c.price.toFixed(4)} around a head at ${b.price.toFixed(4)}. The neckline sits at ${neckline.toFixed(4)}; a close above it projects ${(neckline + height).toFixed(4)}. Until that close happens the pattern is only potential.`,
      });
    }
  }

  if (highs.length >= 2) {
    const [a, b] = highs.slice(-2);
    const trough = Math.min(...window.slice(a.index, b.index + 1).map((c) => c.low));
    if (Math.abs(a.price - b.price) < tolerance && a.price - trough > 1.5 * atr) {
      const height = a.price - trough;
      out.push({
        name: "Double Top",
        kind: "double_top",
        direction: "bearish",
        maturity: window[window.length - 1].close < trough ? 100 : 65,
        strength: Math.round(clamp(52 + (height / Math.max(atr, 1e-9)) * 4, 0, 88)),
        upperBoundary: Math.max(a.price, b.price),
        lowerBoundary: trough,
        measuredTarget: trough - height,
        startTime: a.time,
        note: `Price failed twice at ${a.price.toFixed(4)} / ${b.price.toFixed(4)} with a trough at ${trough.toFixed(4)} between them. Confirmation is a close below the trough, which projects ${(trough - height).toFixed(4)}.`,
      });
    }
  }

  if (lows.length >= 2) {
    const [a, b] = lows.slice(-2);
    const peak = Math.max(...window.slice(a.index, b.index + 1).map((c) => c.high));
    if (Math.abs(a.price - b.price) < tolerance && peak - a.price > 1.5 * atr) {
      const height = peak - a.price;
      out.push({
        name: "Double Bottom",
        kind: "double_bottom",
        direction: "bullish",
        maturity: window[window.length - 1].close > peak ? 100 : 65,
        strength: Math.round(clamp(52 + (height / Math.max(atr, 1e-9)) * 4, 0, 88)),
        upperBoundary: peak,
        lowerBoundary: Math.min(a.price, b.price),
        measuredTarget: peak + height,
        startTime: a.time,
        note: `Price held twice at ${a.price.toFixed(4)} / ${b.price.toFixed(4)} with a peak at ${peak.toFixed(4)} between them. Confirmation is a close above the peak, which projects ${(peak + height).toFixed(4)}.`,
      });
    }
  }

  return out;
}

const SHAPE_NAMES: Record<ChartShape["kind"], string> = {
  ascending_triangle: "Ascending Triangle",
  descending_triangle: "Descending Triangle",
  symmetrical_triangle: "Symmetrical Triangle",
  rising_wedge: "Rising Wedge",
  falling_wedge: "Falling Wedge",
  ascending_channel: "Ascending Channel",
  descending_channel: "Descending Channel",
  rectangle: "Rectangle / Consolidation",
  bull_flag: "Bull Flag",
  bear_flag: "Bear Flag",
  head_and_shoulders: "Head & Shoulders",
  inverse_head_and_shoulders: "Inverse Head & Shoulders",
  double_top: "Double Top",
  double_bottom: "Double Bottom",
};

function shapeNote(
  kind: ChartShape["kind"],
  upper: number,
  lower: number,
  target: number,
  touches: number,
  maturity: number
): string {
  const bounds = `Boundaries currently ${lower.toFixed(4)} / ${upper.toFixed(4)} across ${touches} swing touches`;
  switch (kind) {
    case "ascending_triangle":
      return `${bounds}. Buyers are paying up into a flat ceiling — higher lows against fixed resistance usually resolve upward, projecting ${target.toFixed(4)}.`;
    case "descending_triangle":
      return `${bounds}. Sellers keep pressing into a fixed floor — lower highs against flat support usually resolve downward, projecting ${target.toFixed(4)}.`;
    case "symmetrical_triangle":
      return `${bounds}. Both sides are compressing and the formation is ${maturity}% through its convergence. Symmetrical triangles carry no inherent bias — they tend to continue the move that entered them.`;
    case "rising_wedge":
      return `${bounds}. Price is still rising but the lows are climbing faster than the highs — momentum is narrowing, which typically resolves downward toward ${target.toFixed(4)}.`;
    case "falling_wedge":
      return `${bounds}. Price is still falling but the highs are dropping faster than the lows — selling is losing traction, which typically resolves upward toward ${target.toFixed(4)}.`;
    case "ascending_channel":
      return `${bounds}. Parallel rising boundaries — trend continuation while the lower rail holds; losing it is the first sign the channel is done.`;
    case "descending_channel":
      return `${bounds}. Parallel falling boundaries — trend continuation while the upper rail caps; reclaiming it is the first sign the channel is done.`;
    case "rectangle":
      return `${bounds}. Flat boundaries on both sides: this is balance, not a directional pattern. The edges are where the information is.`;
    case "bull_flag":
      return `${bounds}. A shallow drift against a strong prior advance — the classic continuation pause, projecting ${target.toFixed(4)} if the upper rail gives way.`;
    case "bear_flag":
      return `${bounds}. A shallow drift against a strong prior decline — the classic continuation pause, projecting ${target.toFixed(4)} if the lower rail gives way.`;
    default:
      return bounds + ".";
  }
}

/* ------------------------------------------------------------------ *
 * Plain price-action reading
 * ------------------------------------------------------------------ */

function describePriceAction(candles: Candle[], atr: number): string[] {
  const out: string[] = [];
  const last = candles[candles.length - 1];
  const range = Math.max(last.high - last.low, 1e-9);
  const closeLoc = (last.close - last.low) / range;

  out.push(
    `The current candle closed in the ${closeLoc >= 0.7 ? "upper third" : closeLoc <= 0.3 ? "lower third" : "middle"} of its own range (${(closeLoc * 100).toFixed(0)}%), ${
      closeLoc >= 0.7
        ? "which is buyers holding the highs into the close."
        : closeLoc <= 0.3
          ? "which is sellers holding the lows into the close."
          : "which settles nothing either way."
    }`
  );

  const last10 = candles.slice(-10);
  const movePct = ((last.close - last10[0].open) / last10[0].open) * 100;
  const greens = last10.filter((c) => c.close > c.open).length;
  out.push(
    `Over the last 10 bars price moved ${movePct >= 0 ? "+" : ""}${movePct.toFixed(2)}% with ${greens} up-closes to ${10 - greens} down-closes — ${
      greens >= 7 ? "one-sided buying" : greens <= 3 ? "one-sided selling" : "a genuinely mixed tape"
    }.`
  );

  // Volatility regime: compression precedes expansion, so it is worth naming.
  const recentAtr = averageTrueRange(candles.slice(-10));
  const ratio = recentAtr / Math.max(atr, 1e-9);
  if (ratio < 0.7) {
    out.push(
      `Bar ranges have compressed to ${(ratio * 100).toFixed(0)}% of their recent norm. Compression like this tends to end in expansion — it says a move is coming without saying which way.`
    );
  } else if (ratio > 1.5) {
    out.push(
      `Bar ranges have expanded to ${(ratio * 100).toFixed(0)}% of their recent norm — the market is already in the move, so chasing here carries the worst of the risk/reward.`
    );
  }

  const recent = candles.slice(-SHAPE_BARS);
  const hi = Math.max(...recent.map((c) => c.high));
  const lo = Math.min(...recent.map((c) => c.low));
  const pos = (last.close - lo) / Math.max(hi - lo, 1e-9);
  out.push(
    `Price sits ${(pos * 100).toFixed(0)}% of the way up the ${recent.length}-bar range (${lo.toFixed(4)}–${hi.toFixed(4)}).`
  );

  return out;
}

function describeTrendWord(candles: Candle[]): string {
  const t = priorTrend(candles);
  return t === "bullish" ? "an uptrend" : t === "bearish" ? "a downtrend" : "a sideways tape";
}

/** Direction of the leg that led into the current formation. */
function priorTrend(candles: Candle[]): Bias {
  const n = Math.min(40, candles.length);
  const seg = candles.slice(-n);
  const change = (seg[seg.length - 1].close - seg[0].open) / seg[0].open;
  return change > 0.01 ? "bullish" : change < -0.01 ? "bearish" : "neutral";
}

/** Was there a strong directional impulse immediately before the formation? */
function impulseBefore(candles: Candle[], offset: number, atr: number): Bias {
  const end = offset;
  const start = Math.max(0, end - 15);
  if (end - start < 5) return "neutral";
  const seg = candles.slice(start, end);
  const move = seg[seg.length - 1].close - seg[0].open;
  if (move > 2.5 * atr) return "bullish";
  if (move < -2.5 * atr) return "bearish";
  return "neutral";
}

/* ------------------------------------------------------------------ *
 * Small numeric helpers
 * ------------------------------------------------------------------ */

function fitLine(pts: { x: number; y: number }[]): { slope: number; intercept: number } {
  const n = pts.length;
  const sx = pts.reduce((s, p) => s + p.x, 0);
  const sy = pts.reduce((s, p) => s + p.y, 0);
  const sxx = pts.reduce((s, p) => s + p.x * p.x, 0);
  const sxy = pts.reduce((s, p) => s + p.x * p.y, 0);
  const d = n * sxx - sx * sx;
  if (Math.abs(d) < 1e-12) return { slope: 0, intercept: sy / n };
  const slope = (n * sxy - sx * sy) / d;
  return { slope, intercept: (sy - slope * sx) / n };
}

function meanAbsResidual(
  pts: SwingPoint[],
  fit: { slope: number; intercept: number }
): number {
  if (pts.length === 0) return 0;
  return (
    pts.reduce((s, p) => s + Math.abs(p.price - (fit.slope * p.index + fit.intercept)), 0) /
    pts.length
  );
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

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function emptyResult(price: number, windowBars: number, historyBars: number): ChartAnalystResult {
  return {
    windowBars,
    historyBars,
    currentPattern: {
      headline: "Not enough chart to read",
      candlestick: [],
      shapes: [],
      priceAction: ["Fewer than 30 bars are available — there is no shape to analyse yet."],
    },
    historicalMatches: [],
    expectedNextMove: {
      direction: "neutral",
      magnitudePct: 0,
      target: null,
      invalidation: null,
      horizonBars: 0,
      rationale: ["Insufficient history for pattern matching."],
    },
    bullishScenario: { trigger: "—", target: price, probability: 50, note: "Insufficient data." },
    bearishScenario: { trigger: "—", target: price, probability: 50, note: "Insufficient data." },
    confidence: 5,
    confidenceLabel: "Low",
    patternExplanation: ["Waiting on more candles before any chart-based read is honest."],
  };
}
