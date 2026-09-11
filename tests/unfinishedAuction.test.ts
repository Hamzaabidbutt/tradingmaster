import { describe, expect, it } from "vitest";
import { buildFootprint, findUnfinishedAuctions } from "@/engines/footprint";
import { Candle } from "@/engines/types";

/**
 * A finished auction leaves one side absent at the extreme — the last trades
 * lifted the offer and nobody sold up there. An unfinished one has both sides
 * still printing. The tests worth having are the ones that keep those apart,
 * and the one that stops an already-revisited level being reported as open.
 */

const T0 = 1_700_000_000;
const BAR = 900;
const SUB = 60;

function bar(i: number, o: number, h: number, l: number, c: number): Candle {
  return { time: T0 + i * BAR, open: o, high: h, low: l, close: c, volume: 1200, takerBuyVolume: 600 };
}

/**
 * Sub-bars that trade a given price band with a given taker split, so the
 * reconstruction — not a model — decides what each level looks like.
 */
function sub(i: number, k: number, low: number, high: number, buyShare: number, volume = 200): Candle {
  return {
    time: T0 + i * BAR + k * SUB,
    open: low,
    high,
    low,
    close: high,
    volume,
    takerBuyVolume: volume * buyShare,
  };
}

describe("findUnfinishedAuctions", () => {
  it("finds nothing in an empty footprint", () => {
    expect(findUnfinishedAuctions({ fidelity: "estimated", sourceTimeframe: "x", candles: [], imbalanceThreshold: 3, summary: [] })).toEqual([]);
  });

  it("leaves a finished high alone", () => {
    /* Only buying at the top row: sellers were never given the chance to trade
       there, which is what a completed test of a high looks like. */
    const candles = [bar(0, 100, 101, 99, 100.5), bar(1, 100.5, 100.8, 100, 100.2)];
    const subs = [
      sub(0, 0, 99, 100, 0.5),
      sub(0, 1, 100, 100.9, 0.5),
      sub(0, 2, 100.9, 101, 1), // top band, buys only
      sub(1, 0, 100, 100.8, 0.5),
    ];
    const fp = buildFootprint(candles, subs, { count: 5, rowsPerCandle: 10 });
    const highs = findUnfinishedAuctions(fp).filter((u) => u.side === "high" && u.time === T0);
    expect(highs).toEqual([]);
  });

  it("marks a high where both sides were still trading", () => {
    const candles = [bar(0, 100, 101, 99, 100.5), bar(1, 100.5, 100.8, 100, 100.2)];
    const subs = [
      sub(0, 0, 99, 100, 0.5),
      sub(0, 1, 100, 100.9, 0.5),
      sub(0, 2, 100.9, 101, 0.5), // top band, evenly split
      sub(1, 0, 100, 100.8, 0.5),
    ];
    const fp = buildFootprint(candles, subs, { count: 5, rowsPerCandle: 10 });
    const found = findUnfinishedAuctions(fp).find((u) => u.side === "high" && u.time === T0);
    expect(found).toBeDefined();
    expect(found!.balance).toBeGreaterThanOrEqual(0.4);
    expect(found!.price).toBeCloseTo(101, 6);
  });

  it("knows when a later bar has traded through the level", () => {
    const candles = [bar(0, 100, 101, 99, 100.5), bar(1, 100.5, 102, 100, 101.8)];
    const subs = [
      sub(0, 0, 99, 100.9, 0.5),
      sub(0, 1, 100.9, 101, 0.5),
      sub(1, 0, 100, 102, 0.5),
    ];
    const fp = buildFootprint(candles, subs, { count: 5, rowsPerCandle: 10 });
    const found = findUnfinishedAuctions(fp).find((u) => u.side === "high" && u.time === T0);
    expect(found?.filled).toBe(true);
    expect(found?.note).toMatch(/outstanding business is done/i);
  });

  it("openOnly drops the levels already traded through", () => {
    const candles = [bar(0, 100, 101, 99, 100.5), bar(1, 100.5, 102, 100, 101.8)];
    const subs = [sub(0, 0, 99, 100.9, 0.5), sub(0, 1, 100.9, 101, 0.5), sub(1, 0, 100, 102, 0.5)];
    const fp = buildFootprint(candles, subs, { count: 5, rowsPerCandle: 10 });
    for (const u of findUnfinishedAuctions(fp, { openOnly: true })) expect(u.filled).toBe(false);
  });

  it("does not treat a wick stopping exactly at the level as finishing it", () => {
    // Touching is not trading through; the business left there is still open.
    const candles = [bar(0, 100, 101, 99, 100.5), bar(1, 100.5, 101, 100, 100.4)];
    const subs = [sub(0, 0, 99, 100.9, 0.5), sub(0, 1, 100.9, 101, 0.5), sub(1, 0, 100, 101, 0.5)];
    const fp = buildFootprint(candles, subs, { count: 5, rowsPerCandle: 10 });
    const found = findUnfinishedAuctions(fp).find((u) => u.side === "high" && u.time === T0);
    expect(found?.filled).toBe(false);
  });

  it("ignores an extreme that barely traded at all", () => {
    // A level with almost no volume was not an auction being interrupted.
    const candles = [bar(0, 100, 101, 99, 100.5), bar(1, 100.5, 100.8, 100, 100.2)];
    const subs = [
      // The heavy sub stops short of the top row, so the extreme really is thin.
      sub(0, 0, 99, 100.7, 0.5, 5000),
      sub(0, 1, 100.9, 101, 0.5, 1),
      sub(1, 0, 100, 100.8, 0.5),
    ];
    const fp = buildFootprint(candles, subs, { count: 5, rowsPerCandle: 10 });
    expect(findUnfinishedAuctions(fp).find((u) => u.side === "high" && u.time === T0)).toBeUndefined();
  });

  it("calls the magnet a tendency rather than a schedule", () => {
    const candles = [bar(0, 100, 101, 99, 100.5), bar(1, 100.5, 100.8, 100, 100.2)];
    const subs = [sub(0, 0, 99, 100.9, 0.5), sub(0, 1, 100.9, 101, 0.5), sub(1, 0, 100, 100.8, 0.5)];
    const fp = buildFootprint(candles, subs, { count: 5, rowsPerCandle: 10 });
    const open = findUnfinishedAuctions(fp, { openOnly: true });
    expect(open.length).toBeGreaterThan(0);
    const text = open.map((u) => u.note).join(" ");
    expect(text).toMatch(/a tendency, not a schedule/i);
    expect(text.toLowerCase()).not.toContain("will return");
  });
});
