import { Candle, VolumeAnalysis } from "./types";

/**
 * Volume intelligence engine. Uses Binance taker-buy volume to split each
 * candle into buying vs selling volume, from which delta and cumulative
 * delta (CVD) are derived without needing raw tick data.
 */
export function analyzeVolume(candles: Candle[]): VolumeAnalysis {
  const n = candles.length;
  const last = candles[n - 1];
  const window = candles.slice(-20);
  const average = window.reduce((s, c) => s + c.volume, 0) / Math.max(window.length, 1);
  const relative = average > 0 ? last.volume / average : 1;

  const buyingVolume = last.takerBuyVolume ?? last.volume / 2;
  const sellingVolume = last.volume - buyingVolume;
  const delta = buyingVolume - sellingVolume;

  let cumulativeDelta = 0;
  const cvdSeries: { time: number; value: number }[] = [];
  for (const c of candles.slice(-120)) {
    const buy = c.takerBuyVolume ?? c.volume / 2;
    cumulativeDelta += buy - (c.volume - buy);
    cvdSeries.push({ time: c.time, value: cumulativeDelta });
  }

  const spike = relative > 2.2;
  const dryUp = relative < 0.45;
  // Climax: extreme volume + extreme range at a local extreme.
  const avgRange = window.reduce((s, c) => s + (c.high - c.low), 0) / Math.max(window.length, 1);
  const climax = relative > 3 && last.high - last.low > avgRange * 2;

  // Divergence: price making new highs/lows while volume trend fades.
  const recent = candles.slice(-12);
  const older = candles.slice(-24, -12);
  let divergence: "bullish" | "bearish" | null = null;
  if (recent.length === 12 && older.length === 12) {
    const recentVol = recent.reduce((s, c) => s + c.volume, 0);
    const olderVol = older.reduce((s, c) => s + c.volume, 0);
    const recentHigh = Math.max(...recent.map((c) => c.high));
    const olderHigh = Math.max(...older.map((c) => c.high));
    const recentLow = Math.min(...recent.map((c) => c.low));
    const olderLow = Math.min(...older.map((c) => c.low));
    if (recentHigh > olderHigh && recentVol < olderVol * 0.75) divergence = "bearish";
    if (recentLow < olderLow && recentVol < olderVol * 0.75) divergence = "bullish";
  }

  const notes: string[] = [];
  if (spike) notes.push(`Volume spike: current bar is ${relative.toFixed(1)}x the 20-bar average — institutional participation.`);
  if (dryUp) notes.push("Volume dry-up: participation fading, current move losing fuel.");
  if (climax) notes.push("Volume climax: extreme volume on extreme range — often marks exhaustion and local turning points.");
  if (divergence === "bearish") notes.push("Bearish volume divergence: price pushed to new highs on fading volume — rally lacks sponsorship.");
  if (divergence === "bullish") notes.push("Bullish volume divergence: price pushed to new lows on fading volume — selling pressure exhausting.");
  if (delta > 0 && relative > 1.2) notes.push("Positive delta on elevated volume — aggressive buyers dominating the tape.");
  if (delta < 0 && relative > 1.2) notes.push("Negative delta on elevated volume — aggressive sellers dominating the tape.");

  return {
    current: last.volume,
    average,
    relative,
    buyingVolume,
    sellingVolume,
    delta,
    cumulativeDelta,
    cvdSeries,
    spike,
    dryUp,
    climax,
    divergence,
    notes,
  };
}
