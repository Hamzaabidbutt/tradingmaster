import { describe, expect, it } from "vitest";
import { collectImbalanceLevels, IMBALANCE_TIERS } from "@/engines/footprint";
import { FootprintCandle, FootprintCell, FootprintResult } from "@/engines/types";

function cell(
  price: number,
  imbalance: "buy" | "sell" | null,
  ratio: number,
  askVolume = 100,
  bidVolume = 100
): FootprintCell {
  return { price, bidVolume, askVolume, delta: askVolume - bidVolume, imbalance, imbalanceRatio: ratio };
}

function candle(time: number, cells: FootprintCell[], stacked: FootprintCandle["stackedImbalances"] = []): FootprintCandle {
  return {
    time,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    cells,
    poc: 100,
    totalVolume: 1000,
    delta: 0,
    stackedImbalances: stacked,
    zeroPrints: [],
    deltaDivergence: false,
  };
}

function footprint(candles: FootprintCandle[]): FootprintResult {
  return {
    fidelity: "sub_candle",
    sourceTimeframe: "1m",
    candles,
    imbalanceThreshold: 3,
  } as FootprintResult;
}

describe("imbalance ladder", () => {
  it("lists imbalanced levels and ignores balanced ones", () => {
    const r = collectImbalanceLevels(
      footprint([candle(1, [cell(100, null, 0), cell(101, "buy", 4), cell(99, "sell", 6)])])
    );
    expect(r.buy.map((l) => l.price)).toEqual([101]);
    expect(r.sell.map((l) => l.price)).toEqual([99]);
  });

  it("buckets ratios into tiers, capping at 20", () => {
    const r = collectImbalanceLevels(
      footprint([
        candle(1, [
          cell(101, "buy", 3.4),
          cell(102, "buy", 7),
          cell(103, "buy", 12),
          cell(104, "buy", 17),
          cell(105, "buy", 45),
          cell(106, "buy", 900),
        ]),
      ])
    );
    expect(r.buy.map((l) => l.tier)).toEqual([20, 20, 15, 10, 5, 3]);
    // A 900x diagonal and a 45x diagonal share the top bucket — both mean the
    // same thing, and sorting by raw ratio would rank near-empty levels first.
    expect(IMBALANCE_TIERS[IMBALANCE_TIERS.length - 1]).toBe(20);
  });

  it("orders by tier, then by volume within a tier", () => {
    const r = collectImbalanceLevels(
      footprint([
        candle(1, [
          cell(101, "buy", 25, 50),
          cell(102, "buy", 25, 900),
          cell(103, "buy", 4, 5000),
        ]),
      ])
    );
    // Both 20x levels outrank the 3x one however large it is, and the bigger
    // of the two comes first.
    expect(r.buy.map((l) => l.price)).toEqual([102, 101, 103]);
  });

  it("records the aggressing side's volume, not the passive side's", () => {
    const r = collectImbalanceLevels(
      footprint([candle(1, [cell(101, "buy", 5, 700, 30), cell(99, "sell", 5, 20, 640)])])
    );
    expect(r.buy[0].volume).toBe(700);
    expect(r.sell[0].volume).toBe(640);
  });

  it("marks levels that sit inside a stacked run", () => {
    const r = collectImbalanceLevels(
      footprint([
        candle(
          1,
          [cell(101, "buy", 5), cell(102, "buy", 5), cell(110, "buy", 5)],
          [{ direction: "buy", fromPrice: 101, toPrice: 102, count: 3 }]
        ),
      ])
    );
    expect(r.buy.find((l) => l.price === 101)?.stacked).toBe(true);
    expect(r.buy.find((l) => l.price === 110)?.stacked).toBe(false);
  });

  it("looks back over several bars, and honours the limit", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      candle(i, [cell(100 + i, "buy", 5, 100 + i)])
    );
    const r = collectImbalanceLevels(footprint(many), { bars: 5, limit: 3 });
    expect(r.buy).toHaveLength(3);
    // Only the last 5 bars are considered.
    expect(r.buy.every((l) => l.time >= 25)).toBe(true);
  });

  it("returns empty lists for a footprint with no imbalances", () => {
    const r = collectImbalanceLevels(footprint([candle(1, [cell(100, null, 0)])]));
    expect(r.buy).toEqual([]);
    expect(r.sell).toEqual([]);
  });
});
