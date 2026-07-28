import { Candle, OrderFlowResult } from "./types";

/**
 * Order flow engine.
 *
 * Derives aggression metrics from taker-buy volume (Binance klines expose
 * which side of each trade was the aggressor). Absorption is inferred when
 * heavy one-sided aggression fails to move price; exhaustion when a long
 * directional run happens on shrinking participation.
 */
export function analyzeOrderFlow(candles: Candle[]): OrderFlowResult {
  const recent = candles.slice(-30);
  const last = candles[candles.length - 1];

  let buyVol = 0;
  let sellVol = 0;
  let cumulativeDelta = 0;
  const deltaSeries: { time: number; value: number }[] = [];
  for (const c of recent) {
    const buy = c.takerBuyVolume ?? c.volume / 2;
    const sell = c.volume - buy;
    buyVol += buy;
    sellVol += sell;
    cumulativeDelta += buy - sell;
    deltaSeries.push({ time: c.time, value: buy - sell });
  }

  const total = buyVol + sellVol;
  const buyPressure = total > 0 ? Math.round((buyVol / total) * 100) : 50;
  const sellPressure = 100 - buyPressure;
  const lastBuy = last.takerBuyVolume ?? last.volume / 2;
  const delta = lastBuy - (last.volume - lastBuy);

  const aggression: OrderFlowResult["aggression"] =
    buyPressure > 56 ? "buyers" : sellPressure > 56 ? "sellers" : "balanced";

  // --- Absorption: big delta, tiny price progress ---
  const avgRange = recent.reduce((s, c) => s + (c.high - c.low), 0) / recent.length;
  const avgVol = recent.reduce((s, c) => s + c.volume, 0) / recent.length;
  const lastRange = last.high - last.low;
  let absorption: OrderFlowResult["absorption"] = { present: false, side: null, note: "" };
  if (last.volume > avgVol * 1.8 && lastRange < avgRange * 0.7) {
    const side = delta < 0 ? "buy" : "sell";
    absorption = {
      present: true,
      side,
      note:
        side === "buy"
          ? "Heavy sell aggression on high volume failed to push price down — passive buyers are absorbing sells."
          : "Heavy buy aggression on high volume failed to push price up — passive sellers are absorbing buys.",
    };
  }

  // --- Exhaustion: directional run with fading delta ---
  const last5 = recent.slice(-5);
  const dirUp = last5.every((c, i) => i === 0 || c.close >= last5[i - 1].close);
  const dirDown = last5.every((c, i) => i === 0 || c.close <= last5[i - 1].close);
  const deltas5 = last5.map((c) => {
    const b = c.takerBuyVolume ?? c.volume / 2;
    return b - (c.volume - b);
  });
  const deltaFading =
    Math.abs(deltas5[deltas5.length - 1]) < Math.abs(deltas5[0]) * 0.4;
  let exhaustion: OrderFlowResult["exhaustion"] = { present: false, side: null, note: "" };
  if (dirUp && deltaFading && deltas5[0] > 0) {
    exhaustion = {
      present: true,
      side: "buy",
      note: "Uptrend continuing but buy delta is collapsing — buyers are exhausting, pullback risk elevated.",
    };
  } else if (dirDown && deltaFading && deltas5[0] < 0) {
    exhaustion = {
      present: true,
      side: "sell",
      note: "Downtrend continuing but sell delta is collapsing — sellers are exhausting, bounce risk elevated.",
    };
  }

  // --- Large orders: volume outliers with strong directional close ---
  const largeOrders: OrderFlowResult["largeOrders"] = [];
  for (const c of recent) {
    if (c.volume > avgVol * 2.5) {
      const buy = c.takerBuyVolume ?? c.volume / 2;
      largeOrders.push({
        time: c.time,
        side: buy > c.volume - buy ? "buy" : "sell",
        volume: c.volume,
      });
    }
  }

  const notes: string[] = [];
  if (aggression === "buyers") notes.push(`Buyers control ${buyPressure}% of aggressive flow over the last 30 bars.`);
  else if (aggression === "sellers") notes.push(`Sellers control ${sellPressure}% of aggressive flow over the last 30 bars.`);
  else notes.push("Aggressive flow is balanced — two-sided auction in progress.");
  if (cumulativeDelta > 0 && aggression === "buyers") notes.push("Cumulative delta rising with price — trend is supported by real aggression, not just passive drift.");
  if (cumulativeDelta < 0 && aggression === "sellers") notes.push("Cumulative delta falling with price — sellers remain committed.");
  if (absorption.present) notes.push(absorption.note);
  if (exhaustion.present) notes.push(exhaustion.note);
  if (largeOrders.length > 0) {
    const lastLarge = largeOrders[largeOrders.length - 1];
    notes.push(`Large ${lastLarge.side === "buy" ? "buy" : "sell"} orders detected (${lastLarge.volume.toFixed(0)} contracts) — whale activity on the tape.`);
  }

  return {
    buyPressure,
    sellPressure,
    delta,
    deltaSeries,
    cumulativeDelta,
    aggression,
    absorption,
    exhaustion,
    largeOrders,
    notes,
  };
}
