import { Bias, Candle, DeltaAnalysis, DeltaDivergence } from "./types";

/**
 * Delta & Cumulative Volume Delta (CVD) engine.
 *
 * Delta = ask volume − bid volume, i.e. aggressive buyers minus aggressive
 * sellers. It answers one question precisely: who dominated this bar?
 *
 * CVD is the running total. Unlike RSI — which is derived from price and
 * therefore lags — CVD is built from volume as it prints, so divergences
 * between price and CVD surface earlier.
 *
 * Divergence types:
 *  • Regular bearish — price makes a higher high, CVD makes a lower high.
 *    Buyers are losing conviction into new highs.
 *  • Regular bullish — price makes a lower low, CVD makes a higher low.
 *    Sellers are losing conviction into new lows.
 *  • Hidden divergences flag continuation rather than reversal.
 *
 * Trap bars: bars whose delta sign contradicts the candle body. A red
 * candle with strongly positive delta means aggressive buyers were filled
 * and immediately underwater — trapped.
 *
 * Delta alone is never a trade. It is confirmation layered onto an
 * existing level or structure.
 */

export function analyzeDelta(candles: Candle[], lookback = 120): DeltaAnalysis {
  const window = candles.slice(-lookback);
  const series: DeltaAnalysis["series"] = [];
  let cvd = 0;

  for (const c of window) {
    const buy = c.takerBuyVolume ?? c.volume / 2;
    const sell = c.volume - buy;
    const delta = buy - sell;
    cvd += delta;
    series.push({ time: c.time, delta, cvd, price: c.close });
  }

  const deltas = series.map((s) => s.delta);
  const maxDelta = deltas.length ? Math.max(...deltas) : 0;
  const minDelta = deltas.length ? Math.min(...deltas) : 0;

  // --- CVD trend from the slope of its last third ---
  const tailLen = Math.max(5, Math.floor(series.length / 3));
  const tail = series.slice(-tailLen);
  const cvdSlope = tail.length > 1 ? tail[tail.length - 1].cvd - tail[0].cvd : 0;
  const cvdTrend: Bias = cvdSlope > 0 ? "bullish" : cvdSlope < 0 ? "bearish" : "neutral";

  // --- Divergences between price pivots and CVD pivots ---
  const divergences = detectDivergences(series);

  // --- Trap bars ---
  const avgAbsDelta =
    deltas.length > 0 ? deltas.reduce((s, d) => s + Math.abs(d), 0) / deltas.length : 0;
  const trapBars: DeltaAnalysis["trapBars"] = [];
  for (let i = 0; i < window.length; i++) {
    const c = window[i];
    const d = series[i].delta;
    if (Math.abs(d) < avgAbsDelta * 1.2) continue;
    const candleDirection: Bias = c.close > c.open ? "bullish" : c.close < c.open ? "bearish" : "neutral";
    const deltaDirection: Bias = d > 0 ? "bullish" : d < 0 ? "bearish" : "neutral";
    if (candleDirection !== "neutral" && deltaDirection !== "neutral" && candleDirection !== deltaDirection) {
      trapBars.push({ time: c.time, price: c.close, candleDirection, deltaDirection, delta: d });
    }
  }

  // --- Summary ---
  const summary: string[] = [];
  const lastDelta = series[series.length - 1]?.delta ?? 0;
  summary.push(
    `Current bar delta ${lastDelta >= 0 ? "+" : ""}${lastDelta.toFixed(0)} — ${lastDelta >= 0 ? "aggressive buyers" : "aggressive sellers"} dominated this bar.`
  );
  summary.push(
    `Cumulative delta is ${cvd >= 0 ? "positive" : "negative"} and ${cvdTrend === "bullish" ? "rising" : cvdTrend === "bearish" ? "falling" : "flat"} — ${
      cvdTrend === "bullish"
        ? "buyers are being rewarded for their aggression."
        : cvdTrend === "bearish"
          ? "sellers are being rewarded for their aggression."
          : "neither side is gaining ground."
    }`
  );
  const lastDiv = divergences[divergences.length - 1];
  if (lastDiv) summary.push(lastDiv.explanation);
  const recentTraps = trapBars.slice(-3);
  if (recentTraps.length > 0) {
    const t = recentTraps[recentTraps.length - 1];
    summary.push(
      `Trap bar at ${t.price.toFixed(4)}: the candle closed ${t.candleDirection} while delta printed ${t.deltaDirection} (${t.delta >= 0 ? "+" : ""}${t.delta.toFixed(0)}). The aggressive side was absorbed and is now offside.`
    );
  }

  return {
    series,
    cvd,
    cvdTrend,
    divergences,
    trapBars: trapBars.slice(-8),
    maxDelta,
    minDelta,
    summary,
  };
}

