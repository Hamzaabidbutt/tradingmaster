import { describe, expect, it } from "vitest";
import { analyzeMarket } from "@/engines/analyzer";
import { computeConfidence } from "@/engines/signal";
import { computeWeightAdjustments } from "@/engines/learning";
import { runBacktest } from "@/engines/backtest";
import { syntheticCandles } from "./helpers";

describe("full analysis pipeline", () => {
  it("produces a complete, internally consistent analysis", () => {
    const analysis = analyzeMarket("UNIUSDT", "1h", syntheticCandles(400));
    expect(analysis.bullishProbability + analysis.bearishProbability).toBe(100);
    expect(["bullish", "bearish", "neutral"]).toContain(analysis.bias);
    expect(analysis.insights.length).toBeGreaterThan(0);
    expect(analysis.srLevels.length).toBeGreaterThan(0);
    if (analysis.setup) {
      const s = analysis.setup;
      expect(s.riskReward).toBeGreaterThanOrEqual(1);
      if (s.side === "BUY") {
        expect(s.stopLoss).toBeLessThan(s.entry);
        expect(s.tp1).toBeGreaterThan(s.entry);
        expect(s.tp2).toBeGreaterThan(s.tp1);
        expect(s.tp3).toBeGreaterThan(s.tp2);
      } else {
        expect(s.stopLoss).toBeGreaterThan(s.entry);
        expect(s.tp1).toBeLessThan(s.entry);
        expect(s.tp2).toBeLessThan(s.tp1);
        expect(s.tp3).toBeLessThan(s.tp2);
      }
      expect(s.reasoning.length).toBeGreaterThan(0);
      expect(s.invalidation.length).toBeGreaterThan(0);
    }
  });

  it("throws on insufficient data", () => {
    expect(() => analyzeMarket("UNIUSDT", "1h", syntheticCandles(10))).toThrow();
  });
});

describe("confidence engine", () => {
  it("is 50/50 with zero scores and never reaches 100", () => {
    const zero = computeConfidence([{ key: "a", name: "A", score: 0, weight: 1, reasons: [] }]);
    expect(zero.bullishProbability).toBe(50);
    const maxed = computeConfidence([{ key: "a", name: "A", score: 100, weight: 1, reasons: [] }]);
    expect(maxed.bullishProbability).toBeLessThan(100);
    expect(maxed.bullishProbability).toBeGreaterThan(80);
  });
});

describe("learning engine", () => {
  it("rewards correct strategies and penalizes wrong ones", () => {
    const scores = [
      { key: "right", name: "Right", score: 60, weight: 1, reasons: [] },
      { key: "wrong", name: "Wrong", score: -60, weight: 1, reasons: [] },
    ];
    const adjustments = computeWeightAdjustments(scores, { side: "BUY", win: true, pnlPct: 2.5 });
    const right = adjustments.find((a) => a.key === "right");
    const wrong = adjustments.find((a) => a.key === "wrong");
    expect(right && right.delta > 0).toBe(true);
    expect(wrong && wrong.delta < 0).toBe(true);
  });

  it("keeps weights within bounds", () => {
    const scores = [{ key: "x", name: "X", score: 100, weight: 2.49, reasons: [] }];
    const adj = computeWeightAdjustments(scores, { side: "BUY", win: true, pnlPct: 10 });
    if (adj[0]) expect(adj[0].after).toBeLessThanOrEqual(2.5);
  });
});

describe("backtester", () => {
  it("runs end-to-end on synthetic data with consistent metrics", () => {
    const metrics = runBacktest("UNIUSDT", "1h", syntheticCandles(800), {
      strategyKey: "all",
      minConfidence: 55,
      window: 200,
      step: 5,
    });
    expect(metrics.totalTrades).toBe(metrics.wins + metrics.losses);
    if (metrics.totalTrades > 0) {
      expect(metrics.winRate).toBeGreaterThanOrEqual(0);
      expect(metrics.winRate).toBeLessThanOrEqual(100);
      expect(metrics.maxDrawdownPct).toBeGreaterThanOrEqual(0);
    }
  });
});
