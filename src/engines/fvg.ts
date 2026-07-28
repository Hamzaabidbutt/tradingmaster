import { Candle, Zone } from "./types";

/**
 * Fair Value Gap engine.
 *
 * A bullish FVG exists when candle[i-2].high < candle[i].low — the middle
 * candle moved so fast it left an unfilled imbalance. Price frequently
 * returns to "rebalance" these gaps before continuing.
 */
export function detectFVGs(candles: Candle[]): Zone[] {
  const fvgs: Zone[] = [];
  for (let i = 2; i < candles.length; i++) {
    const a = candles[i - 2];
    const b = candles[i - 1];
    const c = candles[i];

    // Bullish gap
    if (a.high < c.low) {
      const top = c.low;
      const bottom = a.high;
      const gapPct = (top - bottom) / bottom;
      if (gapPct < 0.0005) continue; // ignore dust gaps
      fvgs.push(trackFill(candles, i, {
        id: `fvg-bull-${b.time}`,
        type: "fvg",
        direction: "bullish",
        top,
        bottom,
        startTime: b.time,
        status: "fresh",
        strength: Math.min(90, 40 + gapPct * 8000),
        note: "Bullish imbalance — unfilled buy-side inefficiency",
      }));
    }
    // Bearish gap
    if (a.low > c.high) {
      const top = a.low;
      const bottom = c.high;
      const gapPct = (top - bottom) / top;
      if (gapPct < 0.0005) continue;
      fvgs.push(trackFill(candles, i, {
        id: `fvg-bear-${b.time}`,
        type: "fvg",
        direction: "bearish",
        top,
        bottom,
        startTime: b.time,
        status: "fresh",
        strength: Math.min(90, 40 + gapPct * 8000),
        note: "Bearish imbalance — unfilled sell-side inefficiency",
      }));
    }
  }
  return fvgs.slice(-15);
}

function trackFill(candles: Candle[], fromIdx: number, zone: Zone): Zone {
  const mid = (zone.top + zone.bottom) / 2;
  for (let i = fromIdx + 1; i < candles.length; i++) {
    const c = candles[i];
    if (zone.direction === "bullish") {
      if (c.low <= zone.bottom) { zone.status = "filled"; zone.endTime = c.time; break; }
      if (c.low <= mid) zone.status = "partial";
    } else {
      if (c.high >= zone.top) { zone.status = "filled"; zone.endTime = c.time; break; }
      if (c.high >= mid) zone.status = "partial";
    }
  }
  if (zone.status === "filled") zone.strength = Math.max(10, zone.strength - 40);
  return zone;
}
