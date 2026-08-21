import {
  AnalystKey,
  AnalystVerdict,
  Candle,
  Excursion,
  OutcomeAnalysis,
  OutcomeReason,
} from "./types";

/**
 * Outcome analysis — why a signal worked, and who was right.
 *
 * Runs once, when a signal closes. Two jobs:
 *
 *  1. Measure what price actually did after entry (`computeExcursion`), so
 *     "it went to target" and "it spiked 3R against us first and then went to
 *     target" are not recorded as the same result.
 *  2. Classify *why* (`classifyOutcome`), and attribute it — which analyst's
 *     confirmation carried the trade, which ones were wrong, and which ones
 *     abstained and were vindicated.
 *
 * The classification vocabulary is a small closed set (`OutcomeReason`) rather
 * than free text, so the same reason can be counted across hundreds of
 * signals. That counting is what makes per-analyst performance measurable —
 * and per the brief, those statistics evaluate the analysts. They never feed
 * back into signal generation: `evaluateConfluence` cannot see them.
 *
 * Pure and synchronous, so every branch is testable without a database.
 */

/** Weights must match confluence.ts — the same contribution decides blame. */
const QUALITY_WEIGHT: Record<AnalystKey, number> = {
  candleClose: 1.0,
  range: 0.85,
  chart: 0.7,
};

const REASON_LABEL: Record<OutcomeReason, string> = {
  target_reached: "Target reached",
  partial_target: "Partial target — first target hit, rest unfilled",
  closed_in_profit: "Closed in profit without reaching a target",
  false_breakout: "False breakout — the level did not hold",
  failed_rejection: "Failed rejection at the boundary",
  range_invalidation: "Range invalidated — price left and stayed out",
  weak_candle_close: "Weak candle close carried the signal",
  unexpected_reversal: "Unexpected reversal after moving in favour",
  expired_no_move: "Expired without moving",
  other: "Other",
};

/**
 * Statuses that mean the signal is finished.
 *
 * TP1_HIT and TP2_HIT are included because `classifyOutcome` may be handed one
 * defensively, but in the live lifecycle they are *running* states: only
 * STOPPED, TP3_HIT, EXPIRED and CANCELLED end a signal, and only those carry a
 * `resultPnlPct`.
 */
const CLOSED = new Set(["TP1_HIT", "TP2_HIT", "TP3_HIT", "STOPPED", "EXPIRED", "CANCELLED"]);

/**
 * The subset of a stored Signal this module needs.
 *
 * Declared here rather than importing Prisma's generated type so the engine
 * stays pure — tests build these by hand, and nothing about outcome
 * classification depends on the database.
 */
export interface OutcomeSignal {
  side: "BUY" | "SELL";
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp3: number;
  status: string;
  resultPnlPct: number | null;
  timeframe: string;
  /** what each analyst said when the signal was created; [] for legacy rows */
  verdicts: AnalystVerdict[];
}

const EMPTY_EXCURSION: Excursion = {
  maxFavourableR: 0,
  maxAdverseR: 0,
  maxFavourablePct: 0,
  maxAdversePct: 0,
  bars: 0,
};

/**
 * Maximum favourable / adverse excursion between entry and close.
 *
 * Expressed in R (multiples of the initial stop distance) as well as percent,
 * because R is what makes excursions comparable across a 0.4 %-risk BTC
 * signal and a 6 %-risk altcoin signal.
 *
 * `candles` should start at or after the signal's creation time; anything
 * earlier is ignored so a pre-entry wick cannot be counted as an excursion.
 */
export function computeExcursion(
  candles: Candle[],
  signal: Pick<OutcomeSignal, "side" | "entry" | "stopLoss">,
  fromTime: number,
  toTime?: number
): Excursion {
  const risk = Math.abs(signal.entry - signal.stopLoss);
  const window = candles.filter((c) => c.time >= fromTime && (toTime === undefined || c.time <= toTime));
  if (window.length === 0 || risk <= 0) return { ...EMPTY_EXCURSION, bars: window.length };

  const isLong = signal.side === "BUY";
  const best = isLong
    ? Math.max(...window.map((c) => c.high))
    : Math.min(...window.map((c) => c.low));
  const worst = isLong
    ? Math.min(...window.map((c) => c.low))
    : Math.max(...window.map((c) => c.high));

  const favourable = isLong ? best - signal.entry : signal.entry - best;
  const adverse = isLong ? signal.entry - worst : worst - signal.entry;

  return {
    // Clamped at 0: an excursion is a distance travelled, so "the best move in
    // our favour" cannot be negative even if price never traded above entry.
    maxFavourableR: Number(Math.max(0, favourable / risk).toFixed(2)),
    maxAdverseR: Number(Math.max(0, adverse / risk).toFixed(2)),
    maxFavourablePct: Number(Math.max(0, (favourable / signal.entry) * 100).toFixed(2)),
    maxAdversePct: Number(Math.max(0, (adverse / signal.entry) * 100).toFixed(2)),
    bars: window.length,
  };
}

