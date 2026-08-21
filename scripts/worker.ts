/**
 * Background worker: continuously analyzes every configured market on key
 * timeframes, persists qualifying signals, evaluates open signals against
 * live prices and feeds outcomes into the learning engine.
 *
 * It also sweeps the *whole* USDT-perpetual universe for confluence setups in
 * rolling slices — the mechanism that turns the dashboard's on-demand top-100
 * into real coverage of every tradable contract.
 *
 * Run alongside the web app:  npm run worker
 * (In docker-compose it runs as its own service.)
 */
import { MARKETS, TIMEFRAME_MINUTES, Timeframe } from "../src/lib/config";
import { logger } from "../src/lib/logger";
import {
  analyzeSymbol,
  ensureStrategyConfigs,
  evaluateOpenSignals,
  maybePersistConfluenceSignal,
  maybePersistSignal,
} from "../src/services/signalService";
import { persistScan, rankUniverse, scanSymbol, ScanEntry } from "../src/services/scanService";
import { prisma } from "../src/lib/db";

const WORKER_TIMEFRAMES: Timeframe[] = ["5m", "15m", "1h", "4h", "1d", "1w"];
const INTERVAL_MS = Number(process.env.WORKER_INTERVAL_SEC ?? 60) * 1000;

/**
 * Longest gap between passes on one timeframe, in minutes.
 *
 * Each timeframe is re-analysed no more often than its own bar length: a 1d
 * setup does not change because 60 seconds passed, and re-running it every tick
 * spends five network fetches per market to recompute an identical answer. The
 * hour cap keeps the daily and weekly passes responsive enough to open a signal
 * within an hour of a bar closing, rather than waiting a full week.
 *
 * Without this, adding 5m/1d/1w would double the composite pass from 21
 * analyses per tick to 42 — and the pass already runs longer than INTERVAL_MS.
 */
const MAX_STAGGER_MIN = 60;

/** Last completed pass per timeframe, as epoch ms. Empty means "never run". */
const lastPassAt = new Map<Timeframe, number>();

/** True when `tf` is due for another pass. */
function isDue(tf: Timeframe, now: number): boolean {
  const last = lastPassAt.get(tf);
  if (last === undefined) return true; // never run — do it on the first tick
  const everyMin = Math.min(TIMEFRAME_MINUTES[tf] ?? 60, MAX_STAGGER_MIN);
  return now - last >= everyMin * 60_000;
}

/** Timeframe the universe sweep runs on. Matches the dashboard default. */
const SCAN_TIMEFRAME: Timeframe = (process.env.SCAN_TIMEFRAME as Timeframe) ?? "1h";
/** Symbols per tick. 40 × weight 10 = 400, comfortably inside the budget. */
const SCAN_SLICE = Number(process.env.SCAN_SLICE ?? 40);

/**
 * Where the next slice starts.
 *
 * Module-level rather than derived from a timestamp so coverage advances
 * strictly: at 40 symbols a minute the ~530-contract universe refreshes about
 * every 13 minutes, and every symbol is visited before any is revisited.
 */
let scanCursor = 0;

