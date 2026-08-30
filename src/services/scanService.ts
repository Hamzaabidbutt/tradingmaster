import { cacheGet, cacheSet } from "@/lib/cache";
import { fetchAllTickers, fetchKlines, fetchOpenInterestHist } from "@/lib/binance";
import { fetchFuturesSymbols } from "@/lib/symbols";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/db";
import { Timeframe } from "@/lib/config";
import { analyzeChart } from "@/engines/chartAnalyst";
import { analyzeCandleCloseExpansion } from "@/engines/candleCloseExpansion";
import { analyzeRangeTrading } from "@/engines/rangeTrading";
import { evaluateConfluence } from "@/engines/confluence";
import { detectAccumulation } from "@/engines/accumulation";
import { detectZoneReversal } from "@/engines/zoneReversal";
import { detectLiquidationReversal } from "@/engines/liquidationReversal";
import { detectCascadeRisk } from "@/engines/cascadeRisk";
import { detectBullishEngulfing } from "@/engines/engulfing";
import { detectInstitutional } from "@/engines/institutional";
import { analyzeMarket } from "@/engines/analyzer";
import { evaluateStrategies } from "@/engines/strategies";
import { getStrategyWeights } from "./signalService";
import {
  AccumulationSetup,
  Bias,
  CascadeRiskSetup,
  EngulfingSetup,
  InstitutionalSetup,
  ConfluenceSetup,
  LiquidationReversalSetup,
  TradeSetup,
  ZoneReversalSetup,
} from "@/engines/types";

/**
 * Universe scanner — finds the best setups across every USDT perpetual.
 *
 * The terminal answers "what is this coin doing?". This answers the question
 * the terminal structurally cannot: "of everything trading right now, where is
 * the strongest setup, long or short?"
 *
 * Two costs govern every decision in this file:
 *
 *  * **Binance weight.** `/fapi/v1/klines` is charged by the `limit`
 *    parameter, not per call: 1 for under 100 bars, **2 for 100–499**, 5 for
 *    500–1000, 10 above that. At `SCAN_BARS = 400` a full sweep of the ~530
 *    perpetuals is therefore ~1060 weight against a ~2400/min IP budget, which
 *    fits. An earlier version of this comment assumed 10 per call — 5300, over
 *    budget — and that single wrong number is why the sweep was capped at 100
 *    symbols. Raising `SCAN_BARS` past 499 would more than double the weight
 *    and put a full sweep back over the line, so that constant and this depth
 *    are coupled.
 *  * **CPU and wall clock.** `analyzeMarket()` is pure and synchronous — its
 *    optional sub-candle, minute and deep-history arguments are what cost
 *    network, and the scanners pass none of them. So the ceiling on a full
 *    sweep is CPU and the serverless function's own time limit, not Binance.
 *    Confluence needs three engines, the composite read needs about twenty-five;
 *    both run off the same single klines call per symbol.
 */

/**
 * Bars per symbol. Enough for the analogue search and range detection.
 *
 * Kept under 500 deliberately: at 500 the per-call Binance weight jumps from
 * 2 to 5 and a full-universe sweep stops fitting in the rate budget.
 */
const SCAN_BARS = 400;
/**
 * Concurrent symbol scans.
 *
 * Twelve at weight 2 is 24 weight in flight — trivial against the budget — and
 * it is what keeps a full ~530-symbol sweep inside the function time limit.
 * The ceiling here is latency, not rate limiting.
 */
const DEFAULT_CONCURRENCY = 12;
/**
 * On-demand depth for a page load. Zero means the whole ranked universe.
 *
 * Full coverage is the default because partial coverage silently changes the
 * answer: "the strongest setup in the top 100 by volume" is a different claim
 * from "the strongest setup available", and the board never said which it was
 * showing.
 */
export const DEFAULT_SCAN_DEPTH = 0;

/** Apply a depth limit, where 0 (or anything non-positive) means "all". */
export function takeDepth<T>(ranked: T[], depth: number | undefined): T[] {
  return depth != null && depth > 0 ? ranked.slice(0, depth) : ranked;
}
/** Scan cache TTL — a setup does not change meaningfully inside 3 minutes. */
const SCAN_TTL_MS = 180_000;

export interface RankedSymbol {
  symbol: string;
  label: string;
  quoteVolume: number;
  lastPrice: number;
  priceChangePercent: number;
}

export interface ScanEntry {
  symbol: string;
  label: string;
  timeframe: string;
  quoteVolume: number;
  /**
   * 24h change at scan time, or null when it is not known — a persisted row
   * written before the column existed. Null prints as "—"; a 0 would claim the
   * coin is flat.
   */
  priceChangePercent: number | null;
  setup: ConfluenceSetup;
}

