import { Candle, LiquidationAnalysis, LiquidationEstimate } from "./types";

/**
 * Aggregate liquidation analysis.
 *
 * Binance no longer exposes historical forced-order data over REST, so the
 * engine estimates liquidation events from their price/volume signature:
 * a fast displacement on outsized volume with one-sided delta is, on
 * futures pairs, dominated by cascading forced orders. Live individual
 * liquidations stream into the UI via the <symbol>@forceOrder websocket.
 *
 * Estimated leverage bands (25x/50x/100x) project where open positions
 * cluster; the zones price would sweep to liquidate them are the "heat" map.
 */
export function analyzeLiquidations(candles: Candle[]): LiquidationAnalysis {
  const recent = candles.slice(-60);
  const last = candles[candles.length - 1];
  const avgVol = recent.reduce((s, c) => s + c.volume, 0) / Math.max(recent.length, 1);
  const avgRange = recent.reduce((s, c) => s + (c.high - c.low), 0) / Math.max(recent.length, 1);

  const events: LiquidationEstimate[] = [];
  for (const c of recent) {
    const movePct = ((c.close - c.open) / c.open) * 100;
    const rangeX = (c.high - c.low) / Math.max(avgRange, 1e-12);
    const volX = c.volume / Math.max(avgVol, 1e-12);
    if (rangeX > 2 && volX > 2) {
      const buy = c.takerBuyVolume ?? c.volume / 2;
      const deltaRatio = (buy - (c.volume - buy)) / c.volume;
      // Sharp down move + heavy sell aggression = longs being force-closed.
      if (movePct < -0.15 && deltaRatio < -0.1) {
        events.push({
          time: c.time,
          side: "long",
          intensity: Math.min(100, Math.round(30 + rangeX * 12 + volX * 10)),
          priceMovePct: movePct,
          note: "Fast markdown on outsized volume with sell-side aggression — long liquidation signature.",
        });
      }
      // Sharp up move + heavy buy aggression = shorts being force-closed.
      if (movePct > 0.15 && deltaRatio > 0.1) {
        events.push({
          time: c.time,
          side: "short",
          intensity: Math.min(100, Math.round(30 + rangeX * 12 + volX * 10)),
          priceMovePct: movePct,
          note: "Fast markup on outsized volume with buy-side aggression — short liquidation signature.",
        });
      }
    }
  }

  const recentEvents = events.slice(-10);
  const longPressure = Math.min(100, recentEvents.filter((e) => e.side === "long").reduce((s, e) => s + e.intensity, 0) / 3);
  const shortPressure = Math.min(100, recentEvents.filter((e) => e.side === "short").reduce((s, e) => s + e.intensity, 0) / 3);

  // Liquidation clusters: project where leveraged entries from recent swing
  // extremes would be force-closed (25x ≈ 4%, 50x ≈ 2%, 100x ≈ 1% moves).
  const swingHigh = Math.max(...recent.map((c) => c.high));
  const swingLow = Math.min(...recent.map((c) => c.low));
  const clusters: LiquidationAnalysis["clusters"] = [
    { priceLow: swingLow * 0.99, priceHigh: swingLow * 0.998, side: "long", heat: 70 },
    { priceLow: swingLow * 0.96, priceHigh: swingLow * 0.98, side: "long", heat: 45 },
    { priceLow: swingHigh * 1.002, priceHigh: swingHigh * 1.01, side: "short", heat: 70 },
    { priceLow: swingHigh * 1.02, priceHigh: swingHigh * 1.04, side: "short", heat: 45 },
  ];

  // Cascade risk: consecutive same-side events compounding.
  let cascadeRisk = 0;
  for (let i = 1; i < recentEvents.length; i++) {
    if (recentEvents[i].side === recentEvents[i - 1].side) cascadeRisk += 18;
  }
  cascadeRisk = Math.min(100, cascadeRisk);

  const lastEvent = recentEvents[recentEvents.length - 1];
  const whaleDriven = lastEvent ? lastEvent.intensity > 70 : false;
  // A violent liquidation flush that immediately mean-reverts is a fake move.
  let likelyFakeMove = false;
  let reversalProbability = 35;
  if (lastEvent) {
    const evIdx = candles.findIndex((c) => c.time === lastEvent.time);
    const after = candles.slice(evIdx + 1);
    if (after.length >= 2) {
      const evCandle = candles[evIdx];
      const retraced =
        lastEvent.side === "long"
          ? after[after.length - 1].close > (evCandle.open + evCandle.close) / 2
          : after[after.length - 1].close < (evCandle.open + evCandle.close) / 2;
      likelyFakeMove = retraced;
      reversalProbability = retraced ? 70 : lastEvent.intensity > 60 ? 55 : 40;
    } else {
      reversalProbability = lastEvent.intensity > 60 ? 55 : 40;
    }
  }

  const summary: string[] = [];
  if (lastEvent) {
    summary.push(
      `${lastEvent.side === "long" ? "Longs" : "Shorts"} were liquidated on the last impulse (intensity ${lastEvent.intensity}/100, move ${lastEvent.priceMovePct.toFixed(2)}%).`
    );
    if (whaleDriven) summary.push("Order size profile suggests whales triggered the cascade deliberately.");
    if (likelyFakeMove) summary.push("Price is already reclaiming the flush — high probability this was an engineered fake move.");
  } else {
    summary.push("No significant liquidation events detected in the recent window.");
  }
  if (cascadeRisk > 50) summary.push(`Cascade risk elevated (${cascadeRisk}/100): stacked same-side liquidations can chain into the next cluster.`);
  if (longPressure > shortPressure && longPressure > 30) summary.push("Net liquidation pressure sits on longs — downside wicks into long clusters remain attractive for market makers.");
  if (shortPressure > longPressure && shortPressure > 30) summary.push("Net liquidation pressure sits on shorts — upside squeezes into short clusters remain attractive.");

  return {
    recentEvents,
    longLiquidationPressure: Math.round(longPressure),
    shortLiquidationPressure: Math.round(shortPressure),
    cascadeRisk,
    clusters,
    whaleDriven,
    likelyFakeMove,
    reversalProbability,
    summary,
  };
}
