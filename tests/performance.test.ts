import { describe, expect, it } from "vitest";
import { computePerformance, parseVerdicts, PerfSignal } from "@/services/performanceService";
import { AnalystKey, AnalystVerdict, OutcomeAnalysis, OutcomeReason } from "@/engines/types";

/**
 * These tests exist to pin the *fairness* rules, not the arithmetic.
 *
 * The arithmetic is trivial; the rules are not, and getting them wrong would
 * quietly slander an analyst. Specifically: an abstention is not a loss, a
 * running partial is not a scored trade, and a strategy is not "worst" off a
 * handful of signals.
 */

const NAME: Record<AnalystKey, string> = {
  chart: "Chart Analyst",
  candleClose: "Candle Close Expansion",
  range: "Range Trading",
};

const BASIS: Record<AnalystKey, AnalystVerdict["basis"]> = {
  chart: "pattern_history",
  candleClose: "level_close",
  range: "range_boundary",
};

function verdict(
  analyst: AnalystKey,
  direction: AnalystVerdict["direction"],
  over: Partial<AnalystVerdict> = {}
): AnalystVerdict {
  return {
    analyst,
    name: NAME[analyst],
    basis: BASIS[analyst],
    direction,
    confidence: 80,
    qualified: direction !== "none",
    gate: direction === "none" ? "abstains — gate not met" : "qualified",
    entry: 100,
    target: direction === "short" ? 94 : 106,
    invalidation: direction === "short" ? 102 : 98,
    evidence: `${NAME[analyst]} evidence`,
    ...over,
  };
}

/** An analyst that saw the setup and declined to vote. */
function abstains(analyst: AnalystKey, gate = "abstains — gate not met"): AnalystVerdict {
  return verdict(analyst, "none", { qualified: false, gate });
}

let seq = 0;

function sig(over: Partial<PerfSignal> = {}): PerfSignal {
  seq++;
  return {
    id: `s${seq}`,
    symbol: "BTCUSDT",
    timeframe: "1h",
    side: "BUY",
    status: "TP3_HIT",
    confidence: 82,
    resultPnlPct: 3,
    outcomeReason: "target_reached",
    outcomeAnalysis: null,
    verdicts: [],
    createdAt: new Date(1_700_000_000_000 + seq * 3_600_000),
    ...over,
  };
}

const WIN = { status: "TP3_HIT", resultPnlPct: 3, outcomeReason: "target_reached" as const };
const LOSS = { status: "STOPPED", resultPnlPct: -2, outcomeReason: "failed_rejection" as const };

function analysis(over: Partial<OutcomeAnalysis> = {}): OutcomeAnalysis {
  return {
    win: true,
    reason: "target_reached",
    reasonLabel: "Target reached",
    detail: [],
    workingConfirmation: null,
    topContributor: null,
    analystsRight: [],
    analystsWrong: [],
    analystsAbstained: [],
    excursion: {
      maxFavourableR: 1.5,
      maxAdverseR: 0.3,
      maxFavourablePct: 3,
      maxAdversePct: 0.6,
      // null by default: most cases here are about win rates and attribution,
      // and the target-progress aggregate must be correct for rows that carry
      // no figure. Tests that care pass one in.
      targetProgressPct: null,
      bars: 12,
    },
    ...over,
  };
}

/** `n` copies of the same shape, so sample-size rules can be exercised. */
function many(n: number, build: (i: number) => Partial<PerfSignal>): PerfSignal[] {
  return Array.from({ length: n }, (_, i) => sig(build(i)));
}

function analystOf(report: ReturnType<typeof computePerformance>, key: AnalystKey) {
  return report.analysts.find((a) => a.analyst === key)!;
}

function metric(
  report: ReturnType<typeof computePerformance>,
  key: AnalystKey,
  label: string
): string | number | undefined {
  return analystOf(report, key).specific.find((m) => m.label === label)?.value;
}

/* ------------------------------------------------------------------ *
 * LONG / SHORT split
 * ------------------------------------------------------------------ */

