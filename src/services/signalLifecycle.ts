import { logger } from "@/lib/logger";
import { CompositeEntry, InstitutionalEntry, ScanEntry } from "./scanService";
import {
  evaluateOpenSignals,
  maybePersistCompositeSignal,
  maybePersistConfluenceSignal,
  maybePersistInstitutionalSignal,
} from "./signalService";

/**
 * Serverless-safe signal lifecycle.
 *
 * `scripts/worker.ts` drives persistence and evaluation on a long-lived host.
 * Serverless deployments have no such process, which left two holes:
 *
 *   * qualifying scan setups were never written, so the Active Signals card
 *     stayed empty no matter how many setups the scanner found;
 *   * `evaluateOpenSignals` was never called, so any signal that *did* exist
 *     kept its original status forever — never advancing to TP1_HIT, never
 *     stopping out, never producing an outcome for the learning engine.
 *
 * Both are fixed by hanging the work off request traffic instead of a daemon:
 * a scan persists what it finds, and read endpoints opportunistically refresh
 * open positions. Neither blocks its caller's response.
 *
 * Throttling is per-instance and deliberately coarse. Serverless spawns many
 * instances, so this is a load damper rather than a lock — correctness comes
 * from the database (the ACTIVE-signal guard in `maybePersistConfluenceSignal`
 * and the idempotent status transitions in `evaluateOpenSignals`), never from
 * this timestamp.
 */

/** Minimum gap between evaluation passes on one instance. */
const EVALUATE_THROTTLE_MS = 30_000;
/** Confidence a scan setup must clear before it becomes a tracked signal. */
const PERSIST_MIN_CONFIDENCE = 72;

let lastEvaluatedAt = 0;
let inFlight: Promise<{ evaluated: number; closed: number }> | null = null;

/**
 * Refresh open signal statuses, at most once per throttle window.
 *
 * Concurrent callers share the in-flight promise rather than starting a second
 * pass, so a burst of dashboard requests produces one evaluation, not ten.
 */
export async function refreshOpenSignals(
  opts: { force?: boolean } = {}
): Promise<{ evaluated: number; closed: number; skipped: boolean }> {
  const now = Date.now();
  if (!opts.force && now - lastEvaluatedAt < EVALUATE_THROTTLE_MS && !inFlight) {
    return { evaluated: 0, closed: 0, skipped: true };
  }
  if (inFlight) {
    const shared = await inFlight;
    return { ...shared, skipped: false };
  }

  lastEvaluatedAt = now;
  inFlight = evaluateOpenSignals();
  try {
    const result = await inFlight;
    if (result.closed > 0) {
      logger.info("lifecycle.evaluated", result);
    }
    return { ...result, skipped: false };
  } catch (err) {
    logger.error("lifecycle.evaluate.failed", { error: String(err) });
    return { evaluated: 0, closed: 0, skipped: false };
  } finally {
    inFlight = null;
  }
}

/**
 * Fire-and-forget variant for read paths.
 *
 * A dashboard GET should never wait on signal maintenance, and a failure here
 * must not surface as a failed page load.
 */
export function refreshOpenSignalsInBackground(): void {
  refreshOpenSignals().catch((err) =>
    logger.warn("lifecycle.background.failed", { error: String(err) })
  );
}

/**
 * Persist qualifying setups from a completed scan.
 *
 * Only actionable, high-confidence entries are written — the scanner looks at
 * hundreds of symbols and most have nothing worth tracking. Duplicate open
 * positions are rejected inside `maybePersistConfluenceSignal`, so re-running a
 * scan is safe.
 */
export async function persistScanSignals(
  entries: ScanEntry[],
  opts: { minConfidence?: number; limit?: number } = {}
): Promise<{ created: number; considered: number }> {
  const min = opts.minConfidence ?? PERSIST_MIN_CONFIDENCE;
  const limit = opts.limit ?? 8;

  const candidates = entries
    .filter((e) => e.setup.decision !== "NO_TRADE" && e.setup.confidence >= min)
    .sort((a, b) => b.setup.confidence - a.setup.confidence)
    .slice(0, limit);

  let created = 0;
  for (const entry of candidates) {
    try {
      const id = await maybePersistConfluenceSignal(entry.setup, {
        quoteVolume: entry.quoteVolume,
        // ScanEntry allows a null 24h change (a symbol the ticker sweep
        // missed); the persist API takes an optional number, not a null.
        priceChangePercent: entry.priceChangePercent ?? undefined,
      });
      if (id) created++;
    } catch (err) {
      logger.warn("lifecycle.persist.failed", {
        symbol: entry.setup.symbol,
        error: String(err),
      });
    }
  }

  if (created > 0) {
    logger.info("lifecycle.persisted", { created, considered: candidates.length });
  }
  return { created, considered: candidates.length };
}