/** Verdicts that pointed the same way as the signal. */
function agreeing(signal: OutcomeSignal): AnalystVerdict[] {
  const want = signal.side === "BUY" ? "long" : "short";
  return signal.verdicts.filter((v) => v.qualified && v.direction === want);
}

/** Verdicts that pointed the opposite way. */
function opposing(signal: OutcomeSignal): AnalystVerdict[] {
  const other = signal.side === "BUY" ? "short" : "long";
  return signal.verdicts.filter((v) => v.qualified && v.direction === other);
}

function abstaining(signal: OutcomeSignal): AnalystKey[] {
  return signal.verdicts.filter((v) => !v.qualified).map((v) => v.analyst);
}

/** The agreeing analyst with the largest quality-weighted contribution. */
function topContributor(verdicts: AnalystVerdict[]): AnalystKey | null {
  if (verdicts.length === 0) return null;
  return verdicts.reduce((best, v) =>
    (v.confidence / 100) * QUALITY_WEIGHT[v.analyst] >
    (best.confidence / 100) * QUALITY_WEIGHT[best.analyst]
      ? v
      : best
  ).analyst;
}

/**
 * Which confirmation actually played out.
 *
 * On a win, that's the agreeing analyst whose own projected target price was
 * reached — evidence its read was right, not merely aligned. Falls back to the
 * biggest contributor when no analyst quoted a reachable target.
 */
function workingConfirmation(
  signal: OutcomeSignal,
  reachedPrice: number
): { text: string | null; analyst: AnalystKey | null } {
  const isLong = signal.side === "BUY";
  const hit = agreeing(signal)
    .filter((v) => v.target !== null)
    .filter((v) => (isLong ? reachedPrice >= v.target! : reachedPrice <= v.target!))
    // Furthest target that still got hit is the most impressive claim.
    .sort((a, b) => (isLong ? b.target! - a.target! : a.target! - b.target!));

  if (hit.length > 0) {
    const v = hit[0];
    return {
      text: `${v.name} — its ${v.target!.toFixed(6).replace(/0+$/, "")} target was reached; the read was "${v.evidence}"`,
      analyst: v.analyst,
    };
  }
  const top = topContributor(agreeing(signal));
  const v = signal.verdicts.find((x) => x.analyst === top);
  return {
    text: v ? `${v.name} contributed most: ${v.evidence}` : null,
    analyst: top,
  };
}

/**
 * Classify a closed signal.
 *
 * The failure taxonomy is ordered most-specific first: a stop-out on a
 * decisive-close signal that never went anywhere is a *false breakout*, which
 * is a far more useful fact than the generic "stopped out" it would otherwise
 * be recorded as.
 */
