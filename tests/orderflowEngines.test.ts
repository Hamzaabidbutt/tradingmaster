import { describe, expect, it } from "vitest";
import { buildVolumeProfile } from "@/engines/volumeProfile";
import { buildFootprint } from "@/engines/footprint";
import { analyzeDelta } from "@/engines/deltaAnalysis";
import { detectOrderFlowEvents } from "@/engines/orderFlowEvents";
import { analyzeLiquidationDelta } from "@/engines/liquidationDelta";
import { computeFibonacci, computeMovingAverages, computeVwap, detectEqualLevels } from "@/engines/indicators";
import { analyzeMarketStructure } from "@/engines/marketStructure";
import { detectSupportResistance } from "@/engines/supportResistance";
import { candle, syntheticCandles } from "./helpers";

describe("volume profile engine", () => {
  const candles = syntheticCandles(300);
  const vp = buildVolumeProfile(candles, { bins: 40 });

  it("places the POC inside the value area", () => {
    expect(vp.poc).toBeGreaterThanOrEqual(vp.val);
    expect(vp.poc).toBeLessThanOrEqual(vp.vah);
  });

  it("captures approximately 70% of volume in the value area", () => {
    expect(vp.valueAreaShare).toBeGreaterThan(0.65);
    expect(vp.valueAreaShare).toBeLessThanOrEqual(1);
  });

  it("classifies a shape and auction state consistently", () => {
    expect(["D", "P", "b", "B"]).toContain(vp.shape);
    const inside = vp.acceptance === "inside_value";
    expect(vp.auctionState).toBe(inside ? "balance" : "imbalance");
  });

  it("puts the POC at the price where most volume traded", () => {
    // Build a series that spends most of its time at ~100.
    const flat = Array.from({ length: 80 }, (_, i) => candle(1000 + i * 60, 100, 100.4, 99.6, 100, 5000));
    const spike = Array.from({ length: 5 }, (_, i) => candle(1000 + (80 + i) * 60, 100, 120, 100, 118, 200));
    const profile = buildVolumeProfile([...flat, ...spike], { bins: 40 });
    expect(Math.abs(profile.poc - 100)).toBeLessThan(4);
  });
});

