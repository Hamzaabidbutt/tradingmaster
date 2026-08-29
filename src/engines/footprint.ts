import { Candle, FootprintCandle, FootprintCell, FootprintResult } from "./types";

/**
 * Footprint engine — the "x-ray" of a candle.
 *
 * A normal candle tells you the price. The footprint tells you the battle
 * that produced it: at every price level inside the bar, how much volume
 * hit the BID (aggressive sellers) versus lifted the ASK (aggressive
 * buyers).
 *
 * Reading rules implemented here:
 *
 *  • Delta = ask − bid. Positive means buyers dominated that level.
 *  • Diagonal imbalance: compare ask at price P against bid at price P−1
 *    (that is how the two sides actually meet). A ratio above the
 *    threshold (300% / 3x is the common default) marks aggression that the
 *    other side could not answer.
 *  • Stacked imbalance: 3+ consecutive imbalances in the same direction —
 *    a genuinely one-sided auction, and the strongest continuation tell.
 *  • Zero prints: a level where one side got no fills at all — the other
 *    side was given no opportunity.
 *  • Candle POC: the price level inside the bar with the most volume.
 *  • Delta divergence: delta sign contradicts the candle body (e.g. a red
 *    candle closing with positive delta). That is the classic absorption /
 *    trap signature — aggressive sellers hit the bid but passive buyers
 *    soaked it up and price refused to fall.
 *
 * NOTE ON DATA FIDELITY: true footprints need raw tick data. Binance
 * klines expose taker-buy volume per bar, so the honest approach is to
 * rebuild each bar from LOWER-TIMEFRAME candles (e.g. a 15m bar from 1m
 * bars), which gives a genuine per-price split. When sub-candles are not
 * supplied the engine falls back to a modelled distribution and reports
 * `fidelity: "estimated"` so nothing downstream over-trusts it.
 */

export interface FootprintOptions {
  /** imbalance ratio; 3 = 300%. Asset- and session-dependent — tune it. */
  imbalanceThreshold?: number;
  /** number of price rows per candle */
  rowsPerCandle?: number;
  /** how many recent candles to build */
  count?: number;
  sourceTimeframe?: string;
}

export function buildFootprint(
  candles: Candle[],
  subCandles: Candle[] | null,
  opts: FootprintOptions = {}
): FootprintResult {
  const threshold = opts.imbalanceThreshold ?? 3;
  const rowsPerCandle = opts.rowsPerCandle ?? 12;
  const count = opts.count ?? 30;
  const target = candles.slice(-count);
  const fidelity: FootprintResult["fidelity"] = subCandles && subCandles.length > 0 ? "sub_candle" : "estimated";

  const out: FootprintCandle[] = [];
  for (let i = 0; i < target.length; i++) {
    const c = target[i];
    const next = target[i + 1];
    const windowSubs = subCandles
      ? subCandles.filter((s) => s.time >= c.time && (!next || s.time < next.time))
      : [];
    out.push(buildOne(c, windowSubs, rowsPerCandle, threshold));
  }

  const summary: string[] = [];
  const last = out[out.length - 1];
  if (last) {
    if (last.stackedImbalances.length > 0) {
      const si = last.stackedImbalances[last.stackedImbalances.length - 1];
      summary.push(
        `Stacked ${si.direction} imbalance (${si.count} levels, ${si.fromPrice.toFixed(4)}–${si.toPrice.toFixed(4)}) — one side is being given no opportunity to fill, the hallmark of a genuinely aggressive move.`
      );
    }
    if (last.deltaDivergence) {
      summary.push(
        last.close < last.open
          ? "Red candle closing with POSITIVE delta — aggressive sellers were absorbed by passive buyers. Price refused to fall despite the selling."
          : "Green candle closing with NEGATIVE delta — aggressive buyers were absorbed by passive sellers. Price refused to rise despite the buying."
      );
    }
    if (last.zeroPrints.length > 0) {
      summary.push(
        `${last.zeroPrints.length} zero-print level(s) in the current bar — one side got literally no fills there.`
      );
    }
    summary.push(
      `Current bar POC ${last.poc.toFixed(4)} with total delta ${last.delta >= 0 ? "+" : ""}${last.delta.toFixed(0)}.`
    );
  }
  if (fidelity === "estimated") {
    summary.push(
      "Footprint is modelled from bar-level taker volume (no sub-timeframe data supplied) — treat level detail as indicative rather than exact."
    );
  }

  return {
    fidelity,
    sourceTimeframe: opts.sourceTimeframe ?? (fidelity === "sub_candle" ? "sub-candle" : "modelled"),
    candles: out,
    imbalanceThreshold: threshold,
    summary,
  };
}

