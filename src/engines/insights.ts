import { Bias, Candle, FullAnalysis, Insight } from "./types";

type A = Omit<FullAnalysis, "setup" | "insights" | "bias" | "bullishProbability" | "bearishProbability">;

/**
 * AI market intelligence feed — the running commentary of a desk analyst.
 *
 * Three things separate this from a list of labels:
 *
 * **Every line is anchored to a candle.** An observation like "buyers absorbed
 * sellers" is a statement about one bar. The sweep that noticed it ran later —
 * on a 4h chart, potentially hours later — so a single timestamp conflates two
 * different questions: when did this happen, and how stale is the reading.
 * Each insight therefore carries `barTime` (the candle it describes) alongside
 * `time` (when the system said it), plus `barsAgo` so the reader can see at a
 * glance whether it is about the live bar or something four bars back.
 *
 * **Every line carries a confidence.** Not all evidence is equal: absorption
 * measured at a mapped level is a stronger claim than a volume note. Ranking by
 * it puts the load-bearing observations at the top instead of leaving the feed
 * in the arbitrary order the engines happen to run.
 *
 * **The feed states its own confluence.** The final line counts how many
 * *distinct categories* — order flow, structure, liquidity, liquidation,
 * volume, pattern — point the same way, because five order-flow lines are one
 * mechanism described five times, not five confirmations.
 *
 * None of this makes the read a forecast. Confidence is conviction that the
 * observation is real, never a probability that a trade works.
 */

interface PushOpts {
  /** the event's own timestamp; snapped to the candle containing it */
  at?: number;
  /** 0-100 conviction in the observation itself */
  confidence?: number;
}

