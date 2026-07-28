import { FullAnalysis, StrategyScore } from "./types";

/**
 * Strategy engine.
 *
 * Each strategy inspects the shared FullAnalysis and emits a score in
 * [-100, +100] (negative = bearish conviction) plus human-readable reasons.
 * The confidence engine blends these using per-strategy weights that the
 * learning engine adapts from realized results — no strategy ever claims a
 * fixed accuracy; its live win rate is displayed instead.
 */

export interface StrategyDef {
  key: string;
  name: string;
  description: string;
  defaultWeight: number;
  evaluate: (a: Omit<FullAnalysis, "setup" | "insights" | "bias" | "bullishProbability" | "bearishProbability">) => { score: number; reasons: string[] };
}

type A = Parameters<StrategyDef["evaluate"]>[0];

const clamp = (v: number) => Math.max(-100, Math.min(100, v));

export const STRATEGIES: StrategyDef[] = [
  {
    key: "smc",
    name: "Smart Money Concepts",
    description: "Composite SMC read: structure + premium/discount + liquidity narrative.",
    defaultWeight: 1.3,
    evaluate: (a: A) => {
      let score = 0;
      const reasons: string[] = [];
      if (a.structure.trend === "bullish") { score += 30; reasons.push("External structure bullish (HH/HL sequence)"); }
      if (a.structure.trend === "bearish") { score -= 30; reasons.push("External structure bearish (LH/LL sequence)"); }
      if (a.premiumDiscount.currentZone === "discount" && a.structure.trend === "bullish") {
        score += 25; reasons.push("Price in discount within a bullish range — optimal buy conditions");
      }
      if (a.premiumDiscount.currentZone === "premium" && a.structure.trend === "bearish") {
        score -= 25; reasons.push("Price in premium within a bearish range — optimal sell conditions");
      }
      const sweep = a.liquidity.sweeps[a.liquidity.sweeps.length - 1];
      if (sweep) {
        if (sweep.direction === "below" && sweep.reversalProbability > 55) { score += 20; reasons.push("Sell-side liquidity swept and reclaimed — smart money accumulation"); }
        if (sweep.direction === "above" && sweep.reversalProbability > 55) { score -= 20; reasons.push("Buy-side liquidity swept and rejected — smart money distribution"); }
      }
      return { score: clamp(score), reasons };
    },
  },
  {
    key: "ict",
    name: "ICT Model",
    description: "FVG + order block confluence after a liquidity raid (ICT 2022 model).",
    defaultWeight: 1.2,
    evaluate: (a: A) => {
      let score = 0;
      const reasons: string[] = [];
      const sweep = a.liquidity.sweeps[a.liquidity.sweeps.length - 1];
      const freshBullFvg = a.fvgs.find((f) => f.direction === "bullish" && f.status !== "filled");
      const freshBearFvg = a.fvgs.find((f) => f.direction === "bearish" && f.status !== "filled");
      const choch = [...a.structure.events].reverse().find((e) => e.type === "CHOCH");
      if (sweep?.direction === "below" && choch?.direction === "bullish" && freshBullFvg) {
        score += 55; reasons.push("ICT sequence complete: raid below lows → bullish CHOCH → unfilled bullish FVG entry zone");
      }
      if (sweep?.direction === "above" && choch?.direction === "bearish" && freshBearFvg) {
        score -= 55; reasons.push("ICT sequence complete: raid above highs → bearish CHOCH → unfilled bearish FVG entry zone");
      }
      return { score: clamp(score), reasons };
    },
  },
  {
    key: "liquidity_sweep",
    name: "Liquidity Sweep",
    description: "Fade engineered stop hunts when price closes back through the level.",
    defaultWeight: 1.1,
    evaluate: (a: A) => {
      const sweep = a.liquidity.sweeps[a.liquidity.sweeps.length - 1];
      if (!sweep) return { score: 0, reasons: [] };
      const edge = sweep.reversalProbability - 50;
      const score = sweep.direction === "below" ? edge * 1.6 : -edge * 1.6;
      return { score: clamp(score), reasons: sweep.explanation };
    },
  },
  {
    key: "order_block",
    name: "Order Block",
    description: "Trade reactions from fresh/respected institutional order blocks.",
    defaultWeight: 1.0,
    evaluate: (a: A) => {
      let score = 0;
      const reasons: string[] = [];
      for (const ob of a.orderBlocks.slice(-5)) {
        if (ob.status === "mitigated") continue;
        const near = a.price >= ob.bottom * 0.997 && a.price <= ob.top * 1.003;
        if (!near) continue;
        if (ob.direction === "bullish") { score += ob.status === "respected" ? 45 : 35; reasons.push(`Price trading into a ${ob.status} bullish order block (${ob.bottom.toFixed(4)}–${ob.top.toFixed(4)})`); }
        else { score -= ob.status === "respected" ? 45 : 35; reasons.push(`Price trading into a ${ob.status} bearish order block (${ob.bottom.toFixed(4)}–${ob.top.toFixed(4)})`); }
      }
      return { score: clamp(score), reasons };
    },
  },
  {
    key: "fvg",
    name: "Fair Value Gap",
    description: "Trade rebalances into unfilled imbalances aligned with trend.",
    defaultWeight: 0.9,
    evaluate: (a: A) => {
      let score = 0;
      const reasons: string[] = [];
      for (const f of a.fvgs.slice(-6)) {
        if (f.status === "filled") continue;
        const inside = a.price >= f.bottom && a.price <= f.top;
        if (!inside) continue;
        if (f.direction === "bullish" && a.structure.trend !== "bearish") { score += 35; reasons.push("Price rebalancing an unfilled bullish FVG with structure support"); }
        if (f.direction === "bearish" && a.structure.trend !== "bullish") { score -= 35; reasons.push("Price rebalancing an unfilled bearish FVG with structure support"); }
      }
      return { score: clamp(score), reasons };
    },
  },
  {
    key: "breakout",
    name: "Breakout",
    description: "Momentum breakouts of key S/R with volume expansion.",
    defaultWeight: 0.8,
    evaluate: (a: A) => {
      let score = 0;
      const reasons: string[] = [];
      const res = a.srLevels.filter((l) => l.kind === "resistance").sort((x, y) => x.price - y.price)[0];
      const sup = a.srLevels.filter((l) => l.kind === "support").sort((x, y) => y.price - x.price)[0];
      if (res && a.price > res.price && a.volume.relative > 1.5) {
        score += 40; reasons.push(`Breakout above resistance ${res.price.toFixed(4)} on ${a.volume.relative.toFixed(1)}x volume`);
      }
      if (sup && a.price < sup.price && a.volume.relative > 1.5) {
        score -= 40; reasons.push(`Breakdown below support ${sup.price.toFixed(4)} on ${a.volume.relative.toFixed(1)}x volume`);
      }
      return { score: clamp(score), reasons };
    },
  },
  {
    key: "volume_expansion",
    name: "Volume Expansion",
    description: "Follow directional moves backed by expanding volume and delta.",
    defaultWeight: 0.8,
    evaluate: (a: A) => {
      let score = 0;
      const reasons: string[] = [];
      if (a.volume.spike && a.volume.delta > 0) { score += 30; reasons.push("Volume spike with positive delta — real buying behind the move"); }
      if (a.volume.spike && a.volume.delta < 0) { score -= 30; reasons.push("Volume spike with negative delta — real selling behind the move"); }
      if (a.volume.divergence === "bullish") { score += 15; reasons.push("Bullish volume divergence — selling pressure exhausting"); }
      if (a.volume.divergence === "bearish") { score -= 15; reasons.push("Bearish volume divergence — buying pressure exhausting"); }
      return { score: clamp(score), reasons };
    },
  },
  {
    key: "trend_continuation",
    name: "Trend Continuation",
    description: "Align with the dominant trend while continuation odds exceed reversal odds.",
    defaultWeight: 1.0,
    evaluate: (a: A) => {
      const edge = (a.structure.continuationProbability - 50) / 50;
      let score = 0;
      const reasons: string[] = [];
      if (a.structure.trend === "bullish") { score = 40 * Math.max(0, edge); if (score > 5) reasons.push(`Bullish trend intact, continuation probability ${a.structure.continuationProbability}%`); }
      if (a.structure.trend === "bearish") { score = -40 * Math.max(0, edge); if (score < -5) reasons.push(`Bearish trend intact, continuation probability ${a.structure.continuationProbability}%`); }
      return { score: clamp(score), reasons };
    },
  },
  {
    key: "reversal",
    name: "Reversal",
    description: "Counter-trend entries on CHOCH + sweep + climax confluence.",
    defaultWeight: 0.7,
    evaluate: (a: A) => {
      let score = 0;
      const reasons: string[] = [];
      const choch = [...a.structure.events].reverse().find((e) => e.type === "CHOCH");
      const lastEventRecent = choch && a.structure.events[a.structure.events.length - 1] === choch;
      if (lastEventRecent && choch) {
        if (choch.direction === "bullish" && a.structure.reversalProbability > 50) { score += 35; reasons.push("Fresh bullish CHOCH with elevated reversal probability"); }
        if (choch.direction === "bearish" && a.structure.reversalProbability > 50) { score -= 35; reasons.push("Fresh bearish CHOCH with elevated reversal probability"); }
      }
      if (a.volume.climax && a.structure.trend === "bearish") { score += 15; reasons.push("Selling climax after markdown — capitulation often precedes reversal"); }
      if (a.volume.climax && a.structure.trend === "bullish") { score -= 15; reasons.push("Buying climax after markup — euphoria often precedes reversal"); }
      return { score: clamp(score), reasons };
    },
  },
  {
    key: "choch",
    name: "CHOCH",
    description: "Trade the first structural character change after a trend.",
    defaultWeight: 0.9,
    evaluate: (a: A) => {
      const recent = a.structure.events.slice(-3);
      const choch = recent.filter((e) => e.type === "CHOCH");
      if (choch.length === 0) return { score: 0, reasons: [] };
      const last = choch[choch.length - 1];
      const score = last.direction === "bullish" ? 40 : -40;
      return {
        score: clamp(score),
        reasons: [`${last.scope} CHOCH ${last.direction} at ${last.price.toFixed(4)} — character of the move has changed`],
      };
    },
  },
  {
    key: "bos",
    name: "BOS Momentum",
    description: "Trade continuation after clean breaks of structure.",
    defaultWeight: 0.9,
    evaluate: (a: A) => {
      const recent = a.structure.events.slice(-3);
      const bos = recent.filter((e) => e.type === "BOS" && e.scope === "external");
      if (bos.length === 0) return { score: 0, reasons: [] };
      const last = bos[bos.length - 1];
      const score = last.direction === "bullish" ? 35 : -35;
      return {
        score: clamp(score),
        reasons: [`External BOS ${last.direction} at ${last.price.toFixed(4)} — trend momentum confirmed`],
      };
    },
  },
  {
    key: "engulfing",
    name: "Engulfing",
    description: "High-strength engulfing candles at meaningful locations.",
    defaultWeight: 0.7,
    evaluate: (a: A) => {
      const recent = a.patterns.filter((p) => p.name.includes("Engulfing")).slice(-1)[0];
      if (!recent || recent.strength < 55) return { score: 0, reasons: [] };
      const barsAgo = a.patterns.length > 0 ? 0 : 0;
      const score = recent.direction === "bullish" ? recent.strength * 0.6 : -recent.strength * 0.6;
      return {
        score: clamp(score),
        reasons: [`${recent.name} (strength ${recent.strength}) — ${recent.context}`],
      };
    },
  },
  {
    key: "support_resistance",
    name: "Support / Resistance",
    description: "Fade strong levels, follow confirmed breaks.",
    defaultWeight: 0.8,
    evaluate: (a: A) => {
      let score = 0;
      const reasons: string[] = [];
      for (const l of a.srLevels) {
        const dist = Math.abs(a.price - l.price) / a.price;
        if (dist > 0.004) continue;
        if (l.kind === "support" && l.bounceProbability > 55) { score += l.strength * 0.5; reasons.push(`Sitting on support ${l.price.toFixed(4)} (strength ${l.strength}, ${l.touches} touches, bounce odds ${l.bounceProbability}%)`); }
        if (l.kind === "resistance" && l.bounceProbability > 55) { score -= l.strength * 0.5; reasons.push(`Pressing resistance ${l.price.toFixed(4)} (strength ${l.strength}, ${l.touches} touches, rejection odds ${l.bounceProbability}%)`); }
      }
      return { score: clamp(score), reasons };
    },
  },
  {
    key: "delta",
    name: "Delta / Order Flow",
    description: "Follow sustained aggressive flow; fade absorbed aggression.",
    defaultWeight: 1.0,
    evaluate: (a: A) => {
      let score = 0;
      const reasons: string[] = [];
      if (a.orderFlow.aggression === "buyers") { score += (a.orderFlow.buyPressure - 50) * 1.2; reasons.push(`Buy pressure ${a.orderFlow.buyPressure}% with cumulative delta ${a.orderFlow.cumulativeDelta > 0 ? "positive" : "negative"}`); }
      if (a.orderFlow.aggression === "sellers") { score -= (a.orderFlow.sellPressure - 50) * 1.2; reasons.push(`Sell pressure ${a.orderFlow.sellPressure}% with cumulative delta ${a.orderFlow.cumulativeDelta < 0 ? "negative" : "positive"}`); }
      if (a.orderFlow.exhaustion.present) {
        const adj = a.orderFlow.exhaustion.side === "buy" ? -15 : 15;
        score += adj; reasons.push(a.orderFlow.exhaustion.note);
      }
      return { score: clamp(score), reasons };
    },
  },
  {
    key: "absorption",
    name: "Absorption",
    description: "Position with the passive side that is absorbing aggression.",
    defaultWeight: 0.8,
    evaluate: (a: A) => {
      if (!a.orderFlow.absorption.present) return { score: 0, reasons: [] };
      const score = a.orderFlow.absorption.side === "buy" ? 45 : -45;
      return { score: clamp(score), reasons: [a.orderFlow.absorption.note] };
    },
  },
  {
    key: "liquidation_fade",
    name: "Liquidation Fade",
    description: "Fade engineered liquidation flushes that immediately reclaim.",
    defaultWeight: 0.8,
    evaluate: (a: A) => {
      const lastEv = a.liquidations.recentEvents[a.liquidations.recentEvents.length - 1];
      if (!lastEv || !a.liquidations.likelyFakeMove) return { score: 0, reasons: [] };
      const score = lastEv.side === "long" ? 40 : -40;
      return {
        score: clamp(score),
        reasons: [
          `${lastEv.side === "long" ? "Long" : "Short"} liquidation flush reclaimed — engineered move, fading it`,
          `Reversal probability ${a.liquidations.reversalProbability}%`,
        ],
      };
    },
  },
];

export function evaluateStrategies(
  analysis: A,
  weights: Record<string, { weight: number; enabled: boolean }> = {}
): StrategyScore[] {
  return STRATEGIES.map((s) => {
    const cfg = weights[s.key];
    const weight = cfg?.enabled === false ? 0 : cfg?.weight ?? s.defaultWeight;
    const { score, reasons } = s.evaluate(analysis);
    return { key: s.key, name: s.name, score, weight, reasons };
  });
}
