import { describe, expect, it } from "vitest";
import { readPositioning, readValueMigration } from "@/engines/positioning";
import { Candle } from "@/engines/types";

/**
 * The quadrant is only worth anything if it refuses to produce one from data
 * that cannot support it, so most of what is pinned here is the refusals:
 * missing open interest, a stale series, a single print straddling the
 * window, and either axis sitting inside its noise band.
 */

const HOUR = 3600;
const T0 = 1_700_000_000;

function bar(i: number, close: number, over: Partial<Candle> = {}): Candle {
  return {
    time: T0 + i * HOUR,
    open: close,
    high: close * 1.002,
    low: close * 0.998,
    close,
    volume: 1000,
    takerBuyVolume: 500,
    ...over,
  };
}

/** A ramp of `n` bars from `from` to `to`. */
function ramp(n: number, from: number, to: number, over: (i: number) => Partial<Candle> = () => ({})): Candle[] {
  return Array.from({ length: n }, (_, i) => bar(i, from + ((to - from) * i) / (n - 1), over(i)));
}

/** Open-interest points on the candle grid, ramping the same way. */
function oiSeries(n: number, from: number, to: number) {
  return Array.from({ length: n }, (_, i) => ({
    time: T0 + i * HOUR,
    openInterest: from + ((to - from) * i) / (n - 1),
  }));
}

describe("readPositioning — refusals", () => {
  it("refuses with no candles", () => {
    const r = readPositioning([], oiSeries(20, 100, 110));
    expect(r.quadrant).toBeNull();
    expect(r.caveats[0]).toMatch(/two candles/i);
  });

  it("refuses when the contract has no open-interest history", () => {
    const r = readPositioning(ramp(20, 100, 110), []);
    expect(r.quadrant).toBeNull();
    expect(r.caveats[0]).toMatch(/no open-interest history/i);
  });

  it("refuses a stale open-interest series rather than pairing it with fresh candles", () => {
    // Readings that stop a day before the candles start.
    const stale = [
      { time: T0 - 86_400, openInterest: 100 },
      { time: T0 - 86_000, openInterest: 120 },
    ];
    const r = readPositioning(ramp(20, 100, 110), stale);
    expect(r.quadrant).toBeNull();
    expect(r.caveats[0]).toMatch(/stale|do not cover/i);
  });

  it("refuses when a single print straddles the whole window", () => {
    /* The real shape of this: a fast timeframe against a series that only
       publishes every five minutes. Minute bars, a twelve-bar window, and one
       print recent enough to be valid at both ends of it — so start and end
       resolve to the same reading and the change across the window is a
       fiction. (On hourly bars this cannot arise: an eleven-hour window is
       wider than the staleness limit, so a lone print fails that guard
       first.) */
    const minuteBars = Array.from({ length: 60 }, (_, i) => ({
      ...bar(0, 100 + i * 0.02),
      time: T0 + i * 60,
    }));
    const r = readPositioning(minuteBars, [{ time: T0, openInterest: 100 }], 12);
    expect(r.quadrant).toBeNull();
    expect(r.caveats[0]).toMatch(/one open-interest reading/i);
  });

  it("refuses when price is inside its noise band", () => {
    const flat = ramp(30, 100, 100.05);
    const r = readPositioning(flat, oiSeries(30, 100, 130));
    expect(r.quadrant).toBeNull();
    expect(r.caveats[0]).toMatch(/noise band|flat/i);
    // The measured numbers still come back — the refusal is about the verdict.
    expect(r.oiPct).toBeGreaterThan(0);
  });

  it("refuses when open interest is inside its noise band", () => {
    const r = readPositioning(ramp(30, 100, 110), oiSeries(30, 100, 100.05));
    expect(r.quadrant).toBeNull();
    expect(r.caveats[0]).toMatch(/noise band|between existing holders/i);
    expect(r.pricePct).toBeGreaterThan(0);
  });
});

describe("readPositioning — staleness scales with the bar interval", () => {
  /** Daily bars: a window's start is days back, not minutes. */
  const dayBars = (n: number, from: number, to: number): Candle[] =>
    Array.from({ length: n }, (_, i) => ({
      ...bar(0, from + ((to - from) * i) / (n - 1)),
      time: T0 + i * 86_400,
    }));

  it("accepts a reading one bar old on a daily chart", () => {
    // Prints every twelve hours — far past a flat one-hour tolerance, but
    // well inside one daily bar.
    const oi = Array.from({ length: 80 }, (_, i) => ({
      time: T0 + i * 43_200,
      openInterest: 100 + i * 0.5,
    }));
    const r = readPositioning(dayBars(40, 100, 130), oi);
    expect(r.quadrant).toBe("new_longs");
  });

  it("still refuses a reading older than a bar", () => {
    // One print, a week before the window even starts.
    const oi = [{ time: T0, openInterest: 100 }];
    const r = readPositioning(dayBars(40, 100, 130), oi);
    expect(r.quadrant).toBeNull();
  });

  it("keeps the one-hour floor on fast timeframes", () => {
    // Minute bars: one bar of tolerance would be 60 seconds, which no
    // five-minute series could ever satisfy.
    const minuteBars = Array.from({ length: 60 }, (_, i) => ({
      ...bar(0, 100 + i * 0.05),
      time: T0 + i * 60,
    }));
    const oi = Array.from({ length: 24 }, (_, i) => ({
      time: T0 + i * 300,
      openInterest: 100 + i * 0.4,
    }));
    const r = readPositioning(minuteBars, oi);
    expect(r.quadrant).toBe("new_longs");
  });
});

