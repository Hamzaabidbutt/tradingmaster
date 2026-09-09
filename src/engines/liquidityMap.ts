import { OrderWall, PressureZone } from "./types";

/**
 * Where the size is, as a ladder rather than a number.
 *
 * "Nearest bid wall: $48M" is a fact you cannot act on. What a trader needs is
 * the *shape* — how much is above, how much below, how far away each block is,
 * and therefore which direction has less standing in its way. That is a
 * picture, and collapsing it to a single figure throws away the only part that
 * decides anything.
 *
 * Two independent sources feed the same ladder, and they are kept apart
 * because they are different kinds of claim:
 *
 *  - **Book liquidity** is *measured*. Those orders exist right now. They can
 *    also be pulled the instant price approaches, which is what spoofing is,
 *    so resting size is evidence of intent at best and a decoy at worst.
 *
 *  - **Liquidation liquidity** is *inferred*. Nobody publishes where stops
 *    are; these are derived from leverage bands and prior swing extremes. They
 *    cannot be pulled — a liquidation is mechanical — but the estimate of
 *    where they sit can simply be wrong.
 *
 * Mixing them into one "liquidity" number would present an inference and a
 * measurement as the same thing. Every row says which it is.
 *
 * ## The attraction score
 *
 * Price tends to travel toward resting size, because that is where trades can
 * actually be filled — a market seeking liquidity is a description of how
 * auctions work, not a prediction. The score combines how much size sits on
 * each side with how far away it is, and says which direction has more pull.
 * It is a statement about the *current* map, and the map changes: book orders
 * are pulled and stops are moved.
 */

/** Rungs on the ladder either side of price. */
const RUNGS = 6;
/** Ignore anything further than this from price — it is not this session's business. */
const MAX_DISTANCE_PCT = 12;

export type LiquiditySource = "book" | "liquidation";

export interface LiquidityRung {
  price: number;
  /** signed % from current price; positive = above */
  distancePct: number;
  side: "above" | "below";
  source: LiquiditySource;
  /** notional in quote terms for book rows; relative heat 0-100 for inferred ones */
  magnitude: number;
  /** true when the figure is a measured notional rather than an inferred intensity */
  measured: boolean;
  label: string;
  note: string;
}

export interface LiquidityMap {
  price: number;
  rungs: LiquidityRung[];
  /** nearest significant rung on each side */
  nearestAbove: LiquidityRung | null;
  nearestBelow: LiquidityRung | null;
  /**
   * -100..100. Positive means more pull above than below.
   *
   * Weighted by proximity: size ten percent away pulls far less than the same
   * size one percent away, because price has to survive everything in between
   * to reach it.
   */
  attraction: number;
  headline: string;
  note: string;
  caveats: string[];
}

/**
 * A price at a readable precision.
 *
 * Prices reach this engine as raw floats — an order-book level is
 * 15.796573291158271 — and printing that into a headline is unreadable. Six
 * decimals with trailing zeros stripped covers everything from BTC to a
 * sub-cent altcoin without the engine needing to know the symbol's tick size.
 */
