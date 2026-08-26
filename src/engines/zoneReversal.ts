import { detectFVGs } from "./fvg";
import { analyzeMarketStructure } from "./marketStructure";
import { detectOrderBlocks } from "./orderBlocks";
import { detectSupportResistance } from "./supportResistance";
import { Bias, Candle, Zone, ZoneReaction, ZoneReversalSetup } from "./types";

/**
 * Order block / fair-value-gap reversal detector.
 *
 * Order blocks and FVGs are *locations*, not signals. Marking them on a chart
 * says where institutional orders were left behind; it says nothing about
 * whether price returning there will actually turn. This engine asks the second
 * question — has price gone back to one of these zones and **reacted**?
 *
 * A reaction, as opposed to a tap, requires four things:
 *
 *   1. price traded into the zone while the zone was still intact
 *   2. it closed back out of the zone the way it came in
 *   3. the rejection left a wick — the level was defended intrabar, not merely
 *      drifted away from
 *   4. taker flow at the tap points the same way as the zone
 *
 * (2) is what separates a reversal from a breakdown. Price sitting inside a
 * bullish order block is not bullish; price being *expelled* from it is. So a
 * setup with no reclaim is reported as `forming`, never as qualified, no matter
 * how good the rest of the checklist looks.
 *
 * Overlapping zones are the strongest configuration in practice — an order
 * block whose range contains an unfilled FVG is one price level with two
 * independent reasons to hold — so overlap is scored explicitly rather than
 * being counted twice by listing both zones.
 */

/** Bars back a re-entry still counts as "just happened". */
const REACTION_WINDOW = 14;
/** Zones further than this from price are not in play. */
const MAX_DISTANCE_PCT = 0.08;
const QUALIFY_SCORE = 62;

/** Zone statuses that mean the zone still holds unfilled orders. */
const INTACT: Zone["status"][] = ["fresh", "respected", "partial"];

function zoneMid(z: Zone): number {
  return (z.top + z.bottom) / 2;
}

function overlaps(a: Zone, b: Zone): boolean {
  return a.top >= b.bottom && b.top >= a.bottom;
}

/** Net taker delta over a slice, estimated from Binance's taker-buy volume. */
function netDelta(candles: Candle[]): number {
  return candles.reduce((sum, c) => {
    const buy = c.takerBuyVolume ?? c.volume / 2;
    return sum + (buy - (c.volume - buy));
  }, 0);
}

