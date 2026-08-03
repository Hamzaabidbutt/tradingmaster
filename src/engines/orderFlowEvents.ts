import {
  AbsorptionEvent,
  Candle,
  ExhaustionEvent,
  FootprintResult,
  OrderFlowEvents,
  SRLevel,
  TrappedTraders,
  VolumeProfileResult,
} from "./types";

/**
 * Absorption / Exhaustion / Trapped-trader engine.
 *
 * ABSORPTION — heavy aggression arrives but price does not move, because
 * the passive side is quietly filling limit orders against it. Red candle
 * with positive delta = sellers hitting the bid while buyers absorb.
 * Critically, absorption only carries an edge AT A KEY LEVEL: the same
 * pattern in the middle of a range is noise. This engine therefore scores
 * absorption against the POC, value-area edges and S/R levels and reports
 * which level it occurred at.
 *
 * EXHAUSTION — price keeps travelling but participation drains away. The
 * move isn't reversing yet; it's running out of fuel and needs a rest.
 * Three stages are tracked: momentum → weakening → danger.
 *
 * TRAPPED TRADERS — aggressive volume enters at an extreme and gets no
 * follow-through, then price closes back against them. Their stops sit
 * just beyond the extreme, and that pool of stops becomes the next
 * target. Absorption + exhaustion + trapped traders stacking at one level
 * is the highest-probability reversal configuration in this framework.
 */

export interface OrderFlowEventOptions {
  lookback?: number;
  keyLevelTolerance?: number;
}

