import { AlertKind, AlertPayload, dispatchAlert } from "@/lib/alerts";
import { Timeframe, TIMEFRAME_MINUTES } from "@/lib/config";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/db";
import {
  CandleLadderEntry,
  RetestThrustEntry,
  scanCandleLadder,
  scanRetestThrust,
} from "./scanService";

/**
 * Push alerts for the two setup scanners.
 *
 * The alerting problem is not "how do I send a message". That part is four
 * lines and already exists. The problem is that a channel which fires a
 * hundred times a day gets muted, and a muted channel is worse than no
 * channel — it is the same absence of information plus the false belief that
 * you are covered. So most of this file is about *not* sending.
 *
 * Three separate suppressions, because they stop three different failures:
 *
 *  1. **The gate.** Thresholds decide what is worth a notification at all.
 *     Defaults are strict; every one is an env var.
 *  2. **The key.** One alert per *event*, not per sweep. A setup sitting at
 *     its level for six bars is one alert, not six, because the key is built
 *     from the event's own timestamp rather than from the time of the sweep
 *     that found it.
 *  3. **The cooldown.** One symbol cannot fill the channel by itself, however
 *     many distinct events it produces.
 *
 * ## What these alerts will not say
 *
 * The thrust alert carries the setup's precedent — what this symbol did after
 * previous instances — because that is the most useful thing in it. It is
 * written as a count and an outcome ("7 of 11 previous"), never as a
 * probability, a confidence or an expectation, and never without the
 * denominator. An alert arriving on a phone is read in two seconds with no
 * context, which is exactly the situation where "78%" gets remembered as a
 * fact about the future.
 *
 * Nothing here predicts anything. A setup alert says a sequence has just
 * completed on a chart, and where to look.
 */

/* `satisfies` rather than a type annotation: the annotation widens these to
   the whole AlertKind union, which then makes `SetupAlertKind` mean "any
   alert kind at all" and quietly lets a signal-closure alert through a
   parameter that is supposed to accept only these two. */
export const THRUST_KIND = "setup.thrust" satisfies AlertKind;
export const LADDER_KIND = "setup.ladder" satisfies AlertKind;

export type SetupAlertKind = typeof THRUST_KIND | typeof LADDER_KIND;

/**
 * What gets recorded alongside a sent alert.
 *
 * Scalars only, so it is valid JSON for the store without a cast. A cast here
 * would be hiding the one thing worth checking: that nothing non-serialisable
 * reaches a column the rest of the app reads back.
 */
type AlertMeta = Record<string, string | number | boolean | null>;

export interface SetupGate {
  /** minimum checks passed, out of the setup's own total */
  thrustMinScore: number;
  /**
   * Minimum previous instances before the precedent is allowed to matter.
   *
   * Below this the rate is not used as a filter at all — not because a thin
   * record is bad news, but because it is no news, and filtering on it would
   * silently drop every symbol whose history simply is not long enough.
   */
  thrustMinPrecedent: number;
  /**
   * Minimum share of previous instances that reached the boom threshold.
   *
   * Applied only when there are at least `thrustMinPrecedent` cases. Defaults
   * to 0 — off — because a filter on a measured frequency is a judgement about
   * how much that frequency means, and that judgement belongs to whoever is
   * reading the alerts, not to a default.
   */
  thrustMinBoomRate: number;
  /** minimum bars in a ladder run */
  ladderMinBars: number;
  /** minimum straightness, 0-1 */
  ladderMinR2: number;
  /** minimum share of bars closing in the run's direction */
  ladderMinBodyShare: number;
  /** hard cap per run, so a violent session cannot empty itself into a phone */
  maxPerRun: number;
}

export const DEFAULT_GATE: SetupGate = {
  thrustMinScore: 3,
  thrustMinPrecedent: 5,
  thrustMinBoomRate: 0,
  ladderMinBars: 6,
  ladderMinR2: 0.9,
  ladderMinBodyShare: 0.5,
  maxPerRun: 5,
};

