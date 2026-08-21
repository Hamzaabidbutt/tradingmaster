import { describe, expect, it } from "vitest";
import { classifyOutcome, computeExcursion, OutcomeSignal } from "@/engines/outcome";
import { AnalystKey, AnalystVerdict, Excursion } from "@/engines/types";
import { candle } from "./helpers";

const T0 = 1_700_000_000;
const HOUR = 3600;

const BASIS: Record<AnalystKey, AnalystVerdict["basis"]> = {
  chart: "pattern_history",
  candleClose: "level_close",
  range: "range_boundary",
};

const NAME: Record<AnalystKey, string> = {
  chart: "Chart Analyst",
  candleClose: "Candle Close Expansion",
  range: "Range Trading",
};

function verdict(
  analyst: AnalystKey,
  over: Partial<AnalystVerdict> & { direction: AnalystVerdict["direction"] }
): AnalystVerdict {
  return {
    analyst,
    name: NAME[analyst],
    basis: BASIS[analyst],
    direction: over.direction,
    confidence: over.confidence ?? 75,
    qualified: over.qualified ?? over.direction !== "none",
    gate: over.gate ?? "qualified for test",
    entry: over.entry ?? null,
    target: over.target ?? null,
    invalidation: over.invalidation ?? null,
    evidence: over.evidence ?? `${NAME[analyst]} evidence`,
  };
}

function signal(over: Partial<OutcomeSignal> = {}): OutcomeSignal {
  return {
    side: "BUY",
    entry: 100,
    stopLoss: 98,
    tp1: 102,
    tp2: 104,
    tp3: 106,
    status: "STOPPED",
    resultPnlPct: -2,
    timeframe: "1h",
    verdicts: [],
    ...over,
  };
}

/** Excursion literal, so failure classes can be driven exactly. */
function exc(favourableR: number, adverseR: number, bars = 20): Excursion {
  return {
    maxFavourableR: favourableR,
    maxAdverseR: adverseR,
    maxFavourablePct: favourableR * 2,
    maxAdversePct: adverseR * 2,
    bars,
  };
}

/* ------------------------------------------------------------------ *
 * Excursion measurement
 * ------------------------------------------------------------------ */