export interface UniverseScan {
  timeframe: string;
  /** qualifying LONG setups, strongest first */
  long: ScanEntry[];
  /** qualifying SHORT setups, strongest first */
  short: ScanEntry[];
  /** the strongest non-qualifying setups, with the reason each fell short */
  nearMisses: ScanEntry[];
  /**
   * Every symbol this pass evaluated, including the NO_TRADE results that were
   * dropped from the board.
   *
   * The board keeps only the qualifying setups and three near misses, so it is
   * not a record of what was looked at. `mergeScans` needs that record: a live
   * NO_TRADE is a *result*, and without the full list a persisted row from ten
   * minutes ago would put a coin back on the board that the fresh scan had just
   * rejected.
   */
  scannedSymbols: string[];
  noTradeCount: number;
  scanned: number;
  failed: number;
  /** true when at least one symbol errored — coverage is incomplete */
  partial: boolean;
  coverage: { onDemand: number; persisted: number; universe: number };
  minConfidence: number;
  scannedAt: number;
}

/**
 * Rank the tradable universe by 24 h quote volume.
 *
 * Volume order is what makes a truncated sweep acceptable: whatever prefix
 * gets scanned is the part anyone would actually trade. Ranking by symbol name
 * instead would put AAVE ahead of BTC.
 */
export async function rankUniverse(): Promise<RankedSymbol[]> {
  const [symbols, tickers] = await Promise.all([fetchFuturesSymbols(), fetchAllTickers()]);
  const ranked: RankedSymbol[] = [];
  for (const s of symbols) {
    const t = tickers.get(s.symbol);
    if (!t) continue;
    ranked.push({
      symbol: s.symbol,
      label: s.label,
      quoteVolume: t.quoteVolume,
      lastPrice: t.lastPrice,
      priceChangePercent: t.priceChangePercent,
    });
  }
  ranked.sort((a, b) => b.quoteVolume - a.quoteVolume);
  return ranked;
}

/**
 * Evaluate one symbol: one klines call, three independent analysts, one
 * confluence verdict.
 *
 * The three analysts receive no deep history here (`null`), unlike the
 * terminal which pages in 3000 bars. That is a deliberate trade: the analogue
 * search finds fewer precedents from 400 bars, so the Chart Analyst's
 * confidence is lower and it abstains more often on a scan than it would on
 * the terminal. Under-claiming across 500 symbols is the right side to err on.
 */
export async function scanSymbol(
  symbol: string,
  timeframe: Timeframe,
  minConfidence?: number
): Promise<ConfluenceSetup> {
  const candles = await fetchKlines(symbol, timeframe, SCAN_BARS);
  const price = candles[candles.length - 1]?.close ?? 0;
  const chart = analyzeChart(candles, null);
  const candleClose = analyzeCandleCloseExpansion(candles, timeframe, null);
  const range = analyzeRangeTrading(candles);
  return evaluateConfluence(symbol, timeframe, price, chart, candleClose, range, minConfidence);
}

/**
 * Wall-clock budget for one sweep.
 *
 * The hosting platform kills a function at `maxDuration` with no chance to
 * respond, which turns a sweep that ran slightly long into a failed request and
 * an empty board. Stopping ourselves a few seconds short instead means the
 * caller gets whatever was covered, honestly labelled, plus the persisted rows
 * to fill the rest. Volume-ranked order is what makes the truncated prefix the
 * useful one.
 */
const SCAN_BUDGET_MS = 50_000;

/**
 * Run `worker` over `items` with at most `limit` in flight, within a deadline.
 *
 * Items not reached before the deadline come back as `undefined` rather than
 * as a rejection: "we ran out of time" is a different fact from "this symbol
 * failed", and conflating them would report a healthy sweep as broken.
 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
  budgetMs = SCAN_BUDGET_MS
): Promise<(PromiseSettledResult<R> | undefined)[]> {
  // `.fill()` matters: `new Array(n)` is *sparse*, and both `forEach` and
  // `filter` skip holes entirely. Leaving it sparse meant unreached symbols
  // were invisible to every caller — the truncation counter could never fire
  // and a half-finished sweep reported itself as complete.
  const results: (PromiseSettledResult<R> | undefined)[] = new Array(items.length).fill(undefined);
  const deadline = Date.now() + budgetMs;
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    // Each runner pulls the next index until the queue is empty, so one slow
    // symbol never stalls a whole batch the way fixed-size batching does.
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      // Checked before starting work, never mid-flight: abandoning an in-flight
      // request would waste the Binance weight already spent on it.
      if (Date.now() >= deadline) return;
      try {
        results[i] = { status: "fulfilled", value: await worker(items[i]) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

/* ------------------------------------------------------------------ *
 * Accumulation sweep
 * ------------------------------------------------------------------ */

export interface AccumulationEntry {
  symbol: string;
  label: string;
  timeframe: string;
  quoteVolume: number;
  priceChangePercent: number | null;
  setup: AccumulationSetup;
}

export interface AccumulationScan {
  timeframe: string;
  /** qualifying setups, strongest first */
  candidates: AccumulationEntry[];
  /** scored but below threshold — shown so the sweep is auditable */
  forming: AccumulationEntry[];
  scanned: number;
  failed: number;
  scannedAt: number;
  error?: string;
}

/**
 * Sweep the universe for coins building an accumulation base.
 *
 * Separate from `scanUniverse` because it answers a narrower question: not
 * "where is the best setup" but "who is defending a level with real buying
 * behind it". A coin can score poorly on general confluence and still be a
 * textbook accumulation candidate, and vice versa.
 */
