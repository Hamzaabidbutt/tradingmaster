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
 *
 * ## Why sub-candles matter here
 *
 * The estimator is inherently *relative*: a bar counts as forced when its
 * range and volume are outsized against the mean of the bars around it. Run
 * that on the displayed timeframe alone and the same real event appears or
 * disappears depending on how the chart was sampled — a three-minute cascade
 * fills one 5m bar (3× the average, easily detected) but is diluted inside a
 * 15m bar that also holds twelve minutes of ordinary trade (1.4×, invisible).
 *
 * Forced flow happened at a real time for a real size, so it must not be a
 * function of the user's timeframe button. Given `subCandles`, detection runs
 * at that finer resolution and the results are summed into the parent bars,
 * exactly as `buildFootprint` reconstructs intrabar structure. `fidelity`
 * reports which path produced the numbers, because a reconstructed figure and
 * a same-timeframe estimate do not deserve equal trust.
 */

/** Per-candle forced flow, measured against the supplied series' own averages. */
function detectForced(candles: Candle[]): Map<number, { long: number; short: number }> {
  const out = new Map<number, { long: number; short: number }>();
  if (candles.length < 5) return out;

  const avgVol = candles.reduce((s, c) => s + c.volume, 0) / candles.length;
  const avgRange = candles.reduce((s, c) => s + (c.high - c.low), 0) / candles.length;

  for (const c of candles) {
    const buy = c.takerBuyVolume ?? c.volume / 2;
    const sell = c.volume - buy;
    const rangeX = (c.high - c.low) / Math.max(avgRange, 1e-9);
    const volX = c.volume / Math.max(avgVol, 1e-9);
    const movePct = ((c.close - c.open) / Math.max(c.open, 1e-9)) * 100;

    let long = 0;
    let short = 0;

    // Forced flow only registers when displacement AND volume are both
    // outsized — ordinary two-sided trade is not liquidation.
    if (rangeX > 1.6 && volX > 1.6) {
      const intensity = Math.min(1, (rangeX - 1.6) * 0.5 + (volX - 1.6) * 0.35);
      const sellDominance = sell / Math.max(c.volume, 1e-9);
      const buyDominance = buy / Math.max(c.volume, 1e-9);

      // Sharp markdown on seller aggression = longs being force-closed.
      if (movePct < -0.1 && sellDominance > 0.52) {
        long = c.volume * intensity * (sellDominance - 0.5) * 2;
      }
      // Sharp markup on buyer aggression = shorts being force-closed.
      if (movePct > 0.1 && buyDominance > 0.52) {
        short = c.volume * intensity * (buyDominance - 0.5) * 2;
      }
    }
    out.set(c.time, { long, short });
  }
  return out;
}

/**
 * Sum sub-candle forced flow into the parent bars.
 *
 * Each parent claims sub-candles from its own open time up to the next
 * parent's. The final parent has no successor, so its span is inferred from
 * the parent spacing — without that the still-forming bar would silently drop
 * every sub-candle inside it, which is precisely the bar a trader is watching.
 */
function aggregateToParents(
  parents: Candle[],
  subCandles: Candle[]
): Map<number, { long: number; short: number }> {
  const perSub = detectForced(subCandles);
  const out = new Map<number, { long: number; short: number }>();
  if (parents.length === 0) return out;

  const span =
    parents.length > 1
      ? parents[parents.length - 1].time - parents[parents.length - 2].time
      : Number.MAX_SAFE_INTEGER;

  for (let i = 0; i < parents.length; i++) {
    const start = parents[i].time;
    const end = i + 1 < parents.length ? parents[i + 1].time : start + span;
    let long = 0;
    let short = 0;
    for (const sub of subCandles) {
      if (sub.time < start || sub.time >= end) continue;
      const f = perSub.get(sub.time);
      if (f) {
        long += f.long;
        short += f.short;
      }
    }
    out.set(start, { long, short });
  }
  return out;
}

export function analyzeLiquidationDelta(
  candles: Candle[],
  lookback = 60,
  subCandles?: Candle[] | null
): LiquidationDeltaResult {
  const window = candles.slice(-lookback);
  if (window.length < 5) {
    return {
      series: [],
      netDelta: 0,
      cumulative: 0,
      dominantSide: "balanced",
      fidelity: "estimated",
      summary: [],
    };
  }

  // Sub-candles are only usable if they actually cover the window; a short or
  // stale slice would under-report rather than fail, which is worse than
  // falling back to the same-timeframe estimate and saying so.
  const usableSubs =
    subCandles && subCandles.length >= window.length * 2
      ? subCandles.filter((c) => c.time >= window[0].time)
      : null;
  const fidelity: LiquidationDeltaResult["fidelity"] =
    usableSubs && usableSubs.length >= window.length ? "sub_candle" : "estimated";

  const forced =
    fidelity === "sub_candle"
      ? aggregateToParents(window, usableSubs!)
      : detectForced(window);

  const series: LiquidationDeltaPoint[] = [];
  let cumulative = 0;

  for (const c of window) {
    const f = forced.get(c.time) ?? { long: 0, short: 0 };
    const longLiquidated = f.long;
    const shortLiquidated = f.short;
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

  summary.push(
    fidelity === "sub_candle"
      ? "Forced volume was reconstructed from lower-timeframe candles, so a cascade reads the same size on this chart as it does on a faster one."
      : "Forced volume was estimated from these bars directly — no lower-timeframe data was available. An event shorter than one bar can be diluted below the detection threshold here while remaining visible on a faster timeframe."
  );

  return {
    series,
    netDelta: Number(netDelta.toFixed(2)),
    cumulative: Number(cumulative.toFixed(2)),
    dominantSide,
    fidelity,
    summary,
  };
}
