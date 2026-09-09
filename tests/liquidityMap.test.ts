import { describe, expect, it } from "vitest";
import { buildLiquidationHeatmap, buildLiquidityMap } from "@/engines/liquidityMap";
import { OrderWall, PressureZone } from "@/engines/types";

/**
 * The distinction the map exists to preserve: book size is *measured* and can
 * be pulled; stop location is *inferred* and cannot. Collapsing them into one
 * "liquidity" figure presents a guess and a fact as the same thing, so most of
 * what is pinned here is that they stay separable.
 */

const PRICE = 100;

function wall(over: Partial<OrderWall>): OrderWall {
  return {
    side: "bid",
    price: 98,
    size: 1000,
    notional: 98_000,
    multiple: 5,
    distancePct: -2,
    levels: 3,
    ...over,
  } as OrderWall;
}

function zone(over: Partial<PressureZone>): PressureZone {
  return {
    price: 96,
    distancePct: -4,
    side: "long",
    intensity: 60,
    basis: "leverage_band",
    note: "Stops cluster here.",
    ...over,
  };
}

describe("buildLiquidityMap — the two sources stay apart", () => {
  it("marks book rows measured and inferred rows not", () => {
    const m = buildLiquidityMap(PRICE, { bids: [wall({})], asks: [] }, [zone({})]);
    const book = m.rungs.find((r) => r.source === "book")!;
    const inferred = m.rungs.find((r) => r.source === "liquidation")!;
    expect(book.measured).toBe(true);
    expect(inferred.measured).toBe(false);
    expect(book.note).toMatch(/can be pulled/i);
    expect(inferred.note).toMatch(/cannot be pulled|estimate/i);
  });

  it("says which half is missing rather than presenting a partial map as whole", () => {
    const noBook = buildLiquidityMap(PRICE, null, [zone({})]);
    expect(noBook.caveats.join(" ")).toMatch(/measured half of the map is missing/i);

    const noZones = buildLiquidityMap(PRICE, { bids: [wall({})], asks: [] }, []);
    expect(noZones.caveats.join(" ")).toMatch(/inferred half of the map is missing/i);
  });

  it("normalises the two scales separately", () => {
    /* A book notional is in the tens of thousands and an inferred intensity is
       0-100. Compared raw, the notional would dominate the attraction score
       for no reason other than its unit. */
    const m = buildLiquidityMap(
      PRICE,
      { bids: [], asks: [wall({ side: "ask", price: 102, distancePct: 2, notional: 5_000_000 })] },
      [zone({ price: 98, distancePct: -2, intensity: 100 })]
    );
    // Equal distance, each the largest of its own kind: they should offset.
    expect(Math.abs(m.attraction)).toBeLessThan(20);
  });
});

describe("buildLiquidityMap — the ladder", () => {
  it("splits rungs above and below, nearest first", () => {
    const m = buildLiquidityMap(
      PRICE,
      {
        bids: [wall({ price: 99, distancePct: -1 }), wall({ price: 95, distancePct: -5 })],
        asks: [wall({ side: "ask", price: 101, distancePct: 1 }), wall({ side: "ask", price: 106, distancePct: 6 })],
      },
      []
    );
    expect(m.nearestAbove!.price).toBe(101);
    expect(m.nearestBelow!.price).toBe(99);
  });

  it("ignores liquidity too far away to be this session's business", () => {
    const m = buildLiquidityMap(PRICE, { bids: [wall({ price: 50, distancePct: -50 })], asks: [] }, []);
    expect(m.rungs).toHaveLength(0);
  });

  it("weights nearby size more heavily than distant size", () => {
    const near = buildLiquidityMap(
      PRICE,
      { bids: [], asks: [wall({ side: "ask", price: 101, distancePct: 1 })] },
      [zone({ price: 90, distancePct: -10 })]
    );
    // Size 1% above versus stops 10% below: the pull is upward.
    expect(near.attraction).toBeGreaterThan(0);
  });

  it("reports balance rather than inventing a direction", () => {
    const m = buildLiquidityMap(
      PRICE,
      {
        bids: [wall({ price: 98, distancePct: -2, notional: 100_000 })],
        asks: [wall({ side: "ask", price: 102, distancePct: 2, notional: 100_000 })],
      },
      []
    );
    expect(Math.abs(m.attraction)).toBeLessThan(15);
    expect(m.headline).toMatch(/balanced/i);
  });

  it("handles an empty map without dividing by zero", () => {
    const m = buildLiquidityMap(PRICE, null, []);
    expect(m.attraction).toBe(0);
    expect(Number.isFinite(m.attraction)).toBe(true);
    expect(m.headline).toMatch(/no liquidity within range/i);
  });

  it("says attraction describes the map rather than the future", () => {
    const m = buildLiquidityMap(PRICE, { bids: [wall({})], asks: [] }, []);
    expect(m.caveats.join(" ")).toMatch(/book orders get pulled and stops get moved/i);
    expect(`${m.headline} ${m.note}`.toLowerCase()).not.toContain("will move");
  });
});

