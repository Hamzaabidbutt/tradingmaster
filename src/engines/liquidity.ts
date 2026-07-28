import { Candle, LiquidityLevel, LiquidityResult, LiquiditySweep, SwingPoint } from "./types";

/**
 * Liquidity engine.
 *
 * Resting liquidity accumulates as stop orders above swing highs (buy stops:
 * shorts' stop losses + breakout buyers) and below swing lows (sell stops).
 * Equal highs/lows concentrate it further. A sweep occurs when price wicks
 * through a level and closes back — the classic stop hunt signature.
 */
export function analyzeLiquidity(
  candles: Candle[],
  swings: SwingPoint[],
  equalTolerance = 0.0015
): LiquidityResult {
  const levels: LiquidityLevel[] = [];
  const sweeps: LiquiditySweep[] = [];
  const majorSwings = swings.filter((s) => s.degree === "major");
  const lastPrice = candles[candles.length - 1]?.close ?? 0;

  // --- Equal highs / equal lows clustering ---
  const highs = majorSwings.filter((s) => s.kind === "high");
  const lows = majorSwings.filter((s) => s.kind === "low");

  const clusterEquals = (points: SwingPoint[], kind: "equal_highs" | "equal_lows") => {
    for (let i = 0; i < points.length - 1; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const diff = Math.abs(points[i].price - points[j].price) / points[i].price;
        if (diff <= equalTolerance) {
          const price = (points[i].price + points[j].price) / 2;
          if (!levels.some((l) => l.kind === kind && Math.abs(l.price - price) / price < equalTolerance)) {
            levels.push({
              id: `${kind}-${points[j].time}`,
              kind,
              price,
              time: points[j].time,
              swept: false,
              strength: 85,
            });
          }
        }
      }
    }
  };
  clusterEquals(highs, "equal_highs");
  clusterEquals(lows, "equal_lows");

  // --- Swing liquidity pools (most recent swings carry resting stops) ---
  for (const s of highs.slice(-5)) {
    levels.push({
      id: `swing-high-${s.time}`,
      kind: s.price > lastPrice ? "buy_side" : "swing_high",
      price: s.price,
      time: s.time,
      swept: false,
      strength: 60,
    });
  }
  for (const s of lows.slice(-5)) {
    levels.push({
      id: `swing-low-${s.time}`,
      kind: s.price < lastPrice ? "sell_side" : "swing_low",
      price: s.price,
      time: s.time,
      swept: false,
      strength: 60,
    });
  }

  // --- Sweep detection: wick beyond a level with a close back inside ---
  for (const level of levels) {
    const levelIdx = candles.findIndex((c) => c.time === level.time);
    for (let i = Math.max(0, levelIdx + 1); i < candles.length; i++) {
      const c = candles[i];
      const isHighSide =
        level.kind === "equal_highs" || level.kind === "buy_side" || level.kind === "swing_high" || level.kind === "buy_stops";
      if (isHighSide && c.high > level.price && c.close < level.price) {
        level.swept = true;
        level.sweptAt = c.time;
        const wickRatio = (c.high - Math.max(c.open, c.close)) / Math.max(c.high - c.low, 1e-12);
        sweeps.push({
          time: c.time,
          price: level.price,
          direction: "above",
          levelKind: level.kind,
          reversalProbability: Math.min(85, 45 + wickRatio * 40 + (level.kind === "equal_highs" ? 10 : 0)),
          continuationProbability: Math.max(15, 55 - wickRatio * 40),
          explanation: [
            `Price wicked above ${level.kind.replace("_", " ")} at ${level.price.toFixed(4)} and closed back below — buy stops were harvested.`,
            wickRatio > 0.5
              ? "Long upper wick shows aggressive sellers filled into the stop-driven buying — classic smart-money distribution."
              : "Partial rejection; continuation is still possible if price reclaims the level.",
          ],
        });
        break;
      }
      const isLowSide =
        level.kind === "equal_lows" || level.kind === "sell_side" || level.kind === "swing_low" || level.kind === "sell_stops";
      if (isLowSide && c.low < level.price && c.close > level.price) {
        level.swept = true;
        level.sweptAt = c.time;
        const wickRatio = (Math.min(c.open, c.close) - c.low) / Math.max(c.high - c.low, 1e-12);
        sweeps.push({
          time: c.time,
          price: level.price,
          direction: "below",
          levelKind: level.kind,
          reversalProbability: Math.min(85, 45 + wickRatio * 40 + (level.kind === "equal_lows" ? 10 : 0)),
          continuationProbability: Math.max(15, 55 - wickRatio * 40),
          explanation: [
            `Price wicked below ${level.kind.replace("_", " ")} at ${level.price.toFixed(4)} and closed back above — sell stops were harvested.`,
            wickRatio > 0.5
              ? "Long lower wick shows large buyers absorbing the stop-driven selling — classic smart-money accumulation."
              : "Partial reclaim; watch for confirmation before treating this as a reversal.",
          ],
        });
        break;
      }
    }
  }

  const summary: string[] = [];
  const unsweptAbove = levels.filter((l) => !l.swept && l.price > lastPrice).sort((a, b) => a.price - b.price);
  const unsweptBelow = levels.filter((l) => !l.swept && l.price < lastPrice).sort((a, b) => b.price - a.price);
  if (unsweptAbove[0]) {
    summary.push(
      `Nearest buy-side liquidity rests at ${unsweptAbove[0].price.toFixed(4)} (${(((unsweptAbove[0].price - lastPrice) / lastPrice) * 100).toFixed(2)}% above) — a magnet for price.`
    );
  }
  if (unsweptBelow[0]) {
    summary.push(
      `Nearest sell-side liquidity rests at ${unsweptBelow[0].price.toFixed(4)} (${(((lastPrice - unsweptBelow[0].price) / lastPrice) * 100).toFixed(2)}% below).`
    );
  }
  const recentSweep = sweeps[sweeps.length - 1];
  if (recentSweep) {
    const barsAgo = candles.length - 1 - candles.findIndex((c) => c.time === recentSweep.time);
    if (barsAgo <= 10) {
      summary.push(
        `Liquidity ${recentSweep.direction === "above" ? "hunt above highs" : "grab below lows"} detected ${barsAgo} bars ago — reversal probability ${recentSweep.reversalProbability.toFixed(0)}%.`
      );
    }
  }

  return { levels, sweeps, summary };
}