describe("computePerformance — direction split", () => {
  // 3 longs (2 win) and 3 shorts (1 win), all supported by the chart analyst.
  const signals = [
    ...many(2, () => ({ side: "BUY" as const, ...WIN, verdicts: [verdict("chart", "long")] })),
    ...many(1, () => ({ side: "BUY" as const, ...LOSS, verdicts: [verdict("chart", "long")] })),
    ...many(1, () => ({ side: "SELL" as const, ...WIN, verdicts: [verdict("chart", "short")] })),
    ...many(2, () => ({ side: "SELL" as const, ...LOSS, verdicts: [verdict("chart", "short")] })),
  ];

  it("scores an analyst's longs and shorts separately", () => {
    const chart = analystOf(computePerformance(signals), "chart");
    expect(chart.totalSignals).toBe(6);
    expect(chart.longWins).toBe(2);
    expect(chart.longLosses).toBe(1);
    expect(chart.longWinRate).toBeCloseTo(66.7, 1);
    expect(chart.shortWins).toBe(1);
    expect(chart.shortLosses).toBe(2);
    expect(chart.shortWinRate).toBeCloseTo(33.3, 1);
    expect(chart.winRate).toBe(50);
  });

  it("reports the same split at the overall level", () => {
    const { overall } = computePerformance(signals);
    expect(overall.longSignals).toBe(3);
    expect(overall.shortSignals).toBe(3);
    // Overall side rates need MIN_SAMPLE, and 3 per side is under it — a null
    // here is the honest answer, not a bug.
    expect(overall.longWinRate).toBeNull();
    expect(overall.shortWinRate).toBeNull();
    expect(overall.winRate).toBe(50);
    expect(overall.avgProfitPct).toBe(3);
    expect(overall.avgLossPct).toBe(-2);
  });

  it("withholds a win rate below the minimum sample but still counts the trades", () => {
    const report = computePerformance(
      many(4, () => ({ ...LOSS, verdicts: [verdict("candleClose", "long")] }))
    );
    const cc = analystOf(report, "candleClose");
    expect(cc.totalSignals).toBe(4);
    expect(cc.losses).toBe(4);
    // 4 < MIN_SAMPLE: a 0% win rate off four trades is noise, not a record.
    expect(cc.winRate).toBeNull();
    expect(report.minSample).toBe(5);
  });
});

/* ------------------------------------------------------------------ *
 * Attribution fairness
 * ------------------------------------------------------------------ */

describe("computePerformance — attribution fairness", () => {
  const losers = many(6, () => ({
    ...LOSS,
    verdicts: [verdict("candleClose", "long"), abstains("chart"), abstains("range")],
  }));

  it("never counts an abstention as a loss", () => {
    const report = computePerformance(losers);
    const chart = analystOf(report, "chart");
    // The whole point of the quality gates in confluence.ts: declining to vote
    // must not look identical to being wrong, or the gates score as defects.
    expect(chart.totalSignals).toBe(0);
    expect(chart.losses).toBe(0);
    expect(chart.wins).toBe(0);
    expect(chart.winRate).toBeNull();
    expect(chart.abstentions).toBe(6);
    expect(chart.correctAbstentions).toBe(6);

    expect(analystOf(report, "candleClose").losses).toBe(6);
    expect(analystOf(report, "candleClose").winRate).toBe(0);
  });

  it("does not credit an abstention on a signal that won", () => {
    const report = computePerformance(
      many(5, () => ({ ...WIN, verdicts: [verdict("range", "long"), abstains("chart")] }))
    );
    const chart = analystOf(report, "chart");
    expect(chart.abstentions).toBe(5);
    // It abstained and the trade worked — the gate cost us this one.
    expect(chart.correctAbstentions).toBe(0);
  });

  it("credits an analyst that argued against a losing signal", () => {
    const report = computePerformance([
      ...many(3, () => ({ ...LOSS, verdicts: [verdict("candleClose", "long"), verdict("chart", "short")] })),
      ...many(2, () => ({ ...WIN, verdicts: [verdict("candleClose", "long"), verdict("chart", "short")] })),
    ]);
    const chart = analystOf(report, "chart");
    // Opposing is scored on its own axis, not folded into the win rate: the
    // chart analyst never supported these trades, so it owns none of them.
    expect(chart.totalSignals).toBe(0);
    expect(chart.correctlyOpposed).toBe(3);
  });

  it("only attributes a signal to an analyst that pointed the same way", () => {
    const report = computePerformance([
      sig({ side: "SELL", ...WIN, verdicts: [verdict("range", "long")] }),
    ]);
    expect(analystOf(report, "range").totalSignals).toBe(0);
  });

  it("counts rows written before attribution existed as legacy", () => {
    const report = computePerformance([
      ...many(2, () => ({ ...WIN, verdicts: [] })),
      ...many(3, () => ({ ...WIN, verdicts: [verdict("range", "long")] })),
    ]);
    expect(report.legacySignals).toBe(2);
    expect(report.attributedSignals).toBe(3);
  });
});

