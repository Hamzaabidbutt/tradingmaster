import { describe, expect, it } from "vitest";
import { readSessionIntel } from "@/engines/sessionIntel";
import { Candle } from "@/engines/types";

/**
 * Both session patterns are widely traded, which is exactly why they need
 * evidence rather than assertion. The tests here are mostly about the
 * difference between a sweep and a breakout — a trade through a level that
 * comes back, versus one that holds — because conflating those two is what
 * makes a session read useless.
 */

/** A UTC midnight, so hour arithmetic is legible. */
const MIDNIGHT = Date.UTC(2026, 0, 5) / 1000;
const HOUR = 3600;

function bar(hourOffset: number, o: number, h: number, l: number, c: number, v = 1000): Candle {
  return {
    time: MIDNIGHT + hourOffset * HOUR,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: v,
    takerBuyVolume: v * 0.5,
  };
}

/** Flat bars filling one hour band. */
function band(from: number, to: number, price: number, spread = 0.5): Candle[] {
  const out: Candle[] = [];
  for (let hr = from; hr < to; hr++) {
    out.push(bar(hr, price, price + spread, price - spread, price));
  }
  return out;
}

/**
 * A trending band.
 *
 * Needed because a flat band has `open === close` and therefore reports
 * `direction: "flat"` — correctly. A test that wants a session to have gone
 * somewhere has to make it go somewhere.
 */
function trend(from: number, to: number, start: number, end: number): Candle[] {
  const out: Candle[] = [];
  const n = to - from;
  for (let k = 0; k < n; k++) {
    const o = start + ((end - start) * k) / n;
    const c = start + ((end - start) * (k + 1)) / n;
    out.push(bar(from + k, o, Math.max(o, c) + 0.3, Math.min(o, c) - 0.3, c));
  }
  return out;
}

describe("readSessionIntel — statistics", () => {
  it("summarises each session that has enough bars", () => {
    const candles = [...band(0, 8, 100), ...band(8, 16, 102), ...band(16, 22, 101)];
    const r = readSessionIntel(candles);
    expect(r.sessions.map((s) => s.key)).toContain("asia");
    expect(r.sessions.map((s) => s.key)).toContain("london");
    const asia = r.sessions.find((s) => s.key === "asia")!;
    expect(asia.bars).toBe(8);
    expect(asia.high).toBeCloseTo(100.5, 4);
    expect(asia.low).toBeCloseTo(99.5, 4);
    expect(asia.volume).toBe(8000);
  });

  it("omits a session with too few bars rather than reporting unstable stats", () => {
    // Only two Asia bars.
    const r = readSessionIntel([...band(0, 2, 100), ...band(8, 16, 102)]);
    expect(r.sessions.find((s) => s.key === "asia")).toBeUndefined();
  });

  it("says why a daily chart cannot be read this way", () => {
    const r = readSessionIntel([]);
    expect(r.sessions).toHaveLength(0);
    expect(r.note).toMatch(/daily chart a bar spans all three/i);
  });

  it("measures a session still in progress rather than skipping it", () => {
    /* London is five hours in — but the band opens at 07:00 UTC and Asia's
       runs to 08:00, so the 07:00 bar belongs to both. Six is the right
       answer, and the overlap is deliberate: those hours are where most of
       the day's volume trades. */
    const r = readSessionIntel([...band(0, 8, 100), ...band(8, 13, 103)]);
    const london = r.sessions.find((s) => s.key === "london")!;
    expect(london.bars).toBe(6);
  });

  it("names the session the last bar falls in", () => {
    const r = readSessionIntel([...band(0, 8, 100), ...band(8, 12, 102)]);
    expect(r.current).toBe("london");
  });

  it("is explicit that the bands overlap", () => {
    const r = readSessionIntel([...band(0, 8, 100), ...band(8, 16, 102)]);
    expect(r.note).toMatch(/overlap/i);
  });
});