export async function scanAccumulation(opts: {
  timeframe: Timeframe;
  depth?: number;
  concurrency?: number;
}): Promise<AccumulationScan> {
  const ranked = takeDepth(await rankUniverse(), opts.depth ?? DEFAULT_SCAN_DEPTH);

  const results = await mapLimit(ranked, opts.concurrency ?? DEFAULT_CONCURRENCY, async (r) => {
    const candles = await fetchKlines(r.symbol, opts.timeframe, SCAN_BARS);
    return {
      symbol: r.symbol,
      label: r.label,
      timeframe: opts.timeframe,
      quoteVolume: r.quoteVolume,
      priceChangePercent: r.priceChangePercent,
      setup: detectAccumulation(r.symbol, opts.timeframe, candles),
    } satisfies AccumulationEntry;
  });

  const entries: AccumulationEntry[] = [];
  let failed = 0;
  for (const res of results) {
    // undefined = the deadline hit before this symbol was reached. Not a
    // failure — counting it as one would report a healthy sweep as broken.
    if (!res) continue;
    if (res.status === "fulfilled") entries.push(res.value);
    else failed++;
  }

  const byScore = (a: AccumulationEntry, b: AccumulationEntry) => b.setup.score - a.setup.score;

  return {
    timeframe: opts.timeframe,
    candidates: entries.filter((e) => e.setup.qualified).sort(byScore),
    forming: entries
      .filter((e) => !e.setup.qualified && e.setup.grade === "forming")
      .sort(byScore)
      .slice(0, 12),
    scanned: entries.length,
    failed,
    scannedAt: Math.floor(Date.now() / 1000),
  };
}

/* ------------------------------------------------------------------ *
 * Zone reversal sweep — reactions from order blocks and FVGs
 * ------------------------------------------------------------------ */

export interface ZoneReversalEntry {
  symbol: string;
  label: string;
  timeframe: string;
  quoteVolume: number;
  priceChangePercent: number | null;
  setup: ZoneReversalSetup;
}

export interface ZoneReversalScan {
  timeframe: string;
  /** confirmed reversals, strongest first */
  bullish: ZoneReversalEntry[];
  bearish: ZoneReversalEntry[];
  /** price inside a zone with no reclaim yet — the setup before it is a setup */
  forming: ZoneReversalEntry[];
  scanned: number;
  failed: number;
  scannedAt: number;
  error?: string;
}

/**
 * Sweep the universe for reactions from order blocks and fair value gaps.
 *
 * Split by direction rather than ranked into one list: a bullish reversal from
 * a demand zone and a bearish one from supply are opposite trades, and a single
 * ranked column would put them side by side as if they were comparable.
 */
export async function scanZoneReversals(opts: {
  timeframe: Timeframe;
  depth?: number;
  concurrency?: number;
}): Promise<ZoneReversalScan> {
  const ranked = takeDepth(await rankUniverse(), opts.depth ?? DEFAULT_SCAN_DEPTH);

  const results = await mapLimit(ranked, opts.concurrency ?? DEFAULT_CONCURRENCY, async (r) => {
    const candles = await fetchKlines(r.symbol, opts.timeframe, SCAN_BARS);
    return {
      symbol: r.symbol,
      label: r.label,
      timeframe: opts.timeframe,
      quoteVolume: r.quoteVolume,
      priceChangePercent: r.priceChangePercent,
      setup: detectZoneReversal(r.symbol, opts.timeframe, candles),
    } satisfies ZoneReversalEntry;
  });

  const entries: ZoneReversalEntry[] = [];
  let failed = 0;
  for (const res of results) {
    // undefined = the deadline hit before this symbol was reached. Not a
    // failure — counting it as one would report a healthy sweep as broken.
    if (!res) continue;
    if (res.status === "fulfilled") entries.push(res.value);
    else failed++;
  }

  const byScore = (a: ZoneReversalEntry, b: ZoneReversalEntry) => b.setup.score - a.setup.score;
  const qualified = entries.filter((e) => e.setup.qualified);

  return {
    timeframe: opts.timeframe,
    bullish: qualified.filter((e) => e.setup.direction === "bullish").sort(byScore),
    bearish: qualified.filter((e) => e.setup.direction === "bearish").sort(byScore),
    forming: entries
      .filter((e) => !e.setup.qualified && e.setup.grade === "forming")
      .sort(byScore)
      .slice(0, 12),
    scanned: entries.length,
    failed,
    scannedAt: Math.floor(Date.now() / 1000),
  };
}

/* ------------------------------------------------------------------ *
 * Liquidation spike reversal sweep
 * ------------------------------------------------------------------ */

export interface LiquidationReversalEntry {
  symbol: string;
  label: string;
  timeframe: string;
  quoteVolume: number;
  priceChangePercent: number | null;
  setup: LiquidationReversalSetup;
}

export interface LiquidationReversalScan {
  timeframe: string;
  /** long flushes at the low — forced selling exhausted */
  bottoms: LiquidationReversalEntry[];
  /** short squeezes at the high — forced buying exhausted */
  tops: LiquidationReversalEntry[];
  /** spiked, but mid-move or without a reversal yet */
  watching: LiquidationReversalEntry[];
  scanned: number;
  failed: number;
  scannedAt: number;
  error?: string;
}

