import { describe, expect, it } from "vitest";
import { MarketStateInputs, readMarketState } from "@/engines/marketState";
import type { ConflictCheck, ConflictReport } from "@/engines/conflicts";
import type { PositioningRead, ValueMigration } from "@/engines/positioning";
import { Candle, VolumeProfileResult } from "@/engines/types";

/**
 * The classification is a gate chain, so what is pinned here is the ordering
 * as much as the outcomes: which question is asked first, and that a state is
 * decided on what it is before it is qualified by what disagrees with it.
 */

const T0 = 1_700_000_000;
const HOUR = 3600;

function candles(closeAt: number, n = 40): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    time: T0 + i * HOUR,
    open: closeAt,
    high: closeAt * 1.002,
    low: closeAt * 0.998,
    close: closeAt,
    volume: 1000,
    takerBuyVolume: 500,
  }));
}

const vp = (over: Partial<VolumeProfileResult> = {}): VolumeProfileResult =>
  ({
    scope: "visible",
    rows: [],
    poc: 105,
    vah: 110,
    val: 100,
    totalVolume: 1000,
    valueAreaShare: 0.7,
    hvns: [],
    lvns: [],
    shape: "normal",
    acceptance: "inside_value",
    auctionState: "balance",
    summary: [],
    ...over,
  }) as VolumeProfileResult;

const migration = (over: Partial<ValueMigration> = {}): ValueMigration => ({
  direction: "overlapping",
  current: { high: 110, low: 100, poc: 105 },
  prior: { high: 109, low: 99, poc: 104 },
  overlap: 0.9,
  headline: "",
  detail: "",
  caveats: [],
  ...over,
});

const positioning = (over: Partial<PositioningRead> = {}): PositioningRead => ({
  quadrant: "new_longs",
  label: "New longs opening",
  pricePct: 1,
  oiPct: 1,
  barsCovered: 12,
  participation: "opening",
  deltaAgrees: true,
  strength: 30,
  headline: "",
  mechanism: "",
  caveats: [],
  ...over,
});

const noConflicts: ConflictReport = {
  checks: [],
  conflicts: [],
  alignedCount: 5,
  unavailableCount: 0,
  headline: "",
  note: "",
};

function conflictReport(argues: "up" | "down", severity: ConflictCheck["severity"] = "high"): ConflictReport {
  const c: ConflictCheck = {
    id: "cvd-divergence",
    title: "Price vs cumulative delta",
    status: "conflict",
    argues,
    severity,
    says: "",
    reading: "",
  };
  return { ...noConflicts, checks: [c], conflicts: [c], alignedCount: 4 };
}

function inputs(over: Partial<MarketStateInputs> = {}): MarketStateInputs {
  return {
    candles: candles(105),
    structure: {
      swings: [],
      events: [],
      trend: "neutral",
      internalTrend: "neutral",
      isRange: true,
      reversalProbability: 50,
      continuationProbability: 50,
      summary: [],
    },
    volumeProfile: vp(),
    migration: migration(),
    positioning: positioning(),
    conflicts: noConflicts,
    ...over,
  };
}

describe("readMarketState — the gate chain", () => {
  it("returns unclear rather than guessing on too little data", () => {
    expect(readMarketState(inputs({ candles: candles(105, 3) })).id).toBe("unclear");
  });

  it("asks about a change of character before anything else", () => {
    // Price is deep above value, which would otherwise classify as a breakout.
    const r = readMarketState(
      inputs({
        candles: candles(130),
        volumeProfile: vp({ acceptance: "above_value" }),
        migration: migration({ direction: "higher" }),
        structure: {
          ...inputs().structure,
          trend: "bullish",
          events: [
            {
              type: "CHOCH",
              scope: "external",
              direction: "bullish",
              time: T0 + 39 * HOUR,
              price: 120,
              brokenSwingTime: T0 + 20 * HOUR,
            },
          ],
        },
      })
    );
    expect(r.id).toBe("reversal_confirmed");
    expect(r.invalidation?.price).toBe(120);
    expect(r.since).toBe(T0 + 39 * HOUR);
  });

  it("ignores a change of character that has aged out", () => {
    const r = readMarketState(
      inputs({
        candles: candles(130),
        volumeProfile: vp({ acceptance: "above_value" }),
        migration: migration({ direction: "higher" }),
        structure: {
          ...inputs().structure,
          events: [
            {
              type: "CHOCH",
              scope: "external",
              direction: "bullish",
              // Far outside the recent-event window.
              time: T0,
              price: 120,
              brokenSwingTime: T0 - HOUR,
            },
          ],
        },
      })
    );
    expect(r.id).toBe("breakout_accepted");
  });
});