describe("footprint engine", () => {
  const candles = syntheticCandles(120);

  it("marks modelled fidelity when no sub-candles are supplied", () => {
    const fp = buildFootprint(candles, null, { count: 10 });
    expect(fp.fidelity).toBe("estimated");
    expect(fp.candles.length).toBe(10);
  });

  it("reports sub_candle fidelity when lower-timeframe data is supplied", () => {
    const subs = syntheticCandles(600, 7);
    const fp = buildFootprint(candles, subs, { count: 5 });
    expect(fp.fidelity).toBe("sub_candle");
  });

  it("keeps each candle's POC inside its own range", () => {
    const fp = buildFootprint(candles, null, { count: 12 });
    for (const c of fp.candles) {
      expect(c.poc).toBeGreaterThanOrEqual(c.low);
      expect(c.poc).toBeLessThanOrEqual(c.high);
      expect(c.cells.length).toBeGreaterThan(0);
    }
  });

  it("only reports stacked imbalances of 3 or more levels", () => {
    const fp = buildFootprint(candles, null, { count: 20 });
    for (const c of fp.candles) {
      for (const si of c.stackedImbalances) {
        expect(si.count).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

describe("delta analysis", () => {
  const candles = syntheticCandles(200);
  const d = analyzeDelta(candles);

  it("builds a monotonic cumulative delta from per-bar deltas", () => {
    expect(d.series.length).toBeGreaterThan(0);
    for (let i = 1; i < d.series.length; i++) {
      const expected = d.series[i - 1].cvd + d.series[i].delta;
      expect(Math.abs(d.series[i].cvd - expected)).toBeLessThan(1e-6);
    }
  });

  it("classifies trap bars as delta contradicting the candle body", () => {
    for (const t of d.trapBars) {
      expect(t.candleDirection).not.toBe(t.deltaDirection);
    }
  });
});

describe("order flow events", () => {
  it("runs end to end and gates absorption strength by key level", () => {
    const candles = syntheticCandles(200);
    const structure = analyzeMarketStructure(candles);
    const sr = detectSupportResistance(candles, "1h");
    const vp = buildVolumeProfile(candles, { bins: 40 });
    const fp = buildFootprint(candles, null, { count: 30 });
    const ev = detectOrderFlowEvents(candles, fp, vp, sr);

    expect(Array.isArray(ev.absorptions)).toBe(true);
    for (const a of ev.absorptions) {
      expect(a.strength).toBeGreaterThanOrEqual(0);
      expect(a.strength).toBeLessThanOrEqual(100);
      expect(a.explanation.length).toBeGreaterThan(20);
    }
    for (const t of ev.trapped) {
      // Trapped-trader stop zones must be ordered.
      expect(t.stopZone.high).toBeGreaterThanOrEqual(t.stopZone.low);
    }
  });
});

describe("liquidation delta", () => {
  it("keeps delta consistent with its long/short components", () => {
    const ld = analyzeLiquidationDelta(syntheticCandles(150));
    for (const p of ld.series) {
      expect(Math.abs(p.delta - (p.shortLiquidated - p.longLiquidated))).toBeLessThan(1e-6);
      expect(p.longLiquidated).toBeGreaterThanOrEqual(0);
      expect(p.shortLiquidated).toBeGreaterThanOrEqual(0);
    }
    expect(["long", "short", "balanced"]).toContain(ld.dominantSide);
  });
});

describe("indicators", () => {
  const candles = syntheticCandles(300);

  it("computes moving averages with correct lengths and positions", () => {
    const ma = computeMovingAverages(candles);
    expect(ma.averages.length).toBeGreaterThan(0);
    const price = candles[candles.length - 1].close;
    for (const a of ma.averages) {
      expect(a.values.length).toBeGreaterThan(0);
      expect(a.position).toBe(price >= a.current ? "above" : "below");
    }
  });

  it("computes a VWAP that sits inside the traded range", () => {
    const v = computeVwap(candles);
    const high = Math.max(...candles.map((c) => c.high));
    const low = Math.min(...candles.map((c) => c.low));
    expect(v.current).toBeGreaterThan(low);
    expect(v.current).toBeLessThan(high);
    expect(v.upperBand2).toBeGreaterThan(v.upperBand1);
    expect(v.lowerBand2).toBeLessThan(v.lowerBand1);
  });

  it("computes fibonacci levels including the golden pocket", () => {
    const structure = analyzeMarketStructure(candles);
    const fib = computeFibonacci(candles, structure.swings);
    expect(fib.levels.length).toBeGreaterThan(8);
    const golden = fib.levels.filter((l) => l.isGoldenPocket);
    expect(golden.length).toBe(2);
    // 0% and 100% anchor to the swing extremes.
    const zero = fib.levels.find((l) => l.ratio === 0)!;
    const hundred = fib.levels.find((l) => l.ratio === 1 && l.kind === "retracement")!;
    const anchors = [zero.price, hundred.price].sort((a, b) => a - b);
    expect(Math.abs(anchors[0] - fib.swingLow)).toBeLessThan(1e-6);
    expect(Math.abs(anchors[1] - fib.swingHigh)).toBeLessThan(1e-6);
  });

  it("detects equal highs/lows with at least two touches", () => {
    const structure = analyzeMarketStructure(candles);
    const levels = detectEqualLevels(candles, structure.swings, 0.01);
    for (const l of levels) {
      expect(l.touches).toBeGreaterThanOrEqual(2);
      expect(l.endTime).toBeGreaterThanOrEqual(l.startTime);
    }
  });
});
