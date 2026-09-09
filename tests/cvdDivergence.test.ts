import { describe, expect, it } from "vitest";
import { findCvdDivergences } from "@/engines/cvdDivergence";
import { Candle } from "@/engines/types";

/**
 * A divergence is a claim about two slopes disagreeing, so the tests are about
 * the pairs: price up with CVD up is not a divergence however far either
 * moved, and price up with CVD flat is not one either.
 */

const T0 = 1_700_000_000;
const HOUR = 3600;

function bars(closes: number[]): Candle[] {
  return closes.map((c, i) => ({
    time: T0 + i * HOUR,
    open: c,
    high: c * 1.002,
    low: c * 0.998,
    close: c,
    volume: 1000,
    takerBuyVolume: 500,
  }));
}

function cvd(values: number[]) {
  return values.map((v, i) => ({ time: T0 + i * HOUR, cvd: v }));
}

/**
 * A price series with two clear peaks, the second higher.
 *
 * Shaped so `findSwings` with a five-bar lookback actually pivots on them.
 */
function twoPeaks(first: number, second: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < 14; i++) out.push(100 + (first - 100) * (i / 13));
  for (let i = 1; i <= 14; i++) out.push(first - (first - 100) * (i / 14));
  for (let i = 1; i <= 14; i++) out.push(100 + (second - 100) * (i / 14));
  for (let i = 1; i <= 10; i++) out.push(second - (second - 100) * (i / 14));
  return out;
}

/** The mirror: two troughs, the second lower. */
function twoTroughs(first: number, second: number): number[] {
  return twoPeaks(200 - first, 200 - second).map((v) => 200 - v);
}

/** A CVD series that runs from `a` to `b` linearly over `n` points. */
function ramp(n: number, a: number, b: number): number[] {
  return Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
}

describe("findCvdDivergences — refusals", () => {
  it("returns nothing on a series too short", () => {
    expect(findCvdDivergences(bars([1, 2, 3]), cvd([1, 2, 3]))).toEqual([]);
  });

  it("returns nothing when the CVD series is missing", () => {
    const price = twoPeaks(120, 130);
    expect(findCvdDivergences(bars(price), [])).toEqual([]);
  });

  it("returns nothing when CVD never moves", () => {
    const price = twoPeaks(120, 130);
    const flat = cvd(price.map(() => 500));
    expect(findCvdDivergences(bars(price), flat)).toEqual([]);
  });

  it("is not a divergence when price and CVD agree", () => {
    const price = twoPeaks(120, 130);
    const rising = cvd(ramp(price.length, 0, 5000));
    const found = findCvdDivergences(bars(price), rising);
    expect(found.filter((d) => d.kind === "bearish")).toHaveLength(0);
  });

  it("skips bars with no CVD reading rather than interpolating one", () => {
    const price = twoPeaks(120, 130);
    // Only the first half has readings, so the later pivot has none.
    const partial = cvd(ramp(price.length, 5000, 0)).slice(0, 15);
    expect(findCvdDivergences(bars(price), partial)).toEqual([]);
  });
});

describe("findCvdDivergences — the two kinds", () => {
  it("finds a bearish divergence: higher high on falling delta", () => {
    const price = twoPeaks(120, 132);
    const falling = cvd(ramp(price.length, 5000, 0));
    const r = findCvdDivergences(bars(price), falling);
    const bear = r.find((d) => d.kind === "bearish");
    expect(bear).toBeDefined();
    expect(bear!.pricePct).toBeGreaterThan(0);
    expect(bear!.cvdShare).toBeLessThan(0);
    expect(bear!.label).toBe("PRICE ↑ CVD ↓");
    expect(bear!.note).toMatch(/distribution|selling into strength/i);
  });

  it("finds a bullish divergence: lower low on rising delta", () => {
    const price = twoTroughs(80, 68);
    const rising = cvd(ramp(price.length, 0, 5000));
    const r = findCvdDivergences(bars(price), rising);
    const bull = r.find((d) => d.kind === "bullish");
    expect(bull).toBeDefined();
    expect(bull!.pricePct).toBeLessThan(0);
    expect(bull!.cvdShare).toBeGreaterThan(0);
    expect(bull!.label).toBe("PRICE ↓ CVD ↑");
  });

  it("carries both endpoints so the two lines can be drawn", () => {
    const price = twoPeaks(120, 132);
    const r = findCvdDivergences(bars(price), cvd(ramp(price.length, 5000, 0)));
    const d = r[0];
    expect(d.from.time).toBeLessThan(d.to.time);
    expect(d.barsApart).toBeGreaterThanOrEqual(4);
    for (const v of [d.from.price, d.from.cvd, d.to.price, d.to.cvd]) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("returns at most one of each kind", () => {
    const price = twoPeaks(120, 132);
    const r = findCvdDivergences(bars(price), cvd(ramp(price.length, 5000, 0)));
    expect(r.filter((d) => d.kind === "bearish").length).toBeLessThanOrEqual(1);
    expect(r.filter((d) => d.kind === "bullish").length).toBeLessThanOrEqual(1);
  });

  it("scores a wider disagreement higher", () => {
    const price = twoPeaks(120, 132);
    const steep = findCvdDivergences(bars(price), cvd(ramp(price.length, 5000, 0)));
    const shallow = findCvdDivergences(bars(price), cvd(ramp(price.length, 5000, 4200)));
    if (steep.length && shallow.length) {
      expect(steep[0].strength).toBeGreaterThanOrEqual(shallow[0].strength);
    }
  });
});

describe("findCvdDivergences — honesty", () => {
  it("never presents a divergence as a reversal signal", () => {
    const price = twoPeaks(120, 132);
    const r = findCvdDivergences(bars(price), cvd(ramp(price.length, 5000, 0)));
    const text = r.map((d) => d.note).join(" ").toLowerCase();
    for (const banned of ["will reverse", "will fall", "will rise", "short here", "guaranteed"]) {
      expect(text).not.toContain(banned);
    }
    expect(text).toMatch(/not a short signal|not a long signal/);
  });

  it("says divergences persist", () => {
    const price = twoPeaks(120, 132);
    const r = findCvdDivergences(bars(price), cvd(ramp(price.length, 5000, 0)));
    expect(r[0].note).toMatch(/persist|ceasing to diverge/i);
  });
});
