import { OutcomeAnalysis } from "./types";

/**
 * The single definition of "how did this signal end".
 *
 * Signal History, the performance service and the dashboard counters all need
 * the same answer, and three copies of the rule drifted apart the moment one
 * of them changed. This module owns it.
 *
 * The buckets:
 *
 *   active      — still running (ACTIVE, TP1_HIT, TP2_HIT). A partial fill is
 *                 not an outcome; the position is open.
 *   successful  — closed with a positive realised P/L.
 *   partial     — closed at or below breakeven, BUT the trade reached its first
 *                 target before reversing.
 *   failed      — closed at or below breakeven without ever reaching TP1.
 *
 * `partial` exists because collapsing it into `failed` misrepresents both the
 * signal and the trader. A call that ran to its first target was directionally
 * right; giving the move back is a management outcome, not a bad read. Counting
 * those as outright failures understates the engine's accuracy and hides the
 * distinction that actually matters when reviewing losses — "wrong about
 * direction" versus "right, then held too long".
 */

export type OutcomeBucket = "active" | "successful" | "partial" | "failed";

export const ACTIVE_STATUSES = ["ACTIVE", "TP1_HIT", "TP2_HIT"] as const;
/** Statuses that end a signal and carry a realised P/L. */
export const RESOLVED_STATUSES = ["TP3_HIT", "STOPPED", "EXPIRED"] as const;

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
 * pre-migration loss would be relabelled a partial success.
 */
export function reachedFirstTarget(signal: BucketInput): boolean {
  // TP3 can only be tagged by passing through TP1, whatever the analysis says.
  if (signal.status === "TP3_HIT") return true;
  const progress = signal.outcomeAnalysis?.excursion?.targetProgressPct;
  return typeof progress === "number" && progress >= 100;
}

export function classifyBucket(signal: BucketInput): OutcomeBucket {
  if (isActiveStatus(signal.status)) return "active";
  if ((signal.resultPnlPct ?? 0) > 0) return "successful";
  return reachedFirstTarget(signal) ? "partial" : "failed";
}

/** Convenience predicates, so call sites read as prose. */
export const isSuccessful = (s: BucketInput) => classifyBucket(s) === "successful";
export const isPartial = (s: BucketInput) => classifyBucket(s) === "partial";
export const isFailed = (s: BucketInput) => classifyBucket(s) === "failed";

/**
 * Weighted score for accuracy reporting.
 *
 * A partial counts as half a win: the direction was right and the first target
 * paid, but the trade did not finish green. Scoring it 1.0 would flatter the
 * engine; scoring it 0 would punish a correct call for a management error.
 */
export function bucketScore(bucket: OutcomeBucket): number {
  if (bucket === "successful") return 1;
  if (bucket === "partial") return 0.5;
  return 0;
}

export const BUCKET_LABEL: Record<OutcomeBucket, string> = {
  active: "Running",
  successful: "Successful",
  partial: "Partial — reached TP1, then reversed",
  failed: "Failed",
};