/**
 * Sweep for coins where a liquidation delta spike has just printed at an
 * extreme, and report the reversal it produced.
 *
 * Nothing here reads a forced-order feed: a universe sweep has no websocket per
 * symbol, so `setup.forced` comes back as `inferred` at best. That is carried in
 * the data rather than hidden, because a cascade inferred from a candle and one
 * observed in the tape are different-sized bets.
 */
export async function scanLiquidationReversals(opts: {
  timeframe: Timeframe;
  depth?: number;
  concurrency?: number;
}): Promise<LiquidationReversalScan> {
  const ranked = takeDepth(await rankUniverse(), opts.depth ?? DEFAULT_SCAN_DEPTH);

  const results = await mapLimit(ranked, opts.concurrency ?? DEFAULT_CONCURRENCY, async (r) => {
    const candles = await fetchKlines(r.symbol, opts.timeframe, SCAN_BARS);
    return {
      symbol: r.symbol,
      label: r.label,
      timeframe: opts.timeframe,
      quoteVolume: r.quoteVolume,
      priceChangePercent: r.priceChangePercent,
      setup: detectLiquidationReversal(r.symbol, opts.timeframe, candles),
    } satisfies LiquidationReversalEntry;
  });

  const entries: LiquidationReversalEntry[] = [];
  let failed = 0;
  for (const res of results) {
    // undefined = the deadline hit before this symbol was reached. Not a
    // failure — counting it as one would report a healthy sweep as broken.
    if (!res) continue;
    if (res.status === "fulfilled") entries.push(res.value);
    else failed++;
  }

  /**
   * Newest spike first.
   *
   * Ranking by score would bury a cascade that printed two minutes ago under
   * a stronger one from an hour back — and for an event whose whole value is
   * catching the reversal, recency *is* the ranking. Score ties are broken by
   * score so the order is total and stable.
   */
  const byRecency = (a: LiquidationReversalEntry, b: LiquidationReversalEntry) => {
    const at = a.setup.spike?.time ?? 0;
    const bt = b.setup.spike?.time ?? 0;
    return bt - at || b.setup.score - a.setup.score;
  };
  const byScore = (a: LiquidationReversalEntry, b: LiquidationReversalEntry) =>
    b.setup.score - a.setup.score;
  const qualified = entries.filter((e) => e.setup.qualified);

  return {
    timeframe: opts.timeframe,
    bottoms: qualified.filter((e) => e.setup.location === "bottom").sort(byRecency),
    tops: qualified.filter((e) => e.setup.location === "top").sort(byRecency),
    // A spike that has not reversed is still worth seeing — it is the same
    // event one bar earlier, and hiding it would mean the panel only ever
    // shows moves that already happened.
    watching: entries
      .filter((e) => !e.setup.qualified && e.setup.spike !== null && e.setup.forced !== "unlikely")
      .sort(byScore)
      .slice(0, 12),
    scanned: entries.length,
    failed,
    scannedAt: Math.floor(Date.now() / 1000),
  };
}

/* ------------------------------------------------------------------ *
 * Cascade risk sweep
 * ------------------------------------------------------------------ */

export interface CascadeRiskEntry {
  symbol: string;
  label: string;
  timeframe: string;
  quoteVolume: number;
  priceChangePercent: number | null;
  setup: CascadeRiskSetup;
}

export interface CascadeRiskScan {
  timeframe: string;
  /** crowded longs with a trigger below — a flush would start there */
  longFlush: CascadeRiskEntry[];
  /** crowded shorts with a trigger above */
  shortSqueeze: CascadeRiskEntry[];
  /** loaded but not yet close enough, or fuel draining */
  forming: CascadeRiskEntry[];
  scanned: number;
  failed: number;
  scannedAt: number;
  error?: string;
}

/**
 * Sweep for coins where the conditions for a cascade are loaded.
 *
 * Costs one extra request per symbol over the other sweeps: open interest is
 * the only public series that says which side is crowded, and without it the
 * scan can locate triggers but cannot tell you whether anything is resting on
 * them. Depth defaults lower here for that reason.
 *
 * Nothing in the result claims a cascade *will* happen — see the header of
 * `cascadeRisk.ts`. The lists are ordered by how loaded the setup is.
 */