export function detectOrderFlowEvents(
  candles: Candle[],
  footprint: FootprintResult,
  profile: VolumeProfileResult,
  srLevels: SRLevel[],
  opts: OrderFlowEventOptions = {}
): OrderFlowEvents {
  const lookback = opts.lookback ?? 60;
  const tolerance = opts.keyLevelTolerance ?? 0.0035;
  const window = candles.slice(-lookback);
  if (window.length < 10) {
    return { absorptions: [], exhaustions: [], trapped: [], deltaSpikeLevels: [], bigTrades: [], summary: [] };
  }

  const avgVol = window.reduce((s, c) => s + c.volume, 0) / window.length;
  const avgRange = window.reduce((s, c) => s + (c.high - c.low), 0) / window.length;

  /** Name the key level a price is sitting on, or null if it's mid-range. */
  const keyLevelAt = (price: number): string | null => {
    if (near(price, profile.poc, tolerance)) return `Point of Control ${profile.poc.toFixed(4)}`;
    if (near(price, profile.vah, tolerance)) return `Value Area High ${profile.vah.toFixed(4)}`;
    if (near(price, profile.val, tolerance)) return `Value Area Low ${profile.val.toFixed(4)}`;
    for (const lvn of profile.lvns) {
      if (near(price, lvn.price, tolerance)) return `Low Volume Node ${lvn.price.toFixed(4)}`;
    }
    for (const sr of srLevels) {
      if (near(price, sr.price, tolerance)) {
        return `${sr.kind === "support" ? "Support" : "Resistance"} ${sr.price.toFixed(4)} (strength ${sr.strength})`;
      }
    }
    return null;
  };

  const absorptions: AbsorptionEvent[] = [];
  const exhaustions: ExhaustionEvent[] = [];
  const trapped: TrappedTraders[] = [];
  const bigTrades: OrderFlowEvents["bigTrades"] = [];
  const deltaSpikeLevels: OrderFlowEvents["deltaSpikeLevels"] = [];

  const fpByTime = new Map(footprint.candles.map((f) => [f.time, f]));

  for (let i = 3; i < window.length; i++) {
    const c = window[i];
    const buy = c.takerBuyVolume ?? c.volume / 2;
    const sell = c.volume - buy;
    const delta = buy - sell;
    const range = c.high - c.low;
    const bullish = c.close >= c.open;
    const volX = c.volume / Math.max(avgVol, 1e-9);

    // ---------------- Big trades ("bubbles") ----------------
    if (volX >= 2.5) {
      bigTrades.push({
        time: c.time,
        price: c.close,
        side: delta >= 0 ? "buy" : "sell",
        volume: c.volume,
        multiple: Number(volX.toFixed(1)),
      });
    }

    // ------------- Delta spike levels (future S/R) -------------
    const deltaX = Math.abs(delta) / Math.max(avgVol * 0.35, 1e-9);
    if (deltaX >= 2.2) {
      deltaSpikeLevels.push({
        price: c.close,
        time: c.time,
        side: delta >= 0 ? "buy" : "sell",
        delta,
      });
    }

    // ---------------- Absorption ----------------
    // Heavy volume, compressed range, and delta pointing against the close.
    const compressed = range < avgRange * 0.85;
    const fp = fpByTime.get(c.time);
    const divergent = fp?.deltaDivergence ?? ((bullish && delta < 0) || (!bullish && delta > 0));
    if (volX >= 1.6 && (compressed || divergent)) {
      // The absorbing side is the PASSIVE one — opposite the aggression.
      const absorbingSide: "buy" | "sell" = delta < 0 ? "buy" : "sell";
      const level = keyLevelAt(c.close);
      let strength = 30 + Math.min(35, volX * 10) + (compressed ? 12 : 0) + (divergent ? 15 : 0);
      // Mid-range absorption is materially less reliable than at a level.
      if (!level) strength *= 0.55;
      if (strength >= 40) {
        absorptions.push({
          time: c.time,
          price: c.close,
          side: absorbingSide,
          strength: Math.round(Math.min(100, strength)),
          volume: c.volume,
          delta,
          atKeyLevel: level,
          explanation:
            absorbingSide === "buy"
              ? `Aggressive sellers dumped ${sell.toFixed(0)} into this bar (${volX.toFixed(1)}x average volume) yet price held — passive buyers are absorbing the supply.${level ? ` This is happening at ${level}, which is what makes it tradeable rather than noise.` : " It is mid-range though, so the signal is weak on its own."}`
              : `Aggressive buyers lifted ${buy.toFixed(0)} into this bar (${volX.toFixed(1)}x average volume) yet price stalled — passive sellers are absorbing the demand.${level ? ` This is happening at ${level}, which is what makes it tradeable rather than noise.` : " It is mid-range though, so the signal is weak on its own."}`,
        });
      }
    }

    // ---------------- Trapped traders ----------------
    // Aggression into an extreme, then price closes back against it.
    if (i >= 4 && volX >= 1.5) {
      const prior = window.slice(Math.max(0, i - 8), i);
      const priorHigh = Math.max(...prior.map((p) => p.high));
      const priorLow = Math.min(...prior.map((p) => p.low));
      const wickUp = c.high - Math.max(c.open, c.close);
      const wickDown = Math.min(c.open, c.close) - c.low;

      if (c.high > priorHigh && c.close < priorHigh && delta > 0 && wickUp > range * 0.35) {
        trapped.push({
          time: c.time,
          price: c.high,
          side: "buyers",
          volume: buy,
          strength: Math.round(Math.min(100, 45 + volX * 12)),
          stopZone: { low: priorHigh, high: c.high },
          explanation: `Buyers paid up through ${priorHigh.toFixed(4)} on ${volX.toFixed(1)}x volume with positive delta, but price closed back below it. Those longs are trapped and their stops now sit between ${priorHigh.toFixed(4)} and ${c.high.toFixed(4)} — a liquidity pool the market is likely to come back for.`,
        });
      }
      if (c.low < priorLow && c.close > priorLow && delta < 0 && wickDown > range * 0.35) {
        trapped.push({
          time: c.time,
          price: c.low,
          side: "sellers",
          volume: sell,
          strength: Math.round(Math.min(100, 45 + volX * 12)),
          stopZone: { low: c.low, high: priorLow },
          explanation: `Sellers pressed through ${priorLow.toFixed(4)} on ${volX.toFixed(1)}x volume with negative delta, but price closed back above it. Those shorts are trapped and their stops now sit between ${c.low.toFixed(4)} and ${priorLow.toFixed(4)}.`,
        });
      }
    }
  }

  // ---------------- Exhaustion ----------------
  // Directional run whose participation is fading bar over bar.
  const tail = window.slice(-8);
  if (tail.length === 8) {
    const firstHalf = tail.slice(0, 4);
    const secondHalf = tail.slice(4);
    const v1 = firstHalf.reduce((s, c) => s + c.volume, 0);
    const v2 = secondHalf.reduce((s, c) => s + c.volume, 0);
    const volumeTrendPct = v1 > 0 ? ((v2 - v1) / v1) * 100 : 0;
    const up = tail[tail.length - 1].close > tail[0].close;
    const down = tail[tail.length - 1].close < tail[0].close;
    const moved = Math.abs(tail[tail.length - 1].close - tail[0].close) / tail[0].close > 0.002;

    if (moved && volumeTrendPct < -12) {
      const stage: ExhaustionEvent["stage"] =
        volumeTrendPct < -45 ? "danger" : volumeTrendPct < -25 ? "weakening" : "momentum";
      const side: "buy" | "sell" = up ? "buy" : "sell";
      exhaustions.push({
        time: tail[tail.length - 1].time,
        price: tail[tail.length - 1].close,
        side,
        stage,
        volumeTrendPct: Number(volumeTrendPct.toFixed(1)),
        strength: Math.round(Math.min(100, Math.abs(volumeTrendPct) * 1.6)),
        explanation:
          `Price is still ${up ? "rising" : "falling"} but participation has dropped ${Math.abs(volumeTrendPct).toFixed(0)}% across the last 8 bars. ` +
          (stage === "danger"
            ? `The ${up ? "buyers" : "sellers"} are running on fumes — a pullback or reversal is due, not necessarily a full trend change.`
            : stage === "weakening"
              ? `The move is losing its sponsor; tighten risk and stop adding.`
              : `Early fatigue — worth watching but not yet actionable on its own.`),
      });
    }
    // Low-volume spike into a new extreme: the classic final push.
    const lastBar = tail[tail.length - 1];
    const lastVolX = lastBar.volume / Math.max(avgVol, 1e-9);
    const newHigh = lastBar.high >= Math.max(...tail.map((t) => t.high));
    const newLow = lastBar.low <= Math.min(...tail.map((t) => t.low));
    if (lastVolX < 0.7 && (newHigh || newLow)) {
      exhaustions.push({
        time: lastBar.time,
        price: lastBar.close,
        side: newHigh ? "buy" : "sell",
        stage: "danger",
        volumeTrendPct: Number(((lastVolX - 1) * 100).toFixed(1)),
        strength: 70,
        explanation: `A new ${newHigh ? "high" : "low"} was printed on only ${lastVolX.toFixed(2)}x average volume. Extremes made without participation are rarely defended — this is the hollow push that typically precedes a reversal.`,
      });
    }
  }

  // ---------------- Summary ----------------
  const summary: string[] = [];
  const lastAbs = absorptions[absorptions.length - 1];
  if (lastAbs) summary.push(lastAbs.explanation);
  const lastExh = exhaustions[exhaustions.length - 1];
  if (lastExh) summary.push(lastExh.explanation);
  const lastTrap = trapped[trapped.length - 1];
  if (lastTrap) summary.push(lastTrap.explanation);
  if (lastAbs && lastExh && lastAbs.atKeyLevel) {
    summary.push(
      "Absorption and exhaustion are stacking at the same key level — this is the highest-probability reversal configuration in order flow, but still wait for a price-action trigger before acting."
    );
  }
  if (bigTrades.length > 0) {
    const bt = bigTrades[bigTrades.length - 1];
    summary.push(
      `Large ${bt.side} print detected: ${bt.volume.toFixed(0)} at ${bt.price.toFixed(4)} (${bt.multiple}x average bar volume).`
    );
  }

  return {
    absorptions: absorptions.slice(-8),
    exhaustions: exhaustions.slice(-4),
    trapped: trapped.slice(-6),
    deltaSpikeLevels: dedupeLevels(deltaSpikeLevels).slice(-8),
    bigTrades: bigTrades.slice(-12),
    summary,
  };
}

function near(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) / Math.max(Math.abs(b), 1e-9) <= tolerance;
}

function dedupeLevels(
  levels: OrderFlowEvents["deltaSpikeLevels"]
): OrderFlowEvents["deltaSpikeLevels"] {
  const out: OrderFlowEvents["deltaSpikeLevels"] = [];
  for (const l of levels) {
    if (!out.some((o) => near(o.price, l.price, 0.0015))) out.push(l);
  }
  return out;
}
