import { TIMEFRAME_MINUTES, Timeframe } from "@/lib/config";
import { FullAnalysis, StrategyScore, TradeSetup } from "./types";

type AnalysisCore = Omit<FullAnalysis, "setup" | "insights" | "bias" | "bullishProbability" | "bearishProbability">;

/**
 * Confidence engine: blends weighted strategy scores into a directional
 * probability. The mapping is deliberately conservative — scores saturate
 * with tanh so stacked confluence increases confidence with diminishing
 * returns and can never reach 100%.
 */
export function computeConfidence(scores: StrategyScore[]): {
  netScore: number;
  bullishProbability: number;
  bearishProbability: number;
  confidence: number;
  label: TradeSetup["confidenceLabel"];
} {
  const active = scores.filter((s) => s.weight > 0);
  const totalWeight = active.reduce((s, x) => s + x.weight, 0) || 1;
  const netScore = active.reduce((s, x) => s + x.score * x.weight, 0) / totalWeight;

  // tanh squash: netScore 0 -> 50/50, ±60 -> ~88/12
  const squashed = Math.tanh(netScore / 40);
  const bullishProbability = Math.round(50 + squashed * 42);
  const bearishProbability = 100 - bullishProbability;
  const confidence = Math.max(bullishProbability, bearishProbability);

  const label: TradeSetup["confidenceLabel"] =
    confidence >= 85 ? "Very Strong" : confidence >= 75 ? "Strong" : confidence >= 65 ? "Moderate" : "Weak";

  return { netScore, bullishProbability, bearishProbability, confidence, label };
}

/**
 * Build a complete trade setup from the analysis. Stops go beyond structural
 * invalidation (swing + liquidity), targets ladder into resting liquidity
 * and the measured range, and RR is computed from actual levels — never
 * fabricated.
 */
