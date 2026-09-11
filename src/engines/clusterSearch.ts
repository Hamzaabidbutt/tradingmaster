import { FootprintCandle, FootprintResult } from "./types";

/**
 * Cluster Search — finding the individual price levels that did the work.
 *
 * The footprint grid already holds every number this needs. The problem is
 * that reading it means scanning a matrix of thirty bars × twelve rows for
 * cells that stand out, which nobody does reliably and nobody does fast. This
 * inverts it: state the property you care about, get back the clusters that
 * have it, in order.
 *
 * That is the whole idea behind cluster search in a professional order-flow
 * terminal, and it is the difference between owning a footprint and using one.
 *
 * ## Thresholds are relative, always
 *
 * "Volume above 500" is meaningless across symbols and useless across
 * sessions — 500 is enormous on one contract and dust on another, and the same
 * contract's idea of large moves with volatility. Every size filter here is a
 * multiple of the *window's own* average cluster, so a query written once
 * works on any symbol at any hour without being retuned.
 *
 * ## What it cannot do
 *
 * Search data that does not exist. Binance publishes taker-buy volume per bar,
 * not per price level. When the footprint was reconstructed from lower
 * timeframe candles (`fidelity: "sub_candle"`) the per-level split is a real
 * reconstruction and these results describe the tape. When it was not, the
 * split is modelled — and searching modelled clusters returns properties of
 * the model, not of the market. The result says which it is, on every call, in
 * `fidelity` and in `caveats`. Nothing downstream should present an estimated
 * hit as an observation.
 */

/** Properties of a single cluster that can be filtered on. */
export type ClusterMetric =
  /** total traded at this level, as a multiple of the window's average cluster */
  | "volumeX"
  /** ask − bid at this level, as a multiple of the window's average cluster */
  | "deltaX"
  /** delta as a share of the level's own volume, −100..100 */
  | "deltaPercent"
  /** diagonal imbalance ratio, 0 when the level is not imbalanced */
  | "imbalanceRatio";

export type ClusterOp = "gte" | "lte" | "between";

export interface ClusterFilter {
  metric: ClusterMetric;
  op: ClusterOp;
  value: number;
  /** upper bound, required by "between" and ignored otherwise */
  upper?: number;
}

export interface ClusterQuery {
  filters: ClusterFilter[];
  /** restrict to the highest-volume cluster in each bar */
  pocOnly?: boolean;
  /** restrict to clusters sitting at the top or bottom row of their bar */
  extremesOnly?: boolean;
  /** only clusters inside a bar that closed this way */
  barDirection?: "up" | "down";
  /** how many recent bars to search */
  bars?: number;
  /** cap on returned hits */
  limit?: number;
}

export interface ClusterHit {
  time: number;
  price: number;
  bidVolume: number;
  askVolume: number;
  volume: number;
  delta: number;
  /** delta as a share of this level's own volume, −100..100 */
  deltaPercent: number;
  /** level volume against the average cluster in the searched window */
  volumeX: number;
  imbalance: "buy" | "sell" | null;
  imbalanceRatio: number;
  /** this level held the most volume in its bar */
  isPoc: boolean;
  /** the level sits at the bar's own high or low */
  atExtreme: "high" | "low" | null;
  /** direction of the bar this level belongs to */
  barDirection: "up" | "down";
  /** plain-language reason this cluster matched */
  reason: string;
}

export interface ClusterSearchResult {
  hits: ClusterHit[];
  /** clusters examined, before filtering */
  scanned: number;
  /** the average cluster volume every size filter was measured against */
  averageCluster: number;
  fidelity: FootprintResult["fidelity"];
  headline: string;
  caveats: string[];
}

/**
 * A price at a readable precision.
 *
 * Cluster prices are row midpoints, so they arrive as raw floats — 97.61935518
 * — and printing that into a headline is unreadable. Six decimals with
 * trailing zeros stripped covers everything from BTC to a sub-cent altcoin
 * without the engine needing to know the symbol's tick size.
 */