export async function scanCascadeRisk(opts: {
  timeframe: Timeframe;
  depth?: number;
  concurrency?: number;
}): Promise<CascadeRiskScan> {
  const ranked = takeDepth(await rankUniverse(), opts.depth ?? 60);

  const results = await mapLimit(ranked, opts.concurrency ?? DEFAULT_CONCURRENCY, async (r) => {
    const [candles, oi] = await Promise.all([
      fetchKlines(r.symbol, opts.timeframe, SCAN_BARS),
      // Best-effort: a symbol with no OI history still yields trigger levels,
      // and the engine reports the positioning read as unknown rather than
      // inventing one.
      fetchOpenInterestHist(r.symbol, "15m", 48).catch(() => []),
    ]);
    return {
      symbol: r.symbol,
      label: r.label,
      timeframe: opts.timeframe,
      quoteVolume: r.quoteVolume,
      priceChangePercent: r.priceChangePercent,
      setup: detectCascadeRisk(
        r.symbol,
        opts.timeframe,
        candles,
        oi.length > 0 ? oi.map((p) => p.openInterest) : null
      ),
    } satisfies CascadeRiskEntry;
  });

  const entries: CascadeRiskEntry[] = [];
  let failed = 0;
  for (const res of results) {
    // undefined = the deadline hit before this symbol was reached. Not a
    // failure — counting it as one would report a healthy sweep as broken.
    if (!res) continue;
    if (res.status === "fulfilled") entries.push(res.value);
    else failed++;
  }

  const byScore = (a: CascadeRiskEntry, b: CascadeRiskEntry) => b.setup.score - a.setup.score;
  const qualified = entries.filter((e) => e.setup.qualified);

  return {
    timeframe: opts.timeframe,
    longFlush: qualified.filter((e) => e.setup.side === "long").sort(byScore),
    shortSqueeze: qualified.filter((e) => e.setup.side === "short").sort(byScore),
    forming: entries
      .filter((e) => !e.setup.qualified && e.setup.grade === "forming")
      .sort(byScore)
      .slice(0, 12),
    scanned: entries.length,
    failed,
    scannedAt: Math.floor(Date.now() / 1000),
  };
}

/* ------------------------------------------------------------------ *
 * Bullish engulfing sweep
 * ------------------------------------------------------------------ */

export interface EngulfingEntry {
  symbol: string;
  label: string;
  timeframe: string;
  quoteVolume: number;
  priceChangePercent: number | null;
  setup: EngulfingSetup;
}

export interface EngulfingScan {
  timeframe: string;
  /** engulfing bars that also cleared the confirmation checks */
  confirmed: EngulfingEntry[];
  /** the pattern printed, but flow or location did not back it */
  unconfirmed: EngulfingEntry[];
  scanned: number;
  failed: number;
  scannedAt: number;
  error?: string;
}

/**
 * Sweep for bullish engulfing bars on the last closed candle.
 *
 * Defaults to 4h, which is the timeframe the pattern is worth scanning on: on
 * 5m every coin prints one every hour and the list is noise.
 */
export async function scanEngulfing(opts: {
  timeframe: Timeframe;
  depth?: number;
  concurrency?: number;
}): Promise<EngulfingScan> {
  const ranked = takeDepth(await rankUniverse(), opts.depth ?? DEFAULT_SCAN_DEPTH);

  const results = await mapLimit(ranked, opts.concurrency ?? DEFAULT_CONCURRENCY, async (r) => {
    const candles = await fetchKlines(r.symbol, opts.timeframe, SCAN_BARS);
    return {
      symbol: r.symbol,
      label: r.label,
      timeframe: opts.timeframe,
      quoteVolume: r.quoteVolume,
      priceChangePercent: r.priceChangePercent,
      setup: detectBullishEngulfing(r.symbol, opts.timeframe, candles),
    } satisfies EngulfingEntry;
  });

  const entries: EngulfingEntry[] = [];
  let failed = 0;
  for (const res of results) {
    // undefined = the deadline hit before this symbol was reached. Not a
    // failure — counting it as one would report a healthy sweep as broken.
    if (!res) continue;
    if (res.status === "fulfilled") entries.push(res.value);
    else failed++;
  }

  const byScore = (a: EngulfingEntry, b: EngulfingEntry) => b.setup.score - a.setup.score;
  const engulfed = entries.filter((e) => e.setup.engulfed);

  return {
    timeframe: opts.timeframe,
    confirmed: engulfed.filter((e) => e.setup.qualified).sort(byScore),
    // Kept rather than dropped: "the pattern is there and the flow is not" is
    // the more common case, and seeing it is how the filter earns its keep.
    unconfirmed: engulfed.filter((e) => !e.setup.qualified).sort(byScore).slice(0, 15),
    scanned: entries.length,
    failed,
    scannedAt: Math.floor(Date.now() / 1000),
  };
}

/* ------------------------------------------------------------------ *
 * Institutional footprint sweep
 * ------------------------------------------------------------------ */

export interface InstitutionalEntry {
  symbol: string;
  label: string;
  timeframe: string;
  quoteVolume: number;
  priceChangePercent: number | null;
  setup: InstitutionalSetup;
}

export interface InstitutionalScan {
  timeframe: string;
  /** several kinds of evidence converging on one area */
  footprints: InstitutionalEntry[];
  /** evidence present but scattered, or too few kinds */
  forming: InstitutionalEntry[];
  scanned: number;
  failed: number;
  scannedAt: number;
  error?: string;
}

/**
 * Sweep for coins showing an institutional footprint.
 *
 * The most expensive sweep in the app: eleven engines plus an open-interest
 * request per symbol. Depth defaults lower than the others for that reason,
 * and the timeframe defaults to 4h because size is worked over hours, not
 * minutes — the same evidence on a 5m chart is mostly noise.
 */