async function tick(): Promise<void> {
  // 1) Evaluate open signals first so learning happens before new entries.
  try {
    const { evaluated, closed } = await evaluateOpenSignals();
    if (evaluated > 0) logger.info("worker.evaluated", { evaluated, closed });
  } catch (err) {
    logger.error("worker.evaluate.failed", { error: String(err) });
  }

  // 2) Scan all markets on every timeframe that is due (kind to rate limits).
  const due = WORKER_TIMEFRAMES.filter((tf) => isDue(tf, Date.now()));
  if (due.length > 0) logger.info("worker.pass.due", { timeframes: due });
  for (const market of MARKETS) {
    for (const tf of due) {
      try {
        const analysis = await analyzeSymbol(market.symbol, tf);
        const id = await maybePersistSignal(analysis);
        if (id) logger.info("worker.signal", { symbol: market.symbol, tf, id });

        // Persist a lightweight snapshot for historical audit.
        await prisma.marketSnapshot
          .create({
            data: {
              symbol: market.symbol,
              timeframe: tf,
              price: analysis.price,
              data: {
                bias: analysis.bias,
                bullishProbability: analysis.bullishProbability,
                trend: analysis.structure.trend,
                cvd: analysis.orderFlow.cumulativeDelta,
              },
            },
          })
          .catch(() => undefined);
      } catch (err) {
        logger.warn("worker.analysis.failed", { symbol: market.symbol, tf, error: String(err) });
      }
      await sleep(400); // stay well inside Binance API weight limits
    }
  }
  // Stamped after the pass, not before, so a slow sweep does not immediately
  // become due again on the next tick.
  const finishedAt = Date.now();
  for (const tf of due) lastPassAt.set(tf, finishedAt);

  // 3) Rolling universe sweep for confluence setups.
  await scanUniverseSlice();
}

/**
 * Scan the next slice of the volume-ranked universe.
 *
 * Sequential with a short pause rather than concurrent: the worker shares its
 * IP weight budget with the web app, and unlike a page load it has no deadline
 * — there is nothing to gain from bursting.
 */
async function scanUniverseSlice(): Promise<void> {
  let ranked;
  try {
    ranked = await rankUniverse();
  } catch (err) {
    logger.warn("worker.scan.rank_failed", { error: String(err) });
    return;
  }
  if (ranked.length === 0) return;

  if (scanCursor >= ranked.length) scanCursor = 0;
  const slice = ranked.slice(scanCursor, scanCursor + SCAN_SLICE);
  const start = scanCursor;
  scanCursor += slice.length;

  const entries: ScanEntry[] = [];
  let signals = 0;
  let failed = 0;

  for (const r of slice) {
    try {
      const setup = await scanSymbol(r.symbol, SCAN_TIMEFRAME);
      entries.push({
        symbol: r.symbol,
        label: r.label,
        timeframe: SCAN_TIMEFRAME,
        quoteVolume: r.quoteVolume,
        priceChangePercent: r.priceChangePercent,
        setup,
      });
      // NO_TRADE is the common case and returns null — most symbols have
      // nothing worth trading, which is the point of scanning them.
      const id = await maybePersistConfluenceSignal(setup, {
        quoteVolume: r.quoteVolume,
        priceChangePercent: r.priceChangePercent,
      });
      if (id) {
        signals++;
        logger.info("worker.confluence_signal", {
          symbol: r.symbol,
          decision: setup.decision,
          confidence: setup.confidence,
          id,
        });
      }
    } catch (err) {
      failed++;
      logger.warn("worker.scan.symbol_failed", { symbol: r.symbol, error: String(err) });
    }
    await sleep(250);
  }

  const written = await persistScan(entries);
  logger.info("worker.scan.slice", {
    timeframe: SCAN_TIMEFRAME,
    range: `${start}-${start + slice.length}`,
    universe: ranked.length,
    scanned: entries.length,
    failed,
    signals,
    persisted: written,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  logger.info("worker.start", {
    markets: MARKETS.length,
    timeframes: WORKER_TIMEFRAMES,
    intervalMs: INTERVAL_MS,
    scanTimeframe: SCAN_TIMEFRAME,
    scanSlice: SCAN_SLICE,
  });
  try {
    await ensureStrategyConfigs();
  } catch (err) {
    logger.warn("worker.seed.failed", { error: String(err) });
  }
  // Simple resilient loop; each tick is independently error-isolated.
  for (;;) {
    const started = Date.now();
    await tick();
    const elapsed = Date.now() - started;
    await sleep(Math.max(5_000, INTERVAL_MS - elapsed));
  }
}

main().catch((err) => {
  logger.error("worker.fatal", { error: String(err) });
  process.exit(1);
});
