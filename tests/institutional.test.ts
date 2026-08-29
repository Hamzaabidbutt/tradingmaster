import { describe, expect, it } from "vitest";
import { detectInstitutional } from "@/engines/institutional";
import { Candle } from "@/engines/types";
import { syntheticCandles } from "./helpers";

/**
 * This engine makes a narrow claim — several *different kinds* of evidence
 * landed on one price band — and deliberately stops short of a forecast. Both
 * halves need guarding: the confluence arithmetic must not inflate, and the
 * output must not start predicting.
 */

/**
 * A constructed accumulation sequence: a flush that liquidates longs, a base
 * where heavy volume trades in a tight range on the bid, and a departure that
 * leaves a gap behind. That is the shape the engine is meant to recognise.
 */
function accumulationSeries(): Candle[] {
  const out: Candle[] = [];
  const t = (i: number) => 1_700_000_000 + i * 3600;
  let price = 120;

  // 1. Distribution and decline — supplies the swings the structure engine needs.
  for (let i = 0; i < 40; i++) {
    const open = price;
    const close = open - 0.5 - (i % 3) * 0.1;
    out.push({
      time: t(i),
      open,
      high: open + 0.3,
      low: close - 0.35,
      close,
      volume: 1000 + (i % 5) * 60,
      takerBuyVolume: (1000 + (i % 5) * 60) * 0.4,
    });
    price = close;
  }

  // 2. The flush: an outsized down bar on sell-side aggression, with a long
  //    lower wick — forced supply hitting whatever was resting underneath.
  const flushOpen = price;
  const flushLow = flushOpen - 6;
  const flushClose = flushOpen - 1.4;
  out.push({
    time: t(40),
    open: flushOpen,
    high: flushOpen + 0.2,
    low: flushLow,
    close: flushClose,
    volume: 9000,
    takerBuyVolume: 9000 * 0.18,
  });
  price = flushClose;

  // 3. The base: heavy volume, tight range, buy-side taker share. Selling
  //    keeps arriving and price refuses to go with it.
  for (let i = 0; i < 14; i++) {
    const open = price;
    const close = open + 0.05;
    out.push({
      time: t(41 + i),
      open,
      high: open + 0.28,
      low: open - 0.3,
      close,
      volume: 6000,
      takerBuyVolume: 6000 * 0.63,
    });
    price = close;
  }

  // 4. The departure: three bars that gap away from the base, leaving an
  //    unfilled bullish imbalance behind them.
  const legs = [
    { o: price, h: price + 2.2, l: price - 0.1, c: price + 2.0 },
    { o: price + 2.4, h: price + 5.4, l: price + 2.3, c: price + 5.2 },
    { o: price + 5.3, h: price + 7.6, l: price + 5.2, c: price + 7.3 },
  ];
  legs.forEach((leg, i) => {
    out.push({
      time: t(55 + i),
      open: leg.o,
      high: leg.h,
      low: leg.l,
      close: leg.c,
      volume: 7000,
      takerBuyVolume: 7000 * 0.72,
    });
  });
  price = legs[2].c;

  // 5. A drift back toward the area, so the zone is still in range of price.
  for (let i = 0; i < 12; i++) {
    const open = price;
    const close = open - 0.25;
    out.push({
      time: t(58 + i),
      open,
      high: open + 0.2,
      low: close - 0.25,
      close,
      volume: 2200,
      takerBuyVolume: 2200 * 0.47,
    });
    price = close;
  }

  return out;
}

