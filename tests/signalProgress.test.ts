import { describe, expect, it } from "vitest";
import { computeLiveProgress } from "@/engines/signalProgress";

const long = { side: "BUY" as const, entry: 100, stopLoss: 95, tp1: 110, tp2: 120, tp3: 130 };
const short = { side: "SELL" as const, entry: 100, stopLoss: 105, tp1: 90, tp2: 80, tp3: 70 };

describe("live signal progress — long", () => {
  it("reports zero progress at entry", () => {
    const p = computeLiveProgress(long, 100);
    expect(p.pnlPct).toBe(0);
    expect(p.rMultiple).toBe(0);
    expect(p.progressToTp1Pct).toBe(0);
    expect(p.state).toBe("at_entry");
    expect(p.nextTarget?.label).toBe("TP1");
  });

  it("measures progress toward TP1 as distance covered", () => {
    // Halfway from 100 to 110.
    const p = computeLiveProgress(long, 105);
    expect(p.progressToTp1Pct).toBeCloseTo(50, 1);
    expect(p.pnlPct).toBeCloseTo(5, 3);
    expect(p.rMultiple).toBeCloseTo(1, 2); // 5 gained on 5 risked
    expect(p.state).toBe("in_profit");
    expect(p.targets[0].remainingPct).toBeCloseTo(5, 1);
  });

  it("marks TP1 hit and advances the next target", () => {
    const p = computeLiveProgress(long, 112);
    expect(p.targets[0].hit).toBe(true);
    expect(p.targets[0].progressPct).toBe(100);
    expect(p.targets[1].hit).toBe(false);
    expect(p.nextTarget?.label).toBe("TP2");
  });

  it("keeps a tagged target hit even after price retraces", () => {
    // Price fell back below TP1 but the evaluator already recorded TP1_HIT.
    const p = computeLiveProgress({ ...long, status: "TP1_HIT" }, 103);
    expect(p.targets[0].hit).toBe(true);
    expect(p.nextTarget?.label).toBe("TP2");
  });

  it("tracks drawdown toward the stop when underwater", () => {
    const p = computeLiveProgress(long, 97.5); // half of the 5-point risk
    expect(p.state).toBe("in_loss");
    expect(p.drawdownToStopPct).toBeCloseTo(50, 1);
    expect(p.rMultiple).toBeCloseTo(-0.5, 2);
    expect(p.progressToTp1Pct).toBe(0);
  });

  it("never reports negative or >100 progress", () => {
    for (const price of [50, 90, 100, 140, 500]) {
      const p = computeLiveProgress(long, price);
      expect(p.progressToTp1Pct).toBeGreaterThanOrEqual(0);
      expect(p.progressToTp1Pct).toBeLessThanOrEqual(100);
      expect(p.drawdownToStopPct).toBeGreaterThanOrEqual(0);
      expect(p.drawdownToStopPct).toBeLessThanOrEqual(100);
    }
  });
});

describe("live signal progress — short", () => {
  it("treats downward movement as favourable", () => {
    const p = computeLiveProgress(short, 95); // halfway to TP1 at 90
    expect(p.state).toBe("in_profit");
    expect(p.pnlPct).toBeCloseTo(5, 3);
    expect(p.progressToTp1Pct).toBeCloseTo(50, 1);
    expect(p.rMultiple).toBeCloseTo(1, 2);
  });

  it("treats upward movement as loss and measures stop drawdown", () => {
    const p = computeLiveProgress(short, 102.5);
    expect(p.state).toBe("in_loss");
    expect(p.drawdownToStopPct).toBeCloseTo(50, 1);
    expect(p.pnlPct).toBeLessThan(0);
  });

  it("hits targets on the way down", () => {
    const p = computeLiveProgress(short, 79);
    expect(p.targets[0].hit).toBe(true);
    expect(p.targets[1].hit).toBe(true);
    expect(p.targets[2].hit).toBe(false);
    expect(p.nextTarget?.label).toBe("TP3");
  });
});

describe("progress edge cases", () => {
  it("survives a zero-risk signal without dividing by zero", () => {
    const p = computeLiveProgress({ ...long, stopLoss: 100 }, 105);
    expect(Number.isFinite(p.rMultiple)).toBe(true);
    expect(Number.isFinite(p.drawdownToStopPct)).toBe(true);
  });

  it("returns null next target once every target is tagged", () => {
    const p = computeLiveProgress({ ...long, status: "TP3_HIT" }, 135);
    expect(p.nextTarget).toBeNull();
    expect(p.targets.every((t) => t.hit)).toBe(true);
  });

  it("always produces a human-readable summary", () => {
    for (const price of [95, 100, 105, 125]) {
      expect(computeLiveProgress(long, price).summary.length).toBeGreaterThan(15);
    }
  });
});
