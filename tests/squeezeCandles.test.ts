import { describe, expect, it } from "vitest";
import { findSqueezeCandles, strongestSqueezePerRun } from "@/engines/squeezeCandles";
import { Candle, LiquidationDeltaPoint } from "@/engines/types";

/**
 * The whole value of this indicator is that it marks the *opposite* of the
 * obvious: a downtrend liquidating longs is the trend working and must never
 * be marked, while a downtrend liquidating shorts is the shakeout and must be.
 * So the tests that matter most are the ones asserting the ordinary case stays
 * unmarked.
 */

const T0 = 1_700_000_000;
const HOUR = 3600;

function bars(closes: number[]): Candle[] {
  return closes.map((c, i) => ({
    time: T0 + i * HOUR,
    open: c,
    high: c * 1.004,
    low: c * 0.996,
    close: c,
    volume: 1000,
    takerBuyVolume: 500,
  }));
}

/** A liquidation series with a quiet baseline and one spike at `at`. */
function liq(
  n: number,
  at: number,
  spike: { long?: number; short?: number },
  base = { long: 100, short: 100 }
): LiquidationDeltaPoint[] {
  return Array.from({ length: n }, (_, i) => {
    const longLiquidated = i === at ? (spike.long ?? base.long) : base.long;
    const shortLiquidated = i === at ? (spike.short ?? base.short) : base.short;
    return {
      time: T0 + i * HOUR,
      longLiquidated,
      shortLiquidated,
      delta: shortLiquidated - longLiquidated,
      cumulative: 0,
    };
  });
}

/** 80 bars declining hard, so price sits well below its own average. */
const downtrend = bars(Array.from({ length: 80 }, (_, i) => 200 - i * 1.4));
/** 80 bars rising hard. */
const uptrend = bars(Array.from({ length: 80 }, (_, i) => 100 + i * 1.4));

describe("findSqueezeCandles — what it refuses", () => {
  it("returns nothing without enough history", () => {
    expect(findSqueezeCandles(bars([1, 2, 3]), liq(3, 1, { short: 9999 }))).toEqual([]);
  });

  it("returns nothing without liquidation data", () => {
    expect(findSqueezeCandles(downtrend, [])).toEqual([]);
  });

  it("ignores a downtrend liquidating LONGS — that is the trend working", () => {
    // The obvious case, and the one this indicator exists not to mark.
    expect(findSqueezeCandles(downtrend, liq(80, 70, { long: 9999 }))).toEqual([]);
  });

  it("ignores an uptrend liquidating SHORTS — also just the trend working", () => {
    expect(findSqueezeCandles(uptrend, liq(80, 70, { short: 9999 }))).toEqual([]);
  });

  it("ignores a spike in a market with no trend to be counter to", () => {
    // Price sitting on its own average: a flush here is a range event, and
    // every flush in a range would qualify if the trend gate were dropped.
    const flat = bars(Array.from({ length: 80 }, () => 100));
    expect(findSqueezeCandles(flat, liq(80, 70, { short: 9999 }))).toEqual([]);
  });

  it("ignores a bar that liquidated both sides roughly equally", () => {
    // Volatility, not a squeeze of one crowd.
    const both = liq(80, 70, { short: 9000, long: 8000 });
    expect(findSqueezeCandles(downtrend, both)).toEqual([]);
  });

  it("ignores forced volume that is merely ordinary", () => {
    // 1.5x the baseline is not a spike.
    expect(findSqueezeCandles(downtrend, liq(80, 70, { short: 150 }))).toEqual([]);
  });
});

describe("findSqueezeCandles — what it marks", () => {
  it("marks a downtrend liquidating shorts", () => {
    const r = findSqueezeCandles(downtrend, liq(80, 70, { short: 9999 }));
    expect(r).toHaveLength(1);
    expect(r[0].side).toBe("shorts");
    expect(r[0].trend).toBe("down");
    expect(r[0].index).toBe(70);
    expect(r[0].multiple).toBeGreaterThan(2);
  });

  it("marks an uptrend liquidating longs", () => {
    const r = findSqueezeCandles(uptrend, liq(80, 70, { long: 9999 }));
    expect(r).toHaveLength(1);
    expect(r[0].side).toBe("longs");
    expect(r[0].trend).toBe("up");
  });

  it("separates a violent squeeze from a merely present one", () => {
    const mild = findSqueezeCandles(downtrend, liq(80, 70, { short: 250 }));
    const violent = findSqueezeCandles(downtrend, liq(80, 70, { short: 9999 }));
    expect(mild[0].severe).toBe(false);
    expect(violent[0].severe).toBe(true);
  });

  it("records whether the bar closed back with the trend", () => {
    // Bar 70 closes down, with the downtrend: the flush was absorbed.
    const withReclaim = [...downtrend];
    withReclaim[70] = { ...withReclaim[70], open: withReclaim[70].close * 1.02 };
    const r = findSqueezeCandles(withReclaim, liq(80, 70, { short: 9999 }));
    expect(r[0].reclaimed).toBe(true);
    expect(r[0].note).toMatch(/absorbed within it/i);
  });
});

describe("findSqueezeCandles — honesty", () => {
  it("never claims the trend resumes", () => {
    const r = findSqueezeCandles(downtrend, liq(80, 70, { short: 9999 }));
    const text = r[0].note.toLowerCase();
    for (const banned of ["will resume", "will continue", "will reverse", "guaranteed", "expect price"]) {
      expect(text).not.toContain(banned);
    }
  });

  it("says a shakeout and a real reversal are indistinguishable in the moment", () => {
    const r = findSqueezeCandles(uptrend, liq(80, 70, { long: 9999 }));
    expect(r[0].note).toMatch(/look identical while they happen/i);
  });

  it("emits finite numbers on a zero baseline", () => {
    const zeroBase = liq(80, 70, { short: 500 }, { long: 0, short: 0 });
    const r = findSqueezeCandles(downtrend, zeroBase);
    // A zero baseline gives no multiple to compute, so the bar is skipped
    // rather than reported as an infinite spike.
    for (const s of r) expect(Number.isFinite(s.multiple)).toBe(true);
  });
});

describe("strongestSqueezePerRun", () => {
  /* A cascade prints across adjacent bars — one event, not four. Marking each
     of them stacked the labels into an unreadable smear on the chart. */
  it("keeps the fiercest bar of a run", () => {
    const r = findSqueezeCandles(
      downtrend,
      liq(80, 70, { short: 9999 }).map((p, i) =>
        i >= 69 && i <= 71 ? { ...p, shortLiquidated: i === 70 ? 9999 : 4000, delta: 0 } : p
      )
    );
    expect(r.length).toBeGreaterThan(1);
    const collapsed = strongestSqueezePerRun(r);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].index).toBe(70);
  });

  it("keeps two flushes that were genuinely separate", () => {
    const series = liq(80, -1, {}).map((p, i) =>
      i === 50 || i === 70 ? { ...p, shortLiquidated: 9999 } : p
    );
    const collapsed = strongestSqueezePerRun(findSqueezeCandles(downtrend, series));
    expect(collapsed.length).toBe(2);
  });

  it("returns nothing for nothing", () => {
    expect(strongestSqueezePerRun([])).toEqual([]);
  });
});