function buildOne(
  candle: Candle,
  subs: Candle[],
  rows: number,
  threshold: number
): FootprintCandle {
  const high = candle.high;
  const low = candle.low;
  const span = Math.max(high - low, 1e-9);
  const rowSize = span / rows;

  const bid = new Array(rows).fill(0);
  const ask = new Array(rows).fill(0);

  if (subs.length > 0) {
    // Genuine reconstruction: each sub-candle contributes its own taker
    // split to the price rows it actually traded through.
    for (const s of subs) {
      const startRow = clamp(Math.floor((s.low - low) / rowSize), 0, rows - 1);
      const endRow = clamp(Math.floor((s.high - low) / rowSize), 0, rows - 1);
      const touched = Math.max(1, endRow - startRow + 1);
      const buy = s.takerBuyVolume ?? s.volume / 2;
      const sell = s.volume - buy;
      for (let r = startRow; r <= endRow; r++) {
        ask[r] += buy / touched;
        bid[r] += sell / touched;
      }
    }
  } else {
    // Modelled fallback: volume concentrates toward the close (where the
    // auction ended) and buyers dominate the upper half of an up-bar.
    const buyTotal = candle.takerBuyVolume ?? candle.volume / 2;
    const sellTotal = candle.volume - buyTotal;
    const closeRow = clamp(Math.floor((candle.close - low) / rowSize), 0, rows - 1);
    let weightSum = 0;
    const weights = new Array(rows).fill(0);
    for (let r = 0; r < rows; r++) {
      const distance = Math.abs(r - closeRow) / rows;
      weights[r] = Math.exp(-distance * 2.2);
      weightSum += weights[r];
    }
    for (let r = 0; r < rows; r++) {
      const w = weights[r] / Math.max(weightSum, 1e-9);
      // Buyers skew high, sellers skew low within the bar.
      const upBias = 0.5 + (r / Math.max(rows - 1, 1) - 0.5) * 0.5;
      ask[r] += buyTotal * w * (0.5 + upBias * 0.5) * 1.2;
      bid[r] += sellTotal * w * (1.5 - upBias) * 0.8;
    }
  }

  // --- Cells + diagonal imbalance ---
  const cells: FootprintCell[] = [];
  for (let r = 0; r < rows; r++) {
    const price = low + rowSize * (r + 0.5);
    cells.push({
      price,
      bidVolume: bid[r],
      askVolume: ask[r],
      delta: ask[r] - bid[r],
      imbalance: null,
      imbalanceRatio: 0,
    });
  }
  for (let r = 0; r < rows; r++) {
    // Buy imbalance: ask at this level vs bid one level lower.
    if (r > 0) {
      const denom = Math.max(bid[r - 1], 1e-9);
      const ratio = ask[r] / denom;
      if (ratio >= threshold && ask[r] > 0) {
        cells[r].imbalance = "buy";
        cells[r].imbalanceRatio = ratio;
      }
    }
    // Sell imbalance: bid at this level vs ask one level higher.
    if (r < rows - 1 && cells[r].imbalance === null) {
      const denom = Math.max(ask[r + 1], 1e-9);
      const ratio = bid[r] / denom;
      if (ratio >= threshold && bid[r] > 0) {
        cells[r].imbalance = "sell";
        cells[r].imbalanceRatio = ratio;
      }
    }
  }

  // --- Stacked imbalances (3+ consecutive, same direction) ---
  const stacked: FootprintCandle["stackedImbalances"] = [];
  let runStart = -1;
  let runDir: "buy" | "sell" | null = null;
  const flush = (endIdx: number) => {
    if (runStart >= 0 && runDir && endIdx - runStart + 1 >= 3) {
      stacked.push({
        direction: runDir,
        fromPrice: cells[runStart].price,
        toPrice: cells[endIdx].price,
        count: endIdx - runStart + 1,
      });
    }
    runStart = -1;
    runDir = null;
  };
  for (let r = 0; r < rows; r++) {
    const imb = cells[r].imbalance;
    if (imb && imb === runDir) continue;
    if (imb && runDir === null) {
      runStart = r;
      runDir = imb;
    } else {
      flush(r - 1);
      if (imb) {
        runStart = r;
        runDir = imb;
      }
    }
  }
  flush(rows - 1);

  // --- Zero prints ---
  const totalVolume = cells.reduce((s, c) => s + c.bidVolume + c.askVolume, 0);
  const dust = totalVolume * 0.001;
  const zeroPrints: FootprintCandle["zeroPrints"] = [];
  for (const cell of cells) {
    if (cell.askVolume <= dust && cell.bidVolume > dust) {
      zeroPrints.push({ price: cell.price, side: "buy" });
    } else if (cell.bidVolume <= dust && cell.askVolume > dust) {
      zeroPrints.push({ price: cell.price, side: "sell" });
    }
  }

  // --- Candle POC ---
  let pocIdx = 0;
  for (let r = 1; r < rows; r++) {
    if (cells[r].bidVolume + cells[r].askVolume > cells[pocIdx].bidVolume + cells[pocIdx].askVolume) {
      pocIdx = r;
    }
  }

  const delta = cells.reduce((s, c) => s + c.delta, 0);
  const bullishCandle = candle.close >= candle.open;
  const deltaDivergence = (bullishCandle && delta < 0) || (!bullishCandle && delta > 0);

  return {
    time: candle.time,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    cells,
    poc: cells[pocIdx].price,
    totalVolume,
    delta,
    stackedImbalances: stacked,
    zeroPrints,
    deltaDivergence,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/* ------------------------------------------------------------------ *
 * Imbalance ladder
 * ------------------------------------------------------------------ */

/** One price level where the diagonal ratio cleared the threshold. */
export interface ImbalanceLevel {
  time: number;
  price: number;
  side: "buy" | "sell";
  /** ask/bid (buy) or bid/ask (sell) across the diagonal */
  ratio: number;
  /** the ratio rounded down to a displayed tier: 3, 5, 10, 15 or 20 */
  tier: number;
  /** volume on the aggressing side at this level */
  volume: number;
  /** part of a run of 3+ consecutive imbalances in the same direction */
  stacked: boolean;
}

/**
 * Tiers the ladder is bucketed into, ascending.
 *
 * 20 is the top bucket rather than the top ratio: a diagonal where the other
 * side printed almost nothing produces ratios in the hundreds, and a list
 * sorted by raw ratio would then be a list of near-empty levels. Everything
 * at 20× or beyond is equally "one side got no opportunity", so they share a
 * bucket and are ordered by volume within it, which is what distinguishes a
 * meaningful print from a rounding artefact.
 */
export const IMBALANCE_TIERS = [3, 5, 10, 15, 20] as const;

function tierOf(ratio: number): number {
  let tier: number = IMBALANCE_TIERS[0];
  for (const t of IMBALANCE_TIERS) if (ratio >= t) tier = t;
  return tier;
}

/**
 * Every imbalanced level in the footprint, strongest first.
 *
 * The grid already colours these, but reading them off it means scanning a
 * matrix for highlighted cells across dozens of bars. As a list they answer
 * the question directly — *where* is one side being given no opportunity to
 * fill, and how badly — which is the whole point of watching imbalance.
 */
export function collectImbalanceLevels(
  footprint: FootprintResult,
  opts: { bars?: number; limit?: number } = {}
): { buy: ImbalanceLevel[]; sell: ImbalanceLevel[] } {
  const bars = opts.bars ?? 12;
  const limit = opts.limit ?? 20;
  const out: ImbalanceLevel[] = [];

  for (const candle of footprint.candles.slice(-bars)) {
    for (const cell of candle.cells) {
      if (!cell.imbalance || cell.imbalanceRatio <= 0) continue;
      const stacked = candle.stackedImbalances.some(
        (s) =>
          s.direction === cell.imbalance &&
          cell.price >= Math.min(s.fromPrice, s.toPrice) &&
          cell.price <= Math.max(s.fromPrice, s.toPrice)
      );
      out.push({
        time: candle.time,
        price: cell.price,
        side: cell.imbalance,
        ratio: Number(cell.imbalanceRatio.toFixed(2)),
        tier: tierOf(cell.imbalanceRatio),
        volume: cell.imbalance === "buy" ? cell.askVolume : cell.bidVolume,
        stacked,
      });
    }
  }

  // Tier first, then volume — see the note on IMBALANCE_TIERS for why raw
  // ratio is the wrong sort key at the top end.
  const rank = (a: ImbalanceLevel, b: ImbalanceLevel) =>
    b.tier - a.tier || b.volume - a.volume || b.time - a.time;

  return {
    buy: out.filter((l) => l.side === "buy").sort(rank).slice(0, limit),
    sell: out.filter((l) => l.side === "sell").sort(rank).slice(0, limit),
  };
}