/* ------------------------------------------------------------------ *
 * Signal lifecycle buckets
 * ------------------------------------------------------------------ */

describe("computePerformance — lifecycle buckets", () => {
  it("treats a running partial as active and leaves it unscored", () => {
    const report = computePerformance([
      // TP1 tagged, position still open: resultPnlPct is not written yet.
      sig({ status: "TP1_HIT", resultPnlPct: null, outcomeReason: null, verdicts: [verdict("range", "long")] }),
      sig({ status: "ACTIVE", resultPnlPct: null, outcomeReason: null, verdicts: [verdict("range", "long")] }),
      sig({ ...LOSS, verdicts: [verdict("range", "long")] }),
    ]);
    expect(report.overall.active).toBe(2);
    expect(report.overall.successful).toBe(0);
    // Scoring the TP1 row would book an in-progress winner as a zero-P/L loss.
    expect(report.overall.failed).toBe(1);
    expect(analystOf(report, "range").totalSignals).toBe(1);
  });

  it("counts an expiry in profit as successful and one at a loss as failed", () => {
    const report = computePerformance([
      sig({ status: "EXPIRED", resultPnlPct: 1.4, outcomeReason: "closed_in_profit", verdicts: [] }),
      sig({ status: "EXPIRED", resultPnlPct: -0.6, outcomeReason: "expired_no_move", verdicts: [] }),
    ]);
    // The P/L sign is the discriminator, not the status — same rule the
    // /api/signals outcome filter applies, so the two never disagree.
    expect(report.overall.successful).toBe(1);
    expect(report.overall.failed).toBe(1);
    expect(report.overall.expired).toBe(2);
    expect(report.overall.active).toBe(0);
  });

  it("treats a target tagged and then given back as a failure", () => {
    const report = computePerformance([
      sig({ status: "STOPPED", resultPnlPct: -1.1, outcomeReason: "unexpected_reversal", verdicts: [verdict("chart", "long")] }),
    ]);
    expect(report.overall.successful).toBe(0);
    expect(analystOf(report, "chart").losses).toBe(1);
  });

  it("counts every row in totalSignals but only resolved ones in the rates", () => {
    const report = computePerformance([
      ...many(3, () => ({ status: "ACTIVE", resultPnlPct: null, outcomeReason: null })),
      ...many(5, () => ({ ...WIN })),
    ]);
    expect(report.overall.totalSignals).toBe(8);
    expect(report.overall.winRate).toBe(100);
  });
});

/* ------------------------------------------------------------------ *
 * Ranking and timeframes
 * ------------------------------------------------------------------ */

