import { StrategyScore } from "./types";

/**
 * AI learning engine — adaptive strategy weighting.
 *
 * Every closed signal is scored against the strategies that voted for it.
 * Strategies that agreed with a winning trade earn weight; strategies that
 * pushed a losing trade lose weight. Updates are small (learning rate) and
 * bounded so no single trade can destabilize the ensemble, and every
 * adjustment is persisted as an immutable LearningRecord — history is never
 * deleted, so the model's evolution is fully auditable.
 */

export interface WeightAdjustment {
  key: string;
  before: number;
  after: number;
  delta: number;
  reason: string;
}

export interface TradeOutcome {
  side: "BUY" | "SELL";
  win: boolean;
  pnlPct: number;
}

const LEARNING_RATE = 0.04;
const MIN_WEIGHT = 0.1;
const MAX_WEIGHT = 2.5;

export function computeWeightAdjustments(
  strategyScores: StrategyScore[],
  outcome: TradeOutcome
): WeightAdjustment[] {
  const adjustments: WeightAdjustment[] = [];
  const direction = outcome.side === "BUY" ? 1 : -1;
  // Scale adjustment by trade magnitude, capped at 2R-ish moves.
  const magnitude = Math.min(2, Math.abs(outcome.pnlPct) / 1.5 + 0.5);

  for (const s of strategyScores) {
    if (s.weight <= 0 || Math.abs(s.score) < 5) continue;
    const agreedWithTrade = Math.sign(s.score) === direction;
    const correct = agreedWithTrade === outcome.win;
    const delta = (correct ? 1 : -1) * LEARNING_RATE * magnitude * (Math.abs(s.score) / 100);
    const after = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, s.weight + delta));
    if (Math.abs(after - s.weight) < 1e-6) continue;
    adjustments.push({
      key: s.key,
      before: Number(s.weight.toFixed(4)),
      after: Number(after.toFixed(4)),
      delta: Number((after - s.weight).toFixed(4)),
      reason: correct
        ? `${s.name} ${agreedWithTrade ? "supported" : "opposed"} this ${outcome.win ? "winning" : "losing"} ${outcome.side} and was proven right (${outcome.pnlPct.toFixed(2)}%)`
        : `${s.name} ${agreedWithTrade ? "supported" : "opposed"} this ${outcome.win ? "winning" : "losing"} ${outcome.side} and was proven wrong (${outcome.pnlPct.toFixed(2)}%)`,
    });
  }
  return adjustments;
}

/** Post-trade retrospective for the learning record. */
export function buildTradeRetrospective(
  strategyScores: StrategyScore[],
  outcome: TradeOutcome
): { successFactors: string[]; failureFactors: string[] } {
  const direction = outcome.side === "BUY" ? 1 : -1;
  const supporting = strategyScores.filter((s) => Math.sign(s.score) === direction && Math.abs(s.score) > 5);
  const opposing = strategyScores.filter((s) => Math.sign(s.score) === -direction && Math.abs(s.score) > 5);

  if (outcome.win) {
    return {
      successFactors: supporting.map((s) => `${s.name} correctly identified the move: ${s.reasons[0] ?? "confluence"}`),
      failureFactors: opposing.map((s) => `${s.name} argued against the trade and was wrong — its weight decreases`),
    };
  }
  return {
    successFactors: opposing.map((s) => `${s.name} warned against this trade: ${s.reasons[0] ?? "conflicting evidence"}`),
    failureFactors: supporting.map((s) => `${s.name} supported the losing trade — its weight decreases`),
  };
}
