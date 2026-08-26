import { Timeframe, TIMEFRAME_MINUTES } from "@/lib/config";
import { AlertPayload, dispatchAlert } from "@/lib/alerts";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/db";
import { LiquidationReversalEntry, scanLiquidationReversals } from "./scanService";

/**
 * Liquidation-spike alerts.
 *
 * Sweeps the universe for forced flow printing at an extreme and pushes the
 * ones worth waking someone up for to whatever channels are configured
 * (Telegram, Discord, webhook — see `src/lib/alerts.ts`).
 *
 * Three things this file is mostly about, none of which is the sending:
 *
 * **The gate.** Around 500 perpetuals spike constantly. An alerter with no
 * threshold buzzes a hundred times a day, gets muted, and is then worse than
 * having no alerts at all — so a spike must be at an extreme, carry a forced
 * signature, have already begun reversing, and be recent. Anything else is
 * information for the scanner page, not for a phone.
 *
 * **Deduplication.** A cron re-reads the same candles every few minutes. The
 * dedupe key is built from the *spike bar's* timestamp, so one spike produces
 * exactly one alert however many times it is re-evaluated, and the uniqueness
 * is enforced by the database rather than by memory that a serverless instance
 * does not keep.
 *
 * **Honest latency.** Spikes are read off closed candles, so an alert is
 * inherently one bar behind at best. The message says how long ago the spike
 * printed rather than implying it is happening now; a reader who knows the
 * move is nine minutes old can judge whether the entry is still there.
 */

export const ALERT_KIND = "liqspike";

export interface SpikeGate {
  /** minimum setup score, 0-100 */
  minScore: number;
  /** reject spikes whose forced classification is "unlikely" */
  requireForced: boolean;
  /** only alert on spikes no older than this many bars */
  maxBarsAgo: number;
  /** minimum % already reversed off the spike extreme */
  minReversalPct: number;
  /** hard cap per run, so one violent market cannot flood the channel */
  maxPerRun: number;
}

export const DEFAULT_GATE: SpikeGate = {
  minScore: 70,
  requireForced: true,
  /**
   * Six bars on a 5m sweep is half an hour.
   *
   * This was three, chosen on the theory that beyond fifteen minutes the
   * reversal has happened without you. That reasoning assumed a punctual
   * sweep, and no free scheduler is punctual — GitHub's cron drops and delays
   * runs freely, so a window narrower than the gap between sweeps makes most
   * spikes structurally unreachable: they age out in the silence between two
   * runs and are never once seen while fresh.
   *
   * The window therefore has to exceed the *worst* realistic sweep gap, not
   * the best. Every message states the spike's age, so a 25-minute-old print
   * arrives labelled as one and the reader can judge it.
   */
  maxBarsAgo: 6,
  minReversalPct: 0.4,
  maxPerRun: 5,
};

/**
 * Why the gate rejected what it rejected.
 *
 * Counted by *first* failing condition, in the same order the gate applies
 * them, so the number that stands out names the binding constraint. Without
 * this, a run reporting "20 qualified, 0 eligible" gives no way to tell an
 * over-strict threshold from a genuinely quiet market, and tuning becomes
 * guesswork against a market that has moved on by the next run.
 */
export interface RejectionCounts {
  notQualified: number;
  lowScore: number;
  notForced: number;
  stale: number;
  noReversal: number;
  /** passed everything but fell outside maxPerRun */
  overCap: number;
}

/** The rejected spike that came closest to passing, for context in the log. */
export interface NearestMiss {
  symbol: string;
  score: number;
  barsAgo: number;
  reversalPct: number;
  forced: string;
  /** the first condition it failed */
  failed: keyof RejectionCounts;
}

function firstFailure(
  entry: LiquidationReversalEntry,
  gate: SpikeGate
): keyof RejectionCounts | null {
  const s = entry.setup;
  if (!s.qualified || !s.spike) return "notQualified";
  if (s.score < gate.minScore) return "lowScore";
  if (gate.requireForced && s.forced === "unlikely") return "notForced";
  if (s.spike.barsAgo > gate.maxBarsAgo) return "stale";
  if (s.reversalPct < gate.minReversalPct) return "noReversal";
  return null;
}

