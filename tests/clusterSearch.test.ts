import { describe, expect, it } from "vitest";
import { buildFootprint } from "@/engines/footprint";
import { CLUSTER_PRESETS, presetById, searchClusters } from "@/engines/clusterSearch";
import { Candle } from "@/engines/types";

/**
 * Cluster search is only worth having if its thresholds travel. A query
 * written on one symbol must return the same *kind* of level on another
 * without being retuned, which means every size filter has to be relative —
 * so the tests that matter most are the scale-invariance ones.
 */

const T0 = 1_700_000_000;
const BAR = 900;

/** Bars that rise steadily, each with a lopsided taker split. */
function series(n: number, buyShare = 0.5): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const base = 100 + i * 0.2;
    const volume = 1000;
    return {
      time: T0 + i * BAR,
      open: base,
      high: base + 0.5,
      low: base - 0.5,
      close: base + 0.2,
      volume,
      takerBuyVolume: volume * buyShare,
      trades: 200,
    };
  });
}

/** The same series with every size multiplied — the scale-invariance check. */
function scaled(candles: Candle[], by: number): Candle[] {
  return candles.map((c) => ({
    ...c,
    volume: c.volume * by,
    takerBuyVolume: (c.takerBuyVolume ?? c.volume / 2) * by,
  }));
}

const footprint = buildFootprint(series(40), null, { count: 30 });

describe("searchClusters — what it refuses", () => {
  it("returns nothing for an empty filter list", () => {
    // "No criteria" is an unfinished query, not a request for the whole grid.
    const r = searchClusters(footprint, { filters: [] });
    expect(r.hits).toEqual([]);
    expect(r.headline).toMatch(/no criteria/i);
  });

  it("returns nothing when nothing traded", () => {
    const flat = buildFootprint(
      series(40).map((c) => ({ ...c, volume: 0, takerBuyVolume: 0 })),
      null,
      { count: 30 }
    );
    const r = searchClusters(flat, { filters: [{ metric: "volumeX", op: "gte", value: 1 }] });
    expect(r.hits).toEqual([]);
    expect(r.averageCluster).toBe(0);
  });

  it("refuses a between filter with no upper bound rather than treating it as >=", () => {
    // Silently widening the query would answer a different question.
    const r = searchClusters(footprint, {
      filters: [{ metric: "volumeX", op: "between", value: 0 }],
    });
    expect(r.hits).toEqual([]);
  });

  it("finds nothing above a threshold nothing reaches", () => {
    const r = searchClusters(footprint, {
      filters: [{ metric: "volumeX", op: "gte", value: 1000 }],
    });
    expect(r.hits).toEqual([]);
    expect(r.headline).toMatch(/nothing matched/i);
  });
});

describe("searchClusters — thresholds travel between symbols", () => {
  it("returns the same hits when every size is multiplied", () => {
    const big = buildFootprint(scaled(series(40), 10_000), null, { count: 30 });
    const query = { filters: [{ metric: "volumeX" as const, op: "gte" as const, value: 1.5 }] };
    const small = searchClusters(footprint, query);
    const large = searchClusters(big, query);
    expect(large.hits.length).toBe(small.hits.length);
    expect(large.hits.map((h) => h.price)).toEqual(small.hits.map((h) => h.price));
  });

  it("measures against every level, not only the ones that traded", () => {
    /* The bug this guards: averaging over traded levels alone means a bar whose
       volume all landed on one row has exactly one non-empty cluster, so that
       row scores 1.0× and the most concentrated bar on the chart reads as
       perfectly ordinary — the opposite of what the search is for. */
    const base = series(40);
    const subs: Candle[] = [];
    for (const c of base) {
      // All of each bar's volume in a sliver at the close: one hot row, the
      // rest of the grid empty.
      for (let k = 0; k < 4; k++) {
        subs.push({
          time: c.time + k * 180,
          open: c.close,
          high: c.close,
          low: c.close,
          close: c.close,
          volume: c.volume / 4,
          takerBuyVolume: c.volume / 8,
          trades: 40,
        });
      }
    }
    const fp = buildFootprint(base, subs, { count: 30 });
    const top = searchClusters(fp, { filters: [{ metric: "volumeX", op: "gte", value: 0 }], limit: 1 });
    expect(top.hits[0].volumeX).toBeGreaterThan(5);
  });

  it("reports the average it measured against", () => {
    const r = searchClusters(footprint, { filters: [{ metric: "volumeX", op: "gte", value: 1 }] });
    expect(r.averageCluster).toBeGreaterThan(0);
    expect(r.scanned).toBeGreaterThan(0);
  });
});