export function classifyOutcome(signal: OutcomeSignal, excursion: Excursion): OutcomeAnalysis {
  const isLong = signal.side === "BUY";
  const pnl = signal.resultPnlPct ?? 0;
  // The P/L is the ground truth, not the status. A signal that expired 1.4% up
  // made money and must not be run through the failure taxonomy; a TP1 that
  // later reversed into a net loss is a failure whatever its status says.
  const win = CLOSED.has(signal.status) && pnl > 0;

  const supporters = agreeing(signal);
  const opponents = opposing(signal);
  const abstained = abstaining(signal);

  // How far the winner got, in price terms, for the "which target was reached"
  // question. Derived from the excursion so it works even when the signal
  // closed at TP1 while price later ran further.
  const risk = Math.abs(signal.entry - signal.stopLoss);
  const reached = isLong
    ? signal.entry + excursion.maxFavourableR * risk
    : signal.entry - excursion.maxFavourableR * risk;

  const detail: string[] = [];
  let reason: OutcomeReason;
  let working: string | null = null;
  let analystsRight: AnalystKey[] = [];
  let analystsWrong: AnalystKey[] = [];
  /** An abstention is only *vindicated* when the signal actually failed. */
  let vindicatedAbstentions: AnalystKey[] = [];

  /**
   * A signal that expired flat is a statement about the *absence* of a move,
   * and that reading outranks the P/L sign: +0.1% is no more evidence that an
   * analyst was right than -0.1% is evidence it was wrong. `win` still follows
   * the P/L, so this module and the performance dashboard never disagree about
   * whether money was made — but nobody is charged or credited for it.
   */
  const noMove =
    signal.status === "EXPIRED" && Math.abs(pnl) < 0.5 && excursion.maxFavourableR < 0.5;

  if (noMove) {
    reason = "expired_no_move";
    detail.push(
      `Expired at ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}% having never travelled more than ${excursion.maxFavourableR.toFixed(2)}R either way. The direction was not wrong so much as absent — no analyst is charged or credited for a market that did nothing.`
    );
  } else if (win) {
    reason =
      signal.status === "TP3_HIT"
        ? "target_reached"
        : signal.status.startsWith("TP")
          ? "partial_target"
          : "closed_in_profit";
    const wc = workingConfirmation(signal, reached);
    working = wc.text;
    analystsRight = supporters.map((v) => v.analyst);
    analystsWrong = opponents.map((v) => v.analyst);

    detail.push(
      `${isLong ? "LONG" : "SHORT"} closed ${signal.status.replace("_", " ").toLowerCase()} for ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%.`
    );
    detail.push(
      `Price ran ${excursion.maxFavourableR.toFixed(2)}R (${excursion.maxFavourablePct.toFixed(2)}%) in favour and ${excursion.maxAdverseR.toFixed(2)}R (${excursion.maxAdversePct.toFixed(2)}%) against over ${excursion.bars} bars.`
    );
    if (excursion.maxAdverseR >= 0.7) {
      detail.push(
        `It came within ${(1 - excursion.maxAdverseR).toFixed(2)}R of the stop first — the entry was right but the level was tight.`
      );
    }
    if (wc.text) detail.push(`Confirmation that played out: ${wc.text}.`);
    if (opponents.length > 0) {
      detail.push(
        `${opponents.map((v) => v.name).join(" and ")} read this the other way and ${opponents.length === 1 ? "was" : "were"} wrong.`
      );
    }
  } else {
    // --- Failure classification, most specific first ---
    const closeVote = supporters.find((v) => v.analyst === "candleClose");
    const rangeVote = supporters.find((v) => v.analyst === "range");
    const weakClose = signal.verdicts.find(
      (v) => v.analyst === "candleClose" && !v.qualified && /marginal|weak/i.test(v.gate)
    );

    if (excursion.maxFavourableR >= 1) {
      // It worked, then it didn't. The entry read was vindicated; the exit or
      // the hold was the problem, so this is not the analysts being wrong.
      reason = "unexpected_reversal";
      detail.push(
        `Reached ${excursion.maxFavourableR.toFixed(2)}R in favour before reversing into the stop. The setup was correct and the move was there — this is a management outcome, not a bad read.`
      );
      analystsRight = supporters.map((v) => v.analyst);
    } else if (closeVote && excursion.maxFavourableR < 0.3) {
      reason = "false_breakout";
      const lvl = closeVote.entry;
      detail.push(
        `A decisive close through ${lvl !== null ? lvl.toFixed(6).replace(/0+$/, "") : "the key level"} failed immediately — only ${excursion.maxFavourableR.toFixed(2)}R of follow-through before the stop. This is the false-breakout case the module is meant to filter, and it slipped through.`
      );
      analystsWrong = supporters.map((v) => v.analyst);
    } else if (rangeVote && excursion.maxFavourableR < 0.3) {
      // A boundary trade that never got going: price went through the
      // boundary rather than rejecting from it.
      reason = rangeVote.invalidation !== null ? "range_invalidation" : "failed_rejection";
      detail.push(
        reason === "range_invalidation"
          ? `The range gave way — price closed through ${rangeVote.invalidation!.toFixed(6).replace(/0+$/, "")} and stayed out, so the boundary that justified the entry no longer existed.`
          : `The expected rejection at the ${isLong ? "range low" : "range high"} never came; price traded straight through the boundary.`
      );
      analystsWrong = supporters.map((v) => v.analyst);
    } else if (weakClose) {
      reason = "weak_candle_close";
      detail.push(
        `The candle-close analyst had already flagged this: ${weakClose.gate.replace(/^abstains — /, "")}. The signal rested on the other reads and the level did not hold.`
      );
      analystsWrong = supporters.map((v) => v.analyst);
    } else if (supporters.length > 0) {
      reason = "failed_rejection";
      detail.push(
        `Stopped out with ${excursion.maxFavourableR.toFixed(2)}R maximum favourable excursion — the expected reaction did not materialise.`
      );
      analystsWrong = supporters.map((v) => v.analyst);
    } else {
      reason = "other";
      detail.push(
        `Closed ${signal.status.toLowerCase()} at ${pnl.toFixed(2)}%. No analyst verdicts were recorded on this signal, so it cannot be attributed.`
      );
    }

    if (opponents.length > 0) {
      detail.push(
        `${opponents.map((v) => v.name).join(" and ")} disagreed at signal time and ${opponents.length === 1 ? "was" : "were"} right.`
      );
      analystsRight = [...analystsRight, ...opponents.map((v) => v.analyst)];
    }
    if (abstained.length > 0) {
      const names = signal.verdicts.filter((v) => !v.qualified).map((v) => v.name);
      detail.push(`${names.join(" and ")} abstained and ${names.length === 1 ? "was" : "were"} vindicated.`);
      vindicatedAbstentions = abstained;
    }
    detail.push(
      `Excursion: ${excursion.maxFavourableR.toFixed(2)}R favourable / ${excursion.maxAdverseR.toFixed(2)}R adverse over ${excursion.bars} bars.`
    );
  }

  return {
    win,
    reason,
    reasonLabel: REASON_LABEL[reason],
    detail,
    workingConfirmation: working,
    topContributor: topContributor(supporters),
    // De-duplicated: an analyst can land in `right` from two branches above.
    analystsRight: [...new Set(analystsRight)],
    analystsWrong: [...new Set(analystsWrong)],
    analystsAbstained: vindicatedAbstentions,
    excursion,
  };
}