export function explainRejections(
  entries: LiquidationReversalEntry[],
  gate: SpikeGate = DEFAULT_GATE
): { counts: RejectionCounts; nearest: NearestMiss | null } {
  const counts: RejectionCounts = {
    notQualified: 0,
    lowScore: 0,
    notForced: 0,
    stale: 0,
    noReversal: 0,
    overCap: 0,
  };
  let nearest: NearestMiss | null = null;
  let passed = 0;

  for (const entry of entries) {
    const failed = firstFailure(entry, gate);
    if (!failed) {
      passed++;
      continue;
    }
    counts[failed]++;
    // "Closest" is by score among things that at least qualified — the
    // rejects worth knowing about are strong setups caught by one threshold,
    // not coins that were never candidates.
    const s = entry.setup;
    if (failed !== "notQualified" && (!nearest || s.score > nearest.score)) {
      nearest = {
        symbol: entry.symbol,
        score: s.score,
        barsAgo: s.spike?.barsAgo ?? -1,
        reversalPct: s.reversalPct,
        forced: s.forced,
        failed,
      };
    }
  }
  counts.overCap = Math.max(0, passed - gate.maxPerRun);
  return { counts, nearest };
}

export function gateFromEnv(): SpikeGate {
  const num = (key: string, fallback: number) => {
    const raw = process.env[key];
    const parsed = raw == null ? NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    minScore: num("LIQ_ALERT_MIN_SCORE", DEFAULT_GATE.minScore),
    requireForced: process.env.LIQ_ALERT_REQUIRE_FORCED !== "false",
    maxBarsAgo: num("LIQ_ALERT_MAX_BARS_AGO", DEFAULT_GATE.maxBarsAgo),
    minReversalPct: num("LIQ_ALERT_MIN_REVERSAL_PCT", DEFAULT_GATE.minReversalPct),
    maxPerRun: num("LIQ_ALERT_MAX_PER_RUN", DEFAULT_GATE.maxPerRun),
  };
}

/**
 * Which of a sweep's results are worth an alert. Pure — no clock, no I/O.
 *
 * `qualified` already means "at an extreme, forced, and reversing"; the gate
 * layers the thresholds that decide whether it is worth interrupting someone
 * for, which is a different and stricter question.
 */
export function selectAlertable(
  entries: LiquidationReversalEntry[],
  gate: SpikeGate = DEFAULT_GATE
): LiquidationReversalEntry[] {
  // Shares `firstFailure` with the diagnostics rather than restating the
  // conditions. Two copies of a threshold list drift the moment one is tuned,
  // and the failure mode here is silent: the log would then explain rejections
  // the gate never actually made.
  return entries
    .filter((e) => firstFailure(e, gate) === null)
    .sort((a, b) => b.setup.score - a.setup.score)
    .slice(0, gate.maxPerRun);
}

/**
 * Dedupe identity for one spike.
 *
 * Keyed on the spike bar's own timestamp rather than on the run, so the same
 * event re-detected on the next sweep collapses onto the same key. Two
 * different spikes on the same symbol in the same session get two keys, which
 * is correct — the cooldown, not the key, is what suppresses those.
 */
export function alertKey(entry: LiquidationReversalEntry): string {
  return `${ALERT_KIND}:${entry.symbol}:${entry.timeframe}:${entry.setup.spike?.time ?? 0}`;
}

function fmtPrice(v: number): string {
  return v.toFixed(v >= 1000 ? 2 : v >= 1 ? 4 : 6).replace(/0+$/, "").replace(/\.$/, "");
}