describe("searchClusters — filters do what they say", () => {
  it("deltaPercent picks out buy-dominated levels", () => {
    const buyHeavy = buildFootprint(series(40, 0.9), null, { count: 30 });
    const r = searchClusters(buyHeavy, {
      filters: [{ metric: "deltaPercent", op: "gte", value: 50 }],
    });
    expect(r.hits.length).toBeGreaterThan(0);
    for (const h of r.hits) expect(h.deltaPercent).toBeGreaterThanOrEqual(50);
  });

  it("the sell-side mirror returns nothing on a buy-dominated tape", () => {
    const buyHeavy = buildFootprint(series(40, 0.9), null, { count: 30 });
    const r = searchClusters(buyHeavy, {
      filters: [{ metric: "deltaPercent", op: "lte", value: -50 }],
    });
    expect(r.hits).toEqual([]);
  });

  it("pocOnly returns at most one level per bar", () => {
    const r = searchClusters(footprint, {
      filters: [{ metric: "volumeX", op: "gte", value: 0 }],
      pocOnly: true,
      limit: 500,
    });
    const perBar = new Map<number, number>();
    for (const h of r.hits) perBar.set(h.time, (perBar.get(h.time) ?? 0) + 1);
    for (const n of perBar.values()) expect(n).toBe(1);
    for (const h of r.hits) expect(h.isPoc).toBe(true);
  });

  it("extremesOnly keeps only levels at a bar's own high or low", () => {
    const r = searchClusters(footprint, {
      filters: [{ metric: "volumeX", op: "gte", value: 0 }],
      extremesOnly: true,
      limit: 500,
    });
    for (const h of r.hits) expect(h.atExtreme).not.toBeNull();
  });

  it("barDirection keeps only levels inside bars that closed that way", () => {
    const mixed = series(40).map((c, i) =>
      i % 2 === 0 ? { ...c, close: c.open - 0.3 } : { ...c, close: c.open + 0.3 }
    );
    const fp = buildFootprint(mixed, null, { count: 30 });
    const r = searchClusters(fp, {
      filters: [{ metric: "volumeX", op: "gte", value: 0 }],
      barDirection: "down",
      limit: 500,
    });
    expect(r.hits.length).toBeGreaterThan(0);
    for (const h of r.hits) expect(h.barDirection).toBe("down");
  });

  it("applies every filter, not just the first", () => {
    const wide = searchClusters(footprint, {
      filters: [{ metric: "volumeX", op: "gte", value: 1 }],
      limit: 500,
    });
    const narrow = searchClusters(footprint, {
      filters: [
        { metric: "volumeX", op: "gte", value: 1 },
        { metric: "deltaPercent", op: "gte", value: 200 },
      ],
      limit: 500,
    });
    expect(wide.hits.length).toBeGreaterThan(0);
    expect(narrow.hits).toEqual([]);
  });
});

