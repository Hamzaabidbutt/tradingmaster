import { Candle, PremiumDiscount, SwingPoint } from "./types";

/**
 * Premium/discount zones from the current dealing range (last major swing
 * high to last major swing low). Smart money buys at discount (< 50% of the
 * range) and sells at premium (> 50%).
 */
export function analyzePremiumDiscount(
  candles: Candle[],
  swings: SwingPoint[]
): PremiumDiscount {
  const majors = swings.filter((s) => s.degree === "major");
  const lastHigh = [...majors].reverse().find((s) => s.kind === "high");
  const lastLow = [...majors].reverse().find((s) => s.kind === "low");
  const lastClose = candles[candles.length - 1]?.close ?? 0;

  const rangeHigh = lastHigh?.price ?? Math.max(...candles.slice(-50).map((c) => c.high));
  const rangeLow = lastLow?.price ?? Math.min(...candles.slice(-50).map((c) => c.low));
  const hi = Math.max(rangeHigh, rangeLow);
  const lo = Math.min(rangeHigh, rangeLow);
  const equilibrium = (hi + lo) / 2;
  const span = Math.max(hi - lo, 1e-12);
  const positionInRange = Math.min(1, Math.max(0, (lastClose - lo) / span));

  return {
    rangeHigh: hi,
    rangeLow: lo,
    equilibrium,
    currentZone:
      positionInRange > 0.55 ? "premium" : positionInRange < 0.45 ? "discount" : "equilibrium",
    positionInRange,
  };
}
