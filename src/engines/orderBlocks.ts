import { Candle, StructureEvent, Zone } from "./types";

/**
 * Order block engine.
 *
 * A bullish order block is the last bearish candle before an impulsive move
 * that breaks structure upward (institutional buy orders were filled there).
 * A bearish order block is the last bullish candle before an impulsive
 * downward break.
 *
 * Status lifecycle:
 *  fresh      -> price has not returned to the zone
 *  respected  -> price tapped the zone and rejected away from it
 *  mitigated  -> price traded through the zone (orders consumed)
 *
 * A mitigated order block that price later trades back through in the
 * opposite direction becomes a breaker block.
 */
export function detectOrderBlocks(
  candles: Candle[],
  events: StructureEvent[]
): { orderBlocks: Zone[]; breakers: Zone[] } {
  const orderBlocks: Zone[] = [];
  const breakers: Zone[] = [];
  const timeToIndex = new Map<number, number>();
  candles.forEach((c, i) => timeToIndex.set(c.time, i));

  const externalEvents = events.filter((e) => e.scope === "external");

  for (const ev of externalEvents) {
    const breakIdx = timeToIndex.get(ev.time);
    if (breakIdx === undefined) continue;

    // Search backwards from the break for the origin candle of the impulse.
    let obIdx = -1;
    for (let i = breakIdx - 1; i >= Math.max(0, breakIdx - 20); i--) {
      const c = candles[i];
      const isBear = c.close < c.open;
      const isBull = c.close > c.open;
      if (ev.direction === "bullish" && isBear) { obIdx = i; break; }
      if (ev.direction === "bearish" && isBull) { obIdx = i; break; }
    }
    if (obIdx < 0) continue;

    const ob = candles[obIdx];
    const top = Math.max(ob.open, ob.close, ev.direction === "bullish" ? ob.high : -Infinity);
    const bottom = Math.min(ob.open, ob.close, ev.direction === "bearish" ? ob.low : Infinity);
    const zone: Zone = {
      id: `ob-${ev.direction}-${ob.time}`,
      type: "order_block",
      direction: ev.direction,
      top: ev.direction === "bullish" ? Math.max(ob.open, ob.close) : top,
      bottom: ev.direction === "bullish" ? bottom : Math.min(ob.open, ob.close),
      startTime: ob.time,
      status: "fresh",
      strength: ev.type === "CHOCH" ? 80 : 65,
      note: `Origin of ${ev.type} ${ev.direction} impulse`,
    };
    // Use the full candle range for the zone.
    zone.top = ob.high >= zone.top ? Math.max(ob.open, ob.close) : zone.top;
    zone.bottom = Math.min(ob.open, ob.close) < zone.bottom ? zone.bottom : Math.min(ob.open, ob.close);
    zone.top = Math.max(ob.open, ob.close);
    zone.bottom = Math.min(ob.open, ob.close);
    if (ev.direction === "bullish") zone.bottom = ob.low;
    else zone.top = ob.high;

    // Track how price interacted with the zone after formation.
    let respected = false;
    let mitigated = false;
    let becameBreaker = false;
    for (let i = obIdx + 1; i < candles.length; i++) {
      const c = candles[i];
      if (i <= breakIdx) continue;
      if (zone.direction === "bullish") {
        if (c.low <= zone.top && c.low >= zone.bottom && c.close > zone.top) respected = true;
        if (c.close < zone.bottom) { mitigated = true; }
        if (mitigated && c.close < zone.bottom * 0.999) becameBreaker = true;
      } else {
        if (c.high >= zone.bottom && c.high <= zone.top && c.close < zone.bottom) respected = true;
        if (c.close > zone.top) { mitigated = true; }
        if (mitigated && c.close > zone.top * 1.001) becameBreaker = true;
      }
    }
    zone.status = mitigated ? "mitigated" : respected ? "respected" : "fresh";
    if (respected) zone.strength = Math.min(95, zone.strength + 10);
    if (mitigated) zone.strength = Math.max(20, zone.strength - 30);

    if (becameBreaker) {
      breakers.push({
        ...zone,
        id: `breaker-${zone.id}`,
        type: "breaker_block",
        // A broken bullish OB acts as bearish resistance and vice versa.
        direction: zone.direction === "bullish" ? "bearish" : "bullish",
        status: "fresh",
        strength: 55,
        note: "Failed order block flipped into a breaker",
      });
    }
    orderBlocks.push(zone);
  }

  // Keep only the most recent, most relevant blocks.
  return {
    orderBlocks: orderBlocks.slice(-12),
    breakers: breakers.slice(-6),
  };
}

/**
 * Supply/demand zones from consolidation bases before strong departures.
 * Complements order blocks with volume-weighted zones.
 */
export function detectSupplyDemand(candles: Candle[]): Zone[] {
  const zones: Zone[] = [];
  if (candles.length < 30) return zones;
  const avgRange =
    candles.slice(-100).reduce((s, c) => s + (c.high - c.low), 0) /
    Math.min(100, candles.length);

  for (let i = 5; i < candles.length - 3; i++) {
    const c = candles[i];
    const range = c.high - c.low;
    const body = Math.abs(c.close - c.open);
    // Strong departure candle: range and body well above average.
    if (range < avgRange * 1.8 || body / Math.max(range, 1e-12) < 0.6) continue;

    // Base = preceding small candles.
    const base = candles.slice(Math.max(0, i - 4), i);
    const baseSmall = base.every((b) => b.high - b.low < avgRange * 1.1);
    if (!baseSmall || base.length < 2) continue;

    const top = Math.max(...base.map((b) => b.high));
    const bottom = Math.min(...base.map((b) => b.low));
    const bullish = c.close > c.open;

    // Verify price hasn't obliterated the zone since.
    const later = candles.slice(i + 1);
    const violated = bullish
      ? later.some((l) => l.close < bottom)
      : later.some((l) => l.close > top);

    zones.push({
      id: `${bullish ? "demand" : "supply"}-${candles[i - 1].time}`,
      type: bullish ? "demand" : "supply",
      direction: bullish ? "bullish" : "bearish",
      top,
      bottom,
      startTime: base[0].time,
      status: violated ? "mitigated" : "fresh",
      strength: violated ? 25 : 70,
      note: bullish
        ? "Demand base before impulsive rally"
        : "Supply base before impulsive selloff",
    });
    i += 3;
  }
  return zones.filter((z) => z.status !== "mitigated").slice(-8);
}