export async function scanInstitutional(opts: {
  timeframe: Timeframe;
  depth?: number;
  concurrency?: number;
}): Promise<InstitutionalScan> {
  const ranked = takeDepth(await rankUniverse(), opts.depth ?? 50);

  const results = await mapLimit(ranked, opts.concurrency ?? DEFAULT_CONCURRENCY, async (r) => {
    const [candles, oi] = await Promise.all([
      fetchKlines(r.symbol, opts.timeframe, SCAN_BARS),
      fetchOpenInterestHist(r.symbol, "1h", 48).catch(() => []),
    ]);
    return {
      symbol: r.symbol,
      label: r.label,
      timeframe: opts.timeframe,
      quoteVolume: r.quoteVolume,
      priceChangePercent: r.priceChangePercent,
      setup: detectInstitutional(
        r.symbol,
        opts.timeframe,
        candles,
        oi.length > 0 ? oi.map((p) => p.openInterest) : null
      ),
    } satisfies InstitutionalEntry;
  });

  const entries: InstitutionalEntry[] = [];
  let failed = 0;
  for (const res of results) {
    // undefined = the deadline hit before this symbol was reached. Not a
    // failure — counting it as one would report a healthy sweep as broken.
    if (!res) continue;
    if (res.status === "fulfilled") entries.push(res.value);
    else failed++;
  }

  const byScore = (a: InstitutionalEntry, b: InstitutionalEntry) => b.setup.score - a.setup.score;

  return {
    timeframe: opts.timeframe,
    footprints: entries.filter((e) => e.setup.qualified).sort(byScore),
    forming: entries
      .filter((e) => !e.setup.qualified && e.setup.grade === "forming")
      .sort(byScore)
      .slice(0, 12),
    scanned: entries.length,
    failed,
    scannedAt: Math.floor(Date.now() / 1000),
  };
}

/* ------------------------------------------------------------------ *
 * Composite sweep — the weighted 28-strategy ensemble, per coin
 * ------------------------------------------------------------------ */

export interface CompositeEntry {
  symbol: string;
  label: string;
  timeframe: string;
  quoteVolume: number;
  priceChangePercent: number | null;
  price: number;
  bias: Bias;
  bullishProbability: number;
  /** null when the composite found nothing tradable — the common case */
  setup: TradeSetup | null;
  /** the strategies that carried the read, strongest contribution first */
  topStrategies: { key: string; name: string; score: number; weight: number }[];
}

export interface CompositeScan {
  timeframe: string;
  long: CompositeEntry[];
  short: CompositeEntry[];
  /** scored, directional, but produced no setup that cleared the threshold */
  watching: CompositeEntry[];
  scanned: number;
  failed: number;
  scannedAt: number;
  error?: string;
}

/**
 * Run the full composite engine across the universe.
 *
 * The dashboard's board is built from the three independent analysts agreeing
 * (`evaluateConfluence`), which is a deliberately narrow question and stays
 * silent on most coins. This answers the other one: what does the weighted
 * 28-strategy ensemble — structure, order flow, footprint, volume profile,
 * delta, liquidity, liquidations, patterns and the rest — conclude on its own?
 *
 * The two are genuinely different reads, not the same number twice. Confluence
 * abstains unless several *independent kinds* of evidence agree; the composite
 * always has an opinion, weighted by how much each strategy contributed. A
 * coin can be a strong composite setup with no confluence at all, and that is
 * information rather than a contradiction.
 *
 * Cost is one klines call per symbol, the same as the confluence sweep:
 * `analyzeMarket` is pure and synchronous, and its network-bearing optional
 * arguments (sub-candles, minute candles, deep history) are the terminal's,
 * not the scanner's. What it costs instead is CPU — about twenty-five engines
 * per symbol rather than three.
 */
export async function scanComposite(opts: {
  timeframe: Timeframe;
  depth?: number;
  concurrency?: number;
  minConfidence?: number;
}): Promise<CompositeScan> {
  const ranked = takeDepth(await rankUniverse(), opts.depth ?? DEFAULT_SCAN_DEPTH);
  const weights = await getStrategyWeights().catch(() => ({}));

  const results = await mapLimit(ranked, opts.concurrency ?? DEFAULT_CONCURRENCY, async (r) => {
    const candles = await fetchKlines(r.symbol, opts.timeframe, SCAN_BARS);
    const analysis = analyzeMarket(r.symbol, opts.timeframe, candles, {
      weights,
      minConfidence: opts.minConfidence,
    });
    return {
      symbol: r.symbol,
      label: r.label,
      timeframe: opts.timeframe,
      quoteVolume: r.quoteVolume,
      priceChangePercent: r.priceChangePercent,
      price: analysis.price,
      bias: analysis.bias,
      bullishProbability: analysis.bullishProbability,
      setup: analysis.setup,
      // Computed here rather than read off `setup.strategyScores`, which does
      // not exist when the composite declined to produce a setup — and those
      // are exactly the rows where "what is it seeing, then?" is the question.
      //
      // Ranked by actual contribution — score times weight — rather than raw
      // score, so a strategy the user has down-weighted cannot present itself
      // as the reason for a signal it barely moved.
      topStrategies: [...evaluateStrategies(analysis, weights)]
        .filter((s) => s.weight > 0 && s.score !== 0)
        .sort((a, b) => Math.abs(b.score * b.weight) - Math.abs(a.score * a.weight))
        .slice(0, 5)
        .map((s) => ({ key: s.key, name: s.name, score: s.score, weight: s.weight })),
    } satisfies CompositeEntry;
  });

  const entries: CompositeEntry[] = [];
  let failed = 0;
  for (const res of results) {
    // undefined = the deadline hit before this symbol was reached. Not a
    // failure — counting it as one would report a healthy sweep as broken.
    if (!res) continue;
    if (res.status === "fulfilled") entries.push(res.value);
    else failed++;
  }

  const byConfidence = (a: CompositeEntry, b: CompositeEntry) =>
    (b.setup?.confidence ?? 0) - (a.setup?.confidence ?? 0);
  const withSetup = entries.filter((e) => e.setup !== null);

  return {
    timeframe: opts.timeframe,
    long: withSetup.filter((e) => e.setup!.side === "BUY").sort(byConfidence),
    short: withSetup.filter((e) => e.setup!.side === "SELL").sort(byConfidence),
    // Directional but with no setup: the ensemble leans one way and the
    // geometry did not justify a trade. Shown rather than dropped, because
    // "leaning long, nothing tradable yet" is a real state.
    watching: entries
      .filter((e) => e.setup === null && e.bias !== "neutral")
      .sort((a, b) => Math.abs(b.bullishProbability - 50) - Math.abs(a.bullishProbability - 50))
      .slice(0, 20),
    scanned: entries.length,
    failed,
    scannedAt: Math.floor(Date.now() / 1000),
  };
}