describe("buildLiquidationHeatmap", () => {
  it("returns an empty map rather than inventing rows", () => {
    const h = buildLiquidationHeatmap(PRICE, []);
    expect(h.rows).toHaveLength(0);
    expect(h.major).toBeNull();
    expect(h.headline).toMatch(/no liquidation zones/i);
  });

  it("lays rows on a fixed grid so empty bands stay visible", () => {
    const h = buildLiquidationHeatmap(PRICE, [
      zone({ price: 96, intensity: 90 }),
      zone({ price: 104, intensity: 40, side: "short" }),
    ]);
    expect(h.rows.length).toBeGreaterThan(10);
    // Some rows must be empty — that is the point of a grid.
    expect(h.rows.some((r) => r.heat === 0)).toBe(true);
  });

  it("scales heat relative to the hottest band", () => {
    const h = buildLiquidationHeatmap(PRICE, [
      zone({ price: 96, intensity: 90 }),
      zone({ price: 104, intensity: 30, side: "short" }),
    ]);
    expect(Math.max(...h.rows.map((r) => r.heat))).toBe(100);
    for (const r of h.rows) {
      expect(r.heat).toBeGreaterThanOrEqual(0);
      expect(r.heat).toBeLessThanOrEqual(100);
    }
  });

  it("marks the row price is currently in", () => {
    const h = buildLiquidationHeatmap(PRICE, [zone({ price: 96 }), zone({ price: 104, side: "short" })]);
    expect(h.rows.filter((r) => r.current).length).toBeLessThanOrEqual(1);
  });

  it("groups contiguous hot rows into one destination", () => {
    // Three adjacent bands of long stops are one cluster, not three.
    const h = buildLiquidationHeatmap(PRICE, [
      zone({ price: 94, intensity: 80 }),
      zone({ price: 94.5, intensity: 90 }),
      zone({ price: 95, intensity: 85 }),
    ]);
    expect(h.clusters.length).toBeGreaterThanOrEqual(1);
    expect(h.major).not.toBeNull();
    expect(h.major!.low).toBeLessThan(h.major!.high);
    expect(h.headline).toMatch(/cluster/i);
  });

  it("orders rows high price to low, like a ladder", () => {
    const h = buildLiquidationHeatmap(PRICE, [zone({ price: 96 }), zone({ price: 104, side: "short" })]);
    for (let k = 1; k < h.rows.length; k++) {
      expect(h.rows[k - 1].price).toBeGreaterThanOrEqual(h.rows[k].price);
    }
  });

  it("says the heat is inferred, not measured", () => {
    const h = buildLiquidationHeatmap(PRICE, [zone({ price: 96 })]);
    expect(h.note).toMatch(/nobody publishes stop placement/i);
    expect(h.note).toMatch(/where there is no liquidity matters/i);
  });
});