describe("readPositioning — the four quadrants", () => {
  it("names new longs when price and open interest both rise", () => {
    const r = readPositioning(ramp(30, 100, 112), oiSeries(30, 100, 120));
    expect(r.quadrant).toBe("new_longs");
    expect(r.participation).toBe("opening");
    expect(r.pricePct).toBeGreaterThan(0);
    expect(r.oiPct).toBeGreaterThan(0);
  });

  it("names short covering when price rises on falling open interest", () => {
    const r = readPositioning(ramp(30, 100, 112), oiSeries(30, 120, 100));
    expect(r.quadrant).toBe("short_covering");
    expect(r.participation).toBe("closing");
    expect(r.mechanism).toMatch(/finite/i);
  });

  it("names new shorts when price falls on rising open interest", () => {
    const r = readPositioning(ramp(30, 112, 100), oiSeries(30, 100, 120));
    expect(r.quadrant).toBe("new_shorts");
    expect(r.participation).toBe("opening");
  });

  it("names long liquidation when both fall", () => {
    const r = readPositioning(ramp(30, 112, 100), oiSeries(30, 120, 100));
    expect(r.quadrant).toBe("long_liquidation");
    expect(r.participation).toBe("closing");
  });

  it("mirrors: the same magnitudes give the same strength either side", () => {
    const up = readPositioning(ramp(30, 100, 112), oiSeries(30, 100, 120));
    const down = readPositioning(ramp(30, 112, 100), oiSeries(30, 120, 100));
    expect(Math.abs(up.strength - down.strength)).toBeLessThanOrEqual(2);
  });
});

describe("readPositioning — the delta cross-check", () => {
  it("flags a rise that happened against the aggressive flow", () => {
    // Price up, but takers were overwhelmingly selling: absorption.
    const bars = ramp(30, 100, 112, () => ({ takerBuyVolume: 150 }));
    const r = readPositioning(bars, oiSeries(30, 100, 120));
    expect(r.deltaAgrees).toBe(false);
  });

  it("does not flag a rise the flow agreed with", () => {
    const bars = ramp(30, 100, 112, () => ({ takerBuyVolume: 850 }));
    const r = readPositioning(bars, oiSeries(30, 100, 120));
    expect(r.deltaAgrees).toBe(true);
  });

  it("reports disagreement once, as a field and not also as prose", () => {
    // Both together printed the absorption warning twice in the panel.
    const bars = ramp(30, 100, 112, () => ({ takerBuyVolume: 150 }));
    const r = readPositioning(bars, oiSeries(30, 100, 120));
    expect(r.caveats.join(" ")).not.toMatch(/absorption/i);
  });

  it("skips the check rather than assuming a split when takers are missing", () => {
    const bars = ramp(30, 100, 112).map((c) => ({ ...c, takerBuyVolume: undefined }));
    const r = readPositioning(bars, oiSeries(30, 100, 120));
    expect(r.deltaAgrees).toBeNull();
    expect(r.caveats.join(" ")).toMatch(/no taker breakdown/i);
  });

  it("never claims the quadrant predicts direction", () => {
    for (const [c, o] of [
      [ramp(30, 100, 112), oiSeries(30, 120, 100)],
      [ramp(30, 112, 100), oiSeries(30, 100, 120)],
    ] as const) {
      const text = `${readPositioning(c, o).headline} ${readPositioning(c, o).mechanism}`.toLowerCase();
      for (const banned of ["will rise", "will fall", "will reverse", "guaranteed", "expect price to"]) {
        expect(text).not.toContain(banned);
      }
    }
  });
});

describe("readValueMigration", () => {
  it("returns null rather than comparing halves that are too short", () => {
    expect(readValueMigration(ramp(10, 100, 110))).toBeNull();
  });

  it("calls a steady advance a migration higher", () => {
    const r = readValueMigration(ramp(120, 100, 160));
    expect(r).not.toBeNull();
    expect(r!.direction).toBe("higher");
    expect(r!.current.poc).toBeGreaterThan(r!.prior.poc);
    expect(r!.overlap).toBeLessThan(0.6);
  });

  it("mirrors for a decline", () => {
    const r = readValueMigration(ramp(120, 160, 100));
    expect(r!.direction).toBe("lower");
    expect(r!.current.poc).toBeLessThan(r!.prior.poc);
  });

  it("calls a range rotation overlapping, not a migration", () => {
    // Oscillate inside one band: both halves profile the same prices.
    const bars = Array.from({ length: 120 }, (_, i) => bar(i, 100 + Math.sin(i / 3) * 2));
    const r = readValueMigration(bars);
    expect(r!.direction).toBe("overlapping");
    expect(r!.overlap).toBeGreaterThanOrEqual(0.6);
    expect(r!.detail).toMatch(/rotating/i);
  });

  it("says the halves are bars, not calendar sessions", () => {
    const r = readValueMigration(ramp(120, 100, 160));
    expect(r!.caveats.join(" ")).toMatch(/not calendar sessions/i);
  });

  it("emits finite numbers on a dead flat series", () => {
    const r = readValueMigration(Array.from({ length: 120 }, (_, i) => bar(i, 100)));
    expect(r).not.toBeNull();
    for (const v of [r!.overlap, r!.current.poc, r!.prior.poc]) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});
