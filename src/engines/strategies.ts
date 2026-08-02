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

  /* ---------------- Order-flow strategies ---------------- */

  {
    key: "key_level_absorption",
    name: "Key-Level Absorption",
    description:
      "Position with the passive side absorbing aggression — but only when it happens at a key level (POC, value edge, LVN or strong S/R), never mid-range.",
    defaultWeight: 1.2,
    evaluate: (a: A) => {
      const recent = a.orderFlowEvents.absorptions.slice(-2);
      if (recent.length === 0) return { score: 0, reasons: [] };
      let score = 0;
      const reasons: string[] = [];
      for (const abs of recent) {
        // Absorption without a level is deliberately down-weighted — the
        // whole point is that mid-range absorption is noise.
        const levelMultiplier = abs.atKeyLevel ? 1 : 0.35;
        const contribution = (abs.strength * 0.55) * levelMultiplier;
        score += abs.side === "buy" ? contribution : -contribution;
        reasons.push(abs.explanation);
      }
      return { score: clamp(score), reasons };
    },
  },
  {
    key: "exhaustion_reversal",
    name: "Exhaustion Reversal",
    description:
      "Fade moves whose participation is draining away — especially a new extreme printed on shrinking volume.",
    defaultWeight: 1.0,
    evaluate: (a: A) => {
      const exh = a.orderFlowEvents.exhaustions[a.orderFlowEvents.exhaustions.length - 1];
      if (!exh) return { score: 0, reasons: [] };
      const stageWeight = exh.stage === "danger" ? 1 : exh.stage === "weakening" ? 0.6 : 0.3;
      const magnitude = exh.strength * 0.5 * stageWeight;
      // Exhausted buyers is a bearish input and vice versa.
      const score = exh.side === "buy" ? -magnitude : magnitude;
      const reasons = [exh.explanation];
      // Exhaustion + absorption at a level is the premium configuration.
      const abs = a.orderFlowEvents.absorptions[a.orderFlowEvents.absorptions.length - 1];
      if (abs?.atKeyLevel && ((exh.side === "buy" && abs.side === "sell") || (exh.side === "sell" && abs.side === "buy"))) {
        reasons.push("Exhaustion is confirmed by absorption on the opposite side at a key level — the strongest reversal configuration in this framework.");
        return { score: clamp(score * 1.4), reasons };
      }
      return { score: clamp(score), reasons };
    },
  },
  {
    key: "trapped_traders",
    name: "Trapped Traders",
    description:
      "Trade against traders caught offside at an extreme — their stops become the next liquidity target.",
    defaultWeight: 1.1,
    evaluate: (a: A) => {
      const traps = a.orderFlowEvents.trapped.slice(-2);
      if (traps.length === 0) return { score: 0, reasons: [] };
      let score = 0;
      const reasons: string[] = [];
      for (const t of traps) {
        // Trapped buyers → price should fall to their stops, and vice versa.
        score += t.side === "buyers" ? -t.strength * 0.6 : t.strength * 0.6;
        reasons.push(t.explanation);
      }
      return { score: clamp(score), reasons };
    },
  },
  {
    key: "cvd_divergence",
    name: "CVD Divergence",
    description:
      "Cumulative delta disagreeing with price — an earlier reversal warning than any price-derived oscillator.",
    defaultWeight: 1.1,
    evaluate: (a: A) => {
      const div = a.delta.divergences[a.delta.divergences.length - 1];
      if (!div) return { score: 0, reasons: [] };
      const magnitude = div.strength * 0.6;
      let score = 0;
      if (div.kind === "regular_bearish" || div.kind === "hidden_bearish") score = -magnitude;
      if (div.kind === "regular_bullish" || div.kind === "hidden_bullish") score = magnitude;
      return { score: clamp(score), reasons: [div.explanation] };
    },
  },
  {
    key: "stacked_imbalance",
    name: "Stacked Imbalance",
    description:
      "Follow genuinely one-sided auctions: 3+ consecutive footprint imbalances where one side got no opportunity to fill.",
    defaultWeight: 0.9,
    evaluate: (a: A) => {
      const recent = a.footprint.candles.slice(-3);
      let score = 0;
      const reasons: string[] = [];
      for (const fc of recent) {
        for (const si of fc.stackedImbalances) {
          const magnitude = Math.min(45, 18 + si.count * 6);
          score += si.direction === "buy" ? magnitude : -magnitude;
          reasons.push(
            `Stacked ${si.direction} imbalance across ${si.count} price levels (${si.fromPrice.toFixed(4)}–${si.toPrice.toFixed(4)}) — aggressive ${si.direction === "buy" ? "buyers" : "sellers"} gave the other side no chance to fill.`
          );
        }
      }
      // Modelled footprints deserve less trust than reconstructed ones.
      if (a.footprint.fidelity === "estimated") score *= 0.5;
      return { score: clamp(score), reasons };
    },
  },
  {
    key: "value_area",
    name: "Value Area / Auction",
    description:
      "Auction theory: fade the extremes while price is balanced inside value, follow the move once it is accepted outside.",
    defaultWeight: 1.0,
    evaluate: (a: A) => {
      const vp = a.volumeProfile;
      const price = a.price;
      let score = 0;
      const reasons: string[] = [];

      if (vp.auctionState === "balance") {
        // Inside value → mean-revert toward the POC.
        const toPoc = vp.poc - price;
        const span = Math.max(vp.vah - vp.val, 1e-9);
        const pull = (toPoc / span) * 55;
        score += pull;
        if (Math.abs(pull) > 6) {
          reasons.push(
            `Balanced auction inside value — price at ${price.toFixed(4)} should rotate toward the Point of Control at ${vp.poc.toFixed(4)}.`
          );
        }
      } else if (vp.acceptance === "above_value") {
        score += 32;
        reasons.push(
          `Price has been accepted ABOVE the value area (VAH ${vp.vah.toFixed(4)}) — the auction is seeking higher value, which favours continuation while that level holds.`
        );
      } else {
        score -= 32;
        reasons.push(
          `Price has been accepted BELOW the value area (VAL ${vp.val.toFixed(4)}) — the auction is seeking lower value, which favours continuation while that level caps.`
        );
      }

      // Profile shape at an extreme is a reversal tell.
      if (vp.shape === "P" && price > vp.poc) {
        score -= 18;
        reasons.push("P-shaped profile printed into the highs — short covering rather than fresh buying, so the rally is hollow.");
      }
      if (vp.shape === "b" && price < vp.poc) {
        score += 18;
        reasons.push("b-shaped profile printed into the lows — long liquidation rather than fresh selling, so the decline is forced and prone to snapping back.");
      }
      return { score: clamp(score), reasons };
    },
  },
  {
    key: "lvn_rejection",
    name: "LVN Rejection",
    description:
      "Trade reactions at Low Volume Nodes — prices the market previously refused to accept and rips through.",
    defaultWeight: 0.85,
    evaluate: (a: A) => {
      const price = a.price;
      let score = 0;
      const reasons: string[] = [];
      for (const lvn of a.volumeProfile.lvns) {
        const dist = Math.abs(price - lvn.price) / Math.max(price, 1e-9);
        if (dist > 0.003) continue;
        // Direction of rejection follows the prevailing trend read.
        const dir = a.structure.trend === "bearish" ? -1 : a.structure.trend === "bullish" ? 1 : 0;
        if (dir === 0) continue;
        score += dir * 34;
        reasons.push(
          `Price is testing a Low Volume Node at ${lvn.price.toFixed(4)} — it was rejected here before and volume nodes this thin rarely hold price, so expect a fast move away rather than consolidation.`
        );
      }
      return { score: clamp(score), reasons };
    },
  },
  {
    key: "vwap_reversion",
    name: "VWAP",
    description:
      "Institutional execution benchmark — trade the reclaim/rejection and fade statistically stretched extensions.",
    defaultWeight: 0.85,
    evaluate: (a: A) => {
      const v = a.vwap;
      const price = a.price;
      let score = 0;
      const reasons: string[] = [];

      if (price > v.upperBand2) {
        score -= 30;
        reasons.push(`Price is beyond the +2σ VWAP band (${v.upperBand2.toFixed(4)}) — statistically stretched above fair value; execution algos become net sellers here.`);
      } else if (price < v.lowerBand2) {
        score += 30;
        reasons.push(`Price is beyond the −2σ VWAP band (${v.lowerBand2.toFixed(4)}) — statistically stretched below fair value; execution algos become net buyers here.`);
      } else {
        // Inside the bands VWAP acts as directional bias.
        const bias = v.position === "above" ? 20 : -20;
        score += bias;
        reasons.push(
          `Price is holding ${v.position} VWAP (${v.current.toFixed(4)}), ${Math.abs(v.distancePct).toFixed(2)}% away — ${v.position === "above" ? "buyers" : "sellers"} control the volume-weighted fair price.`
        );
      }
      return { score: clamp(score), reasons };
    },
  },
  {
    key: "moving_average",
    name: "Moving Average Stack",
    description: "Directional bias from alignment across the key EMA/SMA stack.",
    defaultWeight: 0.7,
    evaluate: (a: A) => {
      const ma = a.movingAverages;
      if (ma.averages.length === 0) return { score: 0, reasons: [] };
      const above = ma.averages.filter((x) => x.position === "above").length;
      const ratio = above / ma.averages.length;
      let score = (ratio - 0.5) * 60;
      const reasons: string[] = [];
      if (Math.abs(score) > 8) {
        reasons.push(`Price trades above ${above}/${ma.averages.length} key moving averages — ${ma.alignment} stack alignment.`);
      }
      if (ma.goldenCross) { score += 15; reasons.push("Golden cross active (EMA 50 above SMA 200)."); }
      if (ma.deathCross) { score -= 15; reasons.push("Death cross active (EMA 50 below SMA 200)."); }
      return { score: clamp(score), reasons };
    },
  },
  {
    key: "fibonacci",
    name: "Fibonacci",
    description: "Trend-aligned retracement entries, weighted toward the golden pocket.",
    defaultWeight: 0.7,
    evaluate: (a: A) => {
      const fib = a.fibonacci;
      const active = fib.activeLevel;
      if (!active || active.kind !== "retracement") return { score: 0, reasons: [] };
      if (active.ratio <= 0 || active.ratio >= 1) return { score: 0, reasons: [] };

      // A retracement is an entry INTO the direction of the original leg.
      const dir = fib.direction === "up" ? 1 : -1;
      let magnitude = 22;
      if (active.isGoldenPocket) magnitude = 40;
      else if (active.ratio === 0.5) magnitude = 30;
      // Deep retracements past 0.786 threaten the leg rather than support it.
      if (active.ratio >= 0.786) magnitude = 10;

      return {
        score: clamp(dir * magnitude),
        reasons: [
          `Price is reacting at the ${active.label} retracement (${active.price.toFixed(4)}) of the prior ${fib.direction === "up" ? "rally" : "decline"}${active.isGoldenPocket ? " — inside the golden pocket, the highest-probability continuation entry" : ""}.`,
        ],
      };
    },
  },
  {
    key: "liquidation_delta",
    name: "Liquidation Delta",
    description:
      "Read forced flow: fade cascades once the trapped cohort has been cleared out.",
    defaultWeight: 0.8,
    evaluate: (a: A) => {
      const ld = a.liquidationDelta;
      if (ld.dominantSide === "balanced" || ld.series.length === 0) return { score: 0, reasons: [] };
      // Heavy long liquidation = forced selling that exhausts → bullish fade.
      const score = ld.dominantSide === "long" ? 28 : -28;
      return {
        score: clamp(score),
        reasons: [
          ld.summary[0] ?? `Forced flow dominated by ${ld.dominantSide} liquidations.`,
          `Liquidation-driven moves are price-insensitive and exhaust once the cohort is cleared, so the final flush is usually better faded than chased.`,
        ],
      };
    },
  },
  {
    key: "equal_level_liquidity",
    name: "Equal Highs / Lows",
    description:
      "Target unswept equal highs/lows — the resting stop pools that price reliably runs before reversing.",
    defaultWeight: 0.8,
    evaluate: (a: A) => {
      const unswept = a.equalLevels.filter((l) => !l.swept);
      if (unswept.length === 0) return { score: 0, reasons: [] };
      let score = 0;
      const reasons: string[] = [];
      const price = a.price;
      for (const lvl of unswept.slice(0, 2)) {
        const distPct = Math.abs(lvl.price - price) / price;
        if (distPct > 0.03) continue;
        // Price is drawn toward unswept liquidity.
        const pull = Math.max(8, 30 - distPct * 600);
        score += lvl.kind === "EQH" ? pull : -pull;
        reasons.push(lvl.note);
      }
      return { score: clamp(score), reasons };
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
