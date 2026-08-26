import { cacheGet, cacheSet } from "@/lib/cache";
import { fetchAllTickers, fetchKlines } from "@/lib/binance";
import { fetchFuturesSymbols } from "@/lib/symbols";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/db";
import { Timeframe } from "@/lib/config";
import { analyzeChart } from "@/engines/chartAnalyst";
import { analyzeCandleCloseExpansion } from "@/engines/candleCloseExpansion";
import { analyzeRangeTrading } from "@/engines/rangeTrading";
import { evaluateConfluence } from "@/engines/confluence";
import { detectAccumulation } from "@/engines/accumulation";
import { AccumulationSetup, ConfluenceSetup } from "@/engines/types";

/**
 * Universe scanner — finds the best setups across every USDT perpetual.
 *
 * The terminal answers "what is this coin doing?". This answers the question
 * the terminal structurally cannot: "of everything trading right now, where is
 * the strongest setup, long or short?"
 *
 * Two costs govern every decision in this file:
 *
 *  * **Binance weight.** ~530 perpetuals at 10 weight per klines call is 5300
 *    against a ~2400/min IP budget, so a naive full sweep gets the server
 *    rate-limited (429) and then temporarily banned (418). Hence: rank the
 *    universe from a *single* all-tickers call, scan the top N on demand, and
 *    let the worker cover the long tail in rolling slices.
 *  * **CPU per symbol.** `analyzeMarket()` runs ~25 engines and five network
 *    fetches. Confluence needs three engines and one fetch, so `scanSymbol`
 *    calls those three directly. Scanning 100 symbols through the full
 *    orchestrator would be roughly 500 requests; this way it is 100.
 */

/** Bars per symbol. Enough for the analogue search and range detection. */
const SCAN_BARS = 400;
/** Concurrent symbol scans. Six keeps burst weight well inside the budget. */
const DEFAULT_CONCURRENCY = 6;
/** On-demand depth for a page load. */
export const DEFAULT_SCAN_DEPTH = 100;
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
 * Volume order is what makes partial coverage acceptable: if only the first
 * 100 symbols get scanned, those 100 are the ones anyone would actually trade.
 * Ranking by symbol name instead would put AAVE ahead of BTC.
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

/** Run `worker` over `items` with at most `limit` in flight. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    // Each runner pulls the next index until the queue is empty, so one slow
    // symbol never stalls a whole batch the way fixed-size batching does.
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
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
  const depth = opts.depth ?? DEFAULT_SCAN_DEPTH;
  const ranked = (await rankUniverse()).slice(0, depth);

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

export interface ScanOptions {
  timeframe: Timeframe;
  depth?: number;
  concurrency?: number;
  minConfidence?: number;
  /** skip the cache — used by the worker, which persists what it scans */
  fresh?: boolean;
}

/**
 * Scan the top `depth` symbols by volume and sort the qualifying setups.
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
  const slice = ranked.slice(0, depth);

  const settled = await mapLimit(slice, opts.concurrency ?? DEFAULT_CONCURRENCY, (r) =>
    scanSymbol(r.symbol, opts.timeframe, opts.minConfidence)
  );

  const entries: ScanEntry[] = [];
  let failed = 0;
  settled.forEach((res, i) => {
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
