import { describe, expect, it } from "vitest";
import {
  bucketScore,
  classifyBucket,
  isActiveStatus,
  resolvedCount,
  winRate,
  reachedFirstTarget,
  type BucketInput,
} from "@/engines/outcomeBuckets";
import { OutcomeAnalysis } from "@/engines/types";

/** Minimal outcome analysis carrying only the field the buckets read. */
function withProgress(targetProgressPct: number | undefined): OutcomeAnalysis {
  return {
    excursion: { targetProgressPct },
  } as unknown as OutcomeAnalysis;
}

function signal(over: Partial<BucketInput>): BucketInput {
  return { status: "STOPPED", resultPnlPct: -1.4, outcomeAnalysis: null, ...over };
}

describe("active statuses", () => {
  it("treats a partial fill as still running, not as an outcome", () => {
    for (const status of ["ACTIVE", "TP1_HIT", "TP2_HIT"]) {
      expect(isActiveStatus(status)).toBe(true);
      expect(classifyBucket(signal({ status, resultPnlPct: null }))).toBe("active");
    }
  });

  it("does not let a stray P/L on an open signal resolve it early", () => {
    // A running TP1_HIT signal carries unrealised P/L; it is not a result.
    expect(classifyBucket(signal({ status: "TP1_HIT", resultPnlPct: 3.2 }))).toBe("active");
  });

  it("closed statuses are not active", () => {
    for (const status of ["TP3_HIT", "STOPPED", "EXPIRED"]) {
      expect(isActiveStatus(status)).toBe(false);
    }
  });
});

describe("reachedFirstTarget", () => {
  it("counts TP3 as having passed TP1 even with no analysis attached", () => {
    // Price cannot reach the third target without crossing the first.
    expect(reachedFirstTarget(signal({ status: "TP3_HIT", outcomeAnalysis: null }))).toBe(true);
  });

  it("reads 100% target progress as the level being tagged", () => {
    expect(reachedFirstTarget(signal({ outcomeAnalysis: withProgress(100) }))).toBe(true);
    expect(reachedFirstTarget(signal({ outcomeAnalysis: withProgress(163) }))).toBe(true);
  });

  it("treats short of 100% as never tagged", () => {
    expect(reachedFirstTarget(signal({ outcomeAnalysis: withProgress(99.9) }))).toBe(false);
    expect(reachedFirstTarget(signal({ outcomeAnalysis: withProgress(0) }))).toBe(false);
  });

  it("treats unknown progress as not reached", () => {
    // Legacy rows carry no excursion. Guessing "reached" here would relabel
    // every pre-migration loss as a success.
    expect(reachedFirstTarget(signal({ outcomeAnalysis: null }))).toBe(false);
    expect(reachedFirstTarget(signal({ outcomeAnalysis: withProgress(undefined) }))).toBe(false);
  });
});

describe("classifyBucket", () => {
  it("calls any positive realised P/L a success", () => {
    expect(classifyBucket(signal({ status: "TP3_HIT", resultPnlPct: 6.1 }))).toBe("successful");
    // Even a stop that closed green — trailed above entry — is a win.
    expect(classifyBucket(signal({ status: "STOPPED", resultPnlPct: 0.4 }))).toBe("successful");
  });

  it("counts reaching TP1 as success even when the trade closed red", () => {
    // TP1 is the claim the signal made. Once management moves the stop to
    // break-even there, a trade that gets there cannot become a loss — so
    // "reached TP1" and "did not lose" describe the same event, and the
    // closing price is a fact about management rather than about the read.
    const s = signal({ status: "STOPPED", resultPnlPct: -1.8, outcomeAnalysis: withProgress(120) });
    expect(classifyBucket(s)).toBe("successful");
  });

  it("gives a protected stop its own bucket, not a loss", () => {
    // The failure this guards: filing break-evens as losses makes active
    // management look like it damages the record, since every trade saved
    // from a full stop becomes a mark against the engine.
    const s = signal({ status: "BREAKEVEN", resultPnlPct: -0.05, outcomeAnalysis: withProgress(60) });
    expect(classifyBucket(s)).toBe("breakeven");
  });

  it("marks a losing trade that never tagged TP1 as failed", () => {
    const s = signal({ status: "STOPPED", resultPnlPct: -2.6, outcomeAnalysis: withProgress(38) });
    expect(classifyBucket(s)).toBe("failed");
  });

  it("classifies an expiry by whether the target was ever reached", () => {
    expect(classifyBucket(signal({ status: "EXPIRED", resultPnlPct: -0.2, outcomeAnalysis: withProgress(101) }))).toBe(
      "successful"
    );
    expect(classifyBucket(signal({ status: "EXPIRED", resultPnlPct: -0.2, outcomeAnalysis: null }))).toBe("failed");
  });

  it("treats a flat close that never reached TP1 as a failure", () => {
    // 0 is not > 0, and without the protected stop that would make it a
    // break-even, a flat trade that never got anywhere is a loss.
    expect(classifyBucket(signal({ status: "STOPPED", resultPnlPct: 0 }))).toBe("failed");
    expect(classifyBucket(signal({ status: "STOPPED", resultPnlPct: 0, outcomeAnalysis: withProgress(100) }))).toBe(
      "successful"
    );
  });

  it("treats a missing P/L as no gain rather than a win", () => {
    expect(classifyBucket(signal({ status: "STOPPED", resultPnlPct: null }))).toBe("failed");
  });
});

describe("bucketScore and winRate", () => {
  it("scores only wins", () => {
    expect(bucketScore("successful")).toBe(1);
    expect(bucketScore("failed")).toBe(0);
    expect(bucketScore("breakeven")).toBe(0);
    expect(bucketScore("active")).toBe(0);
  });

  it("keeps break-evens out of the denominator entirely", () => {
    // 6 wins, 4 losses and 10 break-evens is a 60% win rate, not 30%.
    // Scoring break-evens zero would let a trader improve their measured
    // accuracy by managing their trades *worse*, which is backwards.
    const counts = { active: 3, successful: 6, breakeven: 10, failed: 4 };
    expect(resolvedCount(counts)).toBe(10);
    expect(winRate(counts)).toBe(60);
  });

  it("withholds a rate when nothing has decided", () => {
    expect(winRate({ active: 5, successful: 0, breakeven: 3, failed: 0 })).toBeNull();
  });

  it("never lets running trades pad the denominator", () => {
    const counts = { active: 40, successful: 3, breakeven: 0, failed: 1 };
    expect(resolvedCount(counts)).toBe(4);
    expect(winRate(counts)).toBe(75);
  });
});
