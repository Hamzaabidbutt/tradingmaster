import { describe, expect, it } from "vitest";
import { buildCvdCandles, findCvdRejections } from "@/engines/cvdCandles";
import { BarExcursion, Candle } from "@/engines/types";

/**
 * The entire reason to draw CVD as candles rather than as a line is the wicks,
 * so the tests that matter most are the ones that keep a wick from being
 * invented where no intrabar path was supplied — a fabricated wick would be
 * fabricating the signal.
 */

const T0 = 1_700_000_000;
const HOUR = 3600;

function bars(shares: number[], volume = 1000): Candle[] {
  return shares.map((share, i) => ({
    time: T0 + i * HOUR,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume,
    takerBuyVolume: volume * share,
    trades: 100,
  }));
}

/** An intrabar path for bar `i`, offsets relative to the bar's own start. */
function path(i: number, maxDelta: number, minDelta: number, closeDelta: number): BarExcursion {
  return {
    time: T0 + i * HOUR,
    index: i,
    closeDelta,
    maxDelta,
    minDelta,
    gaveBackUp: Math.max(0, maxDelta - closeDelta),
    gaveBackDown: Math.max(0, closeDelta - minDelta),
    closePosition: 0.5,
    samples: 6,
    verdict: "two_sided",
    note: "",
  };
}

describe("buildCvdCandles — the running total", () => {
  it("returns nothing for nothing", () => {
    expect(buildCvdCandles([]).candles).toEqual([]);
  });

  it("accumulates each bar's delta into the next bar's open", () => {
    // Three bars at 75% buy on 1000 volume: +500 each.
    const s = buildCvdCandles(bars([0.75, 0.75, 0.75]));
    expect(s.candles.map((c) => c.open)).toEqual([0, 500, 1000]);
    expect(s.candles.map((c) => c.close)).toEqual([500, 1000, 1500]);
  });

  it("falls as well as rises", () => {
    const s = buildCvdCandles(bars([0.25, 0.25]));
    expect(s.candles.map((c) => c.close)).toEqual([-500, -1000]);
  });

  it("starts the series at zero on the first bar of the window", () => {
    expect(buildCvdCandles(bars([0.9])).candles[0].open).toBe(0);
  });

  it("clamps a taker figure that exceeds the bar's own volume", () => {
    // Unclamped, one of these drags the series further than the rest puts back.
    const broken = bars([0.5, 0.5]).map((c, i) =>
      i === 0 ? { ...c, takerBuyVolume: c.volume * 5 } : c
    );
    const s = buildCvdCandles(broken);
    expect(s.candles[0].close).toBeLessThanOrEqual(1000);
  });
});

describe("buildCvdCandles — wicks are never invented", () => {
  it("draws every bar wickless without an intrabar reconstruction", () => {
    const s = buildCvdCandles(bars([0.75, 0.25, 0.75]));
    expect(s.fidelity).toBe("bar");
    expect(s.wickedBars).toBe(0);
    for (const c of s.candles) {
      expect(c.high).toBe(Math.max(c.open, c.close));
      expect(c.low).toBe(Math.min(c.open, c.close));
      expect(c.wicked).toBe(false);
    }
  });

  it("says a missing wick means unknown, not a straight line", () => {
    const text = buildCvdCandles(bars([0.75])).caveats.join(" ");
    expect(text).toMatch(/path is unknown/i);
    expect(text).not.toMatch(/straight line inside the bar\.$/);
  });

  it("draws real wicks where a path was supplied", () => {
    const s = buildCvdCandles(bars([0.75]), [path(0, 900, -200, 500)]);
    expect(s.fidelity).toBe("sub_bar");
    expect(s.candles[0].high).toBe(900);
    expect(s.candles[0].low).toBe(-200);
    expect(s.candles[0].wicked).toBe(true);
  });

  it("reports a partly covered window as mixed and counts it", () => {
    const s = buildCvdCandles(bars([0.75, 0.75, 0.75]), [path(2, 900, -100, 500)]);
    expect(s.fidelity).toBe("mixed");
    expect(s.wickedBars).toBe(1);
    expect(s.caveats.join(" ")).toMatch(/2 of 3 bars/);
  });

  it("keeps the wick containing the body when the two sources disagree", () => {
    /* The running total comes from the candles and the path from a sub-series,
       so they can differ by a rounding. A candle whose high sits below its
       close is not coarser — it is invalid, and the chart library rejects it. */
    const s = buildCvdCandles(bars([0.75]), [path(0, 10, -10, 10)]);
    const c = s.candles[0];
    expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
    expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
  });

  it("matches every path by time, not by position", () => {
    // A path list that starts partway through the window must still land on
    // the right bars.
    const s = buildCvdCandles(bars([0.5, 0.75, 0.5]), [path(1, 800, -50, 500)]);
    expect(s.candles[0].wicked).toBe(false);
    expect(s.candles[1].wicked).toBe(true);
    expect(s.candles[2].wicked).toBe(false);
  });
});

