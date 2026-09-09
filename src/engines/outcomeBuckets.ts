import { OutcomeAnalysis } from "./types";

/**
 * The single definition of "how did this signal end".
 *
 * Signal History, the performance service, the record page and the dashboard
 * counters all need the same answer, and three copies of the rule drifted apart
 * the moment one of them changed. This module owns it.
 *
 * The buckets:
 *
 *   active      — still running. A position with a target tagged is still open.
 *   successful  — reached its first target at any point. The call was right and
 *                 the first target paid; what happened to the remainder is a
 *                 management question, not a question about the read.
 *   breakeven   — closed at a stop that had already been moved to entry or
 *                 better, without reaching TP1. Neither a win nor a loss.
 *   failed      — closed without reaching TP1 and without that protection.
 *
 * ## Why breakeven is its own bucket
 *
 * Because it is genuinely neither outcome, and forcing it into either one
 * lies in a specific direction. Counted as a loss, active management looks
 * like it damages the record — every trade saved from a full stop becomes a
 * mark against the engine. Counted as a win, the record fills with trades that
 * made nothing. It is excluded from the win rate entirely and reported beside
 * it, so the denominator only ever contains trades that actually resolved one
 * way or the other.
 *
 * ## Why TP1 is the bar for success
 *
 * The first target is what the signal is really claiming: that price will move
 * a stated distance in a stated direction before the invalidation level. Once
 * the stop is moved to break-even at TP1, a trade that reaches it cannot become
 * a loss — so "reached TP1" and "did not lose" are the same event, and the
 * former is the honest way to describe it.
 */

export type OutcomeBucket =
  /** published, waiting for price to reach the entry — no position yet */
  | "pending"
  /** published, price never came, closed without ever being a position */
  | "unfilled"
  | "active"
  | "successful"
  | "breakeven"
  | "failed";

export const ACTIVE_STATUSES = ["ACTIVE", "TP1_HIT", "TP2_HIT"] as const;
/** Statuses that end a signal and carry a realised P/L. */
export const RESOLVED_STATUSES = ["TP3_HIT", "STOPPED", "EXPIRED", "BREAKEVEN"] as const;

export interface BucketInput {
  status: string;
  resultPnlPct: number | null;
  outcomeAnalysis?: OutcomeAnalysis | null;
}

export function isActiveStatus(status: string): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(status);
}

/**
 * Did the trade ever tag its first target?
 *
 * `targetProgressPct` is measured from entry to TP1 and is deliberately not
 * clamped, so 100 or more means the level was reached at some point — even if
 * the status now reads STOPPED because price came back through the entry.
 *
 * Returns false when the figure is unknown (legacy rows, or a signal that
 * quoted no first target). Unknown must not be treated as "reached", or every
 * pre-migration loss would be relabelled a success.
 */
export function reachedFirstTarget(signal: BucketInput): boolean {
  // TP3 can only be tagged by passing through TP1, whatever the analysis says.
  if (signal.status === "TP3_HIT") return true;
  const progress = signal.outcomeAnalysis?.excursion?.targetProgressPct;
  return typeof progress === "number" && progress >= 100;
}

export function classifyBucket(signal: BucketInput): OutcomeBucket {
  /* These two come first and are not optional. Neither status is in
     ACTIVE_STATUSES, so without an explicit case both fell through the whole
     chain to "failed" — a signal whose entry price was never reached would
     have been recorded as a losing trade, which is the phantom-fill bug
     wearing the opposite sign. */
  if (signal.status === "PENDING") return "pending";
  if (signal.status === "UNFILLED") return "unfilled";
  if (isActiveStatus(signal.status)) return "active";
  // Reaching the first target is the claim the signal actually made, so it
  // outranks the closing price: a trade that ran to TP1 and was then walked
  // out at break-even was a correct call, managed.
  if (reachedFirstTarget(signal)) return "successful";
  if (signal.status === "BREAKEVEN") return "breakeven";
  if ((signal.resultPnlPct ?? 0) > 0) return "successful";
  return "failed";
}

/** Convenience predicates, so call sites read as prose. */
export const isSuccessful = (s: BucketInput) => classifyBucket(s) === "successful";
export const isBreakEven = (s: BucketInput) => classifyBucket(s) === "breakeven";
export const isFailed = (s: BucketInput) => classifyBucket(s) === "failed";

/**
 * Weighted score for accuracy reporting.
 *
 * Only wins score. Break-evens are removed from the denominator rather than
 * scored zero — see `resolvedCount`, which is the divisor every rate here
 * should use.
 */
export function bucketScore(bucket: OutcomeBucket): number {
  return bucket === "successful" ? 1 : 0;
}

/**
 * The denominator for every win rate in the app.
 *
 * Wins plus losses, and nothing else. Break-evens resolved without resolving
 * the question the rate is asking, and running trades have not resolved at all.
 */
export function resolvedCount(counts: Record<OutcomeBucket, number>): number {
  return counts.successful + counts.failed;
}

/** Win rate over decided trades, or null when none have decided. */
export function winRate(counts: Record<OutcomeBucket, number>): number | null {
  const decided = resolvedCount(counts);
  if (decided === 0) return null;
  return Number(((counts.successful / decided) * 100).toFixed(1));
}

export const BUCKET_LABEL: Record<OutcomeBucket, string> = {
  pending: "Waiting to fill",
  unfilled: "Never filled",
  active: "Running",
  successful: "Successful — reached TP1",
  breakeven: "Break-even — protected, then retraced",
  failed: "Failed",
};