export interface ScanOptions {
  timeframe: Timeframe;
  depth?: number;
  concurrency?: number;
  minConfidence?: number;
  /** skip the cache — used by the worker, which persists what it scans */
  fresh?: boolean;
}

/**
 * Scan the universe by volume rank and sort the qualifying setups.
 *
 * `depth` of 0 — the default — means every symbol. Volume order still matters
 * with full coverage: it decides which symbols are reached first, so a sweep
 * cut short by the function time limit has still covered the ones anyone would
 * trade.
 *
 * A symbol that fails (delisted mid-scan, thin history, Binance hiccup) is
 * counted in `failed` and the sweep continues. An aborted sweep would mean an
 * empty dashboard because one obscure contract had no candles.
 */
export async function scanUniverse(opts: ScanOptions): Promise<UniverseScan> {
  const depth = opts.depth ?? DEFAULT_SCAN_DEPTH;
  const cacheKey = `scan:${opts.timeframe}:${depth}:${opts.minConfidence ?? "default"}`;
  if (!opts.fresh) {
    const cached = cacheGet<UniverseScan>(cacheKey);
    if (cached) return cached;
  }

  const ranked = await rankUniverse();
  const slice = takeDepth(ranked, depth);

  const settled = await mapLimit(slice, opts.concurrency ?? DEFAULT_CONCURRENCY, (r) =>
    scanSymbol(r.symbol, opts.timeframe, opts.minConfidence)
  );

  const entries: ScanEntry[] = [];
  let failed = 0;
  let unreached = 0;
  settled.forEach((res, i) => {
    // undefined = the sweep ran out of its time budget before reaching this
    // symbol. Distinct from a failure, and reported as coverage rather than as
    // an error: the persisted rows below fill the gap.
    if (!res) {
      unreached++;
      return;
    }
    if (res.status !== "fulfilled") {
      failed++;
      logger.warn("scan.symbol.failed", { symbol: slice[i].symbol, error: String(res.reason) });
      return;
    }
    entries.push({
      symbol: slice[i].symbol,
      label: slice[i].label,
      timeframe: opts.timeframe,
      quoteVolume: slice[i].quoteVolume,
      priceChangePercent: slice[i].priceChangePercent,
      setup: res.value,
    });
  });

  if (unreached > 0) {
    logger.info("scan.budget.truncated", {
      timeframe: opts.timeframe,
      scanned: entries.length,
      unreached,
      universe: ranked.length,
    });
  }

  const scan = assembleScan(entries, {
    timeframe: opts.timeframe,
    minConfidence: opts.minConfidence ?? inferThreshold(entries),
    failed,
    coverage: { onDemand: entries.length, persisted: 0, universe: ranked.length },
  });

  cacheSet(cacheKey, scan, SCAN_TTL_MS);
  return scan;
}

/**
 * Recover the confidence threshold the engine actually applied.
 *
 * The threshold lives in `evaluateConfluence` (env-configurable), so rather
 * than duplicate the default here — where it could drift — read it back off a
 * NO_TRADE reason. Falls back to 70 when no setup was rejected on confidence.
 */
function inferThreshold(entries: ScanEntry[]): number {
  for (const e of entries) {
    const m = e.setup.noTradeReason?.match(/below the (\d+(?:\.\d+)?)% confluence threshold/);
    if (m) return Number(m[1]);
  }
  return 70;
}