function trim(v: number): string {
  return v.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

/** Bars searched when the query does not say. */
const DEFAULT_BARS = 30;
/** Hits returned when the query does not say. */
const DEFAULT_LIMIT = 40;
/** A level within this share of the bar's range counts as at its extreme. */
const EXTREME_BAND = 0.15;

/* ------------------------------------------------------------------ *
 * Presets
 * ------------------------------------------------------------------ */

export interface ClusterPreset {
  id: string;
  label: string;
  /** what the preset is looking for, and why that is worth looking for */
  description: string;
  query: ClusterQuery;
}

/**
 * The searches worth having ready.
 *
 * A blank filter form is a worse tool than no tool: it asks the reader to
 * already know which numbers matter, which is the thing they came here to find
 * out. Each of these encodes one recognised order-flow read, and every one is
 * stated in multiples so it travels between symbols unchanged.
 *
 * ## On the numbers
 *
 * Levels at a bar's *extreme* carry a fraction of the volume mid-bar levels
 * do — measured across the reference series, an extreme's ninetieth percentile
 * sits below 0.8× the average cluster while a mid-bar level's sits above 2×.
 * That is not a quirk of one market, it is what a bar is: price spends most of
 * its time in the middle of its own range and passes through the edges. So the
 * presets that look at extremes use a *much* lower size floor than the ones
 * that look anywhere. Carrying one threshold across both reads tidier and
 * quietly makes the extreme searches unable to return anything at all, which
 * is worse than having no preset — an empty result looks like an answer.
 */
export const CLUSTER_PRESETS: ClusterPreset[] = [
  {
    id: "big_clusters",
    label: "Heavy clusters",
    description:
      "Price levels that traded 2× the average cluster or more. Size alone says nothing about direction — it says the auction stopped here, and levels where the auction stopped are the ones price reacts to when it returns.",
    query: { filters: [{ metric: "volumeX", op: "gte", value: 2 }] },
  },
  {
    id: "one_sided",
    label: "One-sided levels",
    description:
      "Heavy levels where one side took 60% or more of the flow. Volume with a lopsided split is aggression that the other side did not answer at that price.",
    query: {
      filters: [
        { metric: "volumeX", op: "gte", value: 1.5 },
        { metric: "deltaPercent", op: "gte", value: 60 },
      ],
    },
  },
  {
    id: "one_sided_sell",
    label: "One-sided selling",
    description:
      "The mirror: heavy levels where sellers took 60% or more. Kept separate from the buy side because a search that returns both makes you re-read every row to find out which.",
    query: {
      filters: [
        { metric: "volumeX", op: "gte", value: 1.5 },
        { metric: "deltaPercent", op: "lte", value: -60 },
      ],
    },
  },
  {
    id: "buyers_trapped",
    label: "Buyers trapped at the high",
    description:
      "Lopsided buying at the top of a bar that then closed down. Those buys were the last ones filled before the bar turned, so everyone long from that level is offside — and price returning there meets them wanting out at cost.",
    query: {
      /* 0.7×, not 1.5×: see the note above on what an extreme's volume looks
         like. The weight of this search is carried by the delta share and the
         bar's direction, which is where the trap actually lives. */
      filters: [
        { metric: "volumeX", op: "gte", value: 0.7 },
        { metric: "deltaPercent", op: "gte", value: 40 },
      ],
      extremesOnly: true,
      barDirection: "down",
    },
  },
  {
    id: "sellers_trapped",
    label: "Sellers trapped at the low",
    description:
      "Heavy selling at the bottom of a bar that then closed up. The same trap the other way round, and the same magnet on a revisit.",
    query: {
      filters: [
        { metric: "volumeX", op: "gte", value: 0.7 },
        { metric: "deltaPercent", op: "lte", value: -40 },
      ],
      extremesOnly: true,
      barDirection: "up",
    },
  },
  {
    id: "stacked_imbalance",
    label: "Severe imbalance",
    description:
      "Levels where one side out-traded the diagonal by 5× or more. At that ratio the other side was not slow, it was absent — which is what an initiative move through thin liquidity looks like from the inside.",
    query: { filters: [{ metric: "imbalanceRatio", op: "gte", value: 5 }] },
  },
  {
    id: "high_volume_nodes",
    label: "Bar POC at an extreme",
    description:
      "Bars whose heaviest level sat at their own high or low. Most volume trades in the middle of a bar; when the bulk of it happens at the edge, the auction was still being fought there when the bar closed rather than having settled.",
    /* The size floor only excludes a dead level; the POC and the extreme are
       doing the selecting, and gating both on mid-bar-sized volume as well
       would leave nothing through. */
    query: { filters: [{ metric: "volumeX", op: "gte", value: 0.5 }], pocOnly: true, extremesOnly: true },
  },
];

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

function matches(filter: ClusterFilter, value: number): boolean {
  switch (filter.op) {
    case "gte":
      return value >= filter.value;
    case "lte":
      return value <= filter.value;
    case "between": {
      // An open-ended "between" is a mistake, not a one-sided filter: honouring
      // it as >= would silently return a different search than was written.
      if (filter.upper == null || !Number.isFinite(filter.upper)) return false;
      const lo = Math.min(filter.value, filter.upper);
      const hi = Math.max(filter.value, filter.upper);
      return value >= lo && value <= hi;
    }
  }
}

const METRIC_LABEL: Record<ClusterMetric, string> = {
  volumeX: "cluster size",
  deltaX: "cluster delta",
  deltaPercent: "delta share",
  imbalanceRatio: "diagonal imbalance",
};

/** Where a level sits inside its own bar. */
function extremeOf(candle: FootprintCandle, price: number): "high" | "low" | null {
  const span = candle.high - candle.low;
  if (span <= 0) return null;
  const fromLow = (price - candle.low) / span;
  if (fromLow >= 1 - EXTREME_BAND) return "high";
  if (fromLow <= EXTREME_BAND) return "low";
  return null;
}

/**
 * Run a query over the footprint.
 *
 * Pure and synchronous. An empty filter list returns no hits rather than
 * everything: "no criteria" is an unfinished query, and answering it with the
 * entire grid buries whatever the reader was actually about to ask.
 */
export function searchClusters(
  footprint: FootprintResult,
  query: ClusterQuery
): ClusterSearchResult {
  const bars = query.bars ?? DEFAULT_BARS;
  const limit = query.limit ?? DEFAULT_LIMIT;
  const window = footprint.candles.slice(-bars);

  const caveats: string[] = [];
  if (footprint.fidelity === "estimated") {
    caveats.push(
      "This footprint was modelled from bar-level taker volume, not reconstructed from lower-timeframe candles. Per-level splits are an estimate, so these hits describe the model as much as the tape — read them as a shortlist to check, never as an observation."
    );
  }

  /* The denominator counts EVERY price level in the window, including the ones
     nothing traded at. Averaging only over levels that traded looks tidier and
     is wrong in exactly the case this tool exists for: a bar whose volume all
     landed on one row has one non-empty cluster, so against a traded-only
     average that row scores 1.0× and the most concentrated bar on the chart
     reads as perfectly ordinary. A level where nothing traded is a cluster
     with zero volume, and leaving it out biases the baseline upward precisely
     where concentration is highest. */
  let scanned = 0;
  let traded = 0;
  let volumeSum = 0;
  for (const candle of window) {
    for (const cell of candle.cells) {
      scanned++;
      const volume = cell.bidVolume + cell.askVolume;
      if (volume <= 0) continue;
      traded++;
      volumeSum += volume;
    }
  }
  const averageCluster = scanned > 0 ? volumeSum / scanned : 0;

  if (query.filters.length === 0) {
    return {
      hits: [],
      scanned,
      averageCluster,
      fidelity: footprint.fidelity,
      headline: "No criteria set — add a filter or pick a preset.",
      caveats,
    };
  }
  if (averageCluster <= 0) {
    return {
      hits: [],
      scanned,
      averageCluster: 0,
      fidelity: footprint.fidelity,
      headline: "No traded clusters in the window to search.",
      caveats,
    };
  }

  const hits: ClusterHit[] = [];

  for (const candle of window) {
    const barDirection: "up" | "down" = candle.close >= candle.open ? "up" : "down";
    if (query.barDirection && query.barDirection !== barDirection) continue;

    for (const cell of candle.cells) {
      const volume = cell.bidVolume + cell.askVolume;
      if (volume <= 0) continue;

      const isPoc = Math.abs(cell.price - candle.poc) < 1e-9;
      if (query.pocOnly && !isPoc) continue;

      const atExtreme = extremeOf(candle, cell.price);
      if (query.extremesOnly && atExtreme === null) continue;

      const values: Record<ClusterMetric, number> = {
        volumeX: volume / averageCluster,
        deltaX: cell.delta / averageCluster,
        deltaPercent: (cell.delta / volume) * 100,
        imbalanceRatio: cell.imbalance ? cell.imbalanceRatio : 0,
      };

      if (!query.filters.every((f) => matches(f, values[f.metric]))) continue;

      /* The reason repeats the numbers that got the level in, not a summary of
         them. A hit whose explanation is "large cluster" leaves the reader to
         go and check whether it was 1.2× or 9×, which is the question. */
      const reason = query.filters
        .map((f) => {
          const v = values[f.metric];
          const shown =
            f.metric === "deltaPercent"
              ? `${v >= 0 ? "+" : ""}${v.toFixed(0)}%`
              : `${v.toFixed(1)}×`;
          return `${METRIC_LABEL[f.metric]} ${shown}`;
        })
        .join(", ");

      hits.push({
        time: candle.time,
        price: Number(cell.price.toFixed(8)),
        bidVolume: Number(cell.bidVolume.toFixed(2)),
        askVolume: Number(cell.askVolume.toFixed(2)),
        volume: Number(volume.toFixed(2)),
        delta: Number(cell.delta.toFixed(2)),
        deltaPercent: Number(values.deltaPercent.toFixed(1)),
        volumeX: Number(values.volumeX.toFixed(2)),
        imbalance: cell.imbalance,
        imbalanceRatio: Number(cell.imbalanceRatio.toFixed(2)),
        isPoc,
        atExtreme,
        barDirection,
        reason,
      });
    }
  }

  /* Size first, then recency. Sorting by time alone would bury a 9× cluster
     from an hour ago under a shelf of 3× ones from the last four bars, and the
     9× one is the level price will react to. */
  hits.sort((a, b) => b.volumeX - a.volumeX || b.time - a.time);
  const top = hits.slice(0, limit);

  const headline =
    top.length === 0
      ? `Nothing matched across ${traded} traded clusters in the last ${window.length} bars.`
      : `${hits.length} cluster${hits.length === 1 ? "" : "s"} matched; heaviest is ${top[0].volumeX.toFixed(1)}× the average at ${trim(top[0].price)}.`;

  if (hits.length > top.length) {
    caveats.push(`${hits.length - top.length} further matches not shown — tighten the filter to see the rest.`);
  }

  return {
    hits: top,
    scanned,
    averageCluster: Number(averageCluster.toFixed(2)),
    fidelity: footprint.fidelity,
    headline,
    caveats,
  };
}

/** Look a preset up by id. Returns null rather than guessing at a typo. */
export function presetById(id: string): ClusterPreset | null {
  return CLUSTER_PRESETS.find((p) => p.id === id) ?? null;
}
