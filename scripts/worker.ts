/**
 * Background worker: continuously analyzes every configured market on key
 * timeframes, persists qualifying signals, evaluates open signals against
 * live prices and feeds outcomes into the learning engine.
 *
 * Run alongside the web app:  npm run worker
 * (In docker-compose it runs as its own service.)
 */
import { MARKETS, Timeframe } from "../src/lib/config";
import { logger } from "../src/lib/logger";
import {
  analyzeSymbol,
  ensureStrategyConfigs,
  evaluateOpenSignals,
  maybePersistSignal,
} from "../src/services/signalService";
import { prisma } from "../src/lib/db";

const WORKER_TIMEFRAMES: Timeframe[] = ["15m", "1h", "4h"];
const INTERVAL_MS = Number(process.env.WORKER_INTERVAL_SEC ?? 60) * 1000;

async function tick(): Promise<void> {
  // 1) Evaluate open signals first so learning happens before new entries.
  try {
    const { evaluated, closed } = await evaluateOpenSignals();
    if (evaluated > 0) logger.info("worker.evaluated", { evaluated, closed });
  } catch (err) {
    logger.error("worker.evaluate.failed", { error: String(err) });
  }

  // 2) Scan all markets/timeframes sequentially (kind to Binance rate limits).
  for (const market of MARKETS) {
    for (const tf of WORKER_TIMEFRAMES) {
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  logger.info("worker.start", { markets: MARKETS.length, timeframes: WORKER_TIMEFRAMES, intervalMs: INTERVAL_MS });
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
