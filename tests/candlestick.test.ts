import { describe, expect, it } from "vitest";
import { detectCandlePatterns } from "@/engines/candlestick";
import { candle } from "./helpers";

function pad(n: number, start = 1, price = 100) {
  return Array.from({ length: n }, (_, i) => candle(start + i, price, price + 0.5, price - 0.5, price + (i % 2 ? 0.2 : -0.2)));
}

describe("candlestick pattern engine", () => {
  it("detects a bullish engulfing", () => {
    const candles = [
      ...pad(10),
      candle(11, 100, 100.3, 98.8, 99), // bearish
      candle(12, 98.8, 101.6, 98.7, 101.5), // engulfs prior body
    ];
    const patterns = detectCandlePatterns(candles);
    expect(patterns.some((p) => p.name === "Bullish Engulfing")).toBe(true);
  });

  it("detects a hammer-style rejection in a downtrend", () => {
    // Downtrend then long lower wick candle.
    const candles = [
      ...Array.from({ length: 12 }, (_, i) => candle(i + 1, 110 - i, 110.5 - i, 108.8 - i, 109 - i)),
      candle(13, 98, 98.4, 93, 98.3), // long lower wick, small body
    ];
    const patterns = detectCandlePatterns(candles);
    expect(patterns.some((p) => p.name === "Hammer" || p.name === "Bullish Pin Bar")).toBe(true);
  });

  it("reports strength and probability within bounds", () => {
    const candles = [
      ...pad(10),
      candle(11, 100, 100.3, 98.8, 99),
      candle(12, 98.8, 101.6, 98.7, 101.5),
    ];
    for (const p of detectCandlePatterns(candles)) {
      expect(p.strength).toBeGreaterThanOrEqual(0);
      expect(p.strength).toBeLessThanOrEqual(100);
      expect(p.probability).toBeGreaterThanOrEqual(0);
      expect(p.probability).toBeLessThanOrEqual(100);
      expect(p.topPrice).toBeGreaterThanOrEqual(p.bottomPrice);
    }
  });
});
