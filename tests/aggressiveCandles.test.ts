import { describe, expect, it } from "vitest";
import { findAggressiveCandles, strongestPerRun } from "@/engines/aggressiveCandles";
import { Candle } from "@/engines/types";

/**
 * The filter is a pairing: one-sided *and* busy. Skew alone marks a third of
 * every quiet session, and volume alone marks every ordinary breakout bar, so
 * most of what is pinned here is that neither passes on its own.
 */

const HOUR = 3600;
const T0 = 1_700_000_000;

function bar(over: Partial<Candle> & { buyShare?: number } = {}, i = 0): Candle {
  const volume = over.volume ?? 1000;
  const buyShare = over.buyShare ?? 0.5;
  return {
    time: T0 + i * HOUR,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume,
    takerBuyVolume: volume * buyShare,
    ...(({ buyShare: _drop, ...rest }) => rest)(over),
  };
}

/** 40 ordinary bars, then whatever the test wants to append. */
function withContext(tail: Array<Partial<Candle> & { buyShare?: number }>): Candle[] {
  const base = Array.from({ length: 40 }, (_, i) => bar({ volume: 1000, buyShare: 0.5 }, i));
  return [...base, ...tail.map((t, i) => bar(t, 40 + i))];
}

describe("findAggressiveCandles", () => {
  it("returns nothing on a series too short to have a baseline", () => {
    expect(findAggressiveCandles(withContext([]).slice(0, 10))).toEqual([]);
  });

  it("finds a one-sided bar on real volume", () => {
    const r = findAggressiveCandles(withContext([{ volume: 2000, buyShare: 0.8 }]));
    expect(r).toHaveLength(1);
    expect(r[0].side).toBe("buy");
    expect(r[0].share).toBeCloseTo(0.8, 2);
    expect(r[0].volumeMultiple).toBeCloseTo(2, 1);
  });

  it("mirrors for aggressive selling", () => {
    const r = findAggressiveCandles(withContext([{ volume: 2000, buyShare: 0.15 }]));
    expect(r).toHaveLength(1);
    expect(r[0].side).toBe("sell");
    expect(r[0].share).toBeCloseTo(0.85, 2);
    expect(r[0].delta).toBeLessThan(0);
  });

  it("refuses a one-sided bar on nothing volume", () => {
    // 90% buy share of a tenth of average volume is three trades and a
    // rounding error. Conviction without participation is not conviction.
    expect(findAggressiveCandles(withContext([{ volume: 100, buyShare: 0.9 }]))).toEqual([]);
  });

  it("refuses a busy bar that was two-sided", () => {
    // Heavy volume with balanced takers is a fight, not an aggression.
    expect(findAggressiveCandles(withContext([{ volume: 4000, buyShare: 0.55 }]))).toEqual([]);
  });

  it("holds the skew line where it is set", () => {
    expect(findAggressiveCandles(withContext([{ volume: 2000, buyShare: 0.67 }]))).toEqual([]);
    expect(findAggressiveCandles(withContext([{ volume: 2000, buyShare: 0.69 }]))).toHaveLength(1);
  });

  it("flags the lopsided ones separately from the merely one-sided", () => {
    const ordinary = findAggressiveCandles(withContext([{ volume: 2000, buyShare: 0.72 }]));
    const lopsided = findAggressiveCandles(withContext([{ volume: 2000, buyShare: 0.92 }]));
    expect(ordinary[0].extreme).toBe(false);
    expect(lopsided[0].extreme).toBe(true);
    expect(lopsided[0].strength).toBeGreaterThan(ordinary[0].strength);
  });

  it("scores skew and size together, not either alone", () => {
    const skewed = findAggressiveCandles(withContext([{ volume: 1300, buyShare: 0.92 }]));
    const big = findAggressiveCandles(withContext([{ volume: 5000, buyShare: 0.7 }]));
    // Both qualify, and both contribute — neither dimension can be ignored.
    expect(skewed[0].strength).toBeGreaterThan(0);
    expect(big[0].strength).toBeGreaterThan(0);
  });

  it("never claims aggression predicts direction", () => {
    // The trap this label invites: buyers paying up into resistance that holds
    // is how a trap starts. The aggression was real and it still lost.
    const r = findAggressiveCandles(withContext([{ volume: 3000, buyShare: 0.85 }]));
    const text = r[0].note.toLowerCase();
    for (const banned of ["bullish", "bearish", "will rise", "will fall", "expect"]) {
      expect(text).not.toContain(banned);
    }
    expect(text).toMatch(/not about who was right|who was in a hurry/);
  });

  it("warns that the last bar is still forming", () => {
    const r = findAggressiveCandles(withContext([{ volume: 3000, buyShare: 0.85 }]));
    expect(r[0].note).toMatch(/still forming/i);
  });

  it("does not warn about a bar that has closed", () => {
    const r = findAggressiveCandles(
      withContext([
        { volume: 3000, buyShare: 0.85 },
        { volume: 1000, buyShare: 0.5 },
      ])
    );
    expect(r).toHaveLength(1);
    expect(r[0].note).not.toMatch(/still forming/i);
  });

  it("skips bars with no taker data rather than assuming a split", () => {
    const candles = withContext([{ volume: 3000 }]);
    candles[candles.length - 1].takerBuyVolume = undefined;
    expect(findAggressiveCandles(candles)).toEqual([]);
  });

  it("emits finite numbers on zero-volume and flat input", () => {
    const flat = Array.from({ length: 60 }, (_, i) =>
      bar({ volume: 0, buyShare: 0.5 }, i)
    );
    expect(findAggressiveCandles(flat)).toEqual([]);

    const r = findAggressiveCandles(withContext([{ volume: 9999, buyShare: 1 }]));
    for (const v of [r[0].share, r[0].volumeMultiple, r[0].delta, r[0].strength]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    expect(r[0].strength).toBeLessThanOrEqual(100);
  });
});

describe("strongestPerRun", () => {
  /** Minimal shape — only the fields the collapse actually reads. */
  const b = (index: number, side: "buy" | "sell", strength: number) =>
    ({
      time: T0 + index * HOUR,
      index,
      side,
      share: 0.7,
      volumeMultiple: 1.5,
      delta: side === "buy" ? 100 : -100,
      strength,
      extreme: false,
      note: "",
    }) as const;

  it("returns nothing for nothing", () => {
    expect(strongestPerRun([])).toEqual([]);
  });

  it("keeps the strongest bar of a run and counts its length", () => {
    const r = strongestPerRun([b(10, "sell", 20), b(11, "sell", 55), b(12, "sell", 30)]);
    expect(r).toHaveLength(1);
    expect(r[0].index).toBe(11);
    expect(r[0].strength).toBe(55);
    expect(r[0].runLength).toBe(3);
  });

  it("breaks the run when the side flips on the very next bar", () => {
    const r = strongestPerRun([b(10, "sell", 40), b(11, "buy", 30)]);
    expect(r.map((x) => x.side)).toEqual(["sell", "buy"]);
  });

  it("bridges a short pause but not a long one", () => {
    // Two bars either side of a two-bar gap are one push; a five-bar gap is two.
    expect(strongestPerRun([b(10, "sell", 40), b(13, "sell", 30)])).toHaveLength(1);
    expect(strongestPerRun([b(10, "sell", 40), b(16, "sell", 30)])).toHaveLength(2);
  });

  it("preserves chronological order across several runs", () => {
    const r = strongestPerRun([
      b(5, "buy", 30),
      b(6, "buy", 60),
      b(20, "sell", 70),
      b(40, "buy", 10),
    ]);
    expect(r.map((x) => x.index)).toEqual([6, 20, 40]);
  });

  it("collapses the real engine output without inventing bars", () => {
    const many = findAggressiveCandles(
      withContext([
        { volume: 2000, buyShare: 0.75 },
        { volume: 2100, buyShare: 0.78 },
        { volume: 2050, buyShare: 0.76 },
      ])
    );
    expect(many).toHaveLength(3);
    const collapsed = strongestPerRun(many);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].runLength).toBe(3);
    // Every survivor must be one of the originals, not a synthesised average.
    expect(many.some((m) => m.index === collapsed[0].index)).toBe(true);
  });
});