export function buildTradeSetup(
  analysis: AnalysisCore,
  scores: StrategyScore[],
  timeframe: Timeframe,
  minConfidence = 65
): TradeSetup | null {
  const { bullishProbability, bearishProbability, confidence, label } = computeConfidence(scores);
  if (confidence < minConfidence) return null;

  const side: "BUY" | "SELL" = bullishProbability >= bearishProbability ? "BUY" : "SELL";
  const price = analysis.price;
  const atr = estimateATR(analysis);

  const majors = analysis.structure.swings.filter((s) => s.degree === "major");
  const lastSwingLow = [...majors].reverse().find((s) => s.kind === "low" && s.price < price);
  const lastSwingHigh = [...majors].reverse().find((s) => s.kind === "high" && s.price > price);

  let entry = price;
  let stopLoss: number;
  let tp1: number, tp2: number, tp3: number;

  if (side === "BUY") {
    // Prefer entry at a nearby demand zone / bullish OB / FVG if price is just above one.
    const zone = [...analysis.orderBlocks, ...analysis.fvgs, ...analysis.supplyDemand]
      .filter((z) => z.direction === "bullish" && z.status !== "mitigated" && z.status !== "filled")
      .filter((z) => z.top <= price * 1.002 && z.top >= price * 0.99)
      .sort((a, b) => b.top - a.top)[0];
    if (zone) entry = Math.min(price, zone.top);

    const structuralStop = lastSwingLow ? lastSwingLow.price : entry - atr * 2;
    stopLoss = Math.min(structuralStop, entry - atr * 0.8) - atr * 0.25;

    const risk = entry - stopLoss;
    const liqTargets = analysis.liquidity.levels
      .filter((l) => !l.swept && l.price > entry * 1.002)
      .map((l) => l.price)
      .sort((a, b) => a - b);
    tp1 = liqTargets[0] ?? entry + risk * 1.5;
    tp2 = liqTargets[1] ?? Math.max(tp1 + risk, entry + risk * 2.5);
    tp3 = liqTargets[2] ?? Math.max(tp2 + risk, entry + risk * 4);
    // Ensure targets are ordered and give at least 1R on TP1.
    if (tp1 - entry < risk) tp1 = entry + risk * 1.2;
    if (tp2 <= tp1) tp2 = tp1 + risk;
    if (tp3 <= tp2) tp3 = tp2 + risk * 1.5;
  } else {
    const zone = [...analysis.orderBlocks, ...analysis.fvgs, ...analysis.supplyDemand]
      .filter((z) => z.direction === "bearish" && z.status !== "mitigated" && z.status !== "filled")
      .filter((z) => z.bottom >= price * 0.998 && z.bottom <= price * 1.01)
      .sort((a, b) => a.bottom - b.bottom)[0];
    if (zone) entry = Math.max(price, zone.bottom);

    const structuralStop = lastSwingHigh ? lastSwingHigh.price : entry + atr * 2;
    stopLoss = Math.max(structuralStop, entry + atr * 0.8) + atr * 0.25;

    const risk = stopLoss - entry;
    const liqTargets = analysis.liquidity.levels
      .filter((l) => !l.swept && l.price < entry * 0.998)
      .map((l) => l.price)
      .sort((a, b) => b - a);
    tp1 = liqTargets[0] ?? entry - risk * 1.5;
    tp2 = liqTargets[1] ?? Math.min(tp1 - risk, entry - risk * 2.5);
    tp3 = liqTargets[2] ?? Math.min(tp2 - risk, entry - risk * 4);
    if (entry - tp1 < risk) tp1 = entry - risk * 1.2;
    if (tp2 >= tp1) tp2 = tp1 - risk;
    if (tp3 >= tp2) tp3 = tp2 - risk * 1.5;
  }

  const risk = Math.abs(entry - stopLoss);
  const reward = Math.abs(tp2 - entry);
  const riskReward = risk > 0 ? Number((reward / risk).toFixed(2)) : 0;
  if (riskReward < 1) return null; // never emit negative-expectancy geometry

  const expectedMovePct = Number((((tp2 - entry) / entry) * 100).toFixed(2));
  const tfMin = TIMEFRAME_MINUTES[timeframe] ?? 60;
  const estHoldingMin = Math.round(tfMin * 8 * (Math.abs(expectedMovePct) / Math.max(0.2, (atr / entry) * 100)));

  const reasoning = scores
    .filter((s) => s.weight > 0 && Math.abs(s.score) > 5 && Math.sign(s.score) === (side === "BUY" ? 1 : -1))
    .flatMap((s) => s.reasons)
    .slice(0, 10);

  const invalidation: string[] = [];
  if (side === "BUY") {
    invalidation.push(`Candle close below ${stopLoss.toFixed(4)} invalidates the structural basis of this long.`);
    if (lastSwingLow) invalidation.push(`Break of the protected swing low at ${lastSwingLow.price.toFixed(4)} flips structure bearish.`);
    invalidation.push("Cumulative delta turning sharply negative while price stalls would signal absorbed buying — exit early.");
  } else {
    invalidation.push(`Candle close above ${stopLoss.toFixed(4)} invalidates the structural basis of this short.`);
    if (lastSwingHigh) invalidation.push(`Break of the protected swing high at ${lastSwingHigh.price.toFixed(4)} flips structure bullish.`);
    invalidation.push("Cumulative delta turning sharply positive while price stalls would signal absorbed selling — exit early.");
  }

  return {
    side,
    entry: round(entry),
    stopLoss: round(stopLoss),
    tp1: round(tp1),
    tp2: round(tp2),
    tp3: round(tp3),
    riskReward,
    expectedMovePct,
    estHoldingMin: Math.min(Math.max(estHoldingMin, tfMin * 2), tfMin * 60),
    confidence,
    confidenceLabel: label,
    reasoning,
    invalidation,
    strategyScores: scores,
  };
}

function estimateATR(analysis: AnalysisCore): number {
  // Approximate ATR from the dealing range when raw candles aren't at hand.
  const span = analysis.premiumDiscount.rangeHigh - analysis.premiumDiscount.rangeLow;
  return Math.max(span / 20, analysis.price * 0.002);
}

function round(v: number): number {
  const magnitude = Math.abs(v);
  const decimals = magnitude >= 1000 ? 1 : magnitude >= 100 ? 2 : magnitude >= 1 ? 4 : 6;
  return Number(v.toFixed(decimals));
}
