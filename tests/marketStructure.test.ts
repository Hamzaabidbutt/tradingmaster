import { describe, expect, it } from "vitest";
import { analyzeMarketStructure, findSwings } from "@/engines/marketStructure";
import { candle, syntheticCandles } from "./helpers";

describe("market structure engine", () => {
  it("finds an isolated swing high and low", () => {
    const candles = [
      candle(1, 100, 101, 99, 100),
      candle(2, 100, 102, 100, 101),
      candle(3, 101, 106, 101, 105), // swing high at 106
      candle(4, 105, 105, 101, 102),
      candle(5, 102, 103, 100, 101),
      candle(6, 101, 102, 95, 96), // swing low at 95
      candle(7, 96, 99, 96, 98),
      candle(8, 98, 100, 97, 99),
      candle(9, 99, 101, 98, 100),
    ];
    const swings = findSwings(candles, 2, "major");
    expect(swings.some((s) => s.kind === "high" && s.price === 106)).toBe(true);
    expect(swings.some((s) => s.kind === "low" && s.price === 95)).toBe(true);
  });

  it("detects a bullish BOS when price closes above a prior swing high", () => {
    const candles: ReturnType<typeof candle>[] = [];
    // Build a swing high at 110 then break it.
    const shape = [100, 103, 110, 104, 101, 99, 101, 103, 105, 108, 112, 114];
    shape.forEach((p, i) => {
      candles.push(candle(i + 1, p - 0.5, p + 1, p - 1.5, p));
    });
    const result = analyzeMarketStructure(candles, { majorLookback: 2, minorLookback: 1 });
    const bullBreaks = result.events.filter((e) => e.direction === "bullish");
    expect(bullBreaks.length).toBeGreaterThan(0);
    expect(result.trend).toBe("bullish");
  });

  it("produces sane probabilities on synthetic data", () => {
    const result = analyzeMarketStructure(syntheticCandles(300));
    expect(result.reversalProbability).toBeGreaterThanOrEqual(10);
    expect(result.reversalProbability).toBeLessThanOrEqual(85);
    expect(result.reversalProbability + result.continuationProbability).toBe(100);
    expect(result.summary.length).toBeGreaterThan(0);
  });
});
