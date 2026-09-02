import { describe, expect, it } from "vitest";
import {
  buildFundingReport,
  emptyFundingReport,
  settlementsPerDay,
} from "@/engines/fundingRates";
import type { FundingPoint, PremiumIndexSnapshot } from "@/lib/binance";

/**
 * Funding is the one number on this page that is a *cost* rather than an
 * inference, so the arithmetic has to be exactly right — a wrong cadence
 * silently doubles or halves every annualised figure, and an annualised figure
 * is the number a reader actually reasons with.
 *
 * What is pinned here: the cadence is measured rather than assumed, the sign
 * convention is Binance's, and nothing in the output edges toward a forecast.
 */

const H8 = 8 * 3600;
const t0 = 1_700_000_000;

/** A settled-funding series at a given cadence and rate. */
function series(count: number, rate: number, gapSec = H8): FundingPoint[] {
  return Array.from({ length: count }, (_, i) => ({ time: t0 + i * gapSec, rate }));
}

const premium = (over: Partial<PremiumIndexSnapshot> = {}): PremiumIndexSnapshot => ({
  symbol: "TESTUSDT",
  markPrice: 100.5,
  indexPrice: 100,
  basisPct: 0.5,
  lastFundingRate: 0.0001,
  interestRate: 0.0001,
  nextFundingTime: t0 + H8,
  time: t0,
  ...over,
});

describe("settlementsPerDay", () => {
  it("reads the usual eight-hour cadence off the series", () => {
    expect(settlementsPerDay(series(10, 0.0001))).toBe(3);
  });

  it("reads a four-hour cadence rather than assuming three a day", () => {
    // Some contracts settle every four hours. Assuming three would understate
    // their annual cost by half.
    expect(settlementsPerDay(series(10, 0.0001, 4 * 3600))).toBe(6);
  });

  it("falls back to three a day when the series is too short to measure", () => {
    expect(settlementsPerDay([])).toBe(3);
    expect(settlementsPerDay(series(2, 0.0001))).toBe(3);
  });

  it("uses the median gap so one missed settlement does not drag the cadence", () => {
    const points = series(9, 0.0001);
    // Drop one settlement, leaving a single 16-hour hole in an 8-hour series.
    points.splice(4, 1);
    expect(settlementsPerDay(points)).toBe(3);
  });
});

describe("buildFundingReport", () => {
  it("reports positive rates as longs paying, Binance's own convention", () => {
    const r = buildFundingReport("TESTUSDT", premium({ lastFundingRate: 0.0003 }), series(21, 0.0003));
    expect(r.payer).toBe("longs");
    expect(r.currentRatePct).toBeCloseTo(0.03, 5);
  });

  it("reports negative rates as shorts paying", () => {
    const r = buildFundingReport("TESTUSDT", premium({ lastFundingRate: -0.0002 }), series(21, -0.0002));
    expect(r.payer).toBe("shorts");
  });

  it("calls a rate near the anchor balanced rather than picking a side", () => {
    // A ten-thousandth of a percent is the rate sitting on its floor. Calling
    // that "longs are paying" would invent a crowded side out of noise.
    const r = buildFundingReport("TESTUSDT", premium({ lastFundingRate: 0.0000001 }), series(21, 0.0000001));
    expect(r.payer).toBe("balanced");
  });

  it("annualises at the measured cadence, not a hardcoded one", () => {
    const eight = buildFundingReport("T", premium({ lastFundingRate: 0.0001 }), series(21, 0.0001));
    const four = buildFundingReport(
      "T",
      premium({ lastFundingRate: 0.0001 }),
      series(21, 0.0001, 4 * 3600)
    );
    // 0.01% × 3 × 365 = 10.95%; the same rate settled twice as often costs twice as much.
    expect(eight.annualisedPct).toBeCloseTo(10.95, 2);
    expect(four.annualisedPct).toBeCloseTo(21.9, 2);
  });

  it("separates a standing cost from a single spike via consistency", () => {
    const steady = buildFundingReport("T", premium(), series(21, 0.0002));
    const mixed = buildFundingReport("T", premium(), [
      ...series(10, 0.0002),
      ...series(10, -0.0002).map((p, i) => ({ ...p, time: t0 + (10 + i) * H8 })),
    ]);
    expect(steady.consistency).toBe(1);
    expect(mixed.consistency!).toBeLessThan(0.7);
  });

  it("sums the cumulative cost rather than averaging it", () => {
    // What the crowded side has actually paid is the sum. The average says
    // how hard each settlement bit; the sum is what forces the exit.
    const r = buildFundingReport("T", premium(), series(10, 0.0001));
    expect(r.cumulativePct).toBeCloseTo(0.1, 4);
    expect(r.avg8hPct).toBeCloseTo(0.01, 5);
  });

  it("keeps the trailing averages ordered by how much they include", () => {
    // A week of calm ending in a spike: the last print must read hotter than
    // the week, or the windows are being sliced from the wrong end.
    const points = [...series(20, 0.00001), { time: t0 + 20 * H8, rate: 0.001 }];
    const r = buildFundingReport("T", premium({ lastFundingRate: 0.001 }), points);
    expect(r.avg8hPct!).toBeGreaterThan(r.avg24hPct!);
    expect(r.avg24hPct!).toBeGreaterThan(r.avg7dPct!);
  });

  it("falls back to the last settled rate when no live premium is available", () => {
    const r = buildFundingReport("T", null, series(21, 0.0004));
    expect(r.currentRatePct).toBeCloseTo(0.04, 5);
    expect(r.interestRatePct).toBeNull();
    expect(r.basisPct).toBeNull();
  });

  it("returns an empty report rather than throwing when both reads fail", () => {
    const r = buildFundingReport("T", null, []);
    expect(r.currentRatePct).toBeNull();
    expect(r.payer).toBeNull();
    expect(r.history).toEqual([]);
    expect(r.note).toMatch(/unavailable/i);
  });

  it("carries the live premium through as the moving half of the rate", () => {
    const r = buildFundingReport(
      "T",
      premium({ markPrice: 101, indexPrice: 100, basisPct: 1 }),
      series(21, 0.0005)
    );
    expect(r.basisPct).toBe(1);
    expect(r.markPrice).toBe(101);
    expect(r.indexPrice).toBe(100);
    expect(r.interestRatePct).toBeCloseTo(0.01, 5);
  });

  it("describes a cost and never a direction", () => {
    // The temptation with funding is to turn "shorts are paying" into "price
    // will go up". It is a cost, and the note must not drift into a call.
    const r = buildFundingReport("T", premium({ lastFundingRate: -0.001 }), series(21, -0.001));
    const text = `${r.note} ${emptyFundingReport("T", "x").note}`.toLowerCase();
    for (const banned of ["will rise", "will fall", "expect price", "squeeze incoming", "guarantee"]) {
      expect(text).not.toContain(banned);
    }
    expect(r.note).toMatch(/not a forecast/i);
  });

  it("never emits a non-finite number a panel would render as NaN", () => {
    for (const points of [[], series(1, 0), series(3, 0), series(21, -0.0007)]) {
      const r = buildFundingReport("T", null, points);
      for (const v of [
        r.currentRatePct,
        r.annualisedPct,
        r.avg8hPct,
        r.avg24hPct,
        r.avg7dPct,
        r.cumulativePct,
        r.consistency,
      ]) {
        if (v != null) expect(Number.isFinite(v)).toBe(true);
      }
      expect(Number.isFinite(r.settlementsPerDay)).toBe(true);
      expect(r.settlementsPerDay).toBeGreaterThan(0);
    }
  });
});
