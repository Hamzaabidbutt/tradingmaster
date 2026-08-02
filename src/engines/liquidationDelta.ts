import { Candle, LiquidationDeltaResult, LiquidationDeltaPoint } from "./types";

/**
 * Aggregate liquidation delta.
 *
 * Where volume delta measures voluntary aggression, liquidation delta
 * measures FORCED flow: how much was liquidated on each side per bar.
 *
 *   delta = shortLiquidated − longLiquidated
 *
 * Positive delta means shorts are being squeezed out (forced buying,
 * which pushes price up); negative means longs are being flushed (forced
 * selling). The cumulative line shows which cohort has been paying for
 * the move overall.
 *
 * Forced flow matters because it is price-insensitive — a liquidation
 * engine does not care about value, it just closes. That is what turns an
 * ordinary move into a cascade, and it is also why liquidation-driven
 * extremes so often mean-revert once the forced supply is exhausted.
 *
 * Binance does not serve historical forced-order data over REST, so bar
 * liquidation volume is estimated from the price/volume/delta signature
 * (fast displacement + outsized volume + one-sided aggression). Live
 * per-order truth arrives separately over the `@forceOrder` websocket and
 * is displayed alongside this in the UI.
 */

export function analyzeLiquidationDelta(candles: Candle[], lookback = 60): LiquidationDeltaResult {
  const window = candles.slice(-lookback);
  if (window.length < 5) {
    return { series: [], netDelta: 0, cumulative: 0, dominantSide: "balanced", summary: [] };
  }

  const avgVol = window.reduce((s, c) => s + c.volume, 0) / window.length;
  const avgRange = window.reduce((s, c) => s + (c.high - c.low), 0) / window.length;

  const series: LiquidationDeltaPoint[] = [];
  let cumulative = 0;

  for (const c of window) {
    const buy = c.takerBuyVolume ?? c.volume / 2;
    const sell = c.volume - buy;
    const range = c.high - c.low;
    const rangeX = range / Math.max(avgRange, 1e-9);
    const volX = c.volume / Math.max(avgVol, 1e-9);
    const movePct = ((c.close - c.open) / Math.max(c.open, 1e-9)) * 100;

    let longLiquidated = 0;
    let shortLiquidated = 0;

    // Forced flow only registers when displacement AND volume are both
    // outsized — ordinary two-sided trade is not liquidation.
    if (rangeX > 1.6 && volX > 1.6) {
      const intensity = Math.min(1, (rangeX - 1.6) * 0.5 + (volX - 1.6) * 0.35);
      const sellDominance = sell / Math.max(c.volume, 1e-9);
      const buyDominance = buy / Math.max(c.volume, 1e-9);

      // Sharp markdown on seller aggression = longs being force-closed.
      if (movePct < -0.1 && sellDominance > 0.52) {
        longLiquidated = c.volume * intensity * (sellDominance - 0.5) * 2;
      }
      // Sharp markup on buyer aggression = shorts being force-closed.
      if (movePct > 0.1 && buyDominance > 0.52) {
        shortLiquidated = c.volume * intensity * (buyDominance - 0.5) * 2;
      }
    }

    const delta = shortLiquidated - longLiquidated;
    cumulative += delta;
    series.push({
      time: c.time,
      longLiquidated,
      shortLiquidated,
      delta,
      cumulative,
    });
  }

  const recent = series.slice(-12);
  const netDelta = recent.reduce((s, p) => s + p.delta, 0);
  const totalLong = series.reduce((s, p) => s + p.longLiquidated, 0);
  const totalShort = series.reduce((s, p) => s + p.shortLiquidated, 0);
  const totalForced = totalLong + totalShort;

  const dominantSide: LiquidationDeltaResult["dominantSide"] =
    totalForced <= 0
      ? "balanced"
      : totalLong > totalShort * 1.25
        ? "long"
        : totalShort > totalLong * 1.25
          ? "short"
          : "balanced";

  const summary: string[] = [];
  if (totalForced <= 0) {
    summary.push("No meaningful forced flow detected in this window — the move is being driven by voluntary participants, which tends to be more durable than a liquidation cascade.");
  } else {
    summary.push(
      `Aggregate liquidation delta over the window is ${cumulative >= 0 ? "+" : ""}${cumulative.toFixed(0)} — ${
        dominantSide === "long"
          ? "longs have absorbed the bulk of forced closures, meaning much of the decline was fuelled by liquidations rather than fresh selling."
          : dominantSide === "short"
            ? "shorts have absorbed the bulk of forced closures, meaning much of the rally was fuelled by a squeeze rather than fresh buying."
            : "forced flow is roughly balanced between both cohorts."
      }`
    );
    summary.push(
      `Recent liquidation delta is ${netDelta >= 0 ? "positive" : "negative"} (${netDelta >= 0 ? "+" : ""}${netDelta.toFixed(0)}) — ${netDelta >= 0 ? "shorts" : "longs"} are currently the side being forced out.`
    );
    const lastBig = [...series].reverse().find((p) => Math.abs(p.delta) > 0);
    if (lastBig) {
      summary.push(
        `Most recent forced event favoured ${lastBig.delta >= 0 ? "upside (short squeeze)" : "downside (long flush)"}. Cascades exhaust once the trapped cohort is cleared, so fading the final flush is often better than chasing it.`
      );
    }
  }

  return {
    series,
    netDelta: Number(netDelta.toFixed(2)),
    cumulative: Number(cumulative.toFixed(2)),
    dominantSide,
    summary,
  };
}
