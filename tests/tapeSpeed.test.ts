import { describe, expect, it } from "vitest";
import { analyzeTapeSpeed } from "@/engines/tapeSpeed";
import { Candle } from "@/engines/types";

const T0 = 1_700_000_000;
const BAR = 900;
const SUB = 60;

function bars(n: number, volume = 1000, trades = 200): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    time: T0 + i * BAR,
    open: 100,
    high: 100.5,
    low: 99.5,
    close: 100,
    volume,
    takerBuyVolume: volume / 2,
    trades,
  }));
}

/** Sub-bars for bar `i`, each carrying the given volume. */
function subsFor(i: number, volumes: number[]): Candle[] {
  return volumes.map((v, k) => ({
    time: T0 + i * BAR + k * SUB,
    open: 100,
    high: 100.2,
    low: 99.8,
    close: 100,
    volume: v,
    takerBuyVolume: v / 2,
    trades: 10,
  }));
}

describe("analyzeTapeSpeed — what it refuses", () => {
  it("returns nothing on too little history", () => {
    expect(analyzeTapeSpeed(bars(5), null).bars).toEqual([]);
  });

  it("returns nothing when the bar interval is unreadable", () => {
    const stuck = bars(20).map((c) => ({ ...c, time: T0 }));
    const r = analyzeTapeSpeed(stuck, null);
    expect(r.bars).toEqual([]);
    expect(r.headline).toMatch(/unreadable/i);
  });

  it("calls a flat tape flat rather than finding bursts in it", () => {
    const r = analyzeTapeSpeed(bars(40), null);
    expect(r.bursts).toEqual([]);
    expect(r.current?.multiple).toBeCloseTo(1, 1);
  });
});

describe("analyzeTapeSpeed — resolution", () => {
  it("falls back to bar resolution and says the peak is diluted", () => {
    const r = analyzeTapeSpeed(bars(40), null);
    expect(r.resolution).toBe("bar");
    expect(r.caveats.join(" ")).toMatch(/diluted across the whole of it/i);
    // The peak can only be the average at this resolution.
    for (const b of r.bars) expect(b.peakVolumePerSecond).toBe(b.volumePerSecond);
  });

  it("finds a burst that hides inside a bar of ordinary total volume", () => {
    /* This is the case bar resolution cannot see: the bar's total is normal,
       but almost all of it arrived in one sub-bar. */
    const all = bars(40);
    const subs: Candle[] = [];
    for (let i = 0; i < all.length; i++) {
      // 15 sub-bars sharing 1000 evenly, except the last bar which crams it in.
      subs.push(...(i === all.length - 1
        ? subsFor(i, [940, ...Array(14).fill(4)])
        : subsFor(i, Array(15).fill(1000 / 15))));
    }
    const flat = analyzeTapeSpeed(all, null);
    const fine = analyzeTapeSpeed(all, subs);
    expect(fine.resolution).toBe("sub_bar");
    expect(flat.current!.multiple).toBeCloseTo(1, 1);
    expect(fine.current!.burst).toBe(true);
    expect(fine.current!.multiple).toBeGreaterThan(flat.current!.multiple);
  });

  it("separates a burst from a violent one", () => {
    const all = bars(40);
    const mild = [...all];
    mild[mild.length - 1] = { ...mild[mild.length - 1], volume: 3000 };
    const violent = [...all];
    violent[violent.length - 1] = { ...violent[violent.length - 1], volume: 9000 };
    expect(analyzeTapeSpeed(mild, null).current!.extreme).toBe(false);
    expect(analyzeTapeSpeed(mild, null).current!.burst).toBe(true);
    expect(analyzeTapeSpeed(violent, null).current!.extreme).toBe(true);
  });
});

describe("analyzeTapeSpeed — size against count", () => {
  it("calls size without count one participant", () => {
    const all = bars(40);
    // Same number of trades, far more volume: fewer, larger orders.
    all[all.length - 1] = { ...all[all.length - 1], volume: 4000, trades: 200 };
    expect(analyzeTapeSpeed(all, null).note).toMatch(/one participant working/i);
  });

  it("calls count without size a liquidation engine or a crowd", () => {
    const all = bars(40);
    all[all.length - 1] = { ...all[all.length - 1], volume: 1000, trades: 900 };
    expect(analyzeTapeSpeed(all, null).note).toMatch(/liquidation engine|retail crowd/i);
  });

  it("calls both rising broad participation", () => {
    const all = bars(40);
    all[all.length - 1] = { ...all[all.length - 1], volume: 4000, trades: 900 };
    expect(analyzeTapeSpeed(all, null).note).toMatch(/broad participation/i);
  });

  it("says so when the feed carries no trade counts", () => {
    const all = bars(40).map(({ trades: _trades, ...rest }) => rest);
    const r = analyzeTapeSpeed(all, null);
    expect(r.baselineTradesPerSecond).toBeNull();
    expect(r.caveats.join(" ")).toMatch(/looks quiet/i);
    expect(r.note).toBe("");
  });
});

describe("analyzeTapeSpeed — scale", () => {
  it("reports the same multiples when every size is multiplied", () => {
    // Speed is relative to this market's own rate, so the unit must not matter.
    const small = bars(40);
    small[small.length - 1] = { ...small[small.length - 1], volume: 5000 };
    const large = small.map((c) => ({ ...c, volume: c.volume * 10_000 }));
    expect(analyzeTapeSpeed(large, null).current!.multiple).toBeCloseTo(
      analyzeTapeSpeed(small, null).current!.multiple,
      2
    );
  });

  it("says the threshold is relative, not absolute", () => {
    expect(analyzeTapeSpeed(bars(40), null).caveats.join(" ")).toMatch(/against this market's own recent rate/i);
  });

  it("emits finite numbers on a zero-volume series", () => {
    const dead = bars(40, 0, 0);
    const r = analyzeTapeSpeed(dead, null);
    for (const b of r.bars) expect(Number.isFinite(b.multiple)).toBe(true);
  });
});
