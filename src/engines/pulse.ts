import { Bias, Candle, RecentWindowSummary } from "./types";

/**
 * Market Pulse — a complete conclusion of the very recent past.
 *
 * Everything else in the platform reasons over hundreds of bars. This
 * engine answers the question a trader actually asks when they glance at
 * the screen: "what just happened in the last few minutes, and what is the
 * most likely next move?"
 *
 * It works on 1-minute candles so the window is granular regardless of the
 * chart timeframe, and it reports:
 *   • the most traded prices in the window (where business actually got done)
 *   • bearish candles that closed with POSITIVE delta (and the bullish
 *     mirror) — the absorption/trap signature that precedes reversals
 *   • the institutional footprint area — the price band that absorbed the
 *     bulk of the volume, i.e. where size was working
 *   • a directional conclusion with explicit bullish / bearish odds
 *
 * Odds are evidence-weighted and deliberately capped short of certainty.
 */

export interface PulseOptions {
  windowMinutes?: number;
  priceBins?: number;
}

export function buildPulse(
  minuteCandles: Candle[],
  opts: PulseOptions = {}
): RecentWindowSummary | null {
  const windowMinutes = opts.windowMinutes ?? 5;
  const bins = opts.priceBins ?? 24;
  if (minuteCandles.length === 0) return null;

  const window = minuteCandles.slice(-windowMinutes);
  if (window.length < 2) return null;

  // Baseline drawn from a wider span so "unusual" means something.
  const baseline = minuteCandles.slice(-Math.min(60, minuteCandles.length));
  const avgVol = baseline.reduce((s, c) => s + c.volume, 0) / baseline.length;
  const avgRange = baseline.reduce((s, c) => s + (c.high - c.low), 0) / baseline.length;

  const priceStart = window[0].open;
  const priceEnd = window[window.length - 1].close;
  const changePct = ((priceEnd - priceStart) / priceStart) * 100;
  const high = Math.max(...window.map((c) => c.high));
  const low = Math.min(...window.map((c) => c.low));

  let buyVolume = 0;
  let sellVolume = 0;
  for (const c of window) {
    const buy = c.takerBuyVolume ?? c.volume / 2;
    buyVolume += buy;
    sellVolume += c.volume - buy;
  }
  const totalVolume = buyVolume + sellVolume;
  const delta = buyVolume - sellVolume;
  const buyPct = totalVolume > 0 ? (buyVolume / totalVolume) * 100 : 50;

  /* ---------------- Most traded prices ---------------- */
  const span = Math.max(high - low, 1e-9);
  const binSize = span / bins;
  const buckets = Array.from({ length: bins }, (_, i) => ({
    price: low + binSize * (i + 0.5),
    volume: 0,
    buyVolume: 0,
  }));
  for (const c of window) {
    const startBin = clamp(Math.floor((c.low - low) / binSize), 0, bins - 1);
    const endBin = clamp(Math.floor((c.high - low) / binSize), 0, bins - 1);
    const touched = endBin - startBin + 1;
    const buy = c.takerBuyVolume ?? c.volume / 2;
    for (let b = startBin; b <= endBin; b++) {
      buckets[b].volume += c.volume / touched;
      buckets[b].buyVolume += buy / touched;
    }
  }
  const mostTradedPrices = [...buckets]
    .filter((b) => b.volume > 0)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 5)
    .map((b) => ({
      price: b.price,
      volume: b.volume,
      share: totalVolume > 0 ? b.volume / totalVolume : 0,
      buyShare: b.volume > 0 ? b.buyVolume / b.volume : 0.5,
    }));
  const poc = mostTradedPrices[0]?.price ?? priceEnd;

  /* ---------------- Absorption candles ---------------- */
  // A red candle closing with positive delta means aggressive sellers were
  // filled and price still refused to fall: passive buyers absorbed them.
  const absorptionCandles: RecentWindowSummary["absorptionCandles"] = [];
  for (const c of window) {
    const buy = c.takerBuyVolume ?? c.volume / 2;
    const sell = c.volume - buy;
    const d = buy - sell;
    const bearish = c.close < c.open;
    const bullish = c.close > c.open;
    const volX = c.volume / Math.max(avgVol, 1e-9);

    if (bearish && d > 0) {
      absorptionCandles.push({
        time: c.time,
        type: "bearish_positive_delta",
        open: c.open,
        close: c.close,
        delta: d,
        volume: c.volume,
        volumeMultiple: Number(volX.toFixed(2)),
        note: `Red candle at ${c.close.toFixed(4)} closed with POSITIVE delta (+${d.toFixed(0)}) on ${volX.toFixed(1)}x volume — buyers were aggressive but price still closed down, meaning passive sellers capped it. Watch for the reverse: if price holds, those sellers get squeezed.`,
      });
    } else if (bullish && d < 0) {
      absorptionCandles.push({
        time: c.time,
        type: "bullish_negative_delta",
        open: c.open,
        close: c.close,
        delta: d,
        volume: c.volume,
        volumeMultiple: Number(volX.toFixed(2)),
        note: `Green candle at ${c.close.toFixed(4)} closed with NEGATIVE delta (${d.toFixed(0)}) on ${volX.toFixed(1)}x volume — sellers were aggressive yet price closed up, so passive buyers absorbed the supply.`,
      });
    }
  }

  /* ---------------- Institutional footprint area ---------------- */
  // The contiguous price band that absorbed the bulk of the volume — this
  // is where size was actually working, not where price merely wicked.
  const institutionalZones: RecentWindowSummary["institutionalZones"] = [];
  const sorted = [...buckets].sort((a, b) => b.volume - a.volume);
  const heavy = sorted.slice(0, Math.max(3, Math.floor(bins * 0.25)));
  if (heavy.length > 0) {
    const zoneLow = Math.min(...heavy.map((h) => h.price)) - binSize / 2;
    const zoneHigh = Math.max(...heavy.map((h) => h.price)) + binSize / 2;
    const zoneVol = heavy.reduce((s, h) => s + h.volume, 0);
    const zoneBuy = heavy.reduce((s, h) => s + h.buyVolume, 0);
    const buyShare = zoneVol > 0 ? zoneBuy / zoneVol : 0.5;
    const side: "accumulation" | "distribution" | "neutral" =
      buyShare > 0.55 ? "accumulation" : buyShare < 0.45 ? "distribution" : "neutral";
    institutionalZones.push({
      priceLow: zoneLow,
      priceHigh: zoneHigh,
      volume: zoneVol,
      share: totalVolume > 0 ? zoneVol / totalVolume : 0,
      side,
      note: `${((zoneVol / Math.max(totalVolume, 1e-9)) * 100).toFixed(0)}% of the window's volume traded between ${zoneLow.toFixed(4)} and ${zoneHigh.toFixed(4)}, with ${(buyShare * 100).toFixed(0)}% of it on the buy side — ${
        side === "accumulation"
          ? "this looks like accumulation; expect this band to act as support on a retest."
          : side === "distribution"
            ? "this looks like distribution; expect this band to act as resistance on a retest."
            : "two-sided trade with no clear winner; treat the band as fair value rather than a decision point."
      }`,
    });
  }

  /* ---------------- Notable bars ---------------- */
  const bigTrades = window
    .filter((c) => c.volume > avgVol * 2)
    .map((c) => {
      const buy = c.takerBuyVolume ?? c.volume / 2;
      return {
        time: c.time,
        price: c.close,
        side: (buy >= c.volume - buy ? "buy" : "sell") as "buy" | "sell",
        volume: c.volume,
        multiple: Number((c.volume / Math.max(avgVol, 1e-9)).toFixed(1)),
      };
    });

  const sweeps: RecentWindowSummary["sweeps"] = [];
  for (let i = 1; i < window.length; i++) {
    const c = window[i];
    const prior = window.slice(0, i);
    const pHigh = Math.max(...prior.map((p) => p.high));
    const pLow = Math.min(...prior.map((p) => p.low));
    if (c.high > pHigh && c.close < pHigh) {
      sweeps.push({ time: c.time, price: pHigh, direction: "above", note: `Swept the local high at ${pHigh.toFixed(4)} and closed back below — buy stops were taken.` });
    }
    if (c.low < pLow && c.close > pLow) {
      sweeps.push({ time: c.time, price: pLow, direction: "below", note: `Swept the local low at ${pLow.toFixed(4)} and closed back above — sell stops were taken.` });
    }
  }

  const volumeTrendPct = (() => {
    const half = Math.floor(window.length / 2);
    if (half < 1) return 0;
    const v1 = window.slice(0, half).reduce((s, c) => s + c.volume, 0);
    const v2 = window.slice(half).reduce((s, c) => s + c.volume, 0);
    return v1 > 0 ? ((v2 - v1) / v1) * 100 : 0;
  })();

  const rangeX = (high - low) / Math.max(avgRange, 1e-9);
  const volX = totalVolume / Math.max(avgVol * window.length, 1e-9);

  /* ---------------- Scoring the next move ---------------- */
  const factors: { label: string; points: number; detail: string }[] = [];

  // 1. Aggression balance
  const aggressionPoints = (buyPct - 50) * 1.1;
  factors.push({
    label: "Aggressive flow",
    points: aggressionPoints,
    detail: `${buyPct.toFixed(0)}% of taker volume was buying (delta ${delta >= 0 ? "+" : ""}${delta.toFixed(0)}).`,
  });

  // 2. Price direction, damped — recent direction is weak evidence alone.
  const directionPoints = clamp(changePct * 6, -18, 18);
  factors.push({
    label: "Price direction",
    points: directionPoints,
    detail: `Price moved ${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}% across the window.`,
  });

  // 3. Absorption candles point AGAINST the aggressive side.
  let absorptionPoints = 0;
  for (const a of absorptionCandles) {
    // Bearish candle + positive delta = trapped buyers → bearish lean.
    absorptionPoints += a.type === "bearish_positive_delta" ? -9 : 9;
  }
  absorptionPoints = clamp(absorptionPoints, -26, 26);
  if (absorptionCandles.length > 0) {
    factors.push({
      label: "Absorption / trapped aggression",
      points: absorptionPoints,
      detail: `${absorptionCandles.length} candle(s) closed against their own delta — the aggressive side was absorbed.`,
    });
  }

  // 4. Institutional band positioning relative to price.
  const zone = institutionalZones[0];
  if (zone) {
    let zonePoints = 0;
    if (zone.side === "accumulation") zonePoints += 14;
    if (zone.side === "distribution") zonePoints -= 14;
    // Holding above the heavy-volume band is constructive, and vice versa.
    if (priceEnd > zone.priceHigh) zonePoints += 8;
    else if (priceEnd < zone.priceLow) zonePoints -= 8;
    factors.push({
      label: "Institutional band",
      points: zonePoints,
      detail: `Heavy volume band ${zone.priceLow.toFixed(4)}–${zone.priceHigh.toFixed(4)} reads as ${zone.side}; price is ${priceEnd > zone.priceHigh ? "above" : priceEnd < zone.priceLow ? "below" : "inside"} it.`,
    });
  }

  // 5. Stop hunts lean toward reversal of the sweep direction.
  const lastSweep = sweeps[sweeps.length - 1];
  if (lastSweep) {
    const sweepPoints = lastSweep.direction === "above" ? -12 : 12;
    factors.push({ label: "Stop hunt", points: sweepPoints, detail: lastSweep.note });
  }

  // 6. Big trades lean with their own side.
  if (bigTrades.length > 0) {
    const netBig = bigTrades.reduce((s, b) => s + (b.side === "buy" ? b.multiple : -b.multiple), 0);
    const bigPoints = clamp(netBig * 3, -14, 14);
    factors.push({
      label: "Large orders",
      points: bigPoints,
      detail: `${bigTrades.length} outsized print(s), net ${netBig >= 0 ? "buy" : "sell"} skewed.`,
    });
  }

  // 7. Participation: a move on fading volume is less trustworthy.
  if (Math.abs(changePct) > 0.05 && volumeTrendPct < -25) {
    const fadePoints = changePct > 0 ? -10 : 10;
    factors.push({
      label: "Fading participation",
      points: fadePoints,
      detail: `Volume fell ${Math.abs(volumeTrendPct).toFixed(0)}% across the window while price kept ${changePct > 0 ? "rising" : "falling"} — the move is running out of fuel.`,
    });
  }

  const net = factors.reduce((s, f) => s + f.points, 0);
  // tanh squash keeps stacked confluence from ever reaching certainty.
  const bullishOdds = Math.round(50 + Math.tanh(net / 45) * 40);
  const bearishOdds = 100 - bullishOdds;
  const direction: Bias =
    bullishOdds >= 58 ? "bullish" : bullishOdds <= 42 ? "bearish" : "neutral";

  /* ---------------- Projected path ---------------- */
  const upTarget = Math.max(high, priceEnd + (high - low) * 0.6);
  const downTarget = Math.min(low, priceEnd - (high - low) * 0.6);
  const nextMove = {
    direction,
    target: direction === "bullish" ? upTarget : direction === "bearish" ? downTarget : poc,
    invalidation: direction === "bullish" ? low : direction === "bearish" ? high : priceEnd,
    rationale: factors
      .filter((f) => Math.abs(f.points) >= 5)
      .sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
      .map((f) => `${f.label}: ${f.detail}`)
      .slice(0, 5),
  };

  /* ---------------- Verdict ---------------- */
  const verdict =
    direction === "bullish"
      ? `Odds favour upside over the next few bars (${bullishOdds}% bullish). The most likely path is a push toward ${upTarget.toFixed(4)}, with the window low at ${low.toFixed(4)} as the line that invalidates it.`
      : direction === "bearish"
        ? `Odds favour downside over the next few bars (${bearishOdds}% bearish). The most likely path is a push toward ${downTarget.toFixed(4)}, with the window high at ${high.toFixed(4)} as the line that invalidates it.`
        : `The last ${windowMinutes} minutes are genuinely two-sided (${bullishOdds}/${bearishOdds}). Neither side has earned the edge — the honest read is to wait for price to leave the ${low.toFixed(4)}–${high.toFixed(4)} range on real volume rather than guess inside it.`;

  const keyTakeaways: string[] = [];
  keyTakeaways.push(
    `Price ${changePct >= 0 ? "rose" : "fell"} ${Math.abs(changePct).toFixed(2)}% (${priceStart.toFixed(4)} → ${priceEnd.toFixed(4)}) on ${volX.toFixed(1)}x normal volume.`
  );
  keyTakeaways.push(
    `Most business was done at ${poc.toFixed(4)} — that price is the near-term magnet and the level to watch on any retest.`
  );
  if (zone) keyTakeaways.push(zone.note);
  if (absorptionCandles.length > 0) {
    keyTakeaways.push(absorptionCandles[absorptionCandles.length - 1].note);
  }
  if (lastSweep) keyTakeaways.push(lastSweep.note);
  if (rangeX > 1.8) {
    keyTakeaways.push(`Range expanded to ${rangeX.toFixed(1)}x normal — volatility regime has shifted, so size positions accordingly.`);
  }
  if (volumeTrendPct < -30) {
    keyTakeaways.push(`Participation is draining (${volumeTrendPct.toFixed(0)}%) — late entries into this move carry poor risk/reward.`);
  }

  return {
    windowMinutes,
    from: window[0].time,
    to: window[window.length - 1].time,
    priceStart,
    priceEnd,
    changePct: Number(changePct.toFixed(3)),
    high,
    low,
    totalVolume,
    buyVolume,
    sellVolume,
    delta,
    buyPct: Number(buyPct.toFixed(1)),
    volumeMultiple: Number(volX.toFixed(2)),
    rangeMultiple: Number(rangeX.toFixed(2)),
    volumeTrendPct: Number(volumeTrendPct.toFixed(1)),
    mostTradedPrices,
    poc,
    absorptionCandles,
    institutionalZones,
    bigTrades,
    sweeps,
    factors,
    bullishOdds,
    bearishOdds,
    nextMove,
    verdict,
    keyTakeaways,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
