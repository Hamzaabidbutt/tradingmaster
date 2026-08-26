/**
 * Live progress for an open signal.
 *
 * `outcome.ts` answers "how did this finish?" once a signal closes. This
 * answers the question the Active Signals card needs while it is still
 * running: where is price *now* relative to entry, the stop and each target,
 * and how much of the first leg has actually been covered.
 *
 * Everything is derived from the current price against levels fixed at signal
 * time, so it is a pure function — no clock, no database, no market fetch.
 */

export interface ProgressInput {
  side: "BUY" | "SELL";
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp3: number;
  /** Status recorded by the evaluator; targets already tagged stay tagged. */
  status?: string;
}

export interface TargetProgress {
  label: "TP1" | "TP2" | "TP3";
  price: number;
  /** 0-100, how much of the entry→target distance price has covered */
  progressPct: number;
  hit: boolean;
  /** signed % move still required to reach it (negative = already past) */
  remainingPct: number;
}

export interface LiveProgress {
  currentPrice: number;
  /** Unrealised P/L in percent, direction-adjusted. */
  pnlPct: number;
  /** Unrealised P/L expressed in R (risk multiples). */
  rMultiple: number;
  /** Distance travelled toward the FIRST target, 0-100 (clamped). */
  progressToTp1Pct: number;
  /** How much of the entry→stop distance has been given up, 0-100. */
  drawdownToStopPct: number;
  targets: TargetProgress[];
  /** The next target price has not yet reached, null once TP3 is tagged. */
  nextTarget: TargetProgress | null;
  state: "in_profit" | "in_loss" | "at_entry";
  /** One-line plain-English status for the UI. */
  summary: string;
}

const TAGGED: Record<string, number> = { TP1_HIT: 1, TP2_HIT: 2, TP3_HIT: 3 };

export function computeLiveProgress(signal: ProgressInput, currentPrice: number): LiveProgress {
  const isLong = signal.side === "BUY";
  const dir = isLong ? 1 : -1;

  // Signed favourable move: positive means price moved the way we wanted.
  const moved = (currentPrice - signal.entry) * dir;
  const risk = Math.abs(signal.entry - signal.stopLoss);

  const pnlPct = signal.entry !== 0 ? (moved / signal.entry) * 100 : 0;
  const rMultiple = risk > 0 ? moved / risk : 0;

  const alreadyTagged = TAGGED[signal.status ?? ""] ?? 0;

  const buildTarget = (label: TargetProgress["label"], price: number, index: number): TargetProgress => {
    const span = Math.abs(price - signal.entry);
    const progress = span > 0 ? clamp((moved / span) * 100, 0, 100) : 0;
    // A target the evaluator already tagged stays tagged even if price has
    // since retraced — the trade genuinely reached it.
    const hit = alreadyTagged >= index || (span > 0 && moved >= span);
    const remaining = signal.entry !== 0 ? ((price - currentPrice) * dir / signal.entry) * 100 : 0;
    return {
      label,
      price,
      progressPct: hit ? 100 : Number(progress.toFixed(1)),
      hit,
      remainingPct: Number(remaining.toFixed(2)),
    };
  };

  const targets = [
    buildTarget("TP1", signal.tp1, 1),
    buildTarget("TP2", signal.tp2, 2),
    buildTarget("TP3", signal.tp3, 3),
  ];

  const nextTarget = targets.find((t) => !t.hit) ?? null;
  const drawdown = risk > 0 ? clamp((-moved / risk) * 100, 0, 100) : 0;

  const state: LiveProgress["state"] =
    Math.abs(pnlPct) < 0.01 ? "at_entry" : pnlPct > 0 ? "in_profit" : "in_loss";

  const tp1 = targets[0];
  const summary =
    state === "in_profit"
      ? tp1.hit
        ? `Running at +${pnlPct.toFixed(2)}% (${rMultiple.toFixed(2)}R). TP1 tagged; ${nextTarget ? `${nextTarget.label} needs ${Math.abs(nextTarget.remainingPct).toFixed(2)}% more.` : "all targets reached."}`
        : `Running at +${pnlPct.toFixed(2)}% (${rMultiple.toFixed(2)}R) — ${tp1.progressPct.toFixed(0)}% of the way to TP1, ${Math.abs(tp1.remainingPct).toFixed(2)}% still required.`
      : state === "in_loss"
        ? `Underwater at ${pnlPct.toFixed(2)}% (${rMultiple.toFixed(2)}R) — ${drawdown.toFixed(0)}% of the way to the stop.`
        : `Flat at entry; no progress toward TP1 yet.`;

  return {
    currentPrice,
    pnlPct: Number(pnlPct.toFixed(3)),
    rMultiple: Number(rMultiple.toFixed(2)),
    progressToTp1Pct: tp1.progressPct,
    drawdownToStopPct: Number(drawdown.toFixed(1)),
    targets,
    nextTarget,
    state,
    summary,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}
