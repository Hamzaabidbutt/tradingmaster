import {
  Bias,
  Candle,
  FullAnalysis,
  PressureMap,
  PressureZone,
  WhaleOrder,
} from "./types";

/**
 * Pressure map — where the forced buyers and forced sellers are.
 *
 * Everything on this map is a price the market has a mechanical reason to
 * travel to, as opposed to a price someone thinks is fair:
 *
 *  • **Squeeze zones** — clusters of stops that, once touched, produce buying
 *    (short squeeze) or selling (long squeeze) from participants who have no
 *    choice. Built from unswept swing liquidity and equal highs/lows.
 *  • **Forced liquidation prices** — where leveraged positions opened around
 *    recent value get closed by the exchange. Projected at the common retail
 *    bands (25x ≈ 4%, 50x ≈ 2%, 100x ≈ 1%), because those are where the
 *    clusters actually sit.
 *  • **Whale orders** — outsized prints already on the tape, with the price
 *    they executed at. A large buy that price later revisits tends to defend;
 *    a large buy that price has left behind is trapped.
 *  • **CVD divergence** — where aggression and price disagreed, which is the
 *    early tell that one of the above is about to matter.
 *
 * Estimates, clearly: Binance publishes no aggregate liquidation heatmap over
 * REST, so leverage bands are modelled from price structure rather than from
 * real open interest per level. Every zone carries its own basis so nothing
 * here reads as measured when it is inferred.
 */

