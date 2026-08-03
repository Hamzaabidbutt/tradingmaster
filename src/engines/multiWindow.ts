import { Bias, Candle, MultiWindowResult, WindowInsight } from "./types";

/**
 * Multi-window lookback engine.
 *
 * The same tape reads differently depending on how far back you stand. A
 * 3-bar read catches the immediate impulse; a 15-bar read shows whether
 * that impulse is part of something larger or is fighting it. Traders
 * routinely fool themselves by looking at exactly one lookback and
 * mistaking it for "the trend".
 *
 * This engine runs an identical analysis across several lookbacks and then
 * reports the CONSENSUS — how many windows agree, and whether the short
 * windows are diverging from the long ones (an early turn), which is
 * information no single window can give you.
 */

export const DEFAULT_LOOKBACKS = [3, 5, 7, 10, 12, 15];

export function buildMultiWindow(
  candles: Candle[],
  lookbacks: number[] = DEFAULT_LOOKBACKS
): MultiWindowResult {
  const usable = lookbacks.filter((n) => candles.length >= n + 2);
  if (usable.length === 0) {
    return { windows: [], consensus: { bias: "neutral", agreement: 0, bullishCount: 0, bearishCount: 0, neutralCount: 0, shortTermBias: "neutral", longTermBias: "neutral", diverging: false, summary: [] } };
  }

  // Baseline for "normal" volume/range, wider than any single window.
  const baseline = candles.slice(-Math.min(80, candles.length));
  const avgVol = baseline.reduce((s, c) => s + c.volume, 0) / baseline.length;
  const avgRange = baseline.reduce((s, c) => s + (c.high - c.low), 0) / baseline.length;

  const windows = usable.map((n) => analyzeWindow(candles, n, avgVol, avgRange));

  /* ---------------- Consensus ---------------- */
  const bullishCount = windows.filter((w) => w.bias === "bullish").length;
  const bearishCount = windows.filter((w) => w.bias === "bearish").length;
  const neutralCount = windows.length - bullishCount - bearishCount;

  const bias: Bias =
    bullishCount > bearishCount && bullishCount >= windows.length / 2
      ? "bullish"
      : bearishCount > bullishCount && bearishCount >= windows.length / 2
        ? "bearish"
        : "neutral";
  const agreement = Math.round((Math.max(bullishCount, bearishCount) / windows.length) * 100);

  // Short vs long horizon: the first two windows against the last two.
  const shortWindows = windows.slice(0, 2);
  const longWindows = windows.slice(-2);
  const avgOdds = (ws: WindowInsight[]) =>
    ws.reduce((s, w) => s + w.bullishOdds, 0) / Math.max(ws.length, 1);
  const shortOdds = avgOdds(shortWindows);
  const longOdds = avgOdds(longWindows);
  const shortTermBias: Bias = shortOdds >= 56 ? "bullish" : shortOdds <= 44 ? "bearish" : "neutral";
  const longTermBias: Bias = longOdds >= 56 ? "bullish" : longOdds <= 44 ? "bearish" : "neutral";
  const diverging =
    shortTermBias !== "neutral" && longTermBias !== "neutral" && shortTermBias !== longTermBias;

  const summary: string[] = [];
  summary.push(
    `${Math.max(bullishCount, bearishCount)} of ${windows.length} lookbacks agree ${bias === "neutral" ? "on nothing decisive" : bias} (${agreement}% agreement).`
  );
  if (diverging) {
    summary.push(
      `Diverging horizons: short lookbacks read ${shortTermBias} while long lookbacks read ${longTermBias} — the immediate tape has turned against the broader move. This is what an early reversal looks like before structure confirms it; it is also what a normal pullback looks like, so it needs a level to act on.`
    );
  } else if (bias !== "neutral" && agreement >= 80) {
    summary.push(
      `Every horizon points the same way, which is the cleanest condition for trading with the move rather than fading it — though it also means the easy part of the move may already be behind price.`
    );
  } else if (bias === "neutral") {
    summary.push(
      `Horizons disagree with no majority — genuinely two-sided conditions. The honest read is that there is no edge here until one side takes control on real volume.`
    );
  }

  // Flag the single most informative window.
  const strongest = [...windows].sort(
    (a, b) => Math.abs(b.bullishOdds - 50) - Math.abs(a.bullishOdds - 50)
  )[0];
  if (strongest && Math.abs(strongest.bullishOdds - 50) > 12) {
    summary.push(
      `The ${strongest.bars}-bar window carries the strongest signal (${Math.max(strongest.bullishOdds, 100 - strongest.bullishOdds)}% ${strongest.bias}): ${strongest.headline}`
    );
  }

  return {
    windows,
    consensus: {
      bias,
      agreement,
      bullishCount,
      bearishCount,
      neutralCount,
      shortTermBias,
      longTermBias,
      diverging,
      summary,
    },
  };
}

