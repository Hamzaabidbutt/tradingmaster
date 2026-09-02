import { describe, expect, it } from "vitest";
import { classifyBucket, OutcomeBucket } from "@/engines/outcomeBuckets";

/**
 * The shadow-recording rule, and the slicing it exists to enable.
 *
 * The persist path itself needs a database, so what is pinned here is the
 * logic that decides what a slice *means* — mirrored from the record route
 * against the same `classifyBucket` the rest of the app uses.
 *
 * The bug this feature fixes is silent and structural: signals arriving into
 * an occupied symbol+timeframe slot used to be discarded, so the recorded set
 * was "whichever setup happened to arrive when a slot was free". Good setups
 * cluster in time, so that systematically kept the first of each cluster and
 * threw the rest away — and the resulting win rate described the slot
 * allocator rather than the engine.
 */

interface Row {
  bucket: OutcomeBucket;
  resultPnlPct: number | null;
  shadow: boolean;
  regime: string | null;
}

const MIN_SAMPLE = 10;

/** The record route's slice reducer, mirrored. */
function slice(rows: Row[]) {
  const counts: Record<OutcomeBucket, number> = {
    active: 0,
    successful: 0,
    partial: 0,
    failed: 0,
  };
  for (const r of rows) counts[r.bucket]++;
  const resolved = counts.successful + counts.partial + counts.failed;
  const closed = rows.filter((r) => r.bucket !== "active" && r.resultPnlPct != null);
  return {
    counts,
    resolved,
    accuracyPct:
      resolved >= MIN_SAMPLE
        ? Number((((counts.successful + counts.partial * 0.5) / resolved) * 100).toFixed(1))
        : null,
    avgPnlPct:
      closed.length > 0
        ? Number((closed.reduce((s, x) => s + (x.resultPnlPct ?? 0), 0) / closed.length).toFixed(2))
        : null,
  };
}

const row = (
  bucket: OutcomeBucket,
  pnl: number | null,
  shadow = false,
  regime: string | null = "risk_on"
): Row => ({ bucket, resultPnlPct: pnl, shadow, regime });

describe("shadow and regime slicing", () => {
  it("keeps running positions out of the resolved denominator", () => {
    const s = slice([
      row("successful", 2),
      row("failed", -1),
      row("active", null),
      row("active", null),
    ]);
    // Four signals, two outcomes. A running trade is not a result.
    expect(s.counts.active).toBe(2);
    expect(s.resolved).toBe(2);
  });

  it("counts a partial as half a success, here as everywhere else", () => {
    const rows: Row[] = [
      ...Array.from({ length: 5 }, () => row("successful", 3)),
      ...Array.from({ length: 5 }, () => row("partial", -0.2)),
    ];
    // 5 + 2.5 out of 10.
    expect(slice(rows).accuracyPct).toBe(75);
  });

  it("withholds a rate below the sample floor but still reports the counts", () => {
    const s = slice([row("successful", 4), row("failed", -2)]);
    expect(s.accuracyPct).toBeNull();
    expect(s.counts.successful).toBe(1);
    expect(s.counts.failed).toBe(1);
    // The average is still shown: two real outcomes are two real outcomes,
    // and it is the *rate* that misleads at this size, not the P/L.
    expect(s.avgPnlPct).toBe(1);
  });

  it("separates taken from shadow cleanly", () => {
    const rows: Row[] = [
      row("successful", 3, false),
      row("failed", -1, false),
      row("successful", 5, true),
      row("successful", 4, true),
    ];
    const taken = slice(rows.filter((r) => !r.shadow));
    const shadow = slice(rows.filter((r) => r.shadow));

    expect(taken.resolved).toBe(2);
    expect(shadow.resolved).toBe(2);
    // This is the case the feature exists to surface: the signals that were
    // suppressed did better than the ones that got a slot, which means the
    // headline number was measuring arrival order.
    expect(shadow.avgPnlPct!).toBeGreaterThan(taken.avgPnlPct!);
  });

  it("splits by regime without losing or double-counting a signal", () => {
    const rows: Row[] = [
      row("successful", 3, false, "risk_on"),
      row("successful", 2, false, "risk_on"),
      row("failed", -4, false, "risk_off"),
      row("failed", -3, false, "risk_off"),
      row("partial", 0, false, null),
    ];
    const regimes = [...new Set(rows.map((r) => r.regime ?? "unknown"))];
    const slices = regimes.map((g) =>
      slice(rows.filter((r) => (r.regime ?? "unknown") === g))
    );
    const total = slices.reduce((s, x) => s + x.resolved, 0);
    expect(total).toBe(rows.length);
    expect(regimes).toContain("unknown");
  });

  it("shows the regime split a blended number would hide", () => {
    // The exact situation the tag is for: mediocre overall, genuinely good in
    // one regime and bad in the other.
    const rows: Row[] = [
      ...Array.from({ length: 10 }, () => row("successful", 4, false, "risk_on")),
      ...Array.from({ length: 10 }, () => row("failed", -4, false, "risk_off")),
    ];
    const blended = slice(rows);
    const on = slice(rows.filter((r) => r.regime === "risk_on"));
    const off = slice(rows.filter((r) => r.regime === "risk_off"));

    expect(blended.accuracyPct).toBe(50);
    expect(on.accuracyPct).toBe(100);
    expect(off.accuracyPct).toBe(0);
    // A 50% blended read is the average of a good strategy and a bad one, and
    // says nothing useful about either.
    expect(blended.avgPnlPct).toBe(0);
  });

  it("agrees with classifyBucket rather than reimplementing it", () => {
    // The slice trusts whatever bucket the shared rule assigned; if these ever
    // diverge the record starts disagreeing with Signal History.
    expect(classifyBucket({ status: "ACTIVE", resultPnlPct: null })).toBe("active");
    expect(classifyBucket({ status: "TP3_HIT", resultPnlPct: 5 })).toBe("successful");
    expect(classifyBucket({ status: "STOPPED", resultPnlPct: -2 })).toBe("failed");
    expect(
      classifyBucket({
        status: "STOPPED",
        resultPnlPct: -1,
        outcomeAnalysis: { excursion: { targetProgressPct: 120 } } as never,
      })
    ).toBe("partial");
  });
});
