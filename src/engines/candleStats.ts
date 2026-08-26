import { Candle, FullAnalysis } from "./types";

/**
 * Per-candle statistics for the click inspector.
 *
 * Everything here is already computed somewhere in the analysis for the chart
 * as a whole; this pulls the values belonging to ONE bar into a single object
 * so clicking a candle answers "what happened in this specific bar" without
 * the reader cross-referencing four panels.
 *
 * Delta and liquidation figures are looked up from the analysis series by
 * timestamp when available, and derived from the candle itself when the bar
 * falls outside the analysed window (the chart holds more history than some
 * engines analyse).
 */

export interface CandleStats {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** high − low in price terms */
  range: number;
  /** range as a percentage of the low */
  rangePct: number;
  /** close − open, direction of the body */
  changePct: number;
  volume: number;
  buyVolume: number;
  sellVolume: number;
  /** buyVolume − sellVolume */
  deltaVolume: number;
  /** share of the bar's volume that lifted the ask, 0-100 */
  buyPct: number;
  /** forced-flow delta for this bar; null when outside the analysed window */
  liquidationDelta: number | null;
  /** running forced-flow total at this bar; null when outside the window */
  liquidationCumulative: number | null;
  /** running volume delta (CVD) at this bar; null when outside the window */
  cvd: number | null;
  bullish: boolean;
  /** volume relative to the surrounding average, 1 = normal */
  volumeMultiple: number | null;
}

export function computeCandleStats(
  candle: Candle,
  candles: Candle[],
  analysis: FullAnalysis | null
): CandleStats {
  const buyVolume = candle.takerBuyVolume ?? candle.volume / 2;
  const sellVolume = candle.volume - buyVolume;
  const range = candle.high - candle.low;

  // Liquidation and CVD series only cover the analysed window; a bar outside
  // it reports null rather than a fabricated zero.
  const liqPoint = analysis?.liquidationDelta.series.find((p) => p.time === candle.time) ?? null;
  const deltaPoint = analysis?.delta.series.find((p) => p.time === candle.time) ?? null;

  // Volume multiple is relative to the 20 bars ending at this one, so it
  // describes the bar in its own context rather than against the whole chart.
  const idx = candles.findIndex((c) => c.time === candle.time);
  let volumeMultiple: number | null = null;
  if (idx >= 0) {
    const window = candles.slice(Math.max(0, idx - 20), idx);
    if (window.length >= 5) {
      const avg = window.reduce((s, c) => s + c.volume, 0) / window.length;
      if (avg > 0) volumeMultiple = Number((candle.volume / avg).toFixed(2));
    }
  }

  return {
    time: candle.time,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    range,
    rangePct: candle.low > 0 ? Number(((range / candle.low) * 100).toFixed(3)) : 0,
    changePct: candle.open > 0 ? Number((((candle.close - candle.open) / candle.open) * 100).toFixed(3)) : 0,
    volume: candle.volume,
    buyVolume,
    sellVolume,
    deltaVolume: buyVolume - sellVolume,
    buyPct: candle.volume > 0 ? Number(((buyVolume / candle.volume) * 100).toFixed(1)) : 50,
    liquidationDelta: liqPoint ? liqPoint.delta : null,
    liquidationCumulative: liqPoint ? liqPoint.cumulative : null,
    cvd: deltaPoint ? deltaPoint.cvd : null,
    bullish: candle.close >= candle.open,
    volumeMultiple,
  };
}

/** Nearest candle to a clicked timestamp, or null if the series is empty. */
export function candleAtTime(candles: Candle[], time: number): Candle | null {
  if (candles.length === 0) return null;
  let best: Candle | null = null;
  let bestDist = Infinity;
  for (const c of candles) {
    const d = Math.abs(c.time - time);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}