function analyzeWindow(
  candles: Candle[],
  bars: number,
  avgVol: number,
  avgRange: number
): WindowInsight {
  const w = candles.slice(-bars);
  const priceStart = w[0].open;
  const priceEnd = w[w.length - 1].close;
  const changePct = ((priceEnd - priceStart) / priceStart) * 100;
  const high = Math.max(...w.map((c) => c.high));
  const low = Math.min(...w.map((c) => c.low));

  let buyVolume = 0;
  let sellVolume = 0;
  let bullishCandles = 0;
  let bearishCandles = 0;
  let absorptionCount = 0;

  for (const c of w) {
    const buy = c.takerBuyVolume ?? c.volume / 2;
    const sell = c.volume - buy;
    buyVolume += buy;
    sellVolume += sell;
    const d = buy - sell;
    if (c.close > c.open) {
      bullishCandles++;
      if (d < 0) absorptionCount++;
    } else if (c.close < c.open) {
      bearishCandles++;
      if (d > 0) absorptionCount++;
    }
  }

  const totalVolume = buyVolume + sellVolume;
  const delta = buyVolume - sellVolume;
  const buyPct = totalVolume > 0 ? (buyVolume / totalVolume) * 100 : 50;
  const volumeMultiple = totalVolume / Math.max(avgVol * bars, 1e-9);
  const rangeMultiple = (high - low) / Math.max(avgRange, 1e-9);

  // Point of control across the window.
  const poc = computePoc(w, high, low);

  // Participation trend within the window.
  const half = Math.max(1, Math.floor(bars / 2));
  const v1 = w.slice(0, half).reduce((s, c) => s + c.volume, 0);
  const v2 = w.slice(half).reduce((s, c) => s + c.volume, 0);
  const volumeTrendPct = v1 > 0 ? ((v2 - v1) / v1) * 100 : 0;

  /* ---------------- Directional score ---------------- */
  let score = 0;
  // Aggression is the primary input.
  score += (buyPct - 50) * 1.15;
  // Direction, damped — a few bars of drift proves little on its own.
  score += clamp(changePct * 5, -16, 16);
  // Candle count balance.
  score += ((bullishCandles - bearishCandles) / bars) * 14;
  // Absorbed aggression argues against the aggressive side.
  score += absorptionCount > 0 ? (delta > 0 ? -6 : 6) * absorptionCount : 0;
  // A directional move on fading participation is less trustworthy.
  if (Math.abs(changePct) > 0.05 && volumeTrendPct < -25) {
    score += changePct > 0 ? -8 : 8;
  }
  // Closing near the window extreme shows who won the period.
  const position = high > low ? (priceEnd - low) / (high - low) : 0.5;
  score += (position - 0.5) * 18;

  const bullishOdds = Math.round(50 + Math.tanh(score / 42) * 38);
  const bias: Bias = bullishOdds >= 56 ? "bullish" : bullishOdds <= 44 ? "bearish" : "neutral";

  /* ---------------- Narrative ---------------- */
  const headline =
    bias === "bullish"
      ? `Buyers control the last ${bars} bars`
      : bias === "bearish"
        ? `Sellers control the last ${bars} bars`
        : `Last ${bars} bars are two-sided`;

  const detailParts: string[] = [];
  detailParts.push(
    `${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}% on ${volumeMultiple.toFixed(2)}x normal volume, ${buyPct.toFixed(0)}% of it buying.`
  );
  detailParts.push(
    `${bullishCandles} up / ${bearishCandles} down bars, closing at ${(position * 100).toFixed(0)}% of the window range.`
  );
  if (absorptionCount > 0) {
    detailParts.push(
      `${absorptionCount} bar(s) closed against their own delta — aggression absorbed, which argues against the side doing the pushing.`
    );
  }
  if (volumeTrendPct < -25) {
    detailParts.push(`Participation fell ${Math.abs(volumeTrendPct).toFixed(0)}% through the window.`);
  } else if (volumeTrendPct > 40) {
    detailParts.push(`Participation rose ${volumeTrendPct.toFixed(0)}% through the window — the move is attracting size.`);
  }

  return {
    bars,
    from: w[0].time,
    to: w[w.length - 1].time,
    priceStart,
    priceEnd,
    changePct: Number(changePct.toFixed(3)),
    high,
    low,
    poc,
    totalVolume,
    buyVolume,
    sellVolume,
    delta,
    buyPct: Number(buyPct.toFixed(1)),
    volumeMultiple: Number(volumeMultiple.toFixed(2)),
    rangeMultiple: Number(rangeMultiple.toFixed(2)),
    volumeTrendPct: Number(volumeTrendPct.toFixed(1)),
    bullishCandles,
    bearishCandles,
    absorptionCount,
    closePosition: Number(position.toFixed(3)),
    bias,
    bullishOdds,
    headline,
    detail: detailParts.join(" "),
  };
}

function computePoc(w: Candle[], high: number, low: number, bins = 20): number {
  const span = Math.max(high - low, 1e-9);
  const binSize = span / bins;
  const buckets = new Array(bins).fill(0);
  for (const c of w) {
    const s = clamp(Math.floor((c.low - low) / binSize), 0, bins - 1);
    const e = clamp(Math.floor((c.high - low) / binSize), 0, bins - 1);
    const touched = e - s + 1;
    for (let b = s; b <= e; b++) buckets[b] += c.volume / touched;
  }
  let best = 0;
  for (let i = 1; i < bins; i++) if (buckets[i] > buckets[best]) best = i;
  return low + binSize * (best + 0.5);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
