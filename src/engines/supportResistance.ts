import { Candle, SRLevel, SwingPoint } from "./types";
import { findSwings } from "./marketStructure";

/**
 * Support & resistance engine.
 *
 * Clusters swing highs/lows into horizontal levels, then scores each level:
 *  - touches: how many times price interacted with the level
 *  - rejections: touches that closed away from the level
 *  - volume confirmation: above-average volume on interactions
 *  - recency decay
 * Break/bounce probabilities derive from rejection ratio and approach count
 * (repeated tests weaken a level).
 */
export function detectSupportResistance(
  candles: Candle[],
  timeframeOrigin: string,
  clusterTolerance = 0.004
): SRLevel[] {
  if (candles.length < 30) return [];
  const swings: SwingPoint[] = findSwings(candles, 4, "minor");
  const lastPrice = candles[candles.length - 1].close;
  const avgVolume =
    candles.slice(-100).reduce((s, c) => s + c.volume, 0) / Math.min(100, candles.length);

  interface Cluster { prices: number[]; times: number[]; volumes: number[] }
  const clusters: Cluster[] = [];

  for (const s of swings) {
    const candle = candles[s.index];
    const existing = clusters.find(
      (cl) => Math.abs(cl.prices[0] - s.price) / s.price < clusterTolerance
    );
    if (existing) {
      existing.prices.push(s.price);
      existing.times.push(s.time);
      existing.volumes.push(candle.volume);
    } else {
      clusters.push({ prices: [s.price], times: [s.time], volumes: [candle.volume] });
    }
  }

  const levels: SRLevel[] = [];
  for (const cl of clusters) {
    if (cl.prices.length < 2) continue;
    const price = cl.prices.reduce((a, b) => a + b, 0) / cl.prices.length;

    // Count touches & rejections across all candles.
    let touches = 0;
    let rejections = 0;
    let volumeSum = 0;
    for (const c of candles) {
      const touched = c.low <= price * (1 + clusterTolerance) && c.high >= price * (1 - clusterTolerance);
      if (!touched) continue;
      touches++;
      volumeSum += c.volume;
      const closedAway = Math.abs(c.close - price) / price > clusterTolerance;
      if (closedAway) rejections++;
    }
    if (touches < 2) continue;

    const rejectionRatio = rejections / touches;
    const recency = 1 - Math.min(1, (candles[candles.length - 1].time - Math.max(...cl.times)) /
      (candles[candles.length - 1].time - candles[0].time + 1));
    const volumeConfirmed = volumeSum / touches > avgVolume;

    const strength = Math.round(
      Math.min(100,
        touches * 9 +
        rejectionRatio * 30 +
        recency * 20 +
        (volumeConfirmed ? 12 : 0))
    );
    // Levels weaken with every retest: many touches without holding = likely break.
    const breakProbability = Math.round(Math.min(90, Math.max(10, 25 + touches * 6 - rejectionRatio * 25)));

    levels.push({
      id: `sr-${timeframeOrigin}-${price.toFixed(6)}`,
      price,
      kind: price < lastPrice ? "support" : "resistance",
      timeframeOrigin,
      touches,
      rejections,
      strength,
      breakProbability,
      bounceProbability: 100 - breakProbability,
      volumeConfirmed,
      firstTouch: Math.min(...cl.times),
      lastTouch: Math.max(...cl.times),
    });
  }

  return levels
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 10)
    .sort((a, b) => a.price - b.price);
}