describe("detectInstitutional", () => {
  it("returns a safe empty read on short history", () => {
    const r = detectInstitutional("TESTUSDT", "1h", syntheticCandles(20, 5, 100));
    expect(r.qualified).toBe(false);
    expect(r.zone).toBeNull();
    expect(r.score).toBe(0);
    expect(r.headline).toMatch(/history/i);
  });

  it("counts distinct kinds of evidence, never repeats of one", () => {
    const r = detectInstitutional("TESTUSDT", "1h", accumulationSeries());
    for (const z of r.zones) {
      // The whole thesis: three order blocks at one price is one mechanism
      // repeating, so `confluence` must track distinct sources, not marks.
      expect(new Set(z.sources).size).toBe(z.sources.length);
      expect(z.confluence).toBe(z.sources.length);
    }
  });

  it("only qualifies when score, kinds and confluence all clear their bars", () => {
    for (const seed of [3, 11, 29, 47, 61]) {
      const r = detectInstitutional("TESTUSDT", "1h", syntheticCandles(200, seed, 100));
      const kinds = r.evidence.filter((e) => e.found).length;
      if (r.qualified) {
        expect(r.score).toBeGreaterThanOrEqual(60);
        expect(kinds).toBeGreaterThanOrEqual(4);
        expect(r.zone?.confluence ?? 0).toBeGreaterThanOrEqual(2);
        expect(r.side).toBe("accumulation");
      } else {
        expect(r.side).toBe("none");
      }
    }
  });

  it("finds converging evidence on a constructed accumulation sequence", () => {
    const r = detectInstitutional("TESTUSDT", "1h", accumulationSeries());
    const found = r.evidence.filter((e) => e.found).map((e) => e.key);
    // Not asserting `qualified` — the bar is deliberately high and a synthetic
    // series need not clear it. What must hold is that the shape registers:
    // several mechanisms fire, and they land on one area rather than scatter.
    expect(found.length).toBeGreaterThanOrEqual(3);
    expect(r.zones.length).toBeGreaterThan(0);
    expect(r.zone).not.toBeNull();
    expect(r.score).toBeGreaterThan(0);
  });

  it("states the limit of its claim rather than implying a forecast", () => {
    const r = detectInstitutional("TESTUSDT", "1h", accumulationSeries());
    const text = r.explanation.join(" ");
    expect(text).toMatch(/What this does not say: where price goes next/);
    // No probability-of-profit language anywhere in the output.
    expect(text).not.toMatch(/\d+% (chance|likely|probability of (a )?(win|profit))/i);
  });

  it("keeps every reported zone within the in-range window", () => {
    for (const seed of [2, 13, 37]) {
      const r = detectInstitutional("TESTUSDT", "1h", syntheticCandles(200, seed, 100));
      for (const z of r.zones) {
        // Evidence 12% away is history, not an area price is trading against.
        expect(Math.abs(z.distancePct)).toBeLessThanOrEqual(12);
        expect(z.low).toBeLessThanOrEqual(z.high);
        expect(z.mid).toBeGreaterThanOrEqual(z.low);
        expect(z.mid).toBeLessThanOrEqual(z.high);
      }
    }
  });

  it("puts invalidation at the bottom of the zone and confirmation above price", () => {
    const r = detectInstitutional("TESTUSDT", "1h", accumulationSeries());
    if (r.zone) expect(r.invalidateBelow).toBe(r.zone.low);
    if (r.confirmAbove != null) expect(r.confirmAbove).toBeGreaterThan(r.price);
    if (r.objective != null && r.confirmAbove != null) {
      expect(r.objective).toBeGreaterThan(r.confirmAbove);
    }
  });

  it("reads falling open interest as positions leaving, not size building", () => {
    const candles = accumulationSeries();
    const rising = detectInstitutional("TESTUSDT", "1h", candles, [100, 110, 125, 140, 160]);
    const falling = detectInstitutional("TESTUSDT", "1h", candles, [160, 145, 130, 115, 100]);

    const oiOf = (r: ReturnType<typeof detectInstitutional>) =>
      r.evidence.find((e) => e.key === "open_interest")!;
    expect(oiOf(rising).found).toBe(true);
    expect(oiOf(falling).found).toBe(false);
    expect(rising.score).toBeGreaterThan(falling.score);
    expect(oiOf(falling).detail).toMatch(/closing|covering/i);
  });

  it("reports no open-interest read when none is supplied", () => {
    const r = detectInstitutional("TESTUSDT", "1h", accumulationSeries(), null);
    expect(r.openInterestChangePct).toBeNull();
    const oi = r.evidence.find((e) => e.key === "open_interest")!;
    expect(oi.found).toBe(false);
    expect(oi.detail).toMatch(/No open-interest history/i);
  });

  it("survives arbitrary series without throwing or emitting bad numbers", () => {
    for (const seed of [1, 8, 19, 26, 44, 53]) {
      const r = detectInstitutional("TESTUSDT", "1h", syntheticCandles(160, seed, 50));
      expect(Number.isFinite(r.score)).toBe(true);
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
      expect(r.evidence.length).toBeGreaterThan(0);
      for (const e of r.evidence) {
        expect(e.score).toBeLessThanOrEqual(e.weight);
        expect(e.detail.length).toBeGreaterThan(0);
      }
    }
  });
});