/** Sort, split and summarise a set of scanned entries. */
export function assembleScan(
  entries: ScanEntry[],
  meta: {
    timeframe: string;
    minConfidence: number;
    failed: number;
    coverage: { onDemand: number; persisted: number; universe: number };
  }
): UniverseScan {
  const byConfidence = (a: ScanEntry, b: ScanEntry) => b.setup.confidence - a.setup.confidence;

  const long = entries.filter((e) => e.setup.decision === "LONG").sort(byConfidence);
  const short = entries.filter((e) => e.setup.decision === "SHORT").sort(byConfidence);
  const noTrade = entries.filter((e) => e.setup.decision === "NO_TRADE");

  // Near misses exist so an empty board is informative rather than blank: the
  // three closest calls and exactly why each was rejected. Only setups that
  // had *some* qualified analyst are interesting; a coin where all three
  // abstained is noise.
  const nearMisses = noTrade
    .filter((e) => e.setup.verdicts.some((v) => v.qualified))
    .sort(byConfidence)
    .slice(0, 3);

  return {
    timeframe: meta.timeframe,
    long,
    short,
    nearMisses,
    scannedSymbols: entries.map((e) => e.symbol),
    noTradeCount: noTrade.length,
    scanned: entries.length,
    failed: meta.failed,
    partial: meta.failed > 0,
    coverage: meta.coverage,
    minConfidence: meta.minConfidence,
    scannedAt: Math.floor(Date.now() / 1000),
  };
}

/**
 * Upsert scan results, keyed on symbol+timeframe.
 *
 * Upsert rather than insert: the worker revisits every symbol every few
 * minutes, and an append-only history of "BTC had no setup" rows would grow
 * without bound while only the latest row is ever read.
 *
 * Best-effort — a database outage must not stop the scan from returning.
 */
export async function persistScan(entries: ScanEntry[]): Promise<number> {
  let written = 0;
  for (const e of entries) {
    try {
      const row = {
        symbol: e.symbol,
        timeframe: e.timeframe,
        decision: e.setup.decision,
        confidence: e.setup.confidence,
        price: e.setup.price,
        quoteVolume: e.quoteVolume,
        priceChangePct: e.priceChangePercent,
        setup: e.setup as unknown as object,
      };
      await prisma.scanResult.upsert({
        where: { symbol_timeframe: { symbol: e.symbol, timeframe: e.timeframe } },
        update: { ...row, scannedAt: new Date() },
        create: row,
      });
      written++;
    } catch (err) {
      logger.warn("scan.persist.failed", { symbol: e.symbol, error: String(err) });
    }
  }
  return written;
}

/**
 * Everything the worker has scanned, for a timeframe.
 *
 * This is what turns the dashboard's on-demand top-100 into whole-universe
 * coverage: the worker sweeps all ~530 symbols in rolling slices, and the page
 * merges those persisted rows with its own live scan.
 */
export async function loadPersistedScan(
  timeframe: string,
  maxAgeMinutes = 30
): Promise<ScanEntry[]> {
  try {
    const cutoff = new Date(Date.now() - maxAgeMinutes * 60_000);
    const rows = await prisma.scanResult.findMany({
      where: { timeframe, scannedAt: { gte: cutoff } },
      orderBy: { confidence: "desc" },
      take: 600,
    });
    return rows.map((r) => ({
      symbol: r.symbol,
      label: r.symbol.replace(/USDT$/, "/USDT"),
      timeframe: r.timeframe,
      quoteVolume: r.quoteVolume,
      priceChangePercent: r.priceChangePct,
      setup: r.setup as unknown as ConfluenceSetup,
    }));
  } catch (err) {
    logger.warn("scan.load.failed", { timeframe, error: String(err) });
    return [];
  }
}

/**
 * Merge a live scan with persisted worker coverage.
 *
 * The live scan wins on conflict: it was computed from candles fetched seconds
 * ago, while a persisted row may be up to `maxAgeMinutes` old.
 */
export function mergeScans(live: UniverseScan, persisted: ScanEntry[]): UniverseScan {
  const liveAll = [...live.long, ...live.short, ...live.nearMisses];
  // Keyed on every symbol the live pass *evaluated*, not just the ones it kept.
  // A coin the fresh scan rejected must stay rejected: taking the persisted row
  // instead would let a stale setup outrank a newer NO_TRADE on the same coin,
  // and would count that symbol twice in the coverage line.
  const seen = new Set([...live.scannedSymbols, ...liveAll.map((e) => e.symbol)]);
  const extra = persisted.filter((e) => !seen.has(e.symbol));

  const merged = assembleScan([...liveAll, ...extra], {
    timeframe: live.timeframe,
    minConfidence: live.minConfidence,
    failed: live.failed,
    coverage: {
      onDemand: live.coverage.onDemand,
      persisted: extra.length,
      universe: live.coverage.universe,
    },
  });
  // `assembleScan` recounts NO_TRADE from the entries it was handed, but the
  // live scan's non-near-miss NO_TRADEs were already dropped. Carry the real
  // figure across so the coverage line stays honest.
  merged.noTradeCount = live.noTradeCount + extra.filter((e) => e.setup.decision === "NO_TRADE").length;
  merged.scanned = live.scanned + extra.length;
  merged.scannedSymbols = [...live.scannedSymbols, ...extra.map((e) => e.symbol)];
  merged.partial = live.partial;
  merged.scannedAt = live.scannedAt;
  return merged;
}