describe("readMarketState — location decides before structure", () => {
  it("calls an accepted breakout when value has followed price out", () => {
    const r = readMarketState(
      inputs({
        candles: candles(130),
        volumeProfile: vp({ acceptance: "above_value" }),
        migration: migration({ direction: "higher", overlap: 0.05 }),
      })
    );
    expect(r.id).toBe("breakout_accepted");
    expect(r.invalidation?.price).toBe(110);
    expect(r.invalidation?.why).toMatch(/value area/i);
  });

  it("calls it unconfirmed when value has not followed", () => {
    const r = readMarketState(
      inputs({
        candles: candles(130),
        volumeProfile: vp({ acceptance: "above_value" }),
        migration: migration({ direction: "overlapping" }),
      })
    );
    expect(r.id).toBe("breakout_unconfirmed");
    expect(r.watch).toMatch(/time spent/i);
  });

  it("mirrors both breakout states to the downside", () => {
    const accepted = readMarketState(
      inputs({
        candles: candles(80),
        volumeProfile: vp({ acceptance: "below_value" }),
        migration: migration({ direction: "lower" }),
      })
    );
    expect(accepted.id).toBe("breakout_accepted");
    expect(accepted.invalidation?.price).toBe(100);

    const unconfirmed = readMarketState(
      inputs({
        candles: candles(80),
        volumeProfile: vp({ acceptance: "below_value" }),
        migration: migration({ direction: "overlapping" }),
      })
    );
    expect(unconfirmed.id).toBe("breakout_unconfirmed");
  });

  it("classifies a breakout on location even when structure disagrees", () => {
    // The gate chain's whole point: location is asked first.
    const r = readMarketState(
      inputs({
        candles: candles(130),
        volumeProfile: vp({ acceptance: "above_value" }),
        migration: migration({ direction: "higher" }),
        structure: { ...inputs().structure, trend: "bearish" },
      })
    );
    expect(r.id).toBe("breakout_accepted");
  });
});

describe("readMarketState — inside value", () => {
  it("calls a pullback when value trends and structure agrees", () => {
    const r = readMarketState(
      inputs({
        candles: candles(104),
        migration: migration({ direction: "higher", overlap: 0.2 }),
        structure: { ...inputs().structure, trend: "bullish" },
      })
    );
    expect(r.id).toBe("pullback_in_trend");
    expect(r.watch).toMatch(/point of control/i);
    expect(r.invalidation?.price).toBe(100);
  });

  it("refuses to pick a side when value and structure point differently", () => {
    const r = readMarketState(
      inputs({
        candles: candles(104),
        migration: migration({ direction: "higher", overlap: 0.2 }),
        structure: { ...inputs().structure, trend: "bearish" },
      })
    );
    expect(r.id).toBe("trending_exhausting");
    expect(r.note).toMatch(/stand aside/i);
  });

  it("names the edge when price is near one", () => {
    // Value area 100-110, so 15% of its width is 1.5.
    const r = readMarketState(inputs({ candles: candles(109) }));
    expect(r.id).toBe("range_at_edge");
    expect(r.label).toMatch(/high edge/i);
    expect(r.invalidation?.price).toBe(110);
  });

  it("names the low edge on the mirror", () => {
    const r = readMarketState(inputs({ candles: candles(101) }));
    expect(r.id).toBe("range_at_edge");
    expect(r.label).toMatch(/low edge/i);
  });

  it("calls mid-range what it is, and says there is nothing there", () => {
    const r = readMarketState(inputs({ candles: candles(105) }));
    expect(r.id).toBe("range_rotating");
    expect(r.invalidation).toBeNull();
    expect(r.watch).toMatch(/nothing to do/i);
  });
});