/** Locate pivots in price and CVD, then compare their sequences. */
function detectDivergences(series: DeltaAnalysis["series"]): DeltaDivergence[] {
  const out: DeltaDivergence[] = [];
  if (series.length < 20) return out;

  const pivotWidth = 3;
  const priceHighs: number[] = [];
  const priceLows: number[] = [];
  for (let i = pivotWidth; i < series.length - pivotWidth; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - pivotWidth; j <= i + pivotWidth; j++) {
      if (j === i) continue;
      if (series[j].price >= series[i].price) isHigh = false;
      if (series[j].price <= series[i].price) isLow = false;
    }
    if (isHigh) priceHighs.push(i);
    if (isLow) priceLows.push(i);
  }

  const compare = (
    indices: number[],
    kind: "high" | "low"
  ): void => {
    for (let k = 1; k < indices.length; k++) {
      const prev = series[indices[k - 1]];
      const cur = series[indices[k]];
      const priceUp = cur.price > prev.price;
      const cvdUp = cur.cvd > prev.cvd;

      if (kind === "high" && priceUp && !cvdUp) {
        out.push({
          time: cur.time,
          kind: "regular_bearish",
          pricePoint: cur.price,
          priorPricePoint: prev.price,
          cvdPoint: cur.cvd,
          priorCvdPoint: prev.cvd,
          strength: strengthOf(prev.price, cur.price, prev.cvd, cur.cvd),
          explanation: `Bearish CVD divergence: price pushed from ${prev.price.toFixed(4)} to a higher high at ${cur.price.toFixed(4)}, but cumulative delta made a LOWER high. The rally is being sold into — buyers are losing conviction exactly where they should be strongest.`,
        });
      }
      if (kind === "low" && !priceUp && cvdUp) {
        out.push({
          time: cur.time,
          kind: "regular_bullish",
          pricePoint: cur.price,
          priorPricePoint: prev.price,
          cvdPoint: cur.cvd,
          priorCvdPoint: prev.cvd,
          strength: strengthOf(prev.price, cur.price, prev.cvd, cur.cvd),
          explanation: `Bullish CVD divergence: price slid from ${prev.price.toFixed(4)} to a lower low at ${cur.price.toFixed(4)}, but cumulative delta made a HIGHER low. Selling pressure is drying up — every dip is being bought.`,
        });
      }
      // Hidden divergences → continuation signals.
      if (kind === "low" && priceUp && !cvdUp) {
        out.push({
          time: cur.time,
          kind: "hidden_bearish",
          pricePoint: cur.price,
          priorPricePoint: prev.price,
          cvdPoint: cur.cvd,
          priorCvdPoint: prev.cvd,
          strength: strengthOf(prev.price, cur.price, prev.cvd, cur.cvd) * 0.7,
          explanation: `Hidden bearish divergence: price made a higher low while cumulative delta made a lower low — the bounce lacks real buying, favouring downtrend continuation.`,
        });
      }
      if (kind === "high" && !priceUp && cvdUp) {
        out.push({
          time: cur.time,
          kind: "hidden_bullish",
          pricePoint: cur.price,
          priorPricePoint: prev.price,
          cvdPoint: cur.cvd,
          priorCvdPoint: prev.cvd,
          strength: strengthOf(prev.price, cur.price, prev.cvd, cur.cvd) * 0.7,
          explanation: `Hidden bullish divergence: price made a lower high while cumulative delta made a higher high — the pullback is not being sold, favouring uptrend continuation.`,
        });
      }
    }
  };

  compare(priceHighs, "high");
  compare(priceLows, "low");

  return out.sort((a, b) => a.time - b.time).slice(-6);
}

function strengthOf(p1: number, p2: number, c1: number, c2: number): number {
  const priceMove = Math.abs((p2 - p1) / Math.max(Math.abs(p1), 1e-9)) * 100;
  const cvdMove = Math.abs((c2 - c1) / Math.max(Math.abs(c1), 1));
  return Math.round(Math.min(100, 40 + priceMove * 12 + Math.min(30, cvdMove * 8)));
}