export function generateInsights(
  a: A,
  bullishProbability: number,
  candles: Candle[] = []
): Insight[] {
  const out: Insight[] = [];
  const now = a.generatedAt;

  /**
   * Snap an arbitrary event time onto the bar that contains it.
   *
   * Engines report times in their own terms — some the bar's open, some a
   * derived moment inside it — so the raw value cannot be shown as "the
   * candle" without first resolving which candle that is. Falls back to the
   * forming bar when a source carries no time of its own, which is honest:
   * those observations really are about the live bar.
   */
  const resolveBar = (at?: number): { barTime: number; barsAgo: number } => {
    if (candles.length === 0) return { barTime: at ?? now, barsAgo: 0 };
    const lastIdx = candles.length - 1;
    if (at == null) return { barTime: candles[lastIdx].time, barsAgo: 0 };

    // Ascending by open time, so a binary search finds the last bar that
    // opened at or before the event.
    let lo = 0;
    let hi = lastIdx;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (candles[mid].time <= at) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (idx < 0) idx = 0;
    return { barTime: candles[idx].time, barsAgo: lastIdx - idx };
  };

  const push = (
    category: Insight["category"],
    severity: Insight["severity"],
    bias: Bias,
    headline: string,
    detail: string,
    opts: PushOpts = {}
  ) => {
    const { barTime, barsAgo } = resolveBar(opts.at);
    out.push({
      time: now,
      barTime,
      barsAgo,
      barTimeframe: a.timeframe,
      confidence: Math.round(Math.max(0, Math.min(100, opts.confidence ?? 55))),
      severity,
      category,
      headline,
      detail,
      bias,
    });
  };

  const lastBarTime = candles[candles.length - 1]?.time;

  // --- Order flow ---
  if (a.orderFlow.absorption.present) {
    push("order_flow", "critical", a.orderFlow.absorption.side === "buy" ? "bullish" : "bearish",
      a.orderFlow.absorption.side === "buy" ? "Buyers are absorbing aggressive sellers" : "Sellers are absorbing aggressive buyers",
      a.orderFlow.absorption.note,
      { confidence: 78 });
  }
  if (a.orderFlow.aggression !== "balanced") {
    const share = a.orderFlow.aggression === "buyers" ? a.orderFlow.buyPressure : a.orderFlow.sellPressure;
    push("order_flow", "info", a.orderFlow.aggression === "buyers" ? "bullish" : "bearish",
      a.orderFlow.aggression === "buyers" ? "Aggressive buy flow dominating" : "Aggressive sell flow dominating",
      `${share}% of taker flow over the last 30 bars is ${a.orderFlow.aggression === "buyers" ? "buying" : "selling"}; cumulative delta is ${a.orderFlow.cumulativeDelta >= 0 ? "positive" : "negative"}.`,
      // A 52/48 split is noise; 70/30 is a read. Scale with the skew rather
      // than treating every non-balanced tape as equally informative.
      { confidence: Math.min(85, 40 + (share - 50) * 1.6) });
  }
  if (a.volume.delta > 0 && a.volume.relative > 1.1) {
    push("order_flow", "info", "bullish", "Delta is turning positive",
      `Current bar delta is +${a.volume.delta.toFixed(0)} on ${a.volume.relative.toFixed(1)}x average volume — buy-side aggression is being rewarded.`,
      { at: lastBarTime, confidence: Math.min(80, 45 + a.volume.relative * 10) });
  } else if (a.volume.delta < 0 && a.volume.relative > 1.1) {
    push("order_flow", "info", "bearish", "Delta is turning negative",
      `Current bar delta is ${a.volume.delta.toFixed(0)} on ${a.volume.relative.toFixed(1)}x average volume — sell-side aggression is being rewarded.`,
      { at: lastBarTime, confidence: Math.min(80, 45 + a.volume.relative * 10) });
  }
  if (a.orderFlow.largeOrders.length > 0) {
    const lo = a.orderFlow.largeOrders[a.orderFlow.largeOrders.length - 1];
    push("order_flow", "warning", lo.side === "buy" ? "bullish" : "bearish",
      "Large orders detected",
      `A ${lo.volume.toFixed(0)}-contract ${lo.side} print hit the tape — 2.5x the average bar. Whales are active at these prices.`,
      { at: lo.time, confidence: 62 });
  }
  if (a.orderFlow.exhaustion.present) {
    push("order_flow", "warning", a.orderFlow.exhaustion.side === "buy" ? "bearish" : "bullish",
      "Momentum is weakening", a.orderFlow.exhaustion.note, { confidence: 66 });
  }

  // --- Liquidations ---
  const lastLiq = a.liquidations.recentEvents[a.liquidations.recentEvents.length - 1];
  if (lastLiq) {
    push("liquidation", lastLiq.intensity > 60 ? "critical" : "warning",
      lastLiq.side === "long" ? "bearish" : "bullish",
      lastLiq.side === "long" ? "Long liquidations increasing" : "Short liquidations increasing",
      `${lastLiq.note} Intensity ${lastLiq.intensity}/100.` +
      (a.liquidations.likelyFakeMove ? " Price is already reclaiming the flush — engineered move, reversal odds elevated." : ""),
      { at: lastLiq.time, confidence: Math.min(90, 45 + lastLiq.intensity * 0.5) });
  }
  if (a.liquidations.cascadeRisk > 50) {
    push("liquidation", "warning", "neutral", "Liquidation cascade risk elevated",
      `Cascade risk ${a.liquidations.cascadeRisk}/100 — stacked same-side liquidations can chain into the next cluster. This describes what is loaded, not that it will fire.`,
      { confidence: a.liquidations.cascadeRisk });
  }

  // --- Liquidity ---
  const lastSweep = a.liquidity.sweeps[a.liquidity.sweeps.length - 1];
  if (lastSweep) {
    push("liquidity", "critical", lastSweep.direction === "below" ? "bullish" : "bearish",
      lastSweep.direction === "below" ? "Whales entered after liquidity sweep below lows" : "Distribution after liquidity sweep above highs",
      lastSweep.explanation.join(" "),
      { at: lastSweep.time, confidence: 74 });
  }
  for (const s of a.liquidity.summary) {
    if (s.includes("magnet")) {
      push("liquidity", "info", "neutral", "Liquidity above/below is the next target", s, { confidence: 52 });
      break;
    }
  }

  // --- Structure ---
  push("structure", "info", a.structure.trend,
    a.structure.trend === "bullish" ? "Market structure remains bullish"
      : a.structure.trend === "bearish" ? "Market structure remains bearish"
      : "Market structure is neutral",
    a.structure.summary.join(" "),
    { confidence: a.structure.trend === "neutral" ? 45 : 68 });
  if (a.structure.internalTrend !== a.structure.trend && a.structure.internalTrend !== "neutral") {
    push("structure", "warning", a.structure.internalTrend, "Potential reversal forming",
      `Internal structure shifted ${a.structure.internalTrend} against the external ${a.structure.trend} trend — early reversal warning. Reversal probability ${a.structure.reversalProbability}%.`,
      { confidence: a.structure.reversalProbability });
  }

  // --- Phase read (accumulation / distribution) ---
  if (a.structure.isRange) {
    const phase = a.orderFlow.cumulativeDelta > 0 ? "accumulation" : "distribution";
    push("phase", "warning", phase === "accumulation" ? "bullish" : "bearish",
      phase === "accumulation" ? "Current move appears to be accumulation" : "Distribution phase detected",
      `Price is ranging while cumulative delta is ${a.orderFlow.cumulativeDelta > 0 ? "positive — passive buyers accumulating inside the range" : "negative — inventory being distributed into passive bids"}.`,
      { confidence: 60 });
  }

  // --- Volume ---
  for (const n of a.volume.notes.slice(0, 2)) {
    push("volume", "info", a.volume.delta >= 0 ? "bullish" : "bearish", "Volume behavior shift", n,
      { at: lastBarTime, confidence: 50 });
  }

  // --- Patterns ---
  const strongPattern = [...a.patterns].reverse().find((p) => p.strength >= 60);
  if (strongPattern) {
    push("pattern", "info", strongPattern.direction, `${strongPattern.name} printed`,
      `${strongPattern.context} Strength ${strongPattern.strength}/100, contextual success probability ${strongPattern.probability}%.`,
      { at: strongPattern.time, confidence: strongPattern.strength });
  }

  // --- Volume profile / auction theory ---
  const vp = a.volumeProfile;
  push("volume", "info",
    vp.acceptance === "above_value" ? "bullish" : vp.acceptance === "below_value" ? "bearish" : "neutral",
    vp.auctionState === "balance" ? "Market is balanced inside value" : "Market is imbalanced, seeking new value",
    `${vp.summary[2] ?? ""} POC sits at ${vp.poc.toFixed(4)}, value area ${vp.val.toFixed(4)}–${vp.vah.toFixed(4)}.`,
    { confidence: 56 });
  if (vp.shape === "P" || vp.shape === "b") {
    push("phase", "warning", vp.shape === "b" ? "bullish" : "bearish",
      vp.shape === "P" ? "P-shaped profile — short covering, not fresh buying" : "b-shaped profile — long liquidation, not fresh selling",
      vp.summary.find((s) => s.includes("shaped")) ?? "",
      { confidence: 64 });
  }

  // --- Absorption at key levels ---
  const abs = a.orderFlowEvents.absorptions[a.orderFlowEvents.absorptions.length - 1];
  if (abs) {
    push("order_flow", abs.atKeyLevel ? "critical" : "info", abs.side === "buy" ? "bullish" : "bearish",
      abs.side === "buy"
        ? `Buyers absorbing aggressive sellers${abs.atKeyLevel ? " at a key level" : ""}`
        : `Sellers absorbing aggressive buyers${abs.atKeyLevel ? " at a key level" : ""}`,
      abs.explanation,
      // Absorption is the mechanism itself rather than a trace of it, and at a
      // mapped level it is the strongest single reading in this feed.
      { at: abs.time, confidence: abs.atKeyLevel ? 85 : 70 });
  }

  // --- Exhaustion ---
  const exh = a.orderFlowEvents.exhaustions[a.orderFlowEvents.exhaustions.length - 1];
  if (exh) {
    push("order_flow", exh.stage === "danger" ? "critical" : "warning",
      exh.side === "buy" ? "bearish" : "bullish",
      exh.side === "buy" ? "Buyers are exhausting" : "Sellers are exhausting",
      exh.explanation,
      { at: exh.time, confidence: exh.stage === "danger" ? 76 : 62 });
  }

  // --- Trapped traders ---
  const trap = a.orderFlowEvents.trapped[a.orderFlowEvents.trapped.length - 1];
  if (trap) {
    push("liquidity", "critical", trap.side === "buyers" ? "bearish" : "bullish",
      trap.side === "buyers" ? "Buyers are trapped at the highs" : "Sellers are trapped at the lows",
      trap.explanation,
      { at: trap.time, confidence: 74 });
  }

  // --- CVD divergence ---
  const div = a.delta.divergences[a.delta.divergences.length - 1];
  if (div) {
    push("order_flow", "critical",
      div.kind.includes("bullish") ? "bullish" : "bearish",
      div.kind.startsWith("regular") ? "Cumulative delta is diverging from price" : "Hidden delta divergence — continuation signal",
      div.explanation,
      { at: div.time, confidence: 72 });
  }

  // --- Footprint: stacked imbalance / delta divergence bars ---
  const lastFp = a.footprint.candles[a.footprint.candles.length - 1];
  if (lastFp?.stackedImbalances.length) {
    const si = lastFp.stackedImbalances[lastFp.stackedImbalances.length - 1];
    push("order_flow", "warning", si.direction === "buy" ? "bullish" : "bearish",
      `Stacked ${si.direction} imbalance on the current bar`,
      `${si.count} consecutive price levels where aggressive ${si.direction === "buy" ? "buyers" : "sellers"} gave the other side no opportunity to fill (${si.fromPrice.toFixed(4)}–${si.toPrice.toFixed(4)}). One-sided auctions like this tend to extend.`,
      { at: lastFp.time, confidence: Math.min(82, 50 + si.count * 6) });
  }

  // --- Liquidation delta ---
  if (a.liquidationDelta.dominantSide !== "balanced") {
    push("liquidation", "info",
      a.liquidationDelta.dominantSide === "long" ? "bullish" : "bearish",
      a.liquidationDelta.dominantSide === "long" ? "Forced flow dominated by long liquidations" : "Forced flow dominated by short liquidations",
      a.liquidationDelta.summary.join(" "),
      { confidence: 58 });
  }

  // --- VWAP / MA / Fib context ---
  push("structure", "info", a.vwap.position === "above" ? "bullish" : "bearish",
    `Price is ${a.vwap.position} session VWAP`, a.vwap.summary.join(" "), { confidence: 48 });
  if (a.fibonacci.activeLevel) {
    push("structure", "info", a.fibonacci.direction === "up" ? "bullish" : "bearish",
      `Reacting at the ${a.fibonacci.activeLevel.label} Fibonacci retracement`,
      a.fibonacci.summary.join(" "), { confidence: 52 });
  }

  // --- Unswept equal-level liquidity ---
  const unswept = a.equalLevels.filter((l) => !l.swept)[0];
  if (unswept) {
    push("liquidity", "info", unswept.kind === "EQH" ? "bullish" : "bearish",
      `Unswept ${unswept.kind === "EQH" ? "equal highs" : "equal lows"} at ${unswept.price.toFixed(4)}`,
      unswept.note, { confidence: 54 });
  }

  /* ------------------------------------------------------------------ *
   * Confluence synthesis
   *
   * Counts distinct *categories* on each side, not lines. The order-flow
   * block alone can emit six entries from one tape reading; treating those as
   * six confirmations would let a single mechanism outvote everything else.
   * ------------------------------------------------------------------ */
  const kindsFor = (bias: Bias) =>
    [...new Set(out.filter((i) => i.bias === bias && i.confidence >= 55).map((i) => i.category))];
  const bullKinds = kindsFor("bullish");
  const bearKinds = kindsFor("bearish");
  const lead = bullKinds.length >= bearKinds.length ? "bullish" : "bearish";
  const leadKinds = lead === "bullish" ? bullKinds : bearKinds;
  const againstKinds = lead === "bullish" ? bearKinds : bullKinds;

  push("signal", "info",
    bullishProbability >= 55 ? "bullish" : bullishProbability <= 45 ? "bearish" : "neutral",
    `Composite bias: ${bullishProbability}% bullish / ${100 - bullishProbability}% bearish`,
    `Weighted blend of structure, order flow, footprint, volume profile, delta, liquidity, liquidations and pattern engines. ` +
    (leadKinds.length === 0
      ? "No category reached the confidence bar this pass, so the composite rests on weak evidence."
      : `${leadKinds.length} distinct ${leadKinds.length === 1 ? "category" : "categories"} (${leadKinds.join(", ")}) read ${lead}` +
        (againstKinds.length > 0
          ? `, against ${againstKinds.length} reading the other way (${againstKinds.join(", ")}) — evidence is split, which is itself information.`
          : ` with nothing of confidence arguing the other side.`)) +
    ` Confidence figures are conviction that each observation is real, not the odds a trade works.`,
    { confidence: Math.max(40, Math.min(90, 40 + leadKinds.length * 9 - againstKinds.length * 6)) });

  /* Rank: severity first, then conviction, then how recent the bar is. An
   * unordered feed buries the one line that mattered under six routine ones. */
  const sevRank = { critical: 0, warning: 1, info: 2 } as const;
  out.sort(
    (x, y) =>
      sevRank[x.severity] - sevRank[y.severity] ||
      y.confidence - x.confidence ||
      x.barsAgo - y.barsAgo
  );

  return out;
}
