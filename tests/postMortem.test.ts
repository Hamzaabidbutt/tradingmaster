import { describe, expect, it } from "vitest";
import { buildPostMortem, PostMortemSignal } from "@/engines/postMortem";
import { OutcomeAnalysis } from "@/engines/types";

/**
 * A post-mortem that finds something in every record is worthless, because a
 * young record will always contain a striking-looking slice. Most of what is
 * pinned here is the refusal: gates on both sides of every comparison, and an
 * explicit statement when the answer is "not enough trades yet".
 */

const T0 = 1_700_000_000;

function excursion(over: Partial<OutcomeAnalysis["excursion"]> = {}): OutcomeAnalysis {
  return {
    win: false,
    reason: "stop_hit" as never,
    reasonLabel: "Stopped",
    detail: [],
    workingConfirmation: null,
    topContributor: null,
    analystsRight: [],
    analystsWrong: [],
    analystsAbstained: [],
    excursion: {
      maxFavourableR: 0.4,
      maxAdverseR: 0.5,
      maxFavourablePct: 1,
      maxAdversePct: 1,
      targetProgressPct: 40,
      ...over,
    } as OutcomeAnalysis["excursion"],
  };
}

let seq = 0;
function sig(over: Partial<PostMortemSignal> = {}): PostMortemSignal {
  seq++;
  return {
    id: `s${seq}`,
    symbol: "UNIUSDT",
    timeframe: "1h",
    side: "BUY",
    status: "STOPPED",
    source: "COMPOSITE",
    confidence: 70,
    entry: 100,
    stopLoss: 98, // 2% risk, so resultPnlPct / 2 = R
    tp1: 104,
    resultPnlPct: -2,
    outcomeReason: "stop_hit",
    outcomeAnalysis: excursion(),
    regime: "risk_on",
    shadow: false,
    earlyExitReason: null,
    managementStage: "initial",
    createdAt: T0,
    closedAt: T0 + 3600,
    ...over,
  };
}

/** A trade that reached TP1 — a success under the app-wide rule. */
const win = (over: Partial<PostMortemSignal> = {}) =>
  sig({
    status: "TP3_HIT",
    resultPnlPct: 4,
    outcomeAnalysis: excursion({ targetProgressPct: 140, maxAdverseR: 0.3 }),
    ...over,
  });

const loss = (over: Partial<PostMortemSignal> = {}) => sig(over);

const many = <T,>(n: number, f: () => T): T[] => Array.from({ length: n }, f);

describe("buildPostMortem — accounting", () => {
  it("counts only decided trades in the rate", () => {
    const r = buildPostMortem([
      ...many(6, () => win()),
      ...many(6, () => loss()),
      ...many(9, () => sig({ status: "BREAKEVEN", resultPnlPct: -0.03 })),
      ...many(4, () => sig({ status: "ACTIVE", resultPnlPct: null })),
    ]);
    expect(r.decided).toBe(12);
    expect(r.overall.winRatePct).toBe(50);
    expect(r.overall.breakEvens).toBe(9);
    // Running trades are not closed at all.
    expect(r.totalClosed).toBe(21);
  });

  it("computes expectancy in R, not in percent", () => {
    // 2% risk per trade. A +4% win is +2R; a -2% loss is -1R.
    const r = buildPostMortem([...many(6, () => win()), ...many(6, () => loss())]);
    expect(r.overall.avgWinR).toBeCloseTo(2, 3);
    expect(r.overall.avgLossR).toBeCloseTo(-1, 3);
    // Half at +2R and half at -1R is +0.5R per trade.
    expect(r.overall.expectancyR).toBeCloseTo(0.5, 3);
  });

  it("withholds every rate below the sample floor", () => {
    const r = buildPostMortem([...many(3, () => win()), ...many(3, () => loss())]);
    expect(r.overall.winRatePct).toBeNull();
    expect(r.overall.expectancyR).toBeNull();
    // The counts are still shown — they are facts, it is the rate that misleads.
    expect(r.overall.wins).toBe(3);
    expect(r.openQuestions.join(" ")).toMatch(/have decided/i);
  });

  it("keeps shadow signals out of the taken slice", () => {
    const r = buildPostMortem([
      ...many(12, () => win()),
      ...many(12, () => win({ shadow: true })),
    ]);
    expect(r.taken.decided).toBe(12);
    expect(r.shadow.decided).toBe(12);
  });
});

describe("buildPostMortem — stop placement", () => {
  it("says the stop is too tight when winners routinely nearly get stopped", () => {
    const r = buildPostMortem(
      many(20, () => win({ outcomeAnalysis: excursion({ targetProgressPct: 140, maxAdverseR: 0.95 }) }))
    );
    expect(r.stops.p90AdverseR!).toBeGreaterThan(0.9);
    expect(r.stops.verdict).toMatch(/fills rather than wrong reads|widening the stop/i);
  });

  it("says the stop is too wide when winners barely draw down", () => {
    const r = buildPostMortem(
      many(20, () => win({ outcomeAnalysis: excursion({ targetProgressPct: 140, maxAdverseR: 0.2 }) }))
    );
    expect(r.stops.verdict).toMatch(/wider than the trades need|tightening/i);
  });

  it("refuses to judge stop placement on too few winners", () => {
    const r = buildPostMortem([...many(4, () => win()), ...many(20, () => loss())]);
    expect(r.stops.verdict).toMatch(/below the \d+ needed/i);
    expect(r.stops.deepDrawdownPct).toBeNull();
    expect(r.openQuestions.join(" ")).toMatch(/highest-value question/i);
  });
});

