import { describe, expect, it } from "vitest";
import { detectOrderWalls } from "@/engines/orderWalls";

/** A flat book: `n` levels of equal size, stepping `step` away from `start`. */
function flat(start: number, step: number, n: number, size: number): [number, number][] {
  return Array.from({ length: n }, (_, i) => [start + step * i, size] as [number, number]);
}

const PRICE = 100;
// 200 levels a tick apart on each side, all the same size.
const BIDS = flat(99.99, -0.01, 200, 10);
const ASKS = flat(100.01, 0.01, 200, 10);

describe("order walls", () => {
  it("reports nothing when the book is evenly spread", () => {
    const r = detectOrderWalls(PRICE, BIDS, ASKS);
    expect(r.bids).toEqual([]);
    expect(r.asks).toEqual([]);
    expect(r.summary.join(" ")).toContain("No wall stands out");
  });

  it("finds a single oversized level", () => {
    const bids = [...BIDS];
    bids[20] = [bids[20][0], 400]; // 40× the surrounding level size
    const r = detectOrderWalls(PRICE, bids, ASKS);
    expect(r.bids).toHaveLength(1);
    expect(r.bids[0].side).toBe("bid");
    expect(r.bids[0].price).toBeCloseTo(99.79, 4);
    expect(r.bids[0].multiple).toBeGreaterThan(20);
    // Below price, so the distance is negative.
    expect(r.bids[0].distancePct).toBeLessThan(0);
  });

  it("merges size split across adjacent ticks into one wall", () => {
    // 8 × 50 spread over consecutive ticks is one 400-lot wall, not eight
    // ordinary levels — the whole reason clustering exists.
    const bids = [...BIDS];
    for (let i = 20; i < 28; i++) bids[i] = [bids[i][0], 50];
    const r = detectOrderWalls(PRICE, bids, ASKS);
    expect(r.bids).toHaveLength(1);
    expect(r.bids[0].size).toBeCloseTo(400, 3);
    expect(r.bids[0].levels).toBe(8);
  });

  it("keeps genuinely separate walls separate", () => {
    // Two blocks 30 ticks apart are two levels to trade against, not one.
    const bids = [...BIDS];
    bids[20] = [bids[20][0], 400];
    bids[50] = [bids[50][0], 400];
    const r = detectOrderWalls(PRICE, bids, ASKS);
    expect(r.bids).toHaveLength(2);
    expect(r.bids[0].price).not.toBeCloseTo(r.bids[1].price, 3);
  });

  it("keeps bid and ask walls on their own sides", () => {
    const bids = [...BIDS];
    const asks = [...ASKS];
    bids[10] = [bids[10][0], 500];
    asks[30] = [asks[30][0], 500];
    const r = detectOrderWalls(PRICE, bids, asks);
    expect(r.bids.map((w) => w.side)).toEqual(["bid"]);
    expect(r.asks.map((w) => w.side)).toEqual(["ask"]);
    expect(r.asks[0].distancePct).toBeGreaterThan(0);
    expect(r.largestBid?.side).toBe("bid");
    expect(r.largestAsk?.side).toBe("ask");
  });

  it("ignores size beyond the distance limit", () => {
    const bids = [...BIDS];
    // 190 ticks below 99.99 is ~1.9% away — inside the default 3% limit.
    bids[190] = [bids[190][0], 500];
    expect(detectOrderWalls(PRICE, bids, ASKS).bids).toHaveLength(1);
    // The same wall with a 1% limit is out of play.
    expect(detectOrderWalls(PRICE, bids, ASKS, { maxDistancePct: 1 }).bids).toEqual([]);
  });

  it("orders walls by proximity, not by size", () => {
    // The far wall is bigger; the near one still comes first, because it is
    // the one price reaches next.
    const bids = [...BIDS];
    bids[5] = [bids[5][0], 300];
    bids[100] = [bids[100][0], 900];
    const r = detectOrderWalls(PRICE, bids, ASKS);
    expect(r.bids).toHaveLength(2);
    expect(Math.abs(r.bids[0].distancePct)).toBeLessThan(Math.abs(r.bids[1].distancePct));
    // …but "largest" still means largest.
    expect(r.largestBid?.size).toBeGreaterThan(r.bids[0].size);
    expect(Math.abs(r.largestBid!.distancePct)).toBeCloseTo(Math.abs(r.bids[1].distancePct), 6);
  });

  it("scores size relative to the book, so a thin book is not all walls", () => {
    // Every level 10× bigger, in the same proportions: nothing stands out.
    const bids = BIDS.map(([p, s]) => [p, s * 10] as [number, number]);
    const asks = ASKS.map(([p, s]) => [p, s * 10] as [number, number]);
    expect(detectOrderWalls(PRICE, bids, asks).bids).toEqual([]);
  });

  it("reports book imbalance and survives an empty book", () => {
    const heavy = detectOrderWalls(PRICE, BIDS, ASKS.slice(0, 100));
    expect(heavy.imbalance).toBeGreaterThan(0);

    const empty = detectOrderWalls(PRICE, [], []);
    expect(empty.imbalance).toBe(0);
    expect(empty.bids).toEqual([]);
    expect(empty.largestAsk).toBeNull();
  });

  it("refuses to guess when there is no price", () => {
    const r = detectOrderWalls(0, BIDS, ASKS);
    expect(r.bids).toEqual([]);
    expect(r.summary[0]).toContain("No price available");
  });

  it("says plainly that resting size can be pulled", () => {
    const bids = [...BIDS];
    bids[10] = [bids[10][0], 500];
    const r = detectOrderWalls(PRICE, bids, ASKS);
    // The caveat belongs in the data, not only in a tooltip: a visible wall is
    // the one market-data input routinely placed in order to be seen.
    expect(r.bids[0].note.toLowerCase()).toContain("pulled");
    expect(r.summary.join(" ").toLowerCase()).toContain("cancelled");
  });
});