describe("computePerformance — ranking", () => {
  /** `n` signals for one analyst, the first `wins` of them profitable. */
  function record(analyst: AnalystKey, n: number, wins: number): PerfSignal[] {
    return many(n, (i) => ({
      ...(i < wins ? WIN : LOSS),
      verdicts: [verdict(analyst, "long")],
    }));
  }

  it("refuses to name a worst strategy when only one clears the ranking sample", () => {
    const report = computePerformance([...record("candleClose", 8, 6), ...record("chart", 4, 1)]);
    expect(report.overall.bestStrategy).toMatchObject({ key: "candleClose", winRate: 75, sample: 8 });
    // "Best and worst are the same analyst" is not a finding, and the chart
    // analyst's 4 signals are too few to be called worst.
    expect(report.overall.worstStrategy).toBeNull();
  });

  it("ranks best against worst once both clear it", () => {
    const report = computePerformance([...record("candleClose", 8, 6), ...record("range", 8, 2)]);
    expect(report.overall.bestStrategy?.key).toBe("candleClose");
    expect(report.overall.worstStrategy).toMatchObject({ key: "range", winRate: 25, sample: 8 });
  });

  it("names no strategy at all when nothing clears the ranking sample", () => {
    const report = computePerformance([...record("candleClose", 7, 7), ...record("range", 6, 0)]);
    // A 100%-from-7 "best strategy" is worse than no answer.
    expect(report.overall.bestStrategy).toBeNull();
    expect(report.overall.worstStrategy).toBeNull();
  });

  it("picks the best timeframe only from buckets with enough signals", () => {
    const report = computePerformance([
      // 1h: 3 signals, 2 wins → 66.7%. 4h: 2 signals, both wins → 100%.
      ...many(2, () => ({ timeframe: "1h", ...WIN, verdicts: [verdict("chart", "long")] })),
      ...many(1, () => ({ timeframe: "1h", ...LOSS, verdicts: [verdict("chart", "long")] })),
      ...many(2, () => ({ timeframe: "4h", ...WIN, verdicts: [verdict("chart", "long")] })),
    ]);
    const best = analystOf(report, "chart").bestTimeframe;
    // A perfect 4h record off two signals is not a "best-performing timeframe".
    expect(best).toMatchObject({ timeframe: "1h", sample: 3 });
    expect(best!.winRate).toBeCloseTo(66.7, 1);
  });

  it("returns no best timeframe when every bucket is too thin", () => {
    const report = computePerformance([
      sig({ timeframe: "15m", ...WIN, verdicts: [verdict("chart", "long")] }),
      sig({ timeframe: "1h", ...WIN, verdicts: [verdict("chart", "long")] }),
    ]);
    expect(analystOf(report, "chart").bestTimeframe).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Per-analyst metric sets
 * ------------------------------------------------------------------ */

describe("computePerformance — analyst-specific metrics", () => {
  it("counts confirmed breakouts and false breakouts for the candle-close analyst", () => {
    const report = computePerformance([
      ...many(2, () => ({ ...WIN, verdicts: [verdict("candleClose", "long")], outcomeAnalysis: analysis() })),
      ...many(2, () => ({
        ...LOSS,
        outcomeReason: "false_breakout" as OutcomeReason,
        verdicts: [verdict("candleClose", "long")],
        outcomeAnalysis: analysis({ win: false, reason: "false_breakout", excursion: { maxFavourableR: 0.1, maxAdverseR: 1, maxFavourablePct: 0.2, maxAdversePct: 2, targetProgressPct: null, bars: 6 } }),
      })),
      ...many(1, () => ({ ...LOSS, verdicts: [verdict("candleClose", "long")], outcomeAnalysis: analysis({ win: false }) })),
    ]);
    expect(metric(report, "candleClose", "Confirmed breakouts traded")).toBe(5);
    expect(metric(report, "candleClose", "Successful breakouts")).toBe(2);
    expect(metric(report, "candleClose", "Failed breakouts")).toBe(3);
    expect(metric(report, "candleClose", "False breakouts")).toBe(2);
    // (3 + 3 + 0.2 + 0.2 + 3) / 5
    expect(metric(report, "candleClose", "Avg move after confirmation")).toBe("1.88%");
  });

  it("separates range-low longs from range-high shorts", () => {
    // The gate text is the only stored discriminator between a mean-reversion
    // boundary trade and a breakout continuation — these strings must stay in
    // step with rangeVerdict() in confluence.ts.
    const mr = (dir: "long" | "short") =>
      verdict("range", dir, { gate: "validated range — 6 touches, 92% containment" });
    const cont = (dir: "long" | "short") =>
      verdict("range", dir, { gate: "breakout continuation — break under retest" });

    const report = computePerformance([
      sig({ side: "BUY", ...WIN, verdicts: [mr("long")] }),
      sig({ side: "SELL", ...WIN, verdicts: [mr("short")] }),
      sig({ side: "BUY", ...LOSS, outcomeReason: "range_invalidation", verdicts: [mr("long")] }),
      sig({ side: "BUY", ...WIN, verdicts: [cont("long")] }),
      sig({ side: "SELL", ...LOSS, outcomeReason: "false_breakout", verdicts: [cont("short")] }),
    ]);

    expect(metric(report, "range", "Successful range-low LONGs")).toBe(1);
    expect(metric(report, "range", "Successful range-high SHORTs")).toBe(1);
    expect(metric(report, "range", "Failed range setups")).toBe(1);
    expect(metric(report, "range", "Range invalidations")).toBe(1);
    expect(metric(report, "range", "False breakouts")).toBe(1);
    expect(metric(report, "range", "Breakout continuations (up)")).toBe(1);
    expect(metric(report, "range", "Breakdown continuations (down)")).toBe(1);
  });

  it("reports how often the chart analyst was the top contributor", () => {
    const report = computePerformance([
      sig({ ...WIN, verdicts: [verdict("chart", "long")], outcomeAnalysis: analysis({ topContributor: "chart" }) }),
      sig({ ...WIN, verdicts: [verdict("chart", "long")], outcomeAnalysis: analysis({ topContributor: "candleClose" }) }),
    ]);
    expect(metric(report, "chart", "Was top contributor")).toBe(1);
  });

  it("groups and sorts the reasons behind wins and losses", () => {
    const report = computePerformance([
      ...many(3, () => ({ ...LOSS, outcomeReason: "false_breakout" as OutcomeReason, verdicts: [verdict("candleClose", "long")] })),
      ...many(1, () => ({ ...LOSS, outcomeReason: "weak_candle_close" as OutcomeReason, verdicts: [verdict("candleClose", "long")] })),
      ...many(2, () => ({ ...WIN, verdicts: [verdict("candleClose", "long")] })),
    ]);
    const cc = analystOf(report, "candleClose");
    expect(cc.failureReasons[0]).toMatchObject({ reason: "false_breakout", count: 3 });
    expect(cc.failureReasons[1]).toMatchObject({ reason: "weak_candle_close", count: 1 });
    expect(cc.failureReasons[0].label).toMatch(/False breakout/);
    expect(cc.successReasons).toEqual([
      expect.objectContaining({ reason: "target_reached", count: 2 }),
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * Degenerate input
 * ------------------------------------------------------------------ */

describe("computePerformance — how close the losers got", () => {
  /** A loser that got `pct` of the way to its first target. */
  function loser(side: "BUY" | "SELL", pct: number | null): PerfSignal {
    return sig({
      ...LOSS,
      side,
      verdicts: [verdict("chart", side === "BUY" ? "long" : "short")],
      outcomeAnalysis: analysis({
        win: false,
        reason: "failed_rejection",
        excursion: {
          maxFavourableR: 0.4,
          maxAdverseR: 1,
          maxFavourablePct: 0.8,
          maxAdversePct: 2,
          targetProgressPct: pct,
          bars: 9,
        },
      }),
    });
  }

  it("averages the distance covered, and splits it by direction", () => {
    const report = computePerformance([
      loser("BUY", 20),
      loser("BUY", 40),
      loser("SELL", 70),
      loser("SELL", 90),
    ]);
    const p = report.overall.lossTargetProgress;
    expect(p.all).toMatchObject({ meanPct: 55, sample: 4, bestPct: 90 });
    // The split is the point: 30% on longs and 80% on shorts is a different
    // system from one that does 55% on both, and the pooled mean hides it.
    expect(p.long).toMatchObject({ meanPct: 30, sample: 2, bestPct: 40 });
    expect(p.short).toMatchObject({ meanPct: 80, sample: 2, bestPct: 90 });
  });

  it("excludes winners, whose figure is ≥100% by construction", () => {
    const report = computePerformance([
      loser("BUY", 20),
      sig({
        ...WIN,
        verdicts: [verdict("chart", "long")],
        outcomeAnalysis: analysis({ excursion: { maxFavourableR: 2, maxAdverseR: 0.2, maxFavourablePct: 4, maxAdversePct: 0.4, targetProgressPct: 250, bars: 20 } }),
      }),
    ]);
    // Pooling the 250 would report an average of 135% "approached before
    // failing", which describes nothing that happened.
    expect(report.overall.lossTargetProgress.all).toMatchObject({ meanPct: 20, sample: 1 });
  });

  it("withholds the mean rather than reporting 0 when no loser carries a figure", () => {
    // Legacy rows: real losses, no stored excursion progress. `null` says "we
    // do not know", `0` would say "price never moved" — a different claim.
    const report = computePerformance([loser("BUY", null), loser("SELL", null)]);
    expect(report.overall.lossTargetProgress.all).toEqual({ meanPct: null, sample: 0, bestPct: null });
    expect(report.overall.failed).toBe(2);
  });

  it("counts only the losers that actually carry a figure in the sample", () => {
    const report = computePerformance([loser("BUY", 50), loser("BUY", null), loser("BUY", 90)]);
    // Three losses, two usable figures. The sample must say 2, not 3, or the
    // mean would look better supported than it is.
    expect(report.overall.failed).toBe(3);
    expect(report.overall.lossTargetProgress.all).toMatchObject({ meanPct: 70, sample: 2 });
  });

  it("is empty, not zero, on an empty report", () => {
    expect(computePerformance([]).overall.lossTargetProgress.all).toEqual({
      meanPct: null,
      sample: 0,
      bestPct: null,
    });
  });
});

describe("computePerformance — empty and malformed input", () => {
  it("returns a usable empty report rather than NaN", () => {
    const report = computePerformance([]);
    expect(report.overall).toMatchObject({
      totalSignals: 0,
      successful: 0,
      failed: 0,
      active: 0,
      winRate: null,
      avgProfitPct: 0,
      avgLossPct: 0,
      bestStrategy: null,
      worstStrategy: null,
    });
    expect(report.analysts).toHaveLength(3);
    expect(report.analysts.every((a) => a.totalSignals === 0)).toBe(true);
  });

  it("keeps every analyst in the report even with no data for it", () => {
    const report = computePerformance(many(5, () => ({ ...WIN, verdicts: [verdict("range", "long")] })));
    expect(report.analysts.map((a) => a.analyst)).toEqual(["chart", "candleClose", "range"]);
    expect(analystOf(report, "chart").specific.length).toBeGreaterThan(0);
  });
});

describe("parseVerdicts", () => {
  it("returns an empty array for anything that is not a verdict array", () => {
    expect(parseVerdicts(null)).toEqual([]);
    expect(parseVerdicts(undefined)).toEqual([]);
    expect(parseVerdicts("nonsense")).toEqual([]);
    expect(parseVerdicts({ analyst: "chart" })).toEqual([]);
  });

  it("drops malformed entries but keeps well-formed ones", () => {
    const good = verdict("chart", "long");
    // Legacy rows and hand-edited documents both turn up here; one bad element
    // must not take the whole signal's attribution with it.
    expect(parseVerdicts([good, null, 42, { analyst: "range" }])).toEqual([good]);
  });
});