describe("buildPostMortem — target reachability", () => {
  it("separates near misses from wrong reads", () => {
    const nearMisses = buildPostMortem(
      many(20, () => loss({ outcomeAnalysis: excursion({ targetProgressPct: 92 }) }))
    );
    expect(nearMisses.targets.nearMissPct).toBe(100);
    expect(nearMisses.targets.verdict).toMatch(/not a directional problem|target was set/i);

    const wrongReads = buildPostMortem(
      many(20, () => loss({ outcomeAnalysis: excursion({ targetProgressPct: 12 }) }))
    );
    expect(wrongReads.targets.verdict).toMatch(/wrong from close to the start|entry criteria/i);
  });
});

describe("buildPostMortem — findings and their gates", () => {
  it("finds a real, large, well-sampled difference", () => {
    const r = buildPostMortem([
      ...many(14, () => win({ confidence: 90 })),
      ...many(2, () => loss({ confidence: 90 })),
      ...many(3, () => win({ confidence: 60 })),
      ...many(13, () => loss({ confidence: 60 })),
    ]);
    const conf = r.findings.find((f) => f.dimension === "Confidence");
    expect(conf).toBeDefined();
    expect(conf!.gapPts).toBeGreaterThan(50);
    expect(conf!.recommendation).toMatch(/raise the minimum/i);
  });

  it("refuses a comparison where one side is thin", () => {
    // 100% from three trades against 40% from sixty is three trades, not a
    // finding. This is the whole reason both sides are gated.
    const r = buildPostMortem([
      ...many(3, () => win({ confidence: 90 })),
      ...many(24, () => win({ confidence: 60 })),
      ...many(36, () => loss({ confidence: 60 })),
    ]);
    expect(r.findings.find((f) => f.dimension === "Confidence")).toBeUndefined();
  });

  it("refuses a comparison whose gap is small", () => {
    const r = buildPostMortem([
      ...many(11, () => win({ confidence: 90 })),
      ...many(9, () => loss({ confidence: 90 })),
      ...many(10, () => win({ confidence: 60 })),
      ...many(10, () => loss({ confidence: 60 })),
    ]);
    expect(r.findings.find((f) => f.dimension === "Confidence")).toBeUndefined();
  });

  it("says nothing found is an answer, not a gap", () => {
    const r = buildPostMortem([...many(15, () => win()), ...many(15, () => loss())]);
    expect(r.findings).toEqual([]);
    expect(r.openQuestions.join(" ")).toMatch(/real answer, not a missing one/i);
  });

  it("warns that a finding is one comparison among several", () => {
    const r = buildPostMortem([
      ...many(14, () => win({ confidence: 90 })),
      ...many(2, () => loss({ confidence: 90 })),
      ...many(3, () => win({ confidence: 60 })),
      ...many(13, () => loss({ confidence: 60 })),
    ]);
    expect(r.findings[0].detail).toMatch(/by chance|lead to watch/i);
  });

  it("calls out a confidence score that is not measuring what it claims", () => {
    // Low confidence outperforming high is the diagnostic that matters most,
    // and the recommendation has to say so rather than suggesting a filter.
    const r = buildPostMortem([
      ...many(3, () => win({ confidence: 90 })),
      ...many(13, () => loss({ confidence: 90 })),
      ...many(14, () => win({ confidence: 60 })),
      ...many(2, () => loss({ confidence: 60 })),
    ]);
    const conf = r.findings.find((f) => f.dimension === "Confidence")!;
    expect(conf.recommendation).toMatch(/not measuring what it claims|sort order/i);
  });
});

describe("buildPostMortem — honesty", () => {
  it("never claims to be a backtest", () => {
    const r = buildPostMortem(many(20, () => win()));
    expect(r.note).toMatch(/not a backtest/i);
    expect(r.note).toMatch(/biased sample/i);
  });

  it("counts failure reasons without inventing them", () => {
    const r = buildPostMortem([
      ...many(6, () => loss({ outcomeReason: "false_breakout" })),
      ...many(4, () => loss({ outcomeReason: "range_invalidation" })),
      ...many(2, () => loss({ outcomeReason: null, outcomeAnalysis: null })),
    ]);
    expect(r.failureReasons[0]).toEqual({ reason: "false_breakout", count: 6, sharePct: 50 });
    expect(r.failureReasons.some((x) => x.reason === "unclassified")).toBe(true);
  });

  it("survives an empty record without throwing", () => {
    const r = buildPostMortem([]);
    expect(r.decided).toBe(0);
    expect(r.overall.winRatePct).toBeNull();
    expect(r.findings).toEqual([]);
    expect(r.openQuestions.length).toBeGreaterThan(0);
  });

  it("survives rows with no excursion or a zero-width stop", () => {
    const r = buildPostMortem([
      ...many(6, () => win({ outcomeAnalysis: null })),
      ...many(6, () => loss({ entry: 100, stopLoss: 100 })),
    ]);
    expect(Number.isFinite(r.decided)).toBe(true);
    for (const s of [r.overall, r.taken, r.shadow]) {
      if (s.expectancyR != null) expect(Number.isFinite(s.expectancyR)).toBe(true);
    }
  });
});