describe("computeExcursion", () => {
  const series = [
    candle(T0 + 0 * HOUR, 100, 101, 99.5, 100.5),
    candle(T0 + 1 * HOUR, 100.5, 103, 100, 102.5), // +1.5R favourable
    candle(T0 + 2 * HOUR, 102.5, 102.8, 99, 99.5), // -0.5R adverse
  ];

  it("measures favourable and adverse excursion in R and percent", () => {
    // risk = 2 (entry 100, stop 98)
    const e = computeExcursion(series, { side: "BUY", entry: 100, stopLoss: 98 }, T0);
    expect(e.bars).toBe(3);
    expect(e.maxFavourableR).toBeCloseTo(1.5, 2); // high 103
    expect(e.maxAdverseR).toBeCloseTo(0.5, 2); // low 99
    expect(e.maxFavourablePct).toBeCloseTo(3, 2);
    expect(e.maxAdversePct).toBeCloseTo(1, 2);
  });

  it("mirrors for a short — a fall is favourable", () => {
    const e = computeExcursion(series, { side: "SELL", entry: 100, stopLoss: 102 }, T0);
    expect(e.maxFavourableR).toBeCloseTo(0.5, 2); // low 99
    expect(e.maxAdverseR).toBeCloseTo(1.5, 2); // high 103
  });

  it("ignores candles before the signal existed", () => {
    // Without the cutoff the 103 high in bar 2 would be credited to a signal
    // created after it — a pre-entry wick counted as an excursion.
    const e = computeExcursion(series, { side: "BUY", entry: 100, stopLoss: 98 }, T0 + 2 * HOUR);
    expect(e.bars).toBe(1);
    expect(e.maxFavourableR).toBeCloseTo(1.4, 2); // only 102.8 remains
  });

  it("never reports a negative excursion", () => {
    const down = [candle(T0, 100, 100, 97, 97.5)];
    const e = computeExcursion(down, { side: "BUY", entry: 100, stopLoss: 98 }, T0);
    // Price never traded above entry, so the favourable distance is zero — not
    // a negative number that would then be compared against thresholds.
    expect(e.maxFavourableR).toBe(0);
    expect(e.maxAdverseR).toBeCloseTo(1.5, 2);
  });

  it("returns an empty excursion rather than NaN when there are no candles", () => {
    const e = computeExcursion([], { side: "BUY", entry: 100, stopLoss: 98 }, T0);
    expect(e).toMatchObject({ maxFavourableR: 0, maxAdverseR: 0, bars: 0 });
  });

  it("returns an empty excursion when the stop distance is zero", () => {
    const e = computeExcursion(series, { side: "BUY", entry: 100, stopLoss: 100 }, T0);
    expect(Number.isFinite(e.maxFavourableR)).toBe(true);
    expect(e.maxFavourableR).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Success attribution
 * ------------------------------------------------------------------ */

describe("classifyOutcome — wins", () => {
  it("names the analyst whose own target was actually reached", () => {
    const s = signal({
      status: "TP3_HIT",
      resultPnlPct: 4,
      verdicts: [
        // The chart analyst is weighted lowest but projected the furthest
        // target — and that target was reached, which is the stronger claim.
        verdict("chart", { direction: "long", confidence: 70, target: 105 }),
        verdict("candleClose", { direction: "long", confidence: 90, target: 102, entry: 100 }),
        verdict("range", { direction: "none", qualified: false, gate: "abstains — market is trending" }),
      ],
    });
    const out = classifyOutcome(s, exc(2.6, 0.2)); // reached 100 + 2.6*2 = 105.2

    expect(out.win).toBe(true);
    expect(out.reason).toBe("target_reached");
    expect(out.workingConfirmation).toContain("Chart Analyst");
    expect(out.analystsRight).toEqual(expect.arrayContaining(["chart", "candleClose"]));
    expect(out.analystsWrong).toEqual([]);
    // Contribution is quality-weighted: 0.90 × 1.0 beats 0.70 × 0.7.
    expect(out.topContributor).toBe("candleClose");
  });

  it("records a TP1 close as a partial rather than a full target", () => {
    const s = signal({
      status: "TP1_HIT",
      resultPnlPct: 2,
      verdicts: [verdict("candleClose", { direction: "long", target: 102, entry: 100 })],
    });
    const out = classifyOutcome(s, exc(1.1, 0.3));
    expect(out.win).toBe(true);
    expect(out.reason).toBe("partial_target");
    expect(out.reasonLabel).toMatch(/Partial target/);
  });

  it("treats an expiry in profit as a win, not a failure", () => {
    // The P/L is the ground truth. Running a profitable trade through the
    // failure taxonomy would charge analysts for a trade that made money.
    const s = signal({
      status: "EXPIRED",
      resultPnlPct: 1.4,
      verdicts: [verdict("candleClose", { direction: "long", target: 106, entry: 100 })],
    });
    const out = classifyOutcome(s, exc(0.8, 0.4));
    expect(out.win).toBe(true);
    expect(out.reason).toBe("closed_in_profit");
    expect(out.analystsWrong).toEqual([]);
    expect(out.analystsRight).toEqual(["candleClose"]);
  });

  it("says when a winner nearly stopped out first", () => {
    const s = signal({
      status: "TP2_HIT",
      resultPnlPct: 4,
      verdicts: [verdict("candleClose", { direction: "long", target: 104, entry: 100 })],
    });
    const out = classifyOutcome(s, exc(2, 0.85));
    expect(out.detail.join(" ")).toMatch(/came within 0\.15R of the stop/);
  });

  it("marks an opposing analyst wrong on a win", () => {
    const s = signal({
      status: "TP3_HIT",
      resultPnlPct: 6,
      verdicts: [
        verdict("candleClose", { direction: "long", target: 106, entry: 100 }),
        verdict("range", { direction: "long", target: 105 }),
        verdict("chart", { direction: "short", target: 94 }),
      ],
    });
    const out = classifyOutcome(s, exc(3, 0.1));
    expect(out.analystsWrong).toEqual(["chart"]);
    expect(out.detail.join(" ")).toContain("Chart Analyst read this the other way");
    // A win charges nobody for abstaining, because nobody abstained.
    expect(out.analystsAbstained).toEqual([]);
  });

  it("does not treat a TP status closed at a loss as a win", () => {
    // TP1 then stopped for a net loss: the status alone would say "success".
    const s = signal({
      status: "TP1_HIT",
      resultPnlPct: -1.2,
      verdicts: [verdict("candleClose", { direction: "long", target: 102, entry: 100 })],
    });
    const out = classifyOutcome(s, exc(1.2, 1));
    expect(out.win).toBe(false);
    expect(out.reason).toBe("unexpected_reversal");
  });
});

/* ------------------------------------------------------------------ *
 * Failure taxonomy
 * ------------------------------------------------------------------ */

describe("classifyOutcome — failure taxonomy", () => {
  const closeVote = verdict("candleClose", {
    direction: "long",
    confidence: 85,
    entry: 100,
    target: 106,
    invalidation: 98,
  });
  const rangeVote = verdict("range", {
    direction: "long",
    confidence: 75,
    entry: 100,
    target: 105,
    invalidation: 96,
  });

  it("classifies a decisive close that failed immediately as a false breakout", () => {
    const out = classifyOutcome(signal({ verdicts: [closeVote] }), exc(0.15, 1));
    expect(out.reason).toBe("false_breakout");
    expect(out.reasonLabel).toMatch(/False breakout/);
    expect(out.analystsWrong).toEqual(["candleClose"]);
    expect(out.detail.join(" ")).toContain("100");
  });

  it("classifies a boundary trade that never rejected as a range invalidation", () => {
    const out = classifyOutcome(signal({ verdicts: [rangeVote] }), exc(0.1, 1));
    expect(out.reason).toBe("range_invalidation");
    expect(out.analystsWrong).toEqual(["range"]);
    expect(out.detail.join(" ")).toContain("96");
  });

  it("falls back to failed_rejection when the range vote quoted no invalidation", () => {
    const noStop = verdict("range", { direction: "long", confidence: 75, entry: 100, target: 105 });
    const out = classifyOutcome(signal({ verdicts: [noStop] }), exc(0.1, 1));
    expect(out.reason).toBe("failed_rejection");
    expect(out.detail.join(" ")).toContain("range low");
  });

  it("prefers false_breakout over range_invalidation when both voted", () => {
    // Most-specific-first: a decisive close that failed is the more useful
    // fact, and the module that let it through is the one to charge.
    const out = classifyOutcome(signal({ verdicts: [closeVote, rangeVote] }), exc(0.1, 1));
    expect(out.reason).toBe("false_breakout");
    expect(out.analystsWrong).toEqual(expect.arrayContaining(["candleClose", "range"]));
  });

  it("classifies a move that worked and then reversed as a management outcome", () => {
    const out = classifyOutcome(signal({ verdicts: [closeVote, rangeVote] }), exc(1.4, 1));
    expect(out.reason).toBe("unexpected_reversal");
    // Reached 1.4R in favour: the read was right, so nobody is charged.
    expect(out.analystsWrong).toEqual([]);
    expect(out.analystsRight).toEqual(expect.arrayContaining(["candleClose", "range"]));
    expect(out.detail.join(" ")).toMatch(/management outcome, not a bad read/);
  });

  it("blames a weak candle close that was flagged at signal time", () => {
    const flagged = verdict("candleClose", {
      direction: "none",
      qualified: false,
      gate: "abstains — close is marginal, not decisive",
    });
    const chartVote = verdict("chart", { direction: "long", confidence: 72, target: 106 });
    const out = classifyOutcome(signal({ verdicts: [flagged, chartVote] }), exc(0.4, 1));
    expect(out.reason).toBe("weak_candle_close");
    expect(out.analystsWrong).toEqual(["chart"]);
    expect(out.detail.join(" ")).toContain("marginal");
  });

  it("classifies an expiry that never moved as no-move, charging nobody", () => {
    const out = classifyOutcome(
      signal({ status: "EXPIRED", resultPnlPct: 0.1, verdicts: [closeVote, rangeVote] }),
      exc(0.2, 0.3)
    );
    expect(out.reason).toBe("expired_no_move");
    // +0.1% is money made, so `win` follows the P/L and agrees with the
    // dashboard — but a market that went nowhere vindicates nobody, so neither
    // supporter is credited either.
    expect(out.win).toBe(true);
    expect(out.analystsWrong).toEqual([]);
    expect(out.analystsRight).toEqual([]);
    expect(out.detail.join(" ")).toMatch(/charged or credited for a market that did nothing/);
  });

  it("still charges an expiry that moved against the position", () => {
    const out = classifyOutcome(
      signal({ status: "EXPIRED", resultPnlPct: -1.8, verdicts: [rangeVote] }),
      exc(0.1, 0.9)
    );
    expect(out.reason).not.toBe("expired_no_move");
    expect(out.analystsWrong).toEqual(["range"]);
  });

  it("says it cannot attribute a signal with no verdicts recorded", () => {
    const out = classifyOutcome(signal({ verdicts: [] }), exc(0.2, 1));
    expect(out.reason).toBe("other");
    expect(out.analystsWrong).toEqual([]);
    expect(out.detail.join(" ")).toMatch(/cannot be attributed/);
  });
});

/* ------------------------------------------------------------------ *
 * Attribution fairness
 * ------------------------------------------------------------------ */

describe("classifyOutcome — attribution fairness", () => {
  it("credits an analyst that abstained on a loser rather than charging it", () => {
    const out = classifyOutcome(
      signal({
        verdicts: [
          verdict("candleClose", { direction: "long", confidence: 82, entry: 100, target: 106 }),
          verdict("chart", { direction: "none", qualified: false, gate: "abstains — only 2 analogues" }),
          verdict("range", { direction: "none", qualified: false, gate: "abstains — market is trending" }),
        ],
      }),
      exc(0.1, 1)
    );
    // Abstaining must never look the same as being wrong, or the quality gates
    // in confluence.ts would score as defects.
    expect(out.analystsWrong).toEqual(["candleClose"]);
    expect(out.analystsAbstained).toEqual(expect.arrayContaining(["chart", "range"]));
    expect(out.analystsRight).not.toContain("chart");
    expect(out.detail.join(" ")).toMatch(/abstained and were vindicated/);
  });

  it("credits an analyst that argued the other way on a loser", () => {
    const out = classifyOutcome(
      signal({
        verdicts: [
          verdict("candleClose", { direction: "long", confidence: 82, entry: 100, target: 106 }),
          verdict("chart", { direction: "short", confidence: 71, target: 94 }),
        ],
      }),
      exc(0.1, 1)
    );
    expect(out.analystsWrong).toEqual(["candleClose"]);
    expect(out.analystsRight).toEqual(["chart"]);
    expect(out.detail.join(" ")).toMatch(/disagreed at signal time and was right/);
  });

  it("never lists the same analyst as both right and duplicated", () => {
    const out = classifyOutcome(
      signal({
        verdicts: [
          verdict("candleClose", { direction: "long", confidence: 82, entry: 100, target: 106 }),
          verdict("chart", { direction: "short", confidence: 71, target: 94 }),
          verdict("range", { direction: "short", confidence: 68, target: 95 }),
        ],
      }),
      // 1.4R favourable puts supporters in `right`, and the opposing branch
      // then appends its own — the de-dup guard is what keeps this a set.
      exc(1.4, 1)
    );
    expect(new Set(out.analystsRight).size).toBe(out.analystsRight.length);
    expect(out.analystsRight).toEqual(expect.arrayContaining(["candleClose", "chart", "range"]));
  });

  it("mirrors the whole classification for a short", () => {
    const short = signal({
      side: "SELL",
      entry: 100,
      stopLoss: 102,
      tp1: 98,
      tp2: 96,
      tp3: 94,
      status: "TP3_HIT",
      resultPnlPct: 4,
      verdicts: [
        verdict("candleClose", { direction: "short", confidence: 85, entry: 100, target: 96 }),
        verdict("chart", { direction: "long", confidence: 70, target: 106 }),
      ],
    });
    const out = classifyOutcome(short, exc(2.1, 0.2));
    expect(out.win).toBe(true);
    expect(out.reason).toBe("target_reached");
    expect(out.workingConfirmation).toContain("Candle Close Expansion");
    expect(out.analystsRight).toEqual(["candleClose"]);
    expect(out.analystsWrong).toEqual(["chart"]);
  });
});