describe("readMarketState — tension", () => {
  it("marks a trend state exhausting when a high-severity conflict argues against it", () => {
    const r = readMarketState(
      inputs({
        candles: candles(130),
        volumeProfile: vp({ acceptance: "above_value" }),
        migration: migration({ direction: "higher" }),
        conflicts: conflictReport("down"),
      })
    );
    expect(r.id).toBe("trending_exhausting");
    expect(r.label).toMatch(/exhausting/i);
    expect(r.tension).toMatch(/cumulative delta/i);
  });

  it("does not mark it exhausting when the conflict argues the same way as price", () => {
    const r = readMarketState(
      inputs({
        candles: candles(130),
        volumeProfile: vp({ acceptance: "above_value" }),
        migration: migration({ direction: "higher" }),
        conflicts: conflictReport("up"),
      })
    );
    expect(r.id).toBe("breakout_accepted");
    expect(r.tension).toBeNull();
  });

  it("does not promote a medium-severity conflict to exhaustion", () => {
    const r = readMarketState(
      inputs({
        candles: candles(130),
        volumeProfile: vp({ acceptance: "above_value" }),
        migration: migration({ direction: "higher" }),
        conflicts: conflictReport("down", "medium"),
      })
    );
    expect(r.id).toBe("breakout_accepted");
  });

  it("attaches tension to a range state without renaming it", () => {
    const r = readMarketState(inputs({ candles: candles(105), conflicts: conflictReport("down") }));
    expect(r.id).toBe("range_rotating");
    expect(r.tension).not.toBeNull();
  });
});

describe("readMarketState — honesty", () => {
  it("always offers both paths, never one", () => {
    const states = [
      inputs({ candles: candles(130), volumeProfile: vp({ acceptance: "above_value" }), migration: migration({ direction: "higher" }) }),
      inputs({ candles: candles(130), volumeProfile: vp({ acceptance: "above_value" }) }),
      inputs({ candles: candles(104), migration: migration({ direction: "higher" }), structure: { ...inputs().structure, trend: "bullish" } }),
      inputs({ candles: candles(109) }),
      inputs({ candles: candles(105) }),
    ];
    for (const s of states) {
      const r = readMarketState(s);
      expect(r.up.condition.length).toBeGreaterThan(0);
      expect(r.down.condition.length).toBeGreaterThan(0);
      expect(r.up.meaning).not.toBe(r.down.meaning);
    }
  });

  it("never forecasts a price", () => {
    const r = readMarketState(
      inputs({ candles: candles(130), volumeProfile: vp({ acceptance: "above_value" }), migration: migration({ direction: "higher" }) })
    );
    const text = `${r.label} ${r.gotHere.join(" ")} ${r.up.meaning} ${r.down.meaning} ${r.watch} ${r.note}`.toLowerCase();
    for (const banned of ["will rise", "will fall", "will reverse", "guaranteed", "target of", "price will"]) {
      expect(text).not.toContain(banned);
    }
  });

  it("says exhaustion is not a reason to take the other side", () => {
    const r = readMarketState(
      inputs({
        candles: candles(130),
        volumeProfile: vp({ acceptance: "above_value" }),
        migration: migration({ direction: "higher" }),
        conflicts: conflictReport("down"),
      })
    );
    expect(r.note).toMatch(/not a reason to take the other side/i);
  });
});
