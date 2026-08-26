import { describe, expect, it } from "vitest";
import { analyzeRangeTrading } from "@/engines/rangeTrading";
import { Candle } from "@/engines/types";
import { candle } from "./helpers";

const T0 = 1_700_000_000;
const HOUR = 3600;

/** Deterministic pseudo-random so fixtures are reproducible across runs. */
function lcg(seed: number) {
  let s = (seed * 2654435761) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * A clean, well-behaved range: price oscillates between `low` and `high`,
 * tagging both boundaries repeatedly with small wicks and closing inside.
 *
 * The jitter and the half-bar phase offset are load-bearing, not decoration.
 * `findSwings` needs a STRICT fractal extreme, and a perfect sine sampled on
 * integer bars produces two bars with identical highs at every peak (each
 * bar opens at the previous close), so no swing would be detected at all.
 */
function rangeCandles(count: number, low: number, high: number, period = 20, seed = 7): Candle[] {
  const rnd = lcg(seed);
  const mid = (low + high) / 2;
  const amp = ((high - low) / 2) * 0.94;
  const out: Candle[] = [];
  let prev = mid;
  for (let i = 0; i < count; i++) {
    const jitter = (rnd() - 0.5) * amp * 0.07;
    const close = mid + amp * Math.sin(((i + 0.5) / period) * Math.PI * 2) + jitter;
    const wick = amp * (0.03 + rnd() * 0.05);
    const vol = 900 + Math.round(rnd() * 300);
    out.push(
      candle(
        T0 + i * HOUR,
        prev,
        Math.max(prev, close) + wick,
        Math.min(prev, close) - wick,
        close,
        vol,
        Math.round(vol * 0.5)
      )
    );
    prev = close;
  }
  return out;
}

/** Append bars, continuing the time series from wherever the input stopped. */
function append(base: Candle[], bars: Omit<Candle, "time">[]): Candle[] {
  const start = base[base.length - 1].time;
  return [
    ...base,
    ...bars.map((b, i) =>
      candle(start + (i + 1) * HOUR, b.open, b.high, b.low, b.close, b.volume, b.takerBuyVolume)
    ),
  ];
}

describe("range trading — detection", () => {
  it("returns an empty, honest result when there is not enough history", () => {
    const r = analyzeRangeTrading(rangeCandles(30, 95, 105));
    expect(r.marketCondition).toBe("Unclear");
    expect(r.rangeHigh).toBeNull();
    expect(r.rangeSetup).toBe("No Trade");
    expect(r.reason.join(" ")).toContain("60 candles");
  });

  it("detects a clean range with sane high / low / midpoint", () => {
    const r = analyzeRangeTrading(rangeCandles(160, 95, 105));
    expect(r.marketCondition).toBe("Ranging");
    expect(r.rangeHigh).toBeGreaterThan(103);
    expect(r.rangeHigh).toBeLessThan(107);
    expect(r.rangeLow).toBeGreaterThan(93);
    expect(r.rangeLow).toBeLessThan(97);
    expect(r.rangeMidpoint).toBeCloseTo((r.rangeHigh! + r.rangeLow!) / 2, 6);
    expect(r.highTouches).toBeGreaterThanOrEqual(2);
    expect(r.lowTouches).toBeGreaterThanOrEqual(2);
    expect(r.containment).toBeGreaterThanOrEqual(0.75);
  });

  it("reports every validation gate, passed or failed", () => {
    const r = analyzeRangeTrading(rangeCandles(160, 95, 105));
    expect(r.validation.length).toBeGreaterThanOrEqual(5);
    for (const g of r.validation) {
      expect(g.label.length).toBeGreaterThan(3);
      expect(g.detail.length).toBeGreaterThan(10);
      expect(typeof g.passed).toBe("boolean");
    }
  });

  it("keeps the boundary off a lone excursion so a broken range is still measurable", () => {
    // One stop-run spike 8 handles above the range must not become the
    // boundary — a boundary is a price other swings agreed on.
    const base = rangeCandles(160, 95, 105);
    const spiked = append(base, [
      { open: 100, high: 113, low: 99.5, close: 100.2, volume: 6000, takerBuyVolume: 3000 },
      { open: 100.2, high: 100.6, low: 99.4, close: 99.8, volume: 1000, takerBuyVolume: 500 },
      { open: 99.8, high: 100.2, low: 99.0, close: 99.4, volume: 1000, takerBuyVolume: 500 },
      { open: 99.4, high: 99.8, low: 98.6, close: 99.0, volume: 1000, takerBuyVolume: 500 },
      { open: 99.0, high: 99.4, low: 98.2, close: 98.6, volume: 1000, takerBuyVolume: 500 },
    ]);
    const r = analyzeRangeTrading(spiked);
    expect(r.rangeHigh).not.toBeNull();
    expect(r.rangeHigh!).toBeLessThan(108);
  });

  it("refuses to call a trend a range, and offers no mean-reversion setup", () => {
    // Steady one-way climb — horizontal-looking only if you squint.
    const trend: Candle[] = Array.from({ length: 160 }, (_, i) =>
      candle(T0 + i * HOUR, 100 + i * 0.5, 100 + i * 0.5 + 0.6, 100 + i * 0.5 - 0.3, 100 + i * 0.5 + 0.5, 1000, 550)
    );
    const r = analyzeRangeTrading(trend);
    expect(r.marketCondition).not.toBe("Ranging");
    expect(["No Trade", "Breakout"]).toContain(r.rangeSetup);
    // Crucially: never a range-long / range-short in a trend.
    expect(r.rangeSetup).not.toBe("Long");
    expect(r.rangeSetup).not.toBe("Short");
  });
});

describe("range trading — setups", () => {
  it("gives a Long at the range low on a bullish rejection, targeting mid then high", () => {
    const base = rangeCandles(160, 95, 105);
    // Walk price down to the low, then wick under it and close back up.
    const r = analyzeRangeTrading(
      append(base, [
        { open: 100, high: 100.3, low: 96.5, close: 96.8, volume: 1200, takerBuyVolume: 600 },
        { open: 96.8, high: 97.0, low: 94.2, close: 96.6, volume: 1800, takerBuyVolume: 1200 },
      ])
    );
    expect(r.currentPosition).toBe("Near Low");
    expect(r.rangeSetup).toBe("Long");
    expect(r.bias).toBe("bullish");
    expect(r.target1).toBeCloseTo(r.rangeMidpoint!, 6);
    expect(r.target2).toBeCloseTo(r.rangeHigh!, 6);
    expect(r.invalidation).toBeLessThan(r.rangeLow!);
    expect(r.potentialEntry).toBeGreaterThan(r.rangeLow!);
  });

  it("gives a Short at the range high on a bearish rejection, targeting mid then low", () => {
    const base = rangeCandles(160, 95, 105);
    const r = analyzeRangeTrading(
      append(base, [
        { open: 100, high: 103.5, low: 99.8, close: 103.2, volume: 1200, takerBuyVolume: 700 },
        { open: 103.2, high: 105.8, low: 103.0, close: 103.4, volume: 1800, takerBuyVolume: 700 },
      ])
    );
    expect(r.currentPosition).toBe("Near High");
    expect(r.rangeSetup).toBe("Short");
    expect(r.bias).toBe("bearish");
    expect(r.target1).toBeCloseTo(r.rangeMidpoint!, 6);
    expect(r.target2).toBeCloseTo(r.rangeLow!, 6);
    expect(r.invalidation).toBeGreaterThan(r.rangeHigh!);
  });

  it("calls mid-range a no-trade zone", () => {
    const base = rangeCandles(160, 95, 105);
    const r = analyzeRangeTrading(
      append(base, [
        { open: 100, high: 100.4, low: 99.6, close: 100.1, volume: 900, takerBuyVolume: 450 },
        { open: 100.1, high: 100.3, low: 99.8, close: 100.0, volume: 900, takerBuyVolume: 450 },
      ])
    );
    expect(r.currentPosition).toBe("Mid Range");
    expect(r.rangeSetup).toBe("No Trade");
    expect(r.bias).toBe("neutral");
    expect(r.reason.join(" ").toLowerCase()).toContain("low-quality location");
  });

  it("switches to Breakout on a held decisive break and refuses to buy the low", () => {
    const base = rangeCandles(160, 95, 105);
    // Decisive close well above the high, then three more closes holding out.
    const r = analyzeRangeTrading(
      append(base, [
        { open: 104, high: 109.5, low: 103.8, close: 109.2, volume: 5000, takerBuyVolume: 4000 },
        { open: 109.2, high: 111.0, low: 109.0, close: 110.6, volume: 4200, takerBuyVolume: 3200 },
        { open: 110.6, high: 112.5, low: 110.4, close: 112.1, volume: 4000, takerBuyVolume: 3000 },
        { open: 112.1, high: 114.0, low: 112.0, close: 113.7, volume: 3800, takerBuyVolume: 2800 },
      ])
    );
    expect(r.rangeSetup).toBe("Breakout");
    expect(r.marketCondition).toBe("Trending");
    expect(r.breakout.active).toBe(true);
    expect(r.breakout.direction).toBe("up");
    expect(["confirmed", "retest"]).toContain(r.breakout.stage);
    // The spec's hard rule, asserted literally.
    expect(r.reason.join(" ")).toContain("off the table");
    expect(r.bias).toBe("bullish");
  });

  it("stops quoting objectives the market has already passed", () => {
    // A break that ran a full range height is history, not a plan: a retest
    // entry back at the boundary and a target price left behind 20 bars ago
    // would both be quoting the past as if it were pending.
    const base = rangeCandles(160, 95, 105);
    const extended = append(base, [
      { open: 104, high: 109.5, low: 103.8, close: 109.2, volume: 5000, takerBuyVolume: 4000 },
      { open: 109.2, high: 111.0, low: 109.0, close: 110.6, volume: 4200, takerBuyVolume: 3200 },
      { open: 110.6, high: 112.5, low: 110.4, close: 112.1, volume: 4000, takerBuyVolume: 3000 },
      { open: 112.1, high: 114.0, low: 112.0, close: 113.7, volume: 3800, takerBuyVolume: 2800 },
    ]);
    const r = analyzeRangeTrading(extended);
    const height = r.rangeHigh! - r.rangeLow!;

    expect(r.rangeSetup).toBe("Breakout");
    // Price is ~0.9 range-heights beyond the boundary.
    expect(113.7 - r.rangeHigh!).toBeGreaterThan(height * 0.5);
    expect(r.potentialEntry).toBeNull();
    // The half-height objective is behind price; the full one is not.
    expect(r.target1).toBeNull();
    expect(r.target2).not.toBeNull();
    expect(r.target2!).toBeGreaterThan(113.7);
    // Structural invalidation still stands.
    expect(r.invalidation).toBeCloseTo(r.rangeMidpoint!, 6);
    expect(r.reason.join(" ")).toContain("too far behind the market");
  });

  it("keeps the retest plan while price is still at the boundary", () => {
    const base = rangeCandles(160, 95, 105);
    // Decisive close just outside, holding — a retest here is still tradeable.
    const fresh = append(base, [
      { open: 103.5, high: 106.4, low: 103.3, close: 106.2, volume: 5000, takerBuyVolume: 4000 },
      { open: 106.2, high: 106.6, low: 105.8, close: 106.0, volume: 3000, takerBuyVolume: 1900 },
      { open: 106.0, high: 106.5, low: 105.7, close: 106.3, volume: 2800, takerBuyVolume: 1800 },
    ]);
    const r = analyzeRangeTrading(fresh);

    expect(r.rangeSetup).toBe("Breakout");
    expect(r.potentialEntry).toBeCloseTo(r.rangeHigh!, 6);
    expect(r.target2!).toBeGreaterThan(r.potentialEntry!);
    expect(r.reason.join(" ")).toContain("wait for a retest");
  });

  it("classifies a quick return inside as a false breakout", () => {
    const base = rangeCandles(160, 95, 105);
    const r = analyzeRangeTrading(
      append(base, [
        { open: 104, high: 108.5, low: 103.8, close: 108.0, volume: 5000, takerBuyVolume: 4000 },
        { open: 108.0, high: 108.2, low: 101.5, close: 101.8, volume: 5200, takerBuyVolume: 1500 },
      ])
    );
    expect(r.breakout.stage).toBe("false_breakout");
    expect(r.breakout.active).toBe(false);
    // A break that failed is the range reasserting itself, not a new trend.
    expect(r.marketCondition).not.toBe("Trending");
  });
});

describe("range trading — output integrity", () => {
  it("keeps targets on the correct side of the entry for every setup", () => {
    const fixtures = [
      rangeCandles(160, 95, 105),
      rangeCandles(200, 1000, 1120, 26),
      rangeCandles(140, 2.5, 2.9, 18),
    ];
    for (const f of fixtures) {
      const r = analyzeRangeTrading(f);
      if (r.rangeSetup === "Long" && r.potentialEntry !== null) {
        expect(r.target1!).toBeGreaterThan(r.potentialEntry);
        expect(r.target2!).toBeGreaterThan(r.target1!);
        expect(r.invalidation!).toBeLessThan(r.potentialEntry);
      }
      if (r.rangeSetup === "Short" && r.potentialEntry !== null) {
        expect(r.target1!).toBeLessThan(r.potentialEntry);
        expect(r.target2!).toBeLessThan(r.target1!);
        expect(r.invalidation!).toBeGreaterThan(r.potentialEntry);
      }
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(90);
      expect(r.reason.length).toBeGreaterThan(0);
    }
  });

  it("never claims certainty", () => {
    for (let p = 14; p <= 30; p += 2) {
      const r = analyzeRangeTrading(rangeCandles(180, 40, 52, p, p));
      expect(r.confidence).toBeLessThanOrEqual(90);
    }
  });
});
