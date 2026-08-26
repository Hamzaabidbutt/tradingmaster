import { OrderWall, OrderWallResult } from "./types";

/**
 * Resting order walls — the buy and sell blocks sitting in the book.
 *
 * A "wall" is an unusually large block of resting limit size at one price, or
 * spread thinly across a few adjacent ticks. Traders watch them because they
 * are the one part of the book that is visible before it trades: a large offer
 * overhead is supply that must be absorbed before price can pass, and a large
 * bid below is where someone has already decided to buy.
 *
 * Three things this deliberately does, because the naive version misleads:
 *
 *  * **Clusters, not single levels.** Real size is routinely split across
 *    adjacent ticks — a 400k bid shown as eight 50k levels one tick apart is
 *    still one wall. Reading raw levels would miss it entirely and instead
 *    highlight whichever single tick happened to be fattest.
 *  * **Relative, not absolute.** "Big" only means anything against the rest of
 *    the book, so size is scored as a multiple of the mean level size on that
 *    side. A fixed notional threshold would flag every level on BTC and none
 *    on a small cap.
 *  * **No prediction.** A wall is inventory, not intent. It can be pulled the
 *    instant price approaches — spoofing is common in crypto perps — so the
 *    output describes what is resting *right now* and says so; nothing here
 *    claims the level will hold.
 */

export interface WallOptions {
  /** ticks within this % of each other join one cluster */
  clusterPct?: number;
  /** a level must be this many × the mean level size to join a cluster at all */
  heavyMultiple?: number;
  /** minimum size, as a multiple of the mean level size on that side */
  minMultiple?: number;
  /** minimum share of the sampled side's total size */
  minShare?: number;
  /** walls further than this % from price are out of play */
  maxDistancePct?: number;
  /** how many to return per side */
  limit?: number;
}

const DEFAULTS: Required<WallOptions> = {
  // 0.1% of price. Wide enough to absorb a block iceberged across a handful of
  // ticks, narrow enough that two genuinely separate walls stay separate —
  // which is what a trader is asking when they want to know where the size is.
  clusterPct: 0.1,
  heavyMultiple: 2,
  minMultiple: 4,
  minShare: 0.03,
  maxDistancePct: 3,
  limit: 4,
};

type Level = [price: number, size: number];

interface Cluster {
  price: number;
  size: number;
  levels: number;
}

/**
 * Merge above-average levels into clusters.
 *
 * Only levels that are themselves heavy take part. That restriction is what
 * makes the result meaningful: clustering *every* level would turn a perfectly
 * uniform book into a row of "walls", because any band wide enough to catch a
 * split block also catches ten ordinary ticks, and their sum looks large next
 * to a single level. Heavy levels chain to each other while ordinary depth
 * between them is ignored, so a block iceberged across eight ticks comes back
 * as one wall and an even book comes back as nothing.
 *
 * `levels` must be ordered away from the mid (bids descending, asks ascending)
 * so "adjacent" means adjacent in the book. The cluster price is the
 * size-weighted mean, which is where the size actually sits when it is spread.
 */
function clusterLevels(levels: Level[], meanLevel: number, band: number, heavyMultiple: number): Cluster[] {
  const heavy = levels.filter(([, s]) => s >= meanLevel * heavyMultiple);
  const clusters: Cluster[] = [];
  let prev: number | null = null;
  let size = 0;
  let weighted = 0;
  let count = 0;

  const flush = () => {
    if (count > 0 && size > 0) clusters.push({ price: weighted / size, size, levels: count });
    size = 0;
    weighted = 0;
    count = 0;
  };

  for (const [p, s] of heavy) {
    if (prev !== null && Math.abs(p - prev) > band) flush();
    prev = p;
    size += s;
    weighted += p * s;
    count++;
  }
  flush();
  return clusters;
}

