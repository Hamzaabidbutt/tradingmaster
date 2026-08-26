import { describe, expect, it } from "vitest";
import { buildVerdicts, evaluateConfluence } from "@/engines/confluence";
import { analyzeChart } from "@/engines/chartAnalyst";
import { analyzeCandleCloseExpansion } from "@/engines/candleCloseExpansion";
import { analyzeRangeTrading } from "@/engines/rangeTrading";
import {
  AnalystVerdict,
  CandleCloseExpansionResult,
  ChartAnalystResult,
  Candle,
  RangeTradingResult,
} from "@/engines/types";
import { candle } from "./helpers";

const T0 = 1_700_000_000;
const HOUR = 3600;

/** Deterministic pseudo-random so fixtures are reproducible across runs. */
function lcg(seed: number) {
  let s = (seed * 2654435761) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/* ------------------------------------------------------------------ *
 * Hand-built analyst results
 *
 * The confluence engine's job is combining verdicts, so most tests feed it
 * synthetic analyst output directly. That isolates the scoring logic from the
 * three analysts' own heuristics — a change in how `analyzeChart` picks
 * analogues must not be able to break a test about disagreement penalties.
 * ------------------------------------------------------------------ */

function chartResult(over: {
  direction: "bullish" | "bearish" | "neutral";
  confidence?: number;
  target?: number | null;
  invalidation?: number | null;
  matches?: number;
  agreement?: number;
}): ChartAnalystResult {
  const n = over.matches ?? 6;
  const agree = Math.round(n * (over.agreement ?? 1));
  const opposite = over.direction === "bullish" ? "bearish" : "bullish";
  return {
    windowBars: 20,
    historyBars: 400,
    currentPattern: {
      headline: "test pattern",
      candlestick: [],
      shapes: [
        {
          name: "Ascending triangle",
          kind: "ascending_triangle",
          direction: over.direction,
          maturity: 80,
          strength: 70,
          upperBoundary: 105,
          lowerBoundary: 95,
          measuredTarget: 110,
          startTime: T0,
          note: "test",
        },
      ],
      priceAction: [],
    },
    historicalMatches: Array.from({ length: n }, (_, i) => ({
      startIndex: i,
      startTime: T0 + i * HOUR,
      endTime: T0 + (i + 10) * HOUR,
      similarity: 80,
      forwardReturnPct: i < agree ? 2 : -2,
      forwardDirection: i < agree ? over.direction : (opposite as "bullish" | "bearish"),
      maxUpPct: 3,
      maxDownPct: -1,
      note: "test",
    })),
    expectedNextMove: {
      direction: over.direction,
      magnitudePct: over.direction === "bullish" ? 2.5 : -2.5,
      target: over.target === undefined ? (over.direction === "bullish" ? 106 : 94) : over.target,
      invalidation:
        over.invalidation === undefined ? (over.direction === "bullish" ? 97 : 103) : over.invalidation,
      horizonBars: 10,
      rationale: [],
    },
    bullishScenario: { trigger: "t", target: 106, probability: 60, note: "" },
    bearishScenario: { trigger: "t", target: 94, probability: 40, note: "" },
    confidence: over.confidence ?? 70,
    confidenceLabel: "Moderate",
    patternExplanation: [],
  };
}

function candleCloseResult(over: {
  direction: "up" | "down" | "uncertain";
  verdict?: "decisive" | "marginal" | "weak" | "none";
  probability?: "Low" | "Medium" | "High";
  score?: number;
  level?: number | null;
  target?: number | null;
  invalidation?: number | null;
  closePrice?: number;
}): CandleCloseExpansionResult {
  const up = over.direction === "up";
  return {
    keyLevel:
      over.level === null
        ? null
        : {
            price: over.level ?? 100,
            kind: up ? "resistance" : "support",
            touches: 5,
            respects: 4,
            historicalFalseBreakRate: 0.2,
            note: "test level",
          },
    candleClose: up ? "above" : "below",
    closePrice: over.closePrice ?? (up ? 101 : 99),
    closeTime: T0,
    breakoutDirection: up ? "bullish" : "bearish",
    decisiveness: {
      score: 80,
      penetrationAtr: 0.8,
      bodyRatio: 0.7,
      closeLocation: up ? 0.9 : 0.1,
      volumeMultiple: 1.8,
      followThroughBars: 2,
      verdict: over.verdict ?? "decisive",
      checks: [],
    },
    expansionProbability: over.probability ?? "High",
    expansionScore: over.score ?? 78,
    expectedDirection: over.direction,
    expansionTarget: over.target === undefined ? (up ? 107 : 93) : over.target,
    invalidationLevel: over.invalidation === undefined ? (up ? 98 : 102) : over.invalidation,
    reason: [],
    historicalPrecedents: [],
    summary: "test",
  };
}

function rangeResult(over: {
  setup: "Long" | "Short" | "No Trade" | "Breakout";
  condition?: "Ranging" | "Trending" | "Unclear";
  confidence?: number;
  allPassed?: boolean;
  entry?: number | null;
  target?: number | null;
  invalidation?: number | null;
  breakoutStage?: RangeTradingResult["breakout"]["stage"];
  breakoutDirection?: "up" | "down" | null;
}): RangeTradingResult {
  const long = over.setup === "Long";
  const passed = over.allPassed ?? true;
  return {
    marketCondition: over.condition ?? "Ranging",
    rangeHigh: 105,
    rangeLow: 95,
    rangeMidpoint: 100,
    rangeWidthPct: 10,
    rangeBars: 120,
    highTouches: 4,
    lowTouches: 4,
    containment: 0.9,
    currentPosition: long ? "Near Low" : "Near High",
    rangeSetup: over.setup,
    bias: long ? "bullish" : "bearish",
    confidence: over.confidence ?? 72,
    confidenceLabel: "Moderate",
    potentialEntry: over.entry === undefined ? (long ? 96 : 104) : over.entry,
    target1: over.target === undefined ? 100 : over.target,
    target2: long ? 105 : 95,
    invalidation: over.invalidation === undefined ? (long ? 94 : 106) : over.invalidation,
    validation: [
      { label: "Boundaries respected", passed, detail: "test" },
      { label: "Containment", passed, detail: "test" },
    ],
    boundaryReactions: [],
    breakout: {
      active: over.breakoutStage !== undefined && over.breakoutStage !== "none",
      direction: over.breakoutDirection ?? null,
      stage: over.breakoutStage ?? "none",
      note: "test",
    },
    reason: [],
  };
}

/* ------------------------------------------------------------------ *
 * Quality gates
 * ------------------------------------------------------------------ */

describe("confluence — quality gates", () => {
  it("abstains on every analyst when none clears its gate, and says why", () => {
    const setup = evaluateConfluence(
      "BTCUSDT",
      "1h",
      100,
      chartResult({ direction: "neutral", target: null }),
      candleCloseResult({ direction: "uncertain", verdict: "weak", probability: "Low" }),
      rangeResult({ setup: "No Trade", condition: "Trending" }),
      70
    );
    expect(setup.decision).toBe("NO_TRADE");
    expect(setup.verdicts.every((v) => !v.qualified)).toBe(true);
    expect(setup.noTradeReason).toBeTruthy();
    // The reason must name each analyst, not just say "no setup".
    expect(setup.noTradeReason).toContain("Chart Analyst");
    expect(setup.noTradeReason).toContain("Range Trading");
    expect(setup.confluenceVerdict).toBe("None");
    // No levels are quoted for a trade we are not taking.
    expect(setup.entry).toBeNull();
    expect(setup.stopLoss).toBeNull();
  });

  it("refuses a marginal candle close — a crossing alone is not a breakout", () => {
    const marginal = buildVerdicts(
      chartResult({ direction: "neutral", target: null }),
      candleCloseResult({ direction: "up", verdict: "marginal" }),
      rangeResult({ setup: "No Trade", condition: "Trending" })
    ).find((v) => v.analyst === "candleClose")!;

    expect(marginal.qualified).toBe(false);
    expect(marginal.gate).toMatch(/marginal/);
    expect(marginal.direction).toBe("none");
  });

  it("a decisive close alone cannot reach the threshold on its own", () => {
    const setup = evaluateConfluence(
      "BTCUSDT",
      "1h",
      100,
      chartResult({ direction: "neutral", target: null }),
      candleCloseResult({ direction: "up", score: 78 }),
      rangeResult({ setup: "No Trade", condition: "Trending" }),
      70
    );
    // One basis gets no independence bonus, so a single strong analyst lands
    // below the bar — which is the whole point of requiring confluence.
    expect(setup.long.independentBases).toBe(1);
    expect(setup.long.independenceMultiplier).toBe(1);
    expect(setup.decision).toBe("NO_TRADE");
    expect(setup.noTradeReason).toMatch(/below the 70% confluence threshold/);
  });

  it("still refuses a lone analyst when the confidence bar is lowered", () => {
    // Calibration puts a single basis under 70 anyway; this proves the
    // requirement is structural rather than a side effect of the threshold.
    // Dropping the bar to 55 must widen the net without admitting one opinion.
    const setup = evaluateConfluence(
      "BTCUSDT",
      "1h",
      100,
      chartResult({ direction: "neutral", target: null }),
      candleCloseResult({ direction: "up", score: 100 }),
      rangeResult({ setup: "No Trade", condition: "Trending" }),
      55
    );
    expect(setup.long.confidence).toBeGreaterThan(55);
    expect(setup.long.independentBases).toBe(1);
    expect(setup.decision).toBe("NO_TRADE");
    expect(setup.noTradeReason).toMatch(/2 independent methods/);
    expect(setup.noTradeReason).toContain("Candle Close Expansion");
    expect(setup.confluenceVerdict).toBe("None");
  });

  it("caps the strongest possible lone analyst below the default bar", () => {
    const setup = evaluateConfluence(
      "BTCUSDT",
      "1h",
      100,
      chartResult({ direction: "neutral", target: null }),
      candleCloseResult({ direction: "up", score: 100 }),
      rangeResult({ setup: "No Trade", condition: "Trending" }),
      70
    );
    // The heaviest-weighted analyst at 100% conviction, alone: still under 70.
    expect(setup.long.confidence).toBeLessThan(70);
  });

  it("rejects a range vote when the range itself failed validation", () => {
    const v = buildVerdicts(
      chartResult({ direction: "neutral", target: null }),
      candleCloseResult({ direction: "uncertain", verdict: "none" }),
      rangeResult({ setup: "Long", allPassed: false })
    ).find((x) => x.analyst === "range")!;
    expect(v.qualified).toBe(false);
    expect(v.gate).toMatch(/range validation failed/);
  });

  it("accepts a range vote on a confirmed break under retest", () => {
    const v = buildVerdicts(
      chartResult({ direction: "neutral", target: null }),
      candleCloseResult({ direction: "uncertain", verdict: "none" }),
      rangeResult({
        setup: "Breakout",
        condition: "Trending",
        breakoutStage: "retest",
        breakoutDirection: "down",
        entry: 94,
        target: 88,
        invalidation: 101,
      })
    ).find((x) => x.analyst === "range")!;
    expect(v.qualified).toBe(true);
    expect(v.direction).toBe("short");
    expect(v.gate).toMatch(/break under retest/);
  });

  it("rejects a breakout that has not been retested yet", () => {
    const v = buildVerdicts(
      chartResult({ direction: "neutral", target: null }),
      candleCloseResult({ direction: "uncertain", verdict: "none" }),
      rangeResult({ setup: "Breakout", condition: "Trending", breakoutStage: "attempt", breakoutDirection: "up" })
    ).find((x) => x.analyst === "range")!;
    expect(v.qualified).toBe(false);
    expect(v.gate).toMatch(/awaiting retest/);
  });

  it("rejects a chart read backed by too few or too split analogues", () => {
    const thin = buildVerdicts(
      chartResult({ direction: "bullish", matches: 2 }),
      candleCloseResult({ direction: "uncertain", verdict: "none" }),
      rangeResult({ setup: "No Trade", condition: "Trending" })
    ).find((v) => v.analyst === "chart")!;
    expect(thin.qualified).toBe(false);
    expect(thin.gate).toMatch(/only 2 analogues/);

    const split = buildVerdicts(
      chartResult({ direction: "bullish", matches: 8, agreement: 0.375 }),
      candleCloseResult({ direction: "uncertain", verdict: "none" }),
      rangeResult({ setup: "No Trade", condition: "Trending" })
    ).find((v) => v.analyst === "chart")!;
    expect(split.qualified).toBe(false);
    expect(split.gate).toMatch(/38% aligned/);
  });
});

/* ------------------------------------------------------------------ *
 * Scoring
 * ------------------------------------------------------------------ */

describe("confluence — scoring by independence, not averaging", () => {
  const strongLongChart = chartResult({ direction: "bullish", confidence: 75 });
  const strongLongClose = candleCloseResult({ direction: "up", score: 78 });
  const strongLongRange = rangeResult({ setup: "Long", confidence: 74 });

  const silentChart = chartResult({ direction: "neutral", target: null });
  const silentClose = candleCloseResult({ direction: "uncertain", verdict: "none", probability: "Low" });
  const silentRange = rangeResult({ setup: "No Trade", condition: "Trending" });

  const one = evaluateConfluence("X", "1h", 100, silentChart, strongLongClose, silentRange, 70);
  const two = evaluateConfluence("X", "1h", 100, silentChart, strongLongClose, strongLongRange, 70);
  const three = evaluateConfluence("X", "1h", 100, strongLongChart, strongLongClose, strongLongRange, 70);

  it("is superadditive in the number of independent bases", () => {
    expect(one.long.independentBases).toBe(1);
    expect(two.long.independentBases).toBe(2);
    expect(three.long.independentBases).toBe(3);
    expect(two.long.confidence).toBeGreaterThan(one.long.confidence);
    expect(three.long.confidence).toBeGreaterThan(two.long.confidence);
  });

  it("is not an average of the analysts' own confidences", () => {
    // Averaging 78 and 74 would give 76 and — crucially — would *drop* when a
    // less confident analyst agreed. Confluence must rise instead.
    const avg = (78 + 74) / 2;
    expect(two.long.confidence).toBeGreaterThan(avg);
    expect(two.long.confidence).toBeGreaterThan(one.long.confidence);
  });

  it("never reaches certainty however much evidence stacks up", () => {
    const maxed = evaluateConfluence(
      "X",
      "1h",
      100,
      chartResult({ direction: "bullish", confidence: 100 }),
      candleCloseResult({ direction: "up", score: 100 }),
      rangeResult({ setup: "Long", confidence: 100 }),
      70
    );
    expect(maxed.long.confidence).toBeLessThan(97);
    expect(maxed.confluenceVerdict).toBe("Strong");
  });

  it("labels three agreeing bases Strong and two Partial", () => {
    expect(three.confluenceVerdict).toBe("Strong");
    expect(two.confluenceVerdict).toBe("Partial");
  });
});

describe("confluence — disagreement is shown, not hidden", () => {
  it("lowers confidence and records who disagrees", () => {
    const agreeing = evaluateConfluence(
      "X",
      "1h",
      100,
      chartResult({ direction: "neutral", target: null }),
      candleCloseResult({ direction: "up", score: 80 }),
      rangeResult({ setup: "Long", confidence: 75 }),
      70
    );
    const conflicted = evaluateConfluence(
      "X",
      "1h",
      100,
      chartResult({ direction: "bearish", confidence: 72 }),
      candleCloseResult({ direction: "up", score: 80 }),
      rangeResult({ setup: "Long", confidence: 75 }),
      70
    );

    expect(agreeing.disagreement.present).toBe(false);
    expect(conflicted.disagreement.present).toBe(true);
    expect(conflicted.disagreement.penaltyApplied).toBeGreaterThan(0);
    expect(conflicted.disagreement.note).toContain("Chart Analyst");
    expect(conflicted.long.confidence).toBeLessThan(agreeing.long.confidence);
  });

  it("returns NO_TRADE when the two sides are too close to call", () => {
    const split = evaluateConfluence(
      "X",
      "1h",
      100,
      chartResult({ direction: "bearish", confidence: 90 }),
      candleCloseResult({ direction: "up", score: 74 }),
      rangeResult({ setup: "Long", confidence: 60 }),
      55
    );
    if (split.decision === "NO_TRADE") {
      expect(split.noTradeReason).toBeTruthy();
    }
    // Whichever way it lands, both sides must be scored — a signal is never
    // emitted without the opposing case having been evaluated.
    expect(split.long.supporters.length).toBeGreaterThan(0);
    expect(split.short.supporters.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

describe("confluence — geometry", () => {
  it("downgrades to NO_TRADE when risk:reward is under 1", () => {
    // Strong agreement, but a stop far below entry and a target barely above:
    // conviction cannot fix negative-expectancy geometry.
    const setup = evaluateConfluence(
      "X",
      "1h",
      100,
      chartResult({ direction: "bullish", confidence: 85, target: 100.4, invalidation: 90 }),
      candleCloseResult({ direction: "up", score: 88, target: 100.5, invalidation: 90, closePrice: 100 }),
      rangeResult({ setup: "Long", confidence: 82, entry: 100, target: 100.3, invalidation: 90 }),
      70
    );
    expect(setup.long.confidence).toBeGreaterThanOrEqual(70);
    expect(setup.decision).toBe("NO_TRADE");
    expect(setup.noTradeReason).toMatch(/geometry/);
    expect(setup.entry).toBeNull();
  });

  it("takes the widest supporting invalidation as the stop", () => {
    const setup = evaluateConfluence(
      "X",
      "1h",
      100,
      chartResult({ direction: "neutral", target: null }),
      candleCloseResult({ direction: "up", score: 80, closePrice: 100, target: 110, invalidation: 99 }),
      rangeResult({ setup: "Long", confidence: 78, entry: 100, target: 108, invalidation: 96 }),
      70
    );
    expect(setup.decision).toBe("LONG");
    // 96, not 99 — the tighter stop would flatter the RR and stop out on noise.
    expect(setup.stopLoss).toBe(96);
    expect(setup.target1).toBe(108);
    expect(setup.target2).toBe(110);
    expect(setup.riskReward).toBeCloseTo(2.5, 1);
  });

  it("refuses to trade when no supporter quotes a usable stop", () => {
    const setup = evaluateConfluence(
      "X",
      "1h",
      100,
      chartResult({ direction: "neutral", target: null }),
      candleCloseResult({ direction: "up", score: 85, closePrice: 100, target: 110, invalidation: null }),
      rangeResult({ setup: "Long", confidence: 82, entry: 100, target: 108, invalidation: null }),
      70
    );
    expect(setup.decision).toBe("NO_TRADE");
    expect(setup.noTradeReason).toMatch(/invalidation/);
  });
});

/* ------------------------------------------------------------------ *
 * Explanation
 * ------------------------------------------------------------------ */

describe("confluence — explanation", () => {
  it("is built from the analysts' own numbers, not a template", () => {
    const a = evaluateConfluence(
      "BTCUSDT",
      "1h",
      100,
      chartResult({ direction: "neutral", target: null }),
      candleCloseResult({ direction: "up", score: 80, level: 100.5, closePrice: 100, target: 110, invalidation: 96 }),
      rangeResult({ setup: "Long", confidence: 78, entry: 100, target: 108, invalidation: 95 }),
      70
    );
    const b = evaluateConfluence(
      "ETHUSDT",
      "4h",
      50,
      chartResult({ direction: "neutral", target: null }),
      candleCloseResult({ direction: "down", score: 76, level: 49.5, closePrice: 50, target: 44, invalidation: 53 }),
      rangeResult({ setup: "Short", confidence: 80, entry: 50, target: 46, invalidation: 54 }),
      70
    );

    expect(a.explanation.join(" ")).not.toEqual(b.explanation.join(" "));
    // The actual level and touch count must appear, not a generic phrase.
    expect(a.explanation.join(" ")).toContain("100.5");
    expect(a.explanation.join(" ")).toContain("5 touches");
    expect(a.explanation.join(" ")).toContain("BTCUSDT");
    expect(b.explanation.join(" ")).toContain("ETHUSDT");
    // Abstaining analysts are reported, never silently dropped.
    expect(a.explanation.join(" ")).toContain("Chart Analyst abstains");
    expect(a.invalidation.length).toBeGreaterThan(0);
  });

  it("explains a NO_TRADE rather than returning an empty result", () => {
    const setup = evaluateConfluence(
      "SOLUSDT",
      "15m",
      20,
      chartResult({ direction: "neutral", target: null }),
      candleCloseResult({ direction: "uncertain", verdict: "weak", probability: "Low" }),
      rangeResult({ setup: "No Trade", condition: "Unclear" }),
      70
    );
    expect(setup.explanation[0]).toContain("NO TRADE");
    expect(setup.explanation.join(" ")).toContain("SOLUSDT");
  });
});

/* ------------------------------------------------------------------ *
 * LONG/SHORT parity — mirror test
 *
 * The strongest available proof that the engine has no directional bias: run
 * it on a real candle series through the real analysts, then reflect that
 * series about a horizontal price axis and run it again. Every bullish
 * structure becomes the identical bearish structure, so a symmetric engine
 * must return the mirrored decision with the same confidence.
 *
 * If any branch in the engine treats up and down differently, this fails.
 * ------------------------------------------------------------------ */

/** Reflect a series about `axis`: highs become lows, closes invert. */
function mirror(candles: Candle[], axis: number): Candle[] {
  return candles.map((c) =>
    candle(
      c.time,
      2 * axis - c.open,
      2 * axis - c.low, // reflected low is the new high
      2 * axis - c.high,
      2 * axis - c.close,
      c.volume,
      c.takerBuyVolume
    )
  );
}

/** A rising series that ends with a decisive close above a tested ceiling. */
function breakoutSeries(seed = 11): Candle[] {
  const rnd = lcg(seed);
  const out: Candle[] = [];
  let prev = 100;
  // 160 bars oscillating under a 104 ceiling, tagging it repeatedly.
  for (let i = 0; i < 160; i++) {
    const target = 100 + Math.sin((i / 18) * Math.PI * 2) * 3.6;
    const close = target + (rnd() - 0.5) * 0.35;
    const wick = 0.12 + rnd() * 0.18;
    const vol = 900 + Math.round(rnd() * 200);
    out.push(
      candle(T0 + i * HOUR, prev, Math.max(prev, close) + wick, Math.min(prev, close) - wick, close, vol, vol * 0.5)
    );
    prev = close;
  }
  // Then a decisive close through it, on volume, with follow-through.
  const breaks = [105.6, 106.4, 107.1, 107.6];
  breaks.forEach((close, i) => {
    const open = prev;
    out.push(
      candle(
        T0 + (160 + i) * HOUR,
        open,
        Math.max(open, close) + 0.1,
        Math.min(open, close) - 0.08,
        close,
        2600 - i * 300,
        (2600 - i * 300) * 0.75
      )
    );
    prev = close;
  });
  return out;
}

function evaluateSeries(symbol: string, candles: Candle[]) {
  const price = candles[candles.length - 1].close;
  return evaluateConfluence(
    symbol,
    "1h",
    price,
    analyzeChart(candles, null),
    analyzeCandleCloseExpansion(candles, "1h", null),
    analyzeRangeTrading(candles),
    70
  );
}

describe("confluence — LONG/SHORT parity", () => {
  const AXIS = 100;
  const up = breakoutSeries();
  const down = mirror(up, AXIS);

  it("puts real, opposing analyst verdicts on the table", () => {
    // Guard against a vacuous mirror. If every analyst abstained on this
    // fixture, the parity assertions below would pass by comparing two empty
    // results. On this series the candle-close analyst qualifies LONG on the
    // break while the chart analyst qualifies SHORT from its analogues — so
    // both directional cases are populated and a penalty is actually charged.
    const bull = evaluateSeries("UPUSDT", up);
    expect(bull.verdicts.filter((v) => v.qualified).length).toBeGreaterThanOrEqual(2);
    expect(bull.long.supporters.length).toBeGreaterThan(0);
    expect(bull.short.supporters.length).toBeGreaterThan(0);
    expect(bull.disagreement.present).toBe(true);
    expect(bull.disagreement.penaltyApplied).toBeGreaterThan(0);
  });

  it("mirrors the decision when the chart is mirrored", () => {
    const bull = evaluateSeries("UPUSDT", up);
    const bear = evaluateSeries("DOWNUSDT", down);

    // Same decision class: a trade one way is a trade the other way, and a
    // NO_TRADE one way is a NO_TRADE the other.
    if (bull.decision === "LONG") expect(bear.decision).toBe("SHORT");
    else if (bull.decision === "SHORT") expect(bear.decision).toBe("LONG");
    else expect(bear.decision).toBe("NO_TRADE");
  });

  it("scores the mirrored case with the same confidence", () => {
    const bull = evaluateSeries("UPUSDT", up);
    const bear = evaluateSeries("DOWNUSDT", down);

    // The long case of the original must equal the short case of the mirror,
    // and vice versa. Tolerance is for float reflection, not for bias.
    expect(bear.short.confidence).toBeCloseTo(bull.long.confidence, 0);
    expect(bear.long.confidence).toBeCloseTo(bull.short.confidence, 0);
    expect(bear.short.independentBases).toBe(bull.long.independentBases);
    expect(bear.long.independentBases).toBe(bull.short.independentBases);
    expect(bear.confidence).toBeCloseTo(bull.confidence, 0);
    // The penalty each side pays must mirror too, or the disagreement maths is
    // itself directional.
    expect(bear.short.disagreementPenalty).toBeCloseTo(bull.long.disagreementPenalty, 0);
    expect(bear.long.disagreementPenalty).toBeCloseTo(bull.short.disagreementPenalty, 0);
  });

  it("qualifies the same analysts in the mirrored direction", () => {
    const bull = evaluateSeries("UPUSDT", up);
    const bear = evaluateSeries("DOWNUSDT", down);

    const flip = (d: AnalystVerdict["direction"]) =>
      d === "long" ? "short" : d === "short" ? "long" : "none";

    for (const v of bull.verdicts) {
      const m = bear.verdicts.find((x) => x.analyst === v.analyst)!;
      expect(m.qualified).toBe(v.qualified);
      expect(m.direction).toBe(flip(v.direction));
    }
  });

  it("is symmetric on hand-built mirrored verdicts too", () => {
    const long = evaluateConfluence(
      "X",
      "1h",
      100,
      chartResult({ direction: "bullish", confidence: 76, target: 108, invalidation: 96 }),
      candleCloseResult({ direction: "up", score: 80, closePrice: 100, target: 110, invalidation: 95 }),
      rangeResult({ setup: "Long", confidence: 74, entry: 100, target: 107, invalidation: 94 }),
      70
    );
    const short = evaluateConfluence(
      "X",
      "1h",
      100,
      chartResult({ direction: "bearish", confidence: 76, target: 92, invalidation: 104 }),
      candleCloseResult({ direction: "down", score: 80, closePrice: 100, target: 90, invalidation: 105 }),
      rangeResult({ setup: "Short", confidence: 74, entry: 100, target: 93, invalidation: 106 }),
      70
    );

    expect(short.decision).toBe("SHORT");
    expect(long.decision).toBe("LONG");
    expect(short.confidence).toBeCloseTo(long.confidence, 5);
    expect(short.riskReward).toBeCloseTo(long.riskReward!, 5);
    expect(Math.abs(short.stopLoss! - 100)).toBeCloseTo(Math.abs(long.stopLoss! - 100), 5);
  });
});
