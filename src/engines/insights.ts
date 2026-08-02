import { Bias, FullAnalysis, Insight } from "./types";

type A = Omit<FullAnalysis, "setup" | "insights" | "bias" | "bullishProbability" | "bearishProbability">;

/**
 * AI market intelligence panel feed. Converts raw engine output into the
 * running commentary of an institutional analyst — every line carries the
 * evidence behind it, never a bare label.
 */
export function generateInsights(a: A, bullishProbability: number): Insight[] {
  const out: Insight[] = [];
  const now = a.generatedAt;
  const push = (
    category: Insight["category"],
    severity: Insight["severity"],
    bias: Bias,
    headline: string,
    detail: string
  ) => out.push({ time: now, severity, category, headline, detail, bias });

  // --- Order flow ---
  if (a.orderFlow.absorption.present) {
    push("order_flow", "critical", a.orderFlow.absorption.side === "buy" ? "bullish" : "bearish",
      a.orderFlow.absorption.side === "buy" ? "Buyers are absorbing aggressive sellers" : "Sellers are absorbing aggressive buyers",
      a.orderFlow.absorption.note);
  }
  if (a.orderFlow.aggression !== "balanced") {
    push("order_flow", "info", a.orderFlow.aggression === "buyers" ? "bullish" : "bearish",
      a.orderFlow.aggression === "buyers" ? "Aggressive buy flow dominating" : "Aggressive sell flow dominating",
      `${a.orderFlow.aggression === "buyers" ? a.orderFlow.buyPressure : a.orderFlow.sellPressure}% of taker flow over the last 30 bars is ${a.orderFlow.aggression === "buyers" ? "buying" : "selling"}; cumulative delta is ${a.orderFlow.cumulativeDelta >= 0 ? "positive" : "negative"}.`);
  }
  if (a.volume.delta > 0 && a.volume.relative > 1.1) {
    push("order_flow", "info", "bullish", "Delta is turning positive",
      `Current bar delta is +${a.volume.delta.toFixed(0)} on ${a.volume.relative.toFixed(1)}x average volume — buy-side aggression is being rewarded.`);
  } else if (a.volume.delta < 0 && a.volume.relative > 1.1) {
    push("order_flow", "info", "bearish", "Delta is turning negative",
      `Current bar delta is ${a.volume.delta.toFixed(0)} on ${a.volume.relative.toFixed(1)}x average volume — sell-side aggression is being rewarded.`);
  }
  if (a.orderFlow.largeOrders.length > 0) {
    const lo = a.orderFlow.largeOrders[a.orderFlow.largeOrders.length - 1];
    push("order_flow", "warning", lo.side === "buy" ? "bullish" : "bearish",
      "Large orders detected",
      `A ${lo.volume.toFixed(0)}-contract ${lo.side} print hit the tape — 2.5x the average bar. Whales are active at these prices.`);
  }
  if (a.orderFlow.exhaustion.present) {
    push("order_flow", "warning", a.orderFlow.exhaustion.side === "buy" ? "bearish" : "bullish",
      "Momentum is weakening", a.orderFlow.exhaustion.note);
  }

  // --- Liquidations ---
  const lastLiq = a.liquidations.recentEvents[a.liquidations.recentEvents.length - 1];
  if (lastLiq) {
    push("liquidation", lastLiq.intensity > 60 ? "critical" : "warning",
      lastLiq.side === "long" ? "bearish" : "bullish",
      lastLiq.side === "long" ? "Long liquidations increasing" : "Short liquidations increasing",
      `${lastLiq.note} Intensity ${lastLiq.intensity}/100.` +
      (a.liquidations.likelyFakeMove ? " Price is already reclaiming the flush — engineered move, reversal odds elevated." : ""));
  }
  if (a.liquidations.cascadeRisk > 50) {
    push("liquidation", "warning", "neutral", "Liquidation cascade risk elevated",
      `Cascade risk ${a.liquidations.cascadeRisk}/100 — stacked same-side liquidations can chain into the next cluster.`);
  }

  // --- Liquidity ---
  const lastSweep = a.liquidity.sweeps[a.liquidity.sweeps.length - 1];
  if (lastSweep) {
    push("liquidity", "critical", lastSweep.direction === "below" ? "bullish" : "bearish",
      lastSweep.direction === "below" ? "Whales entered after liquidity sweep below lows" : "Distribution after liquidity sweep above highs",
      lastSweep.explanation.join(" "));
  }
  for (const s of a.liquidity.summary) {
    if (s.includes("magnet")) {
      push("liquidity", "info", "neutral", "Liquidity above/below is the next target", s);
      break;
    }
  }

  // --- Structure ---
  push("structure", "info", a.structure.trend,
    a.structure.trend === "bullish" ? "Market structure remains bullish"
      : a.structure.trend === "bearish" ? "Market structure remains bearish"
      : "Market structure is neutral",
    a.structure.summary.join(" "));
  if (a.structure.internalTrend !== a.structure.trend && a.structure.internalTrend !== "neutral") {
    push("structure", "warning", a.structure.internalTrend, "Potential reversal forming",
      `Internal structure shifted ${a.structure.internalTrend} against the external ${a.structure.trend} trend — early reversal warning. Reversal probability ${a.structure.reversalProbability}%.`);
  }

  // --- Phase read (accumulation / distribution) ---
  if (a.structure.isRange) {
    const phase = a.orderFlow.cumulativeDelta > 0 ? "accumulation" : "distribution";
    push("phase", "warning", phase === "accumulation" ? "bullish" : "bearish",
      phase === "accumulation" ? "Current move appears to be accumulation" : "Distribution phase detected",
      `Price is ranging while cumulative delta is ${a.orderFlow.cumulativeDelta > 0 ? "positive — passive buyers accumulating inside the range" : "negative — inventory being distributed into passive bids"}.`);
  }

  // --- Volume ---
  for (const n of a.volume.notes.slice(0, 2)) {
    push("volume", "info", a.volume.delta >= 0 ? "bullish" : "bearish", "Volume behavior shift", n);
  }

  // --- Patterns ---
  const strongPattern = [...a.patterns].reverse().find((p) => p.strength >= 60);
  if (strongPattern) {
    push("pattern", "info", strongPattern.direction, `${strongPattern.name} printed`,
      `${strongPattern.context} Strength ${strongPattern.strength}/100, contextual success probability ${strongPattern.probability}%.`);
  }

  // --- Volume profile / auction theory ---
  const vp = a.volumeProfile;
  push("volume", "info",
    vp.acceptance === "above_value" ? "bullish" : vp.acceptance === "below_value" ? "bearish" : "neutral",
    vp.auctionState === "balance" ? "Market is balanced inside value" : "Market is imbalanced, seeking new value",
    `${vp.summary[2] ?? ""} POC sits at ${vp.poc.toFixed(4)}, value area ${vp.val.toFixed(4)}–${vp.vah.toFixed(4)}.`);
  if (vp.shape === "P" || vp.shape === "b") {
    push("phase", "warning", vp.shape === "b" ? "bullish" : "bearish",
      vp.shape === "P" ? "P-shaped profile — short covering, not fresh buying" : "b-shaped profile — long liquidation, not fresh selling",
      vp.summary.find((s) => s.includes("shaped")) ?? "");
  }

  // --- Absorption at key levels ---
  const abs = a.orderFlowEvents.absorptions[a.orderFlowEvents.absorptions.length - 1];
  if (abs) {
    push("order_flow", abs.atKeyLevel ? "critical" : "info", abs.side === "buy" ? "bullish" : "bearish",
      abs.side === "buy"
        ? `Buyers absorbing aggressive sellers${abs.atKeyLevel ? " at a key level" : ""}`
        : `Sellers absorbing aggressive buyers${abs.atKeyLevel ? " at a key level" : ""}`,
      abs.explanation);
  }

  // --- Exhaustion ---
  const exh = a.orderFlowEvents.exhaustions[a.orderFlowEvents.exhaustions.length - 1];
  if (exh) {
    push("order_flow", exh.stage === "danger" ? "critical" : "warning",
      exh.side === "buy" ? "bearish" : "bullish",
      exh.side === "buy" ? "Buyers are exhausting" : "Sellers are exhausting",
      exh.explanation);
  }

  // --- Trapped traders ---
  const trap = a.orderFlowEvents.trapped[a.orderFlowEvents.trapped.length - 1];
  if (trap) {
    push("liquidity", "critical", trap.side === "buyers" ? "bearish" : "bullish",
      trap.side === "buyers" ? "Buyers are trapped at the highs" : "Sellers are trapped at the lows",
      trap.explanation);
  }

  // --- CVD divergence ---
  const div = a.delta.divergences[a.delta.divergences.length - 1];
  if (div) {
    push("order_flow", "critical",
      div.kind.includes("bullish") ? "bullish" : "bearish",
      div.kind.startsWith("regular") ? "Cumulative delta is diverging from price" : "Hidden delta divergence — continuation signal",
      div.explanation);
  }

  // --- Footprint: stacked imbalance / delta divergence bars ---
  const lastFp = a.footprint.candles[a.footprint.candles.length - 1];
  if (lastFp?.stackedImbalances.length) {
    const si = lastFp.stackedImbalances[lastFp.stackedImbalances.length - 1];
    push("order_flow", "warning", si.direction === "buy" ? "bullish" : "bearish",
      `Stacked ${si.direction} imbalance on the current bar`,
      `${si.count} consecutive price levels where aggressive ${si.direction === "buy" ? "buyers" : "sellers"} gave the other side no opportunity to fill (${si.fromPrice.toFixed(4)}–${si.toPrice.toFixed(4)}). One-sided auctions like this tend to extend.`);
  }

  // --- Liquidation delta ---
  if (a.liquidationDelta.dominantSide !== "balanced") {
    push("liquidation", "info",
      a.liquidationDelta.dominantSide === "long" ? "bullish" : "bearish",
      a.liquidationDelta.dominantSide === "long" ? "Forced flow dominated by long liquidations" : "Forced flow dominated by short liquidations",
      a.liquidationDelta.summary.join(" "));
  }

  // --- VWAP / MA / Fib context ---
  push("structure", "info", a.vwap.position === "above" ? "bullish" : "bearish",
    `Price is ${a.vwap.position} session VWAP`, a.vwap.summary.join(" "));
  if (a.fibonacci.activeLevel) {
    push("structure", "info", a.fibonacci.direction === "up" ? "bullish" : "bearish",
      `Reacting at the ${a.fibonacci.activeLevel.label} Fibonacci retracement`,
      a.fibonacci.summary.join(" "));
  }

  // --- Unswept equal-level liquidity ---
  const unswept = a.equalLevels.filter((l) => !l.swept)[0];
  if (unswept) {
    push("liquidity", "info", unswept.kind === "EQH" ? "bullish" : "bearish",
      `Unswept ${unswept.kind === "EQH" ? "equal highs" : "equal lows"} at ${unswept.price.toFixed(4)}`,
      unswept.note);
  }

  // --- Net probability ---
  push("signal", "info", bullishProbability >= 55 ? "bullish" : bullishProbability <= 45 ? "bearish" : "neutral",
    `Composite bias: ${bullishProbability}% bullish / ${100 - bullishProbability}% bearish`,
    "Weighted blend of structure, order flow, footprint, volume profile, delta, liquidity, liquidations and pattern engines. See the signal panel for the full evidence stack.");

  return out;
}
