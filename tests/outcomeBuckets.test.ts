import { describe, expect, it } from "vitest";
import {
  bucketScore,
  classifyBucket,
  isActiveStatus,
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
    // every pre-migration loss as a partial success.
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

  it("marks a losing trade that tagged TP1 as partial, not failed", () => {
    const s = signal({ status: "STOPPED", resultPnlPct: -1.8, outcomeAnalysis: withProgress(120) });
    expect(classifyBucket(s)).toBe("partial");
  });

  it("marks a losing trade that never tagged TP1 as failed", () => {
    const s = signal({ status: "STOPPED", resultPnlPct: -2.6, outcomeAnalysis: withProgress(38) });
    expect(classifyBucket(s)).toBe("failed");
  });

  it("classifies an expiry by whether the target was ever reached", () => {
    expect(classifyBucket(signal({ status: "EXPIRED", resultPnlPct: -0.2, outcomeAnalysis: withProgress(101) }))).toBe(
      "partial"
    );
    expect(classifyBucket(signal({ status: "EXPIRED", resultPnlPct: -0.2, outcomeAnalysis: null }))).toBe("failed");
  });

  it("treats exact breakeven as not a win", () => {
    // 0 is not > 0: a flat trade made nothing, so it falls to partial/failed
    // depending on whether the call was directionally right.
    expect(classifyBucket(signal({ status: "STOPPED", resultPnlPct: 0 }))).toBe("failed");
    expect(classifyBucket(signal({ status: "STOPPED", resultPnlPct: 0, outcomeAnalysis: withProgress(100) }))).toBe(
      "partial"
    );
  });

  it("treats a missing P/L as no gain rather than a win", () => {
    expect(classifyBucket(signal({ status: "STOPPED", resultPnlPct: null }))).toBe("failed");
  });
});

describe("bucketScore", () => {
  it("scores a partial as half a win", () => {
    expect(bucketScore("successful")).toBe(1);
    expect(bucketScore("partial")).toBe(0.5);
    expect(bucketScore("failed")).toBe(0);
    // Running signals contribute nothing to accuracy until they resolve.
    expect(bucketScore("active")).toBe(0);
  });

  it("keeps weighted accuracy between the two naive readings", () => {
    // 4 wins, 2 partials, 4 failures out of 10 resolved.
    const buckets = [
      ...Array(4).fill("successful" as const),
      ...Array(2).fill("partial" as const),
      ...Array(4).fill("failed" as const),
    ];
    const weighted = buckets.reduce((s, b) => s + bucketScore(b), 0) / buckets.length;
    expect(weighted).toBeCloseTo(0.5, 6);
    // Strictly better than counting partials as losses (0.4), strictly worse
    // than counting them as wins (0.6) — the point of the half weight.
    expect(weighted).toBeGreaterThan(0.4);
    expect(weighted).toBeLessThan(0.6);
  });
});