function fmt(v: number): string {
  return v.toFixed(v >= 1000 ? 2 : v >= 1 ? 4 : 6).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Evaluate one zone for a reaction. Returns null when price has not been back
 * inside it within the window — an untouched zone is a level, not a setup.
 */
function evaluateZone(zone: Zone, candles: Candle[]): ZoneReaction | null {
  const price = candles[candles.length - 1]?.close ?? 0;
  if (price <= 0) return null;

  const bullish = zone.direction === "bullish";
  const window = candles.slice(-REACTION_WINDOW);

  // The tap must come after the zone formed, or we would be scoring the
  // impulse that created the zone as if it were a reaction to it.
  const candidates = window.filter((c) => c.time > zone.startTime);
  const tapIdx = candidates.findIndex((c) => c.low <= zone.top && c.high >= zone.bottom);
  if (tapIdx < 0) return null;

  const since = candidates.slice(tapIdx);
  const tap = since[0];
  const last = candidates[candidates.length - 1];

  const extreme = bullish
    ? Math.min(...since.map((c) => c.low))
    : Math.max(...since.map((c) => c.high));

  // Traded clean through the zone and closed beyond it = the zone failed.
  const intact = bullish ? last.close > zone.bottom : last.close < zone.top;
  const reclaimed = bullish ? last.close > zone.top : last.close < zone.bottom;

  // The wick is measured on the bar that printed the extreme, which is the bar
  // that actually did the rejecting — not necessarily the first bar in.
  const rejectBar =
    since.find((c) => (bullish ? c.low === extreme : c.high === extreme)) ?? tap;
  const range = Math.max(rejectBar.high - rejectBar.low, 1e-12);
  const bodyEdge = bullish
    ? Math.min(rejectBar.open, rejectBar.close)
    : Math.max(rejectBar.open, rejectBar.close);
  const rejectionWick = bullish
    ? (bodyEdge - rejectBar.low) / range
    : (rejectBar.high - bodyEdge) / range;

  const deltaAtTap = netDelta(since);
  const deltaConfirms = bullish ? deltaAtTap > 0 : deltaAtTap < 0;

  const reversalPct = bullish
    ? ((price - extreme) / extreme) * 100
    : ((extreme - price) / extreme) * 100;

  /* ---- Scoring ---- */
  let score = 0;
  // A tap of a zone that is still intact is the price of entry, not an edge.
  if (intact) score += 18;
  if (reclaimed) score += 22;
  score += Math.min(14, Math.max(0, rejectionWick) * 28);
  if (deltaConfirms) score += 16;
  // Reversal travel, capped: a move already 3% off the zone is confirmation,
  // but it is also entry that has been given away.
  score += Math.min(14, Math.max(0, reversalPct) * 4.5);
  // Freshness. A tap eight bars ago that has gone nowhere is not a reaction.
  const barsSinceTap = candidates.length - tapIdx - 1;
  score += barsSinceTap <= 3 ? 8 : barsSinceTap <= 7 ? 4 : 0;
  score += (zone.strength / 100) * 8;

  const kind = zone.type === "fvg" ? "fair value gap" : zone.type.replace("_", " ");
  const note = reclaimed
    ? `Price tapped the ${bullish ? "bullish" : "bearish"} ${kind} at ${fmt(extreme)} and closed back ${bullish ? "above" : "below"} it${deltaConfirms ? ` with ${bullish ? "buyers" : "sellers"} taking the aggressor side` : ", though taker flow did not confirm"} — ${reversalPct.toFixed(2)}% off the extreme so far.`
    : intact
      ? `Price is inside the ${bullish ? "bullish" : "bearish"} ${kind} (${fmt(zone.bottom)}–${fmt(zone.top)}) and has not yet closed back out of it. Until it does this is a level being tested, not a reversal.`
      : `Price has traded through the ${bullish ? "bullish" : "bearish"} ${kind} and closed beyond it — the zone has been consumed rather than defended.`;

  return {
    zoneId: zone.id,
    zoneType: zone.type,
    direction: zone.direction === "bearish" ? "bearish" : "bullish",
    top: zone.top,
    bottom: zone.bottom,
    tapTime: tap.time,
    barsSinceTap,
    extreme,
    reversalPct: Number(reversalPct.toFixed(3)),
    rejectionWick: Number(Math.max(0, Math.min(1, rejectionWick)).toFixed(3)),
    deltaAtTap: Number(deltaAtTap.toFixed(2)),
    deltaConfirms,
    reclaimed,
    intact,
    confluence: [],
    score: Math.round(Math.min(100, score)),
    note,
  };
}

export function detectZoneReversal(
  symbol: string,
  timeframe: string,
  candles: Candle[]
): ZoneReversalSetup {
  const price = candles[candles.length - 1]?.close ?? 0;
  const empty: ZoneReversalSetup = {
    symbol,
    timeframe,
    price,
    direction: "neutral",
    best: null,
    reactions: [],
    score: 0,
    qualified: false,
    grade: "none",
    entry: null,
    invalidation: null,
    target: null,
    headline: "No order block or FVG in play",
    explanation: ["Price is not interacting with any unmitigated order block or unfilled fair value gap."],
  };
  if (candles.length < 40 || price <= 0) {
    return { ...empty, headline: "Not enough history to locate zones" };
  }

  const structure = analyzeMarketStructure(candles);
  const { orderBlocks, breakers } = detectOrderBlocks(candles, structure.events);
  const fvgs = detectFVGs(candles);
  const srLevels = detectSupportResistance(candles, timeframe);

  const zones = [...orderBlocks, ...breakers, ...fvgs].filter(
    (z) =>
      INTACT.includes(z.status) &&
      z.direction !== "neutral" &&
      Math.abs(zoneMid(z) - price) / price <= MAX_DISTANCE_PCT
  );

  const reactions: ZoneReaction[] = [];
  for (const zone of zones) {
    const reaction = evaluateZone(zone, candles);
    if (!reaction) continue;
    // Confluence is only meaningful between zones facing the same way; a
    // bullish OB overlapping a bearish FVG is a contested level, not a
    // reinforced one, and is deliberately not credited.
    reaction.confluence = zones
      .filter((o) => o.id !== zone.id && o.direction === zone.direction && overlaps(o, zone))
      .map((o) => o.id);
    if (reaction.confluence.length > 0) {
      reaction.score = Math.round(Math.min(100, reaction.score + Math.min(12, reaction.confluence.length * 8)));
    }
    reactions.push(reaction);
  }

  if (reactions.length === 0) return empty;

  reactions.sort((a, b) => b.score - a.score);
  const best = reactions[0];
  const bullish = best.direction === "bullish";

  // Agreement between zones facing the same way is worth something; zones
  // fighting each other is worth nothing, and pretending otherwise is how a
  // scanner ends up long and short the same coin.
  const agreeing = reactions.filter((r) => r.direction === best.direction && r.reclaimed).length;
  const opposing = reactions.filter((r) => r.direction !== best.direction && r.reclaimed).length;
  let score = best.score + Math.min(8, Math.max(0, agreeing - 1) * 4) - Math.min(12, opposing * 6);

  // Trend context. A bullish zone reaction inside a downtrend is a
  // counter-trend trade; it can still work, but it is not the same setup.
  const withTrend =
    (bullish && structure.trend === "bullish") || (!bullish && structure.trend === "bearish");
  const againstTrend =
    (bullish && structure.trend === "bearish") || (!bullish && structure.trend === "bullish");
  if (withTrend) score += 6;
  if (againstTrend) score -= 4;
  score = Math.round(Math.max(0, Math.min(100, score)));

  // A setup nobody has been expelled from is not a reversal yet, whatever it
  // scores — the reclaim is the definition, not a bonus.
  const qualified = best.reclaimed && best.intact && score >= QUALIFY_SCORE;
  const grade: ZoneReversalSetup["grade"] = qualified
    ? score >= 80
      ? "prime"
      : "strong"
    : score >= 40
      ? "forming"
      : "none";

  const entry = bullish ? best.top : best.bottom;
  const invalidation = bullish ? best.extreme * 0.999 : best.extreme * 1.001;
  const opposingLevel = bullish
    ? srLevels.filter((l) => l.kind === "resistance" && l.price > price).sort((a, b) => a.price - b.price)[0]
    : srLevels.filter((l) => l.kind === "support" && l.price < price).sort((a, b) => b.price - a.price)[0];
  const risk = Math.abs(price - invalidation);
  const target =
    opposingLevel?.price ??
    // No mapped level to aim at: quote 2R rather than inventing a round number.
    (risk > 0 ? (bullish ? price + risk * 2 : price - risk * 2) : null);

  const direction: Bias = qualified ? (bullish ? "bullish" : "bearish") : "neutral";
  const kind = best.zoneType === "fvg" ? "FVG" : best.zoneType === "breaker_block" ? "breaker" : "order block";
  const headline = qualified
    ? `${grade === "prime" ? "Prime" : "Strong"} ${bullish ? "bullish" : "bearish"} reversal from a ${kind} at ${fmt(best.extreme)}`
    : !best.reclaimed
      ? `Testing a ${bullish ? "bullish" : "bearish"} ${kind} — no reclaim yet`
      : `Reaction present but score ${score} is below the ${QUALIFY_SCORE} threshold`;

  const explanation: string[] = [headline, best.note];
  if (best.confluence.length > 0) {
    explanation.push(
      `The zone overlaps ${best.confluence.length} other ${best.direction} zone${best.confluence.length > 1 ? "s" : ""} — one price band with more than one reason to hold.`
    );
  }
  if (opposing > 0) {
    explanation.push(
      `${opposing} zone${opposing > 1 ? "s are" : " is"} reacting the other way, so the level is contested; the score is marked down for it.`
    );
  }
  explanation.push(
    withTrend
      ? `The reaction runs with the ${structure.trend} structure, so this is a continuation entry rather than a counter-trend bet.`
      : againstTrend
        ? `Structure is ${structure.trend}, so this is a counter-trend reaction — it needs a structure break to become a trend, and until then the base case is a bounce.`
        : `Structure is ${structure.trend}, giving no directional context either way.`
  );
  explanation.push(
    `Invalidation is a close beyond ${fmt(invalidation)} — that is where the zone has failed rather than merely being tested.${
      target != null ? ` First objective ${fmt(target)}${opposingLevel ? " (nearest mapped level)" : " (2R, no mapped level in range)"}.` : ""
    }`
  );

  return {
    symbol,
    timeframe,
    price,
    direction,
    best,
    reactions: reactions.slice(0, 6),
    score,
    qualified,
    grade,
    entry,
    invalidation,
    target,
    headline,
    explanation,
  };
}