function buildWalls(
  levels: Level[],
  price: number,
  side: "bid" | "ask",
  opts: Required<WallOptions>
): OrderWall[] {
  const usable = levels.filter(([p, s]) => p > 0 && s > 0);
  if (usable.length === 0) return [];

  const total = usable.reduce((s, l) => s + l[1], 0);
  // The yardstick is the mean *level* size, not the mean cluster size: cluster
  // sizes are what we are trying to grade, and grading them against their own
  // mean would flatten exactly the outlier we are looking for.
  const meanLevel = total / usable.length;
  const clusters = clusterLevels(usable, meanLevel, (price * opts.clusterPct) / 100, opts.heavyMultiple);

  const walls: OrderWall[] = [];
  for (const c of clusters) {
    const distancePct = ((c.price - price) / price) * 100;
    if (Math.abs(distancePct) > opts.maxDistancePct) continue;
    const multiple = c.size / Math.max(meanLevel, 1e-12);
    const share = c.size / Math.max(total, 1e-12);
    if (multiple < opts.minMultiple || share < opts.minShare) continue;

    walls.push({
      side,
      price: c.price,
      size: Number(c.size.toFixed(4)),
      notional: Number((c.size * c.price).toFixed(2)),
      multiple: Number(multiple.toFixed(1)),
      distancePct: Number(distancePct.toFixed(3)),
      levels: c.levels,
      note:
        `${side === "bid" ? "Buy" : "Sell"} wall ${Math.abs(distancePct).toFixed(2)}% ${side === "bid" ? "below" : "above"} price: ` +
        `${multiple.toFixed(1)}× the average level size${c.levels > 1 ? `, spread over ${c.levels} ticks` : ""}, ` +
        `${(share * 100).toFixed(0)}% of the sampled ${side === "bid" ? "bid" : "ask"} depth. ` +
        `${side === "bid" ? "Buyers have size resting here; it has to be consumed before price can go lower." : "Supply is parked here; it has to be absorbed before price can go higher."} ` +
        `Resting size can be pulled — this is what is in the book now, not a commitment.`,
    });
  }

  // Nearest first: a wall two ticks away governs the next minute, one 2% away
  // governs the next hour, and the first is what a trader is asking about.
  return walls.sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct)).slice(0, opts.limit);
}

export function detectOrderWalls(
  price: number,
  bids: Level[],
  asks: Level[],
  options: WallOptions = {}
): OrderWallResult {
  const opts = { ...DEFAULTS, ...options };
  const sampledAt = Math.floor(Date.now() / 1000);

  if (!(price > 0)) {
    return {
      price,
      bids: [],
      asks: [],
      imbalance: 0,
      largestBid: null,
      largestAsk: null,
      sampledAt,
      summary: ["No price available — order walls cannot be located."],
    };
  }

  // Order away from the mid so clustering follows the book, not the array.
  const bidLevels = [...bids].sort((a, b) => b[0] - a[0]);
  const askLevels = [...asks].sort((a, b) => a[0] - b[0]);

  const bidWalls = buildWalls(bidLevels, price, "bid", opts);
  const askWalls = buildWalls(askLevels, price, "ask", opts);

  const bidTotal = bidLevels.reduce((s, l) => s + l[1], 0);
  const askTotal = askLevels.reduce((s, l) => s + l[1], 0);
  const imbalance =
    bidTotal + askTotal > 0 ? Number(((bidTotal - askTotal) / (bidTotal + askTotal)).toFixed(4)) : 0;

  const biggest = (walls: OrderWall[]) =>
    walls.length > 0 ? walls.reduce((a, b) => (a.size >= b.size ? a : b)) : null;
  const largestBid = biggest(bidWalls);
  const largestAsk = biggest(askWalls);

  const summary: string[] = [];
  if (bidWalls.length === 0 && askWalls.length === 0) {
    summary.push(
      `No wall stands out within ${opts.maxDistancePct}% of price — resting size is spread evenly, so the book offers no obvious level to lean on in either direction.`
    );
  } else {
    if (largestBid) {
      summary.push(
        `Largest buy wall is ${largestBid.multiple.toFixed(1)}× average size at ${largestBid.price.toFixed(6).replace(/0+$/, "")} (${Math.abs(largestBid.distancePct).toFixed(2)}% below) — the nearest place where a decline runs into resting demand.`
      );
    }
    if (largestAsk) {
      summary.push(
        `Largest sell wall is ${largestAsk.multiple.toFixed(1)}× average size at ${largestAsk.price.toFixed(6).replace(/0+$/, "")} (${largestAsk.distancePct.toFixed(2)}% above) — supply that has to be cleared before price advances.`
      );
    }
    if (largestBid && largestAsk) {
      const closer = Math.abs(largestBid.distancePct) < Math.abs(largestAsk.distancePct) ? "buy" : "sell";
      summary.push(
        `The ${closer} wall is the closer of the two, so it is the one price is likelier to test first. Which side gets absorbed is the information — a wall that trades through without price stopping is a stronger signal than the wall itself was.`
      );
    }
  }
  summary.push(
    `Book imbalance is ${imbalance >= 0 ? "+" : ""}${(imbalance * 100).toFixed(1)}% ${imbalance > 0.05 ? "(bid heavy)" : imbalance < -0.05 ? "(ask heavy)" : "(balanced)"} across the sampled depth. Resting orders are not trades: they can be cancelled at any moment, and large visible size is sometimes placed precisely to be seen.`
  );

  return { price, bids: bidWalls, asks: askWalls, imbalance, largestBid, largestAsk, sampledAt, summary };
}