describe("searchClusters — ordering and honesty", () => {
  it("ranks by size, not by recency", () => {
    // A 9x level an hour old is what price reacts to; a shelf of 3x levels
    // from the last four bars would bury it under a time sort.
    const r = searchClusters(footprint, {
      filters: [{ metric: "volumeX", op: "gte", value: 0 }],
      limit: 500,
    });
    for (let i = 1; i < r.hits.length; i++) {
      expect(r.hits[i - 1].volumeX).toBeGreaterThanOrEqual(r.hits[i].volumeX);
    }
  });

  it("says when the per-level split is modelled rather than measured", () => {
    const r = searchClusters(footprint, { filters: [{ metric: "volumeX", op: "gte", value: 1 }] });
    expect(r.fidelity).toBe("estimated");
    expect(r.caveats.join(" ")).toMatch(/modelled/i);
  });

  it("drops that caveat once the footprint is genuinely reconstructed", () => {
    const base = series(40);
    const subs: Candle[] = [];
    for (const c of base) {
      for (let k = 0; k < 5; k++) {
        subs.push({ ...c, time: c.time + k * (BAR / 5), volume: c.volume / 5, takerBuyVolume: (c.takerBuyVolume ?? 0) / 5 });
      }
    }
    const fp = buildFootprint(base, subs, { count: 30 });
    const r = searchClusters(fp, { filters: [{ metric: "volumeX", op: "gte", value: 1 }] });
    expect(r.fidelity).toBe("sub_candle");
    expect(r.caveats.join(" ")).not.toMatch(/modelled/i);
  });

  it("says how many matches it had to leave out", () => {
    const r = searchClusters(footprint, {
      filters: [{ metric: "volumeX", op: "gte", value: 0 }],
      limit: 2,
    });
    expect(r.hits).toHaveLength(2);
    expect(r.caveats.join(" ")).toMatch(/further matches not shown/i);
  });

  it("prints a readable price in the headline, not a raw float", () => {
    // Cluster prices are row midpoints, so they arrive as 97.61935518.
    const r = searchClusters(footprint, { filters: [{ metric: "volumeX", op: "gte", value: 0 }] });
    const price = /at ([\d.]+)\./.exec(r.headline)?.[1] ?? "";
    expect(price.length).toBeGreaterThan(0);
    expect((price.split(".")[1] ?? "").length).toBeLessThanOrEqual(6);
  });

  it("gives every hit a reason carrying the numbers that got it in", () => {
    const r = searchClusters(footprint, {
      filters: [{ metric: "volumeX", op: "gte", value: 1 }],
    });
    expect(r.hits.length).toBeGreaterThan(0);
    for (const h of r.hits) expect(h.reason).toMatch(/cluster size \d/);
  });
});

describe("presets", () => {
  it("every preset runs without throwing and returns a coherent result", () => {
    for (const preset of CLUSTER_PRESETS) {
      const r = searchClusters(footprint, preset.query);
      expect(r.headline.length).toBeGreaterThan(0);
      for (const h of r.hits) {
        expect(Number.isFinite(h.volumeX)).toBe(true);
        expect(Number.isFinite(h.deltaPercent)).toBe(true);
      }
    }
  });

  it("every preset explains what it looks for", () => {
    for (const preset of CLUSTER_PRESETS) {
      expect(preset.description.length).toBeGreaterThan(40);
    }
  });

  it("finds a preset by id and returns null for a typo", () => {
    expect(presetById("big_clusters")?.id).toBe("big_clusters");
    expect(presetById("big_cluster")).toBeNull();
  });

  it("the trapped-buyer preset fires on an actual trapped-buyer bar", () => {
    /* The calibration note in the engine explains why this preset uses a much
       lower size floor than the others — extremes carry a fraction of mid-bar
       volume, and a shared threshold would make it unable to return anything.
       This builds the event it is meant to catch and checks it does: heavy,
       almost purely buy-side volume at the top of a bar that then closed down. */
    const base = series(40);
    const last = base.length - 1;
    base[last] = { ...base[last], close: base[last].open - 0.4 };

    const subs: Candle[] = [];
    for (let i = 0; i < base.length; i++) {
      const c = base[i];
      const push = (k: number, low: number, high: number, share: number, vol: number) =>
        subs.push({
          time: c.time + k * 180,
          open: low,
          high,
          low,
          close: high,
          volume: vol,
          takerBuyVolume: vol * share,
          trades: 40,
        });
      if (i === last) {
        // Buyers lifting the offer at the very top, then the bar rolls over.
        push(0, c.low, c.close, 0.5, 200);
        push(1, c.high - 0.02, c.high, 0.98, 900);
        push(2, c.close, c.high - 0.02, 0.2, 200);
        push(3, c.low, c.close, 0.2, 200);
      } else {
        for (let k = 0; k < 4; k++) push(k, c.low, c.high, 0.5, c.volume / 4);
      }
    }

    const fp = buildFootprint(base, subs, { count: 30 });
    const hits = searchClusters(fp, { ...presetById("buyers_trapped")!.query, limit: 100 }).hits;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].atExtreme).toBe("high");
    expect(hits[0].barDirection).toBe("down");
    expect(hits[0].deltaPercent).toBeGreaterThan(40);
  });

  it("the trapped-buyer preset only looks inside bars that closed down", () => {
    const preset = presetById("buyers_trapped");
    expect(preset?.query.barDirection).toBe("down");
    expect(preset?.query.extremesOnly).toBe(true);
  });
});