function fmtSize(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(abs / 1e3).toFixed(1)}K`;
  return abs.toFixed(0);
}

/** Render one spike as an alert. Pure. */
export function formatSpikeAlert(entry: LiquidationReversalEntry, appUrl?: string): AlertPayload {
  const s = entry.setup;
  const spike = s.spike!;
  const flush = spike.side === "long";
  const pair = entry.symbol.replace(/USDT$/, "/USDT");
  const barMin = TIMEFRAME_MINUTES[entry.timeframe as Timeframe] ?? 0;
  const agoMin = spike.barsAgo * barMin;

  const lines = [
    `${pair} · ${entry.timeframe} · score ${s.score}`,
    `${flush ? "Long flush at the low" : "Short squeeze at the high"} — ${fmtSize(spike.volume)} forced ${flush ? "selling" : "buying"}, ${spike.multiple.toFixed(1)}× the window average.`,
    `${flush ? "Flush low" : "Squeeze high"} ${fmtPrice(spike.extreme)} · now ${fmtPrice(s.price)} · reversed ${s.reversalPct.toFixed(2)}% (peak ${s.peakReversalPct.toFixed(2)}%)`,
    // Latency stated, not implied. A reader who knows the print is nine
    // minutes old can decide for themselves whether the entry still exists.
    spike.barsAgo === 0
      ? "Printed on the bar still forming."
      : `Printed ${spike.barsAgo} bar${spike.barsAgo === 1 ? "" : "s"} ago${agoMin > 0 ? ` (~${agoMin}m)` : ""}.`,
    s.forced === "confirmed"
      ? "Forced flow measured from live liquidation prints."
      : "Forced flow inferred from the candle signature, not measured — Binance serves no historical forced-order data.",
    `Invalidation: a close beyond ${fmtPrice(s.invalidation ?? spike.extreme)}.${s.target != null ? ` First objective ${fmtPrice(s.target)}.` : ""}`,
    // The engine reports what has happened, not what will. Saying so in the
    // message keeps the alert from reading as a prediction.
    "This describes a move that has already begun — it is not a forecast that it continues.",
  ];

  return {
    title: `${flush ? "🟢" : "🔴"} Liquidation spike — ${pair}`,
    body: lines.join("\n"),
    symbol: entry.symbol,
    // A flush at the low is where forced *selling* ends, so the side that
    // benefits is the buyer. Naming it lets Discord colour the embed.
    side: flush ? "BUY" : "SELL",
    confidence: s.score,
    url: appUrl
      ? `${appUrl.replace(/\/$/, "")}/terminal?symbol=${entry.symbol}&timeframe=${entry.timeframe}`
      : undefined,
  };
}

/**
 * Claim an alert key.
 *
 * Returns false when the key already exists — the insert *is* the check, so two
 * concurrent runs cannot both decide they are the first. A database failure
 * returns false rather than true: skipping an alert is a nuisance, duplicating
 * one on every sweep for the next hour is a reason to mute the channel.
 *
 * The `findUnique` ahead of the insert looks redundant against the unique
 * index, and against a correctly migrated database it is. It is here for the
 * database that is *not*: MongoDB creates collections implicitly on first
 * write but never creates indexes, so an install that skipped `db push` has a
 * SentAlert collection with no unique constraint — every insert succeeds, no
 * P2002 is ever raised, and the same spike re-alerts on every sweep for as
 * long as it stays in the window. Read-then-write is not atomic and leaves a
 * small race, but it turns "spam every five minutes" into "a rare duplicate",
 * which is the difference between a channel someone keeps and one they mute.
 */
async function claimKey(entry: LiquidationReversalEntry): Promise<boolean> {
  const s = entry.setup;
  const key = alertKey(entry);
  try {
    if (await prisma.sentAlert.findUnique({ where: { key }, select: { id: true } })) return false;
  } catch (err) {
    logger.warn("alerts.liqspike.lookup_failed", { symbol: entry.symbol, error: String(err) });
    return false;
  }
  try {
    await prisma.sentAlert.create({
      data: {
        key,
        kind: ALERT_KIND,
        symbol: entry.symbol,
        timeframe: entry.timeframe,
        meta: {
          score: s.score,
          location: s.location,
          forced: s.forced,
          side: s.spike?.side ?? null,
          extreme: s.spike?.extreme ?? null,
          reversalPct: s.reversalPct,
        },
      },
    });
    return true;
  } catch (err) {
    // P2002 = unique violation = already sent. Anything else is a real fault
    // and is logged, but the answer is the same: do not send.
    const code = (err as { code?: string })?.code;
    if (code !== "P2002") logger.warn("alerts.liqspike.claim_failed", { symbol: entry.symbol, error: String(err) });
    return false;
  }
}

/** Symbols alerted within the cooldown window, so a coin cannot spam. */
async function symbolsInCooldown(minutes: number): Promise<Set<string>> {
  if (minutes <= 0) return new Set();
  try {
    const rows = await prisma.sentAlert.findMany({
      where: { kind: ALERT_KIND, sentAt: { gte: new Date(Date.now() - minutes * 60_000) } },
      select: { symbol: true },
    });
    return new Set(rows.map((r) => r.symbol));
  } catch (err) {
    logger.warn("alerts.liqspike.cooldown_failed", { error: String(err) });
    return new Set();
  }
}

export interface SpikeAlertRun {
  timeframe: string;
  scanned: number;
  qualified: number;
  /** passed the gate */
  eligible: number;
  /** suppressed because the same symbol alerted recently */
  cooledDown: number;
  /** suppressed because this exact spike had already been sent */
  duplicates: number;
  sent: number;
  symbols: string[];
  channelsConfigured: boolean;
  /** why the gate rejected what it rejected — see `explainRejections` */
  rejected: RejectionCounts;
  /** the strongest spike that failed one threshold, and which one */
  nearest: NearestMiss | null;
  /** the thresholds this run actually applied, so the log is self-describing */
  gate: SpikeGate;
  error?: string;
}

export interface SpikeAlertOptions {
  timeframe?: Timeframe;
  depth?: number;
  gate?: SpikeGate;
  cooldownMinutes?: number;
  /** evaluate and report without sending anything */
  dryRun?: boolean;
}

/** True when at least one delivery channel is configured. */
export function alertChannelsConfigured(): boolean {
  return Boolean(
    (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) ||
      process.env.DISCORD_WEBHOOK_URL ||
      process.env.GENERIC_WEBHOOK_URL
  );
}

/**
 * Sweep, gate, dedupe and send.
 *
 * Safe to call on a schedule as often as you like: without a new spike it
 * sends nothing, and the cost is one universe sweep.
 */
export async function runLiquidationSpikeAlerts(
  opts: SpikeAlertOptions = {}
): Promise<SpikeAlertRun> {
  const timeframe = opts.timeframe ?? ((process.env.LIQ_ALERT_TIMEFRAME as Timeframe) || "5m");
  const depth = opts.depth ?? Number(process.env.LIQ_ALERT_DEPTH ?? 80);
  const gate = opts.gate ?? gateFromEnv();
  const cooldownMinutes =
    opts.cooldownMinutes ?? Number(process.env.LIQ_ALERT_COOLDOWN_MIN ?? 45);
  const channelsConfigured = alertChannelsConfigured();

  const run: SpikeAlertRun = {
    timeframe,
    scanned: 0,
    qualified: 0,
    eligible: 0,
    cooledDown: 0,
    duplicates: 0,
    sent: 0,
    symbols: [],
    channelsConfigured,
    rejected: { notQualified: 0, lowScore: 0, notForced: 0, stale: 0, noReversal: 0, overCap: 0 },
    nearest: null,
    gate,
  };

  let scan;
  try {
    scan = await scanLiquidationReversals({ timeframe, depth });
  } catch (err) {
    run.error = String(err);
    logger.warn("alerts.liqspike.scan_failed", { timeframe, error: String(err) });
    return run;
  }
  if (scan.error) run.error = scan.error;

  const qualified = [...scan.bottoms, ...scan.tops];
  run.scanned = scan.scanned;
  run.qualified = qualified.length;

  const eligible = selectAlertable(qualified, gate);
  run.eligible = eligible.length;

  // Explained over every scanned entry, not just the qualifying ones, so a
  // quiet market and an over-strict threshold are distinguishable.
  const explained = explainRejections([...qualified, ...scan.watching], gate);
  run.rejected = explained.counts;
  run.nearest = explained.nearest;

  if (eligible.length === 0) return run;

  const cooling = await symbolsInCooldown(cooldownMinutes);
  const appUrl = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL;

  for (const entry of eligible) {
    if (cooling.has(entry.symbol)) {
      run.cooledDown++;
      continue;
    }
    if (opts.dryRun) {
      run.sent++;
      run.symbols.push(entry.symbol);
      continue;
    }
    // Claim before sending. The reverse order would re-send the whole batch if
    // the process died between the send and the write.
    if (!(await claimKey(entry))) {
      run.duplicates++;
      continue;
    }
    try {
      await dispatchAlert(formatSpikeAlert(entry, appUrl));
      run.sent++;
      run.symbols.push(entry.symbol);
      // One alert per symbol per run, and the cooldown starts immediately.
      cooling.add(entry.symbol);
    } catch (err) {
      logger.warn("alerts.liqspike.dispatch_failed", { symbol: entry.symbol, error: String(err) });
    }
  }

  if (run.sent > 0) {
    logger.info("alerts.liqspike.sent", { timeframe, sent: run.sent, symbols: run.symbols });
  }
  return run;
}
