import { Candle, CandlePattern } from "./types";

/**
 * Candlestick pattern engine. Patterns are scored contextually — a hammer at
 * a swing low after a decline is worth far more than one mid-range, so
 * strength blends geometry with local trend context.
 */

function body(c: Candle) { return Math.abs(c.close - c.open); }
function range(c: Candle) { return Math.max(c.high - c.low, 1e-12); }
function upperWick(c: Candle) { return c.high - Math.max(c.open, c.close); }
function lowerWick(c: Candle) { return Math.min(c.open, c.close) - c.low; }
function isBull(c: Candle) { return c.close > c.open; }
function isBear(c: Candle) { return c.close < c.open; }

/** Simple local trend: net change over the previous `n` candles. */
function localTrend(candles: Candle[], i: number, n = 10): number {
  const from = Math.max(0, i - n);
  const start = candles[from].close;
  const end = candles[i].close;
  return (end - start) / start;
}

export function detectCandlePatterns(candles: Candle[], scanLast = 40): CandlePattern[] {
  const patterns: CandlePattern[] = [];
  const start = Math.max(3, candles.length - scanLast);

  const avgBody =
    candles.slice(-60).reduce((s, c) => s + body(c), 0) / Math.min(60, candles.length);

  for (let i = start; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const pp = candles[i - 2];
    const trend = localTrend(candles, Math.max(0, i - 1));
    const downtrend = trend < -0.005;
    const uptrend = trend > 0.005;

    const push = (
      name: string,
      direction: "bullish" | "bearish" | "neutral",
      geomStrength: number,
      contextBoost: number,
      context: string,
      idx = i
    ) => {
      const strength = Math.min(100, Math.round(geomStrength + contextBoost));
      patterns.push({
        name,
        index: idx,
        time: candles[idx].time,
        direction,
        topPrice: candles[idx].high,
        bottomPrice: candles[idx].low,
        strength,
        probability: Math.min(90, Math.round(35 + strength * 0.45)),
        context,
      });
    };

    // --- Engulfing ---
    if (isBull(c) && isBear(p) && c.close > p.open && c.open < p.close && body(c) > body(p) * 1.1) {
      push("Bullish Engulfing", "bullish", 55 + Math.min(20, (body(c) / Math.max(avgBody, 1e-12)) * 8),
        downtrend ? 15 : 0,
        downtrend ? "Engulfed sellers after a decline — demand stepping in." : "Engulfing mid-move; needs confluence.");
    }
    if (isBear(c) && isBull(p) && c.close < p.open && c.open > p.close && body(c) > body(p) * 1.1) {
      push("Bearish Engulfing", "bearish", 55 + Math.min(20, (body(c) / Math.max(avgBody, 1e-12)) * 8),
        uptrend ? 15 : 0,
        uptrend ? "Engulfed buyers after a rally — supply stepping in." : "Engulfing mid-move; needs confluence.");
    }

    // --- Hammer / Shooting star / Pin bars ---
    if (lowerWick(c) > body(c) * 2 && upperWick(c) < body(c) * 0.8 && body(c) / range(c) < 0.35) {
      push(downtrend ? "Hammer" : "Bullish Pin Bar", "bullish", 50 + Math.min(25, (lowerWick(c) / range(c)) * 40),
        downtrend ? 18 : 5,
        "Long lower wick — sellers pushed price down but buyers absorbed and reclaimed.");
    }
    if (upperWick(c) > body(c) * 2 && lowerWick(c) < body(c) * 0.8 && body(c) / range(c) < 0.35) {
      push(uptrend ? "Shooting Star" : "Bearish Pin Bar", "bearish", 50 + Math.min(25, (upperWick(c) / range(c)) * 40),
        uptrend ? 18 : 5,
        "Long upper wick — buyers pushed price up but sellers absorbed and rejected.");
    }

    // --- Doji ---
    if (body(c) / range(c) < 0.1 && range(c) > avgBody * 0.5) {
      push("Doji", "neutral", 35, uptrend || downtrend ? 10 : 0,
        "Indecision candle — momentum stalling at this price.");
    }

    // --- Marubozu ---
    if (body(c) / range(c) > 0.9 && body(c) > avgBody * 1.5) {
      push(isBull(c) ? "Bullish Marubozu" : "Bearish Marubozu", isBull(c) ? "bullish" : "bearish",
        60, 8, "Full-bodied conviction candle — one side in complete control.");
    }

    // --- Inside / Outside bar ---
    if (c.high < p.high && c.low > p.low) {
      push("Inside Bar", "neutral", 30, 5, "Compression inside prior range — breakout energy building.");
    }
    if (c.high > p.high && c.low < p.low && body(c) > avgBody) {
      push(isBull(c) ? "Bullish Outside Bar" : "Bearish Outside Bar", isBull(c) ? "bullish" : "bearish",
        45, 8, "Range expansion engulfing prior bar — volatility regime shift.");
    }

    // --- Morning / Evening star (3-candle) ---
    if (pp && isBear(pp) && body(pp) > avgBody && body(p) < avgBody * 0.5 && isBull(c) && c.close > (pp.open + pp.close) / 2) {
      push("Morning Star", "bullish", 65, downtrend ? 15 : 5,
        "Three-candle reversal: capitulation, indecision, then strong buying.", i);
    }
    if (pp && isBull(pp) && body(pp) > avgBody && body(p) < avgBody * 0.5 && isBear(c) && c.close < (pp.open + pp.close) / 2) {
      push("Evening Star", "bearish", 65, uptrend ? 15 : 5,
        "Three-candle reversal: euphoria, indecision, then strong selling.", i);
    }

    // --- Strong rejection candle ---
    const wickDominant = Math.max(upperWick(c), lowerWick(c)) / range(c) > 0.6;
    if (wickDominant && range(c) > avgBody * 2.5 && (c.volume ?? 0) > 0) {
      const bullish = lowerWick(c) > upperWick(c);
      push("Strong Rejection Candle", bullish ? "bullish" : "bearish", 58, 10,
        bullish ? "Violent rejection of lower prices on expanded range." : "Violent rejection of higher prices on expanded range.");
    }
  }

  // Deduplicate: keep the strongest pattern per candle index.
  const byIndex = new Map<string, CandlePattern>();
  for (const pat of patterns) {
    const key = `${pat.index}-${pat.name}`;
    const existing = byIndex.get(key);
    if (!existing || pat.strength > existing.strength) byIndex.set(key, pat);
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}