/** Fire-and-forget variant so a scan response is never delayed by writes. */
export function persistScanSignalsInBackground(entries: ScanEntry[]): void {
  persistScanSignals(entries).catch((err) =>
    logger.warn("lifecycle.persist.background.failed", { error: String(err) })
  );
}

/**
 * Persist qualifying institutional footprints as tracked signals.
 *
 * Deliberately tighter than the confluence path. A footprint is a positional
 * read that can sit unresolved for days, so opening many at once would fill
 * the tracker with correlated positions and make the resulting hit rate a
 * measurement of one market move rather than of the engine. Only the strongest
 * few per sweep are written.
 *
 * Entries with no `trade` are skipped inside the persist call: the read can be
 * valid — the levels stand — while the geometry does not justify an entry, and
 * writing one anyway would put a price on a conclusion the engine declined.
 */
export async function persistInstitutionalSignals(
  entries: InstitutionalEntry[],
  opts: { limit?: number } = {}
): Promise<{ created: number; considered: number }> {
  const limit = opts.limit ?? 5;
  const candidates = entries
    .filter((e) => e.setup.qualified && e.setup.trade !== null)
    .sort((a, b) => b.setup.score - a.setup.score)
    .slice(0, limit);

  let created = 0;
  for (const entry of candidates) {
    try {
      const id = await maybePersistInstitutionalSignal(entry.setup, {
        quoteVolume: entry.quoteVolume,
        priceChangePercent: entry.priceChangePercent ?? undefined,
      });
      if (id) created++;
    } catch (err) {
      logger.warn("lifecycle.institutional.persist.failed", {
        symbol: entry.symbol,
        error: String(err),
      });
    }
  }

  if (created > 0) logger.info("lifecycle.institutional.persisted", { created });
  return { created, considered: candidates.length };
}

export function persistInstitutionalSignalsInBackground(entries: InstitutionalEntry[]): void {
  persistInstitutionalSignals(entries).catch((err) =>
    logger.warn("lifecycle.institutional.background.failed", { error: String(err) })
  );
}

/**
 * Persist qualifying composite setups as tracked signals.
 *
 * The composite always has an opinion, so the confidence floor matters more
 * here than on the confluence path — without it every sweep would open dozens
 * of marginal positions and the source's win rate would measure the threshold
 * rather than the engine.
 */
export async function persistCompositeSignals(
  entries: CompositeEntry[],
  opts: { minConfidence?: number; limit?: number } = {}
): Promise<{ created: number; considered: number }> {
  const min = opts.minConfidence ?? PERSIST_MIN_CONFIDENCE;
  const limit = opts.limit ?? 8;
  const candidates = entries
    .filter((e) => e.setup !== null && e.setup.confidence >= min)
    .sort((a, b) => (b.setup?.confidence ?? 0) - (a.setup?.confidence ?? 0))
    .slice(0, limit);

  let created = 0;
  for (const entry of candidates) {
    try {
      const id = await maybePersistCompositeSignal(entry.symbol, entry.timeframe, entry.setup!, {
        price: entry.price,
        bias: entry.bias,
        bullishProbability: entry.bullishProbability,
        quoteVolume: entry.quoteVolume,
        priceChangePercent: entry.priceChangePercent ?? undefined,
      });
      if (id) created++;
    } catch (err) {
      logger.warn("lifecycle.composite.persist.failed", {
        symbol: entry.symbol,
        error: String(err),
      });
    }
  }

  if (created > 0) logger.info("lifecycle.composite.persisted", { created });
  return { created, considered: candidates.length };
}

export function persistCompositeSignalsInBackground(entries: CompositeEntry[]): void {
  persistCompositeSignals(entries).catch((err) =>
    logger.warn("lifecycle.composite.background.failed", { error: String(err) })
  );
}