describe("readSessionIntel — London sweep, New York reversal", () => {
  const pattern = (candles: Candle[]) =>
    readSessionIntel(candles).patterns.find((p) => p.kind === "london_sweep_ny_reversal")!;

  it("fires when London ran Asia's high, came back, and New York fell", () => {
    /* Hours 13–15 belong to London *and* New York — the bands overlap — so
       London's close is the 15:00 bar, not the 12:00 one. The decline that
       makes New York bearish therefore also carries London back inside
       Asia's range, which is exactly the shape the pattern describes. */
    const candles = [
      ...band(0, 7, 100), // Asia: high 100.5
      ...band(7, 12, 100),
      bar(12, 100, 104, 99.8, 100.1), // pokes above 100.5, closes back inside
      ...trend(13, 22, 99, 92), // New York: genuinely down
    ];
    const p = pattern(candles);
    expect(p.found).toBe(true);
    expect(p.side).toBe("up");
    expect(p.conditions.every((c) => c.met)).toBe(true);
  });

  it("calls a London close ABOVE the level a breakout, not a sweep", () => {
    const candles = [
      ...band(0, 7, 100),
      ...band(7, 12, 100),
      bar(12, 100, 104, 99.8, 103), // closes beyond…
      ...trend(13, 22, 103, 108), // …and stays beyond through London's close
    ];
    const p = pattern(candles);
    expect(p.found).toBe(false);
    const reclaim = p.conditions.find((c) => c.label.includes("closed back inside"))!;
    expect(reclaim.met).toBe(false);
    expect(reclaim.detail).toMatch(/breakout rather than a sweep/i);
  });

  it("does not fire when New York agrees with the sweep instead of opposing it", () => {
    const candles = [
      ...band(0, 7, 100),
      ...band(7, 12, 100),
      bar(12, 100, 104, 99.8, 100.1),
      ...trend(13, 22, 101, 108), // New York up, same side as the sweep
    ];
    expect(pattern(candles).found).toBe(false);
  });

  it("shows every condition so a near-miss is legible", () => {
    const candles = [...band(0, 8, 100), ...band(8, 16, 100)];
    const p = pattern(candles);
    expect(p.conditions).toHaveLength(3);
    for (const c of p.conditions) expect(c.detail.length).toBeGreaterThan(10);
    expect(p.note).toMatch(/two of three is not the pattern/i);
  });

  it("says the read is not a forecast", () => {
    const candles = [
      ...band(0, 7, 100),
      ...band(7, 12, 100),
      bar(12, 100, 104, 99.8, 100.1),
      ...trend(13, 22, 99, 92),
    ];
    const p = pattern(candles);
    expect(p.note).toMatch(/already happened/i);
    expect(p.note.toLowerCase()).not.toContain("will continue");
  });
});

describe("readSessionIntel — Asia range, London breakout", () => {
  const pattern = (candles: Candle[]) =>
    readSessionIntel(candles).patterns.find((p) => p.kind === "asia_range_london_breakout")!;

  it("fires on a tight Asia, a close beyond it, and expanding volatility", () => {
    const candles = [
      ...band(0, 8, 100, 0.2), // tight
      ...band(8, 12, 102, 2), // London: beyond 100.2, and wider bars
    ];
    const p = pattern(candles);
    expect(p.found).toBe(true);
    expect(p.side).toBe("up");
  });

  it("refuses when Asia was not a range", () => {
    const candles = [...band(0, 8, 100, 6), ...band(8, 12, 112, 2)];
    const p = pattern(candles);
    expect(p.found).toBe(false);
    const tight = p.conditions.find((c) => c.label.includes("tight range"))!;
    expect(tight.met).toBe(false);
    expect(tight.detail).toMatch(/wide Asia is not a coil/i);
  });

  it("refuses a break that happened without volatility expanding", () => {
    const candles = [...band(0, 8, 100, 0.2), ...band(8, 12, 102, 0.2)];
    const p = pattern(candles);
    expect(p.found).toBe(false);
    const vol = p.conditions.find((c) => c.label.includes("volatility"))!;
    expect(vol.met).toBe(false);
    expect(vol.detail).toMatch(/how breakouts fail/i);
  });

  it("names the level that invalidates it", () => {
    const candles = [...band(0, 8, 100, 0.2), ...band(8, 12, 102, 2)];
    const p = pattern(candles);
    expect(p.level).not.toBeNull();
    expect(p.note).toMatch(/back inside it and the breakout failed/i);
  });
});