export function gateFromEnv(): SetupGate {
  const num = (key: string, fallback: number) => {
    const raw = process.env[key];
    const parsed = raw == null ? NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    thrustMinScore: num("SETUP_ALERT_THRUST_MIN_SCORE", DEFAULT_GATE.thrustMinScore),
    thrustMinPrecedent: num("SETUP_ALERT_THRUST_MIN_PRECEDENT", DEFAULT_GATE.thrustMinPrecedent),
    thrustMinBoomRate: num("SETUP_ALERT_THRUST_MIN_BOOM_RATE", DEFAULT_GATE.thrustMinBoomRate),
    ladderMinBars: num("SETUP_ALERT_LADDER_MIN_BARS", DEFAULT_GATE.ladderMinBars),
    ladderMinR2: num("SETUP_ALERT_LADDER_MIN_R2", DEFAULT_GATE.ladderMinR2),
    ladderMinBodyShare: num("SETUP_ALERT_LADDER_MIN_BODY", DEFAULT_GATE.ladderMinBodyShare),
    maxPerRun: num("SETUP_ALERT_MAX_PER_RUN", DEFAULT_GATE.maxPerRun),
  };
}

/* ------------------------------------------------------------------ *
 * Selection
 * ------------------------------------------------------------------ */

/**
 * Only `armed` setups are alertable.
 *
 * Not the expanding ones, however good they look. The whole point of the
 * sequence is the level you can stop against, and by the time price has
 * thrust, that level is behind you — an alert for it would be an invitation to
 * chase, arriving with the authority of a notification. `held` is excluded for
 * a quieter reason: it is a state price can sit in for twenty bars, so it
 * describes no moment in particular and there is nothing to timestamp an alert
 * to.
 */
export function selectThrustAlerts(
  entries: RetestThrustEntry[],
  gate: SetupGate
): RetestThrustEntry[] {
  return entries
    .filter((e) => {
      const s = e.setup;
      if (s.state !== "armed") return false;
      if (s.score < gate.thrustMinScore) return false;
      const p = s.precedent;
      if (gate.thrustMinBoomRate > 0 && p.count >= gate.thrustMinPrecedent) {
        if (p.boomRate < gate.thrustMinBoomRate) return false;
      }
      return true;
    })
    .sort((a, b) => {
      /* Ranked by the record, with the count damping it, so a 3-of-3 does not
         outrank a 7-of-9 for the last slot under the cap. */
      const w = (e: RetestThrustEntry) =>
        e.setup.precedent.boomRate * Math.min(1, e.setup.precedent.count / 5);
      return w(b) - w(a);
    })
    .slice(0, gate.maxPerRun);
}

/**
 * Only runs still stepping on the last closed bar.
 *
 * A ladder that stopped is not news, and one that has not stopped is news
 * exactly once — the key, not this filter, is what stops it arriving again on
 * every sweep for as long as it lasts.
 */
export function selectLadderAlerts(
  entries: CandleLadderEntry[],
  gate: SetupGate
): CandleLadderEntry[] {
  return entries
    .filter((e) => {
      const l = e.ladder;
      if (l.barsSinceEnd !== 0 || l.broken) return false;
      if (l.bars < gate.ladderMinBars) return false;
      if (l.r2 < gate.ladderMinR2) return false;
      if (l.bodyShare < gate.ladderMinBodyShare) return false;
      return true;
    })
    .sort((a, b) => b.ladder.score - a.ladder.score)
    .slice(0, gate.maxPerRun);
}

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

/**
 * One alert per change of character, not per sweep.
 *
 * Keyed on the CHoCH time rather than the bar the sweep happened to run on,
 * so a setup that sits in its retest zone for six bars produces one alert. The
 * consequence is deliberate: if price leaves the level and comes back to the
 * *same* level later, that is the same key and no second alert fires. Fewer
 * alerts is the right side to err on — the second visit to a level is not new
 * information in the way the first was.
 */
export function thrustAlertKey(entry: RetestThrustEntry): string {
  return `${THRUST_KIND}:${entry.symbol}:${entry.timeframe}:${entry.setup.chochTime ?? 0}`;
}