describe("buildCvdCandles — honesty", () => {
  it("says so when there is no taker breakdown at all", () => {
    const noTaker = bars([0.5]).map(({ takerBuyVolume: _t, ...rest }) => rest);
    expect(buildCvdCandles(noTaker).caveats.join(" ")).toMatch(/placeholder, not a measurement/i);
  });

  it("says the level is relative to the window", () => {
    expect(buildCvdCandles(bars([0.75])).caveats.join(" ")).toMatch(/relative to where you are looking/i);
  });

  it("emits finite numbers on a zero-volume series", () => {
    const dead = bars([0.5, 0.5]).map((c) => ({ ...c, volume: 0, takerBuyVolume: 0 }));
    for (const c of buildCvdCandles(dead).candles) {
      for (const v of [c.open, c.high, c.low, c.close, c.delta]) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it("produces a valid OHLC candle on every bar", () => {
    const s = buildCvdCandles(
      bars([0.75, 0.25, 0.6, 0.4]),
      [path(0, 900, -200, 500), path(2, 300, -600, 200)]
    );
    for (const c of s.candles) {
      expect(c.high).toBeGreaterThanOrEqual(c.low);
      expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
      expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
    }
  });
});

describe("findCvdRejections", () => {
  it("finds nothing without enough reconstructed bars", () => {
    expect(findCvdRejections(buildCvdCandles(bars([0.75, 0.75])))).toEqual([]);
  });

  it("ignores wickless bars rather than calling them unrejected", () => {
    // No wick here means no data, not an absence of rejection.
    expect(findCvdRejections(buildCvdCandles(bars(Array(20).fill(0.75))))).toEqual([]);
  });

  it("marks a bar whose upper wick dwarfs its body", () => {
    const shares = Array(10).fill(0.6);
    const paths = shares.map((_, i) =>
      i === 7 ? path(i, 3000, -20, 200) : path(i, 220, -20, 200)
    );
    const found = findCvdRejections(buildCvdCandles(bars(shares), paths));
    expect(found.some((r) => r.time === T0 + 7 * HOUR && r.side === "upper")).toBe(true);
  });

  it("marks the lower side too", () => {
    const shares = Array(10).fill(0.4);
    const paths = shares.map((_, i) =>
      i === 5 ? path(i, 20, -3000, -200) : path(i, 20, -220, -200)
    );
    const found = findCvdRejections(buildCvdCandles(bars(shares), paths));
    expect(found.some((r) => r.time === T0 + 5 * HOUR && r.side === "lower")).toBe(true);
  });

  it("does not report both sides of the same bar", () => {
    const shares = Array(10).fill(0.5);
    const paths = shares.map((_, i) => path(i, 3000, -3000, 0));
    const found = findCvdRejections(buildCvdCandles(bars(shares), paths));
    const perBar = new Map<number, number>();
    for (const r of found) perBar.set(r.time, (perBar.get(r.time) ?? 0) + 1);
    for (const n of perBar.values()) expect(n).toBe(1);
  });

  it("survives a near-zero body without an infinite ratio", () => {
    const shares = Array(10).fill(0.5);
    const paths = shares.map((_, i) => path(i, 500, -10, 0));
    for (const r of findCvdRejections(buildCvdCandles(bars(shares), paths))) {
      expect(Number.isFinite(r.ratio)).toBe(true);
    }
  });

  it("says what a line would have drawn instead", () => {
    const shares = Array(10).fill(0.6);
    const paths = shares.map((_, i) => (i === 7 ? path(i, 3000, -20, 200) : path(i, 220, -20, 200)));
    const found = findCvdRejections(buildCvdCandles(bars(shares), paths));
    expect(found[0].note).toMatch(/a line would draw/i);
  });
});