function trim(v: number): string {
  return v.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

/** Proximity weight: closer size counts for more. */
function weight(distancePct: number): number {
  return 1 / (1 + Math.abs(distancePct));
}

/**
 * Build the ladder.
 *
 * Pure and synchronous. Either source may be empty — a contract with no order
 * book sample still produces a liquidation-only map, and vice versa — and the
 * caveats say which half is missing rather than presenting a partial map as a
 * complete one.
 */
export function buildLiquidityMap(
  price: number,
  walls: { bids: OrderWall[]; asks: OrderWall[] } | null,
  zones: PressureZone[]
): LiquidityMap {
  const rungs: LiquidityRung[] = [];
  const caveats: string[] = [];

  if (!walls || (walls.bids.length === 0 && walls.asks.length === 0)) {
    caveats.push(
      "No order-book sample — the measured half of the map is missing, and what remains is inferred."
    );
  } else {
    for (const w of [...walls.bids, ...walls.asks]) {
      if (Math.abs(w.distancePct) > MAX_DISTANCE_PCT) continue;
      rungs.push({
        price: w.price,
        distancePct: Number(w.distancePct.toFixed(2)),
        side: w.price >= price ? "above" : "below",
        source: "book",
        magnitude: w.notional,
        measured: true,
        label: w.side === "bid" ? "Bid wall" : "Ask wall",
        note: `${w.multiple.toFixed(1)}× the average level size, across ${w.levels} book levels. Resting orders exist right now — and can be pulled the moment price arrives, which is what spoofing is.`,
      });
    }
  }

  if (zones.length === 0) {
    caveats.push("No liquidation zones derived — the inferred half of the map is missing.");
  } else {
    for (const z of zones) {
      if (Math.abs(z.distancePct) > MAX_DISTANCE_PCT) continue;
      rungs.push({
        price: z.price,
        distancePct: Number(z.distancePct.toFixed(2)),
        side: z.price >= price ? "above" : "below",
        source: "liquidation",
        magnitude: z.intensity,
        measured: false,
        label: z.side === "long" ? "Long stops" : "Short stops",
        note: `${z.note} Derived from ${z.basis.replace(/_/g, " ")} — nobody publishes where stops are, so the location is an estimate. Unlike book orders these cannot be pulled, but the estimate itself can be wrong.`,
      });
    }
  }

  // Nearest first on each side, then trimmed: the far end of the ladder is
  // not this session's business.
  const above = rungs
    .filter((r) => r.side === "above")
    .sort((a, b) => a.distancePct - b.distancePct)
    .slice(0, RUNGS);
  const below = rungs
    .filter((r) => r.side === "below")
    .sort((a, b) => b.distancePct - a.distancePct)
    .slice(0, RUNGS);

  /* Book notionals and inferred intensities are on different scales, so they
     are normalised within their own source before being compared. Adding a
     dollar figure to a 0-100 heat would let whichever happened to be larger
     dominate for no reason. */
  const norm = (list: LiquidityRung[], source: LiquiditySource) => {
    const of = list.filter((r) => r.source === source);
    const max = Math.max(...of.map((r) => r.magnitude), 0);
    return max > 0 ? (r: LiquidityRung) => r.magnitude / max : () => 0;
  };
  const all = [...above, ...below];
  const bookNorm = norm(all, "book");
  const liqNorm = norm(all, "liquidation");
  const pull = (r: LiquidityRung) =>
    (r.source === "book" ? bookNorm(r) : liqNorm(r)) * weight(r.distancePct);

  const upPull = above.reduce((s, r) => s + pull(r), 0);
  const downPull = below.reduce((s, r) => s + pull(r), 0);
  const total = upPull + downPull;
  const attraction = total > 0 ? Math.round(((upPull - downPull) / total) * 100) : 0;

  const nearestAbove = above[0] ?? null;
  const nearestBelow = below[0] ?? null;

  const headline =
    all.length === 0
      ? "No liquidity within range to map."
      : Math.abs(attraction) < 15
        ? "Liquidity is balanced either side — no directional pull from the map."
        : attraction > 0
          ? `More pull above: ${nearestAbove ? `nearest is ${nearestAbove.label.toLowerCase()} at ${trim(nearestAbove.price)}` : "size sits overhead"}.`
          : `More pull below: ${nearestBelow ? `nearest is ${nearestBelow.label.toLowerCase()} at ${trim(nearestBelow.price)}` : "size sits underneath"}.`;

  caveats.push(
    "Attraction weights size by proximity, because price must survive everything in between to reach anything further out. It describes the map as it stands — book orders get pulled and stops get moved."
  );

  return {
    price,
    rungs: [...above, ...below],
    nearestAbove,
    nearestBelow,
    attraction,
    headline,
    note: "Measured book size and inferred stop location are shown as separate kinds of row on purpose. One exists and can vanish; the other cannot vanish but may never have been where the estimate put it.",
    caveats,
  };
}

/* ------------------------------------------------------------------ *
 * Liquidation heatmap
 * ------------------------------------------------------------------ */

export interface HeatRow {
  price: number;
  distancePct: number;
  /** 0-100 relative to the hottest row in the map */
  heat: number;
  side: "long" | "short";
  /** true for the row containing the current price */
  current: boolean;
}

export interface HeatCluster {
  low: number;
  high: number;
  side: "long" | "short";
  /** summed intensity across the rows in the cluster */
  weight: number;
  distancePct: number;
}

export interface LiquidationHeatmap {
  price: number;
  rows: HeatRow[];
  /** contiguous runs of hot rows on the same side */
  clusters: HeatCluster[];
  /** the heaviest cluster, which is the one worth naming */
  major: HeatCluster | null;
  headline: string;
  note: string;
}

/** Rows above and below price in the heatmap. */
const HEAT_ROWS = 9;

/**
 * Turn liquidation zones into a price ladder with heat.
 *
 * Pure and synchronous. Rows are laid out on a fixed grid spanning the zones,
 * so an empty band reads as empty rather than being collapsed away — where
 * there is *no* liquidity is as useful as where there is a lot, and a list
 * that only contains hits hides it.
 */
export function buildLiquidationHeatmap(
  price: number,
  zones: PressureZone[]
): LiquidationHeatmap {
  if (zones.length === 0 || price <= 0) {
    return {
      price,
      rows: [],
      clusters: [],
      major: null,
      headline: "No liquidation zones derived for this symbol.",
      note: "Stop locations are inferred from leverage bands and prior extremes; with neither available there is nothing to map.",
    };
  }

  const prices = zones.map((z) => z.price);
  const lo = Math.min(...prices, price);
  const hi = Math.max(...prices, price);
  const span = Math.max(hi - lo, 1e-9);
  const step = span / (HEAT_ROWS * 2);

  const rows: HeatRow[] = [];
  for (let k = 0; k <= HEAT_ROWS * 2; k++) {
    const rowLow = lo + step * k;
    const rowHigh = rowLow + step;
    const mid = (rowLow + rowHigh) / 2;
    const inRow = zones.filter((z) => z.price >= rowLow && z.price < rowHigh);
    const heat = inRow.reduce((s, z) => s + z.intensity, 0);
    const longSide = inRow.filter((z) => z.side === "long").length >= inRow.length / 2;
    rows.push({
      price: Number(mid.toFixed(8)),
      distancePct: Number((((mid - price) / price) * 100).toFixed(2)),
      heat,
      side: longSide ? "long" : "short",
      current: price >= rowLow && price < rowHigh,
    });
  }

  const maxHeat = Math.max(...rows.map((r) => r.heat), 0);
  for (const r of rows) r.heat = maxHeat > 0 ? Math.round((r.heat / maxHeat) * 100) : 0;

  /* Contiguous hot rows on one side are one destination, not several. A list
     of individual rows makes a wide band of stops look like a handful of thin
     ones, which is the opposite of what the map is for. */
  const clusters: HeatCluster[] = [];
  let run: HeatRow[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const low = Math.min(...run.map((r) => r.price));
    const high = Math.max(...run.map((r) => r.price));
    const mid = (low + high) / 2;
    clusters.push({
      low: Number(low.toFixed(8)),
      high: Number(high.toFixed(8)),
      side: run[0].side,
      weight: run.reduce((s, r) => s + r.heat, 0),
      distancePct: Number((((mid - price) / price) * 100).toFixed(2)),
    });
    run = [];
  };
  for (const r of rows) {
    if (r.heat >= 25 && (run.length === 0 || run[run.length - 1].side === r.side)) {
      run.push(r);
    } else {
      flush();
      if (r.heat >= 25) run = [r];
    }
  }
  flush();

  clusters.sort((a, b) => b.weight - a.weight);
  const major = clusters[0] ?? null;

  return {
    price,
    rows: rows.sort((a, b) => b.price - a.price),
    clusters,
    major,
    headline: major
      ? `Major ${major.side === "long" ? "long" : "short"} liquidation cluster at ${trim(major.low)}–${trim(major.high)}, ${major.distancePct >= 0 ? "+" : ""}${major.distancePct}% away.`
      : "Stops are spread thinly — no cluster stands out.",
    note: "Heat is relative to the hottest band on this map, not an absolute dollar figure: nobody publishes stop placement, so this is a shape derived from leverage bands and prior extremes rather than a measurement. Empty rows are shown because where there is no liquidity matters as much as where there is.",
  };
}