export function buildPressureMap(
  candles: Candle[],
  analysis: Omit<FullAnalysis, "pressureMap" | "setup" | "insights" | "bias" | "bullishProbability" | "bearishProbability">
): PressureMap {
  const price = analysis.price;
  const recent = candles.slice(-60);
  const avgVol =
    recent.length > 0 ? recent.reduce((s, c) => s + c.volume, 0) / recent.length : 0;

  const shortSqueeze: PressureZone[] = [];
  const longSqueeze: PressureZone[] = [];

  /* ---------------- Squeeze zones from resting liquidity ---------------- */
  // Unswept liquidity above price = short stops; below = long stops.
  for (const level of analysis.liquidity.levels) {
    if (level.swept) continue;
    const distPct = ((level.price - price) / price) * 100;
    if (Math.abs(distPct) > 12) continue; // too far to be actionable

    const isEqual = level.kind === "equal_highs" || level.kind === "equal_lows";
    const zone: PressureZone = {
      price: level.price,
      distancePct: Number(distPct.toFixed(2)),
      side: distPct > 0 ? "short" : "long",
      intensity: Math.round(Math.min(100, level.strength + (isEqual ? 15 : 0))),
      basis: isEqual ? "equal_levels" : "swing_liquidity",
      note: isEqual
        ? `Equal ${distPct > 0 ? "highs" : "lows"} at ${level.price.toFixed(4)} — stops stack tightly here, so a touch tends to trigger a cascade rather than a single fill.`
        : `Unswept ${distPct > 0 ? "swing high" : "swing low"} at ${level.price.toFixed(4)} holding resting ${distPct > 0 ? "buy" : "sell"} stops.`,
    };
    (distPct > 0 ? shortSqueeze : longSqueeze).push(zone);
  }

  /* ---------------- Forced liquidation bands ---------------- */
  // Positions opened near recent value get closed at these distances.
  const anchorHigh = Math.max(...recent.map((c) => c.high), price);
  const anchorLow = Math.min(...recent.map((c) => c.low), price);
  const LEVERAGE = [
    { x: 100, movePct: 1, heat: 78 },
    { x: 50, movePct: 2, heat: 62 },
    { x: 25, movePct: 4, heat: 44 },
  ];

  const forcedLong: PressureZone[] = LEVERAGE.map((l) => {
    const p = anchorLow * (1 - l.movePct / 100);
    return {
      price: p,
      distancePct: Number((((p - price) / price) * 100).toFixed(2)),
      side: "long" as const,
      intensity: l.heat,
      basis: "leverage_band" as const,
      note: `Longs opened near the recent low at ${l.x}x are force-closed around ${p.toFixed(4)} (a ${l.movePct}% adverse move). Forced selling here is price-insensitive.`,
    };
  });

  const forcedShort: PressureZone[] = LEVERAGE.map((l) => {
    const p = anchorHigh * (1 + l.movePct / 100);
    return {
      price: p,
      distancePct: Number((((p - price) / price) * 100).toFixed(2)),
      side: "short" as const,
      intensity: l.heat,
      basis: "leverage_band" as const,
      note: `Shorts opened near the recent high at ${l.x}x are force-closed around ${p.toFixed(4)} (a ${l.movePct}% adverse move). Forced buying here is price-insensitive.`,
    };
  });

  /* ---------------- Whale orders ---------------- */
  const whales: WhaleOrder[] = analysis.orderFlowEvents.bigTrades
    .slice(-12)
    .map((bt) => {
      const above = bt.price > price;
      // A large buy below price is defended support; above price it is
      // trapped inventory that tends to sell into strength, and vice versa.
      const posture: WhaleOrder["posture"] =
        bt.side === "buy" ? (above ? "trapped" : "defending") : above ? "defending" : "trapped";
      return {
        time: bt.time,
        price: bt.price,
        side: bt.side,
        volume: bt.volume,
        multiple: bt.multiple,
        notional: bt.volume * bt.price,
        distancePct: Number((((bt.price - price) / price) * 100).toFixed(2)),
        posture,
        note:
          posture === "defending"
            ? `${bt.multiple}x-size ${bt.side} at ${bt.price.toFixed(4)} sits ${above ? "above" : "below"} price — that participant is positioned to defend this level on a retest.`
            : `${bt.multiple}x-size ${bt.side} at ${bt.price.toFixed(4)} is now offside — expect it to be unwound into any move back to that price.`,
      };
    })
    .sort((a, b) => b.notional - a.notional);

  /* ---------------- CVD divergence ---------------- */
  const divergence = analysis.delta.divergences[analysis.delta.divergences.length - 1] ?? null;
  const cvdDivergence = divergence
    ? {
        present: true,
        kind: divergence.kind,
        bias: (divergence.kind.includes("bullish") ? "bullish" : "bearish") as Bias,
        strength: divergence.strength,
        note: divergence.explanation,
      }
    : {
        present: false,
        kind: null,
        bias: "neutral" as Bias,
        strength: 0,
        note: "Cumulative delta is tracking price — aggression and outcome agree, so there is no hidden pressure building on either side.",
      };

  /* ---------------- Narrative ---------------- */
  const byIntensity = (a: PressureZone, b: PressureZone) =>
    Math.abs(a.distancePct) - Math.abs(b.distancePct);
  shortSqueeze.sort(byIntensity);
  longSqueeze.sort(byIntensity);

  const summary: string[] = [];
  const nearestShort = shortSqueeze[0];
  const nearestLong = longSqueeze[0];

  if (nearestShort && nearestLong) {
    const closer = Math.abs(nearestShort.distancePct) <= Math.abs(nearestLong.distancePct) ? nearestShort : nearestLong;
    summary.push(
      `Nearest forced flow is ${Math.abs(closer.distancePct).toFixed(2)}% ${closer.distancePct > 0 ? "above" : "below"} at ${closer.price.toFixed(4)} — a ${closer.side} squeeze. Price gravitates toward whichever pool is closest and least defended.`
    );
  } else if (nearestShort) {
    summary.push(`Only upside stop liquidity is in range: ${nearestShort.price.toFixed(4)}, ${Math.abs(nearestShort.distancePct).toFixed(2)}% above.`);
  } else if (nearestLong) {
    summary.push(`Only downside stop liquidity is in range: ${nearestLong.price.toFixed(4)}, ${Math.abs(nearestLong.distancePct).toFixed(2)}% below.`);
  } else {
    summary.push("No unswept stop clusters within 12% — the obvious liquidity has already been taken, which usually means the next move has to be driven by fresh flow rather than stops.");
  }

  const defending = whales.filter((w) => w.posture === "defending").length;
  const trapped = whales.filter((w) => w.posture === "trapped").length;
  if (whales.length > 0) {
    summary.push(
      `${whales.length} outsized print(s) on the tape: ${defending} positioned to defend, ${trapped} now offside. The offside ones are the supply/demand that shows up on a retest.`
    );
  }
  summary.push(cvdDivergence.note);

  // Directional lean: which side has more forced flow within reach.
  const weigh = (zones: PressureZone[]) =>
    zones.reduce((s, z) => s + z.intensity / Math.max(1, Math.abs(z.distancePct)), 0);
  const upPull = weigh(shortSqueeze) + weigh(forcedShort);
  const downPull = weigh(longSqueeze) + weigh(forcedLong);
  const lean: Bias =
    upPull > downPull * 1.25 ? "bullish" : downPull > upPull * 1.25 ? "bearish" : "neutral";

  summary.push(
    lean === "neutral"
      ? "Forced-flow pull is balanced between the two sides — no mechanical edge in either direction."
      : `Weighted by size and proximity, the pull favours ${lean === "bullish" ? "upside (short liquidity is closer and heavier)" : "downside (long liquidity is closer and heavier)"}.`
  );

  return {
    price,
    shortSqueeze: shortSqueeze.slice(0, 5),
    longSqueeze: longSqueeze.slice(0, 5),
    forcedLongLiquidation: forcedLong,
    forcedShortLiquidation: forcedShort,
    whales: whales.slice(0, 8),
    cvdDivergence,
    lean,
    summary,
  };
}