/** One alert per run, keyed on where the run started. */
export function ladderAlertKey(entry: CandleLadderEntry): string {
  return `${LADDER_KIND}:${entry.symbol}:${entry.timeframe}:${entry.ladder.startTime}`;
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

function fmtPrice(v: number): string {
  return v.toFixed(v >= 1000 ? 2 : v >= 1 ? 4 : 6).replace(/0+$/, "").replace(/\.$/, "");
}

function ageLine(barTime: number, timeframe: string): string {
  const barMin = TIMEFRAME_MINUTES[timeframe as Timeframe] ?? 0;
  const ageMin = Math.max(0, Math.round((Date.now() / 1000 - barTime) / 60));
  if (barMin === 0) return "";
  /* Stated on every alert because a scheduler can run late — GitHub's drifts
     ten or fifteen minutes under load — and an alert that does not say how old
     it is reads as live no matter when it arrives. */
  return ageMin > barMin * 2 ? `\n⚠︎ Bar closed ~${ageMin}m ago — this alert is late.` : "";
}

/**
 * The precedent sentence, or an honest absence of one.
 *
 * Always a count with a denominator, never a bare percentage. An alert is read
 * in two seconds on a lock screen with no surrounding context, which is
 * precisely where "78%" stops being a description of eleven past bars and
 * becomes a belief about the next one.
 */
function precedentLine(entry: RetestThrustEntry): string {
  const p = entry.setup.precedent;
  if (p.count === 0) {
    return "No previous instance of this sequence in the loaded window — no record either way.";
  }
  if (p.count < 5) {
    return `Only ${p.count} previous instance${p.count === 1 ? "" : "s"} on this symbol — too few to read as a rate.`;
  }
  const booms = Math.round(p.boomRate * p.count);
  return `Previously on this symbol: ${booms} of ${p.count} reached ${p.boomThresholdAtr} ATR before losing the level. Past bars, not a forecast.`;
}

export function formatThrustAlert(entry: RetestThrustEntry, appUrl?: string): AlertPayload {
  const s = entry.setup;
  const long = s.direction === "long";
  const pair = entry.symbol.replace(/USDT$/, "/USDT");

  /* Built by pushing rather than by filtering a literal. `.filter(Boolean)`
     over an array holding both optional lines and deliberate blank separators
     cannot tell them apart, and silently removed every blank — which ran the
     precedent sentence straight into the numbers above it, in the one message
     where that sentence most needs to stand alone. */
  const lines: string[] = [
    `${long ? "Long" : "Short"} setup at its level on ${entry.timeframe}.`,
    `Level ${fmtPrice(s.level)} · price ${fmtPrice(entry.price)} (${s.distanceAtr.toFixed(1)} ATR away)`,
    `Leg into the base ${s.legAtr.toFixed(1)} ATR · character changed ${s.barsSinceChoch ?? "?"} bars ago`,
  ];
  if (s.retestDepthAtr != null) lines.push(`Retest depth ${s.retestDepthAtr.toFixed(2)} ATR`);
  lines.push("", precedentLine(entry), "");
  lines.push(
    "The expansion has not happened. This is the sequence arriving at its level, which is the point with the least confirmation."
  );

  const age = ageLine(entry.barTime, entry.timeframe);
  if (age) lines.push(age.trim());

  return {
    title: `${long ? "▲" : "▼"} ${pair} — retest at ${fmtPrice(s.level)}`,
    body: lines.join("\n"),
    symbol: entry.symbol,
    side: long ? "BUY" : "SELL",
    kind: THRUST_KIND,
    url: appUrl ? `${appUrl}/terminal?symbol=${entry.symbol}&timeframe=${entry.timeframe}` : undefined,
  };
}

export function formatLadderAlert(entry: CandleLadderEntry, appUrl?: string): AlertPayload {
  const l = entry.ladder;
  const up = l.direction === "up";
  const pair = entry.symbol.replace(/USDT$/, "/USDT");

  const lines = [
    `${l.bars} consecutive bars stepping ${up ? "up" : "down"} on ${entry.timeframe}.`,
    `Move ${l.movePct >= 0 ? "+" : ""}${l.movePct.toFixed(2)}% (${l.moveAtr.toFixed(1)} ATR) · straightness ${l.r2.toFixed(2)}`,
    `${Math.round(l.bodyShare * 100)}% of bars closed in the run's direction`,
    `The line sits at ${fmtPrice(l.lineNow)} — where the next step has to hold, not a target.`,
    "",
    "A run of bars that have already closed. Runs end, and this one holding for these bars says nothing about the next.",
  ];

  const age = ageLine(entry.barTime, entry.timeframe);
  if (age) lines.push(age.trim());

  return {
    title: `${up ? "▲" : "▼"} ${pair} — ${l.bars}-bar ladder`,
    body: lines.join("\n"),
    symbol: entry.symbol,
    side: up ? "BUY" : "SELL",
    kind: LADDER_KIND,
    url: appUrl ? `${appUrl}/terminal?symbol=${entry.symbol}&timeframe=${entry.timeframe}` : undefined,
  };
}

/* ------------------------------------------------------------------ *
 * Dedupe
 * ------------------------------------------------------------------ */

/**
 * Claim a key, returning false if it was already taken.
 *
 * The `findUnique` ahead of the insert looks redundant against the unique
 * index, and against a correctly migrated database it is. It is here for the
 * database that is not: MongoDB creates collections implicitly on first write
 * but never creates indexes, so an install that skipped `db push` has a
 * SentAlert collection with no unique constraint — every insert succeeds, no
 * P2002 is ever raised, and the same setup re-alerts on every sweep for as
 * long as it lasts. Read-then-write is not atomic and leaves a small race, but
 * it turns "spam every five minutes" into "a rare duplicate", which is the
 * difference between a channel someone keeps and one they mute.
 *
 * A database that cannot be reached returns false — no alert. Sending without
 * being able to record that it was sent is how a broken database becomes a
 * hundred identical messages.
 */
async function claimKey(
  key: string,
  kind: SetupAlertKind,
  symbol: string,
  timeframe: string,
  meta: AlertMeta
): Promise<boolean> {
  try {
    if (await prisma.sentAlert.findUnique({ where: { key }, select: { id: true } })) return false;
  } catch (err) {
    logger.warn("alerts.setup.lookup_failed", { symbol, error: String(err) });
    return false;
  }
  try {
    await prisma.sentAlert.create({ data: { key, kind, symbol, timeframe, meta } });
    return true;
  } catch (err) {
    // P2002 = unique violation = already sent. Anything else is a real fault
    // and is logged, but the answer is the same: do not send.
    const code = (err as { code?: string })?.code;
    if (code !== "P2002") logger.warn("alerts.setup.claim_failed", { symbol, error: String(err) });
    return false;
  }
}

/** Symbols alerted within the cooldown window, so one coin cannot spam. */
async function symbolsInCooldown(kinds: SetupAlertKind[], minutes: number): Promise<Set<string>> {
  if (minutes <= 0) return new Set();
  try {
    const rows = await prisma.sentAlert.findMany({
      where: { kind: { in: kinds }, sentAt: { gte: new Date(Date.now() - minutes * 60_000) } },
      select: { symbol: true },
    });
    return new Set(rows.map((r) => r.symbol));
  } catch (err) {
    logger.warn("alerts.setup.cooldown_failed", { error: String(err) });
    return new Set();
  }
}

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

export interface SetupAlertRun {
  timeframe: string;
  kinds: SetupAlertKind[];
  scanned: number;
  /** setups the scanners produced, before the gate */
  candidates: number;
  /** passed the gate */
  eligible: number;
  /** suppressed because the same symbol alerted recently */
  cooledDown: number;
  /** suppressed because this exact event had already been sent */
  duplicates: number;
  sent: number;
  symbols: string[];
  channelsConfigured: boolean;
  /** the thresholds this run actually applied, so the log is self-describing */
  gate: SetupGate;
  error?: string;
}

export interface SetupAlertOptions {
  timeframe?: Timeframe;
  depth?: number;
  kinds?: SetupAlertKind[];
  gate?: SetupGate;
  cooldownMinutes?: number;
  /** evaluate and report without sending or recording anything */
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
 * Safe to call on a schedule as often as you like: without a new setup it
 * sends nothing, and the cost is one universe sweep per enabled kind.
 */
export async function runSetupAlerts(opts: SetupAlertOptions = {}): Promise<SetupAlertRun> {
  const timeframe = opts.timeframe ?? ((process.env.SETUP_ALERT_TIMEFRAME as Timeframe) || "1h");
  const depth = opts.depth ?? Number(process.env.SETUP_ALERT_DEPTH ?? 80);
  const gate = opts.gate ?? gateFromEnv();
  const cooldownMinutes =
    opts.cooldownMinutes ?? Number(process.env.SETUP_ALERT_COOLDOWN_MIN ?? 120);
  const kinds = opts.kinds ?? [THRUST_KIND, LADDER_KIND];
  const channelsConfigured = alertChannelsConfigured();

  const run: SetupAlertRun = {
    timeframe,
    kinds,
    scanned: 0,
    candidates: 0,
    eligible: 0,
    cooledDown: 0,
    duplicates: 0,
    sent: 0,
    symbols: [],
    channelsConfigured,
    gate,
  };

  const appUrl = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL;
  /* Each entry carries everything the loop needs, so the two kinds share one
     cooldown, one cap and one send path instead of two near-copies that drift
     apart the first time either is changed. */
  const pending: {
    kind: SetupAlertKind;
    symbol: string;
    key: string;
    meta: AlertMeta;
    payload: AlertPayload;
  }[] = [];

  if (kinds.includes(THRUST_KIND)) {
    try {
      const scan = await scanRetestThrust({ timeframe, depth });
      run.scanned = Math.max(run.scanned, scan.scanned);
      if (scan.error) run.error = scan.error;
      const candidates = [...scan.armed, ...scan.held, ...scan.thrusting];
      run.candidates += candidates.length;
      for (const e of selectThrustAlerts(candidates, gate)) {
        pending.push({
          kind: THRUST_KIND,
          symbol: e.symbol,
          key: thrustAlertKey(e),
          meta: {
            state: e.setup.state,
            direction: e.setup.direction,
            level: e.setup.level,
            score: e.setup.score,
            precedentCount: e.setup.precedent.count,
            precedentBoomRate: e.setup.precedent.boomRate,
          },
          payload: formatThrustAlert(e, appUrl),
        });
      }
    } catch (err) {
      run.error = String(err);
      logger.warn("alerts.setup.thrust_scan_failed", { timeframe, error: String(err) });
    }
  }

  if (kinds.includes(LADDER_KIND)) {
    try {
      const scan = await scanCandleLadder({ timeframe, depth });
      run.scanned = Math.max(run.scanned, scan.scanned);
      if (scan.error && !run.error) run.error = scan.error;
      const candidates = [...scan.climbing, ...scan.falling];
      run.candidates += candidates.length;
      for (const e of selectLadderAlerts(candidates, gate)) {
        pending.push({
          kind: LADDER_KIND,
          symbol: e.symbol,
          key: ladderAlertKey(e),
          meta: {
            direction: e.ladder.direction,
            bars: e.ladder.bars,
            r2: e.ladder.r2,
            movePct: e.ladder.movePct,
            score: e.ladder.score,
          },
          payload: formatLadderAlert(e, appUrl),
        });
      }
    } catch (err) {
      if (!run.error) run.error = String(err);
      logger.warn("alerts.setup.ladder_scan_failed", { timeframe, error: String(err) });
    }
  }

  run.eligible = pending.length;
  if (pending.length === 0) return run;

  const cooling = await symbolsInCooldown(kinds, cooldownMinutes);

  for (const item of pending) {
    if (cooling.has(item.symbol)) {
      run.cooledDown++;
      continue;
    }
    if (opts.dryRun) {
      run.sent++;
      run.symbols.push(item.symbol);
      cooling.add(item.symbol);
      continue;
    }
    // Claim before sending. The reverse order would re-send the whole batch if
    // the process died between the send and the write.
    if (!(await claimKey(item.key, item.kind, item.symbol, timeframe, item.meta))) {
      run.duplicates++;
      continue;
    }
    try {
      await dispatchAlert(item.payload);
      run.sent++;
      run.symbols.push(item.symbol);
      // One alert per symbol per run, and the cooldown starts immediately.
      cooling.add(item.symbol);
    } catch (err) {
      logger.warn("alerts.setup.dispatch_failed", { symbol: item.symbol, error: String(err) });
    }
  }

  if (run.sent > 0) {
    logger.info("alerts.setup.sent", { timeframe, sent: run.sent, symbols: run.symbols });
  }
  return run;
}
