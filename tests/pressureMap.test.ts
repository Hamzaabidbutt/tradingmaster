import { describe, expect, it } from "vitest";
import { analyzeMarket } from "@/engines/analyzer";
import { syntheticCandles } from "./helpers";

const analysis = analyzeMarket("BTCUSDT", "1h", syntheticCandles(400));

describe("pressure map", () => {
  const map = analysis.pressureMap;

  it("puts short-squeeze zones above price and long-squeeze zones below", () => {
    for (const z of map.shortSqueeze) {
      expect(z.price).toBeGreaterThan(map.price);
      expect(z.distancePct).toBeGreaterThan(0);
      expect(z.side).toBe("short");
    }
    for (const z of map.longSqueeze) {
      expect(z.price).toBeLessThan(map.price);
      expect(z.distancePct).toBeLessThan(0);
      expect(z.side).toBe("long");
    }
  });

  it("orders liquidation bands outward from price", () => {
    // 100x is nearest, 25x furthest, on both sides.
    const longDist = map.forcedLongLiquidation.map((z) => Math.abs(z.distancePct));
    const shortDist = map.forcedShortLiquidation.map((z) => Math.abs(z.distancePct));
    expect(longDist).toEqual([...longDist].sort((a, b) => a - b));
    expect(shortDist).toEqual([...shortDist].sort((a, b) => a - b));
    expect(map.forcedLongLiquidation).toHaveLength(3);
    expect(map.forcedShortLiquidation).toHaveLength(3);
  });

  it("labels the basis of every zone so inference is never shown as measurement", () => {
    const all = [
      ...map.shortSqueeze,
      ...map.longSqueeze,
      ...map.forcedLongLiquidation,
      ...map.forcedShortLiquidation,
    ];
    for (const z of all) {
      expect(["equal_levels", "swing_liquidity", "leverage_band"]).toContain(z.basis);
      expect(z.intensity).toBeGreaterThanOrEqual(0);
      expect(z.intensity).toBeLessThanOrEqual(100);
      expect(z.note.length).toBeGreaterThan(20);
    }
  });

  it("classifies whale posture by which side of price the print sits on", () => {
    for (const w of map.whales) {
      const above = w.price > map.price;
      const expected =
        w.side === "buy" ? (above ? "trapped" : "defending") : above ? "defending" : "trapped";
      expect(w.posture).toBe(expected);
      expect(w.notional).toBeCloseTo(w.volume * w.price, 4);
    }
  });

  it("sorts whales by notional size, largest first", () => {
    const notionals = map.whales.map((w) => w.notional);
    expect(notionals).toEqual([...notionals].sort((a, b) => b - a));
  });

  it("always reports a lean and an explanation", () => {
    expect(["bullish", "bearish", "neutral"]).toContain(map.lean);
    expect(map.summary.length).toBeGreaterThan(1);
    expect(map.cvdDivergence.note.length).toBeGreaterThan(20);
  });

  it("reports no divergence honestly rather than inventing one", () => {
    if (!map.cvdDivergence.present) {
      expect(map.cvdDivergence.kind).toBeNull();
      expect(map.cvdDivergence.bias).toBe("neutral");
      expect(map.cvdDivergence.strength).toBe(0);
    }
  });

  it("stays stable across different market shapes", () => {
    for (let seed = 2; seed <= 6; seed++) {
      const m = analyzeMarket("ETHUSDT", "15m", syntheticCandles(300, seed)).pressureMap;
      expect(m.price).toBeGreaterThan(0);
      expect(m.forcedLongLiquidation).toHaveLength(3);
      expect(["bullish", "bearish", "neutral"]).toContain(m.lean);
    }
  });
});
