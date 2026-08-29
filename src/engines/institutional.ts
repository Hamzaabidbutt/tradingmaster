import { analyzeDelta } from "./deltaAnalysis";
import { detectFVGs } from "./fvg";
import { analyzeLiquidationDelta } from "./liquidationDelta";
import { analyzeLiquidity } from "./liquidity";
import { analyzeMarketStructure } from "./marketStructure";
import { detectOrderBlocks } from "./orderBlocks";
import { detectOrderFlowEvents } from "./orderFlowEvents";
import { analyzePremiumDiscount } from "./premiumDiscount";
import { buildFootprint } from "./footprint";
import { detectSupportResistance } from "./supportResistance";
import { buildVolumeProfile } from "./volumeProfile";
import {
  Candle,
  InstitutionalEvidence,
  InstitutionalSetup,
  InstitutionalZone,
} from "./types";

/**
 * Institutional footprint — where size was worked, and what that implies.
 *
 * Large positions cannot be bought at one price. They are worked over hours or
 * days, and they leave the same marks every time: unfilled demand gaps left by
 * the impulses away, order blocks at the origin of those impulses, aggressive
 * selling that fails to move price because it is being absorbed, forced sellers
 * whose supply gets bought, and rejection wicks where price was refused. None
 * of those is conclusive alone — every one of them also occurs by accident.
 *
 * So this engine does one thing: it collects the marks, and asks **how many
 * independent kinds land on the same price band**. One is noise. Two is a
 * coincidence. Four different mechanisms pointing at the same 0.5% of price is
 * the signature of someone working an order there, and it is the only claim in
 * this file that the evidence actually supports.
 *
 * ## What "where the market is headed" means here
 *
 * It means a *level*, not a direction with a probability attached. The output
 * names three prices — the area itself, the level that would confirm the read,
 * and the level that would refute it — because those are facts about the chart
 * that follow from the evidence. Whether price goes there is not, and no amount
 * of confluence makes it so. A tool that turned four coincident marks into
 * "target $4.80, 78% likely" would be inventing the part its user most wants
 * and it least knows.
 */

/** Bands within this % of each other are treated as the same area. */
const ZONE_TOLERANCE_PCT = 0.6;
/** Evidence further than this from price is history, not a live area. */
const MAX_DISTANCE_PCT = 12;
const QUALIFY_SCORE = 60;

interface Mark {
  source: string;
  low: number;
  high: number;
}

function fmt(v: number): string {
  return v.toFixed(v >= 1000 ? 2 : v >= 1 ? 4 : 6).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Merge overlapping marks into areas, counting *kinds* rather than instances.
 *
 * Three order blocks stacked at one price is one mechanism repeating, not three
 * independent confirmations, and counting them as three is how a confluence
 * score becomes meaningless. `confluence` therefore counts distinct sources.
 */
function buildZones(marks: Mark[], price: number): InstitutionalZone[] {
  if (marks.length === 0) return [];
  const tolerance = (price * ZONE_TOLERANCE_PCT) / 100;
  const sorted = [...marks].sort((a, b) => (a.low + a.high) / 2 - (b.low + b.high) / 2);

  const clusters: Mark[][] = [];
  for (const mark of sorted) {
    const last = clusters[clusters.length - 1];
    if (!last) {
      clusters.push([mark]);
      continue;
    }
    const lastMid = last.reduce((s, m) => s + (m.low + m.high) / 2, 0) / last.length;
    const mid = (mark.low + mark.high) / 2;
    if (Math.abs(mid - lastMid) <= tolerance) last.push(mark);
    else clusters.push([mark]);
  }

  return clusters
    .map((cluster) => {
      const low = Math.min(...cluster.map((m) => m.low));
      const high = Math.max(...cluster.map((m) => m.high));
      const mid = (low + high) / 2;
      const sources = [...new Set(cluster.map((m) => m.source))];
      return {
        low,
        high,
        mid,
        distancePct: Number((((mid - price) / price) * 100).toFixed(3)),
        confluence: sources.length,
        sources,
      };
    })
    .filter((z) => Math.abs(z.distancePct) <= MAX_DISTANCE_PCT)
    .sort((a, b) => b.confluence - a.confluence || Math.abs(a.distancePct) - Math.abs(b.distancePct));
}

export function detectInstitutional(
  symbol: string,
  timeframe: string,
  candles: Candle[],
  openInterest?: number[] | null
): InstitutionalSetup {
  const price = candles[candles.length - 1]?.close ?? 0;
  const empty: InstitutionalSetup = {
    symbol,
    timeframe,
    price,
    side: "none",
    zone: null,
    zones: [],
    evidence: [],
    score: 0,
    qualified: false,
    grade: "none",
    openInterestChangePct: null,
    confirmAbove: null,
    invalidateBelow: null,
    objective: null,
    headline: "No institutional footprint in range",
    explanation: ["Nothing in this window suggests size was being worked at a level."],
  };
  if (candles.length < 60 || price <= 0) {
    return { ...empty, headline: "Not enough history to read a footprint" };
  }

  const structure = analyzeMarketStructure(candles);
  const { orderBlocks } = detectOrderBlocks(candles, structure.events);
  const fvgs = detectFVGs(candles);
  const delta = analyzeDelta(candles);
  const liqDelta = analyzeLiquidationDelta(candles);
  const liquidity = analyzeLiquidity(candles, structure.swings);
  const srLevels = detectSupportResistance(candles, timeframe);
  const profile = buildVolumeProfile(candles.slice(-Math.min(240, candles.length)), { bins: 50 });
  const footprint = buildFootprint(candles, null, { count: 20 });
  const events = detectOrderFlowEvents(candles, footprint, profile, srLevels);
  const pd = analyzePremiumDiscount(candles, structure.swings);

  const evidence: InstitutionalEvidence[] = [];
  const marks: Mark[] = [];

  /* ---- 1. Unfilled demand: FVGs left behind by the move away ---- */
  const demandGaps = fvgs.filter(
    (z) => z.direction === "bullish" && z.status !== "filled" && z.top <= price * 1.02
  );
  for (const gap of demandGaps) marks.push({ source: "demand_fvg", low: gap.bottom, high: gap.top });
  evidence.push({
    key: "demand_fvg",
    label: "Unfilled demand gap",
    found: demandGaps.length > 0,
    weight: 16,
    score: demandGaps.length > 0 ? Math.min(16, 8 + demandGaps.length * 4) : 0,
    price: demandGaps[0] ? (demandGaps[0].top + demandGaps[0].bottom) / 2 : null,
    detail:
      demandGaps.length > 0
        ? `${demandGaps.length} unfilled bullish gap${demandGaps.length > 1 ? "s" : ""} below price — the market left in a hurry and has not come back to trade the inventory it skipped. Gaps like these are where the impulse started, not where it ended.`
        : "No unfilled demand gap below price; any move up from here started from ground that has since been fully traded.",
  });

  /* ---- 2. Demand order blocks ---- */
  const demandBlocks = orderBlocks.filter(
    (z) => z.direction === "bullish" && z.status !== "mitigated" && z.top <= price * 1.02
  );
  for (const ob of demandBlocks) marks.push({ source: "order_block", low: ob.bottom, high: ob.top });
  evidence.push({
    key: "order_block",
    label: "Unmitigated demand block",
    found: demandBlocks.length > 0,
    weight: 16,
    score: demandBlocks.length > 0 ? Math.min(16, 9 + demandBlocks.length * 3) : 0,
    price: demandBlocks[0] ? (demandBlocks[0].top + demandBlocks[0].bottom) / 2 : null,
    detail:
      demandBlocks.length > 0
        ? `${demandBlocks.length} unmitigated demand block${demandBlocks.length > 1 ? "s" : ""} below — the last selling before an impulse up, which is where the buying that caused the impulse was actually filled.`
        : "No unmitigated demand block below price.",
  });

  /* ---- 3. Absorption: aggression that failed to move price ---- */
  const buyAbsorption = events.absorptions.filter((a) => a.side === "buy");
  for (const a of buyAbsorption) {
    marks.push({ source: "absorption", low: a.price * 0.999, high: a.price * 1.001 });
  }
  evidence.push({
    key: "absorption",
    label: "Selling absorbed",
    found: buyAbsorption.length > 0,
    weight: 18,
    score: buyAbsorption.length > 0 ? (buyAbsorption.some((a) => a.atKeyLevel) ? 18 : 11) : 0,
    price: buyAbsorption[0]?.price ?? null,
    detail:
      buyAbsorption.length > 0
        ? `${buyAbsorption.length} buy-side absorption event${buyAbsorption.length > 1 ? "s" : ""}: heavy selling hit the bid and price did not fall. Someone was standing there with resting size — the single most direct evidence in this list, because it is the mechanism itself rather than a trace of it.`
        : "No buy-side absorption — selling here has been moving price, which is what selling does when nobody is under it.",
  });

  /* ---- 4. Forced sellers being bought ---- */
  const flushes = liqDelta.series.filter((p) => p.longLiquidated > 0);
  const flushTotal = flushes.reduce((s, p) => s + p.longLiquidated, 0);
  const reclaimed =
    flushes.length > 0 &&
    (() => {
      const worst = flushes.reduce((a, b) => (a.longLiquidated >= b.longLiquidated ? a : b));
      const bar = candles.find((c) => c.time === worst.time);
      return bar ? price > (bar.high + bar.low) / 2 : false;
    })();
  if (flushes.length > 0) {
    const worst = flushes.reduce((a, b) => (a.longLiquidated >= b.longLiquidated ? a : b));
    const bar = candles.find((c) => c.time === worst.time);
    if (bar) marks.push({ source: "liquidation", low: bar.low, high: (bar.high + bar.low) / 2 });
  }
  evidence.push({
    key: "liquidation",
    label: "Forced supply absorbed",
    found: flushTotal > 0 && reclaimed,
    weight: 16,
    score: flushTotal > 0 ? (reclaimed ? 16 : 6) : 0,
    price: null,
    detail:
      flushTotal > 0
        ? reclaimed
          ? `Forced long liquidation printed here and price has since reclaimed it. Margin engines sell without regard to value; someone took the other side of that, which is exactly how size gets filled cheaply.`
          : `Forced liquidation is present but price has not reclaimed it — the supply may still be coming, so this is not yet evidence of anyone absorbing it.`
        : "No forced selling in the window, so there has been no discounted supply for anyone to absorb.",
  });

  /* ---- 5. Divergence: price down, cumulative delta refusing to follow ---- */
  const bullishDivergence = delta.divergences.filter((d) => d.kind.includes("bullish"));
  evidence.push({
    key: "divergence",
    label: "Bullish delta divergence",
    found: bullishDivergence.length > 0,
    weight: 12,
    score: bullishDivergence.length > 0 ? Math.min(12, 6 + bullishDivergence.length * 3) : 0,
    price: bullishDivergence[0]?.pricePoint ?? null,
    detail:
      bullishDivergence.length > 0
        ? `${bullishDivergence.length} bullish divergence: price made the lower low, cumulative delta did not. The selling that produced the low was not backed by aggression.`
        : "No bullish delta divergence — cumulative delta has been confirming the price lows rather than refusing them.",
  });

  /* ---- 6. Rejection wicks at the lows ---- */
  const recent = candles.slice(-20);
  const rejections = recent.filter((c) => {
    const range = Math.max(c.high - c.low, 1e-12);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    return lowerWick / range >= 0.5;
  });
  for (const r of rejections) marks.push({ source: "rejection", low: r.low, high: Math.min(r.open, r.close) });
  evidence.push({
    key: "rejection",
    label: "Rejection from below",
    found: rejections.length >= 2,
    weight: 12,
    score: rejections.length >= 2 ? Math.min(12, rejections.length * 4) : rejections.length * 3,
    price: rejections[rejections.length - 1]?.low ?? null,
    detail:
      rejections.length > 0
        ? `${rejections.length} bar${rejections.length > 1 ? "s" : ""} in the last 20 left a lower wick over half their range — price was taken down and bought back each time. Repetition is the point: once is a bounce, repeatedly is someone working an order.`
        : "No repeated rejection wicks in the recent bars.",
  });

  /* ---- 7. Location: is this a discount ---- */
  const atDiscount = pd.currentZone === "discount";
  evidence.push({
    key: "discount",
    label: "Discount location",
    found: atDiscount,
    weight: 10,
    score: atDiscount ? 10 : pd.currentZone === "equilibrium" ? 5 : 0,
    price: null,
    detail: atDiscount
      ? `Price sits in the discount half of the dealing range (${(pd.positionInRange * 100).toFixed(0)}%). Size is worked where it is cheap, which is not usually where it is obvious.`
      : `Price is at ${(pd.positionInRange * 100).toFixed(0)}% of the dealing range (${pd.currentZone}) — not where accumulation normally happens.`,
  });

  /* ---- 8. Open interest ---- */
  let oiChangePct: number | null = null;
  if (openInterest && openInterest.length >= 4) {
    const first = openInterest[0];
    const last = openInterest[openInterest.length - 1];
    oiChangePct = first > 0 ? Number((((last - first) / first) * 100).toFixed(3)) : 0;
  }
  const oiBuilding = oiChangePct != null && oiChangePct > 2;
  evidence.push({
    key: "open_interest",
    label: "Open interest building",
    found: oiBuilding,
    weight: 10,
    score: oiBuilding ? 10 : oiChangePct == null ? 0 : oiChangePct > 0 ? 4 : 0,
    price: null,
    detail:
      oiChangePct == null
        ? "No open-interest history available, so whether positions are being opened or closed here cannot be read."
        : oiBuilding
          ? `Open interest is up ${oiChangePct.toFixed(1)}% over the window — new positions are being opened, not existing ones closed. Absorption with rising OI is someone building; absorption with falling OI is someone leaving.`
          : `Open interest is ${oiChangePct >= 0 ? "up" : "down"} ${Math.abs(oiChangePct).toFixed(1)}% — ${oiChangePct < 0 ? "positions are closing, so any buying here is more likely covering than building." : "no meaningful build-up."}`,
  });

  /* ---- Zones and scoring ---- */
  const zones = buildZones(marks, price);
  const zone = zones.find((z) => z.confluence >= 2) ?? zones[0] ?? null;

  const rawScore = evidence.reduce((s, e) => s + e.score, 0);
  // Confluence is the thesis of this engine, so it is scored explicitly rather
  // than being left as an emergent property of the individual weights.
  const confluenceBonus = zone ? Math.min(15, Math.max(0, zone.confluence - 1) * 5) : 0;
  const score = Math.round(Math.max(0, Math.min(100, rawScore + confluenceBonus)));

  const kinds = evidence.filter((e) => e.found).length;
  const qualified = score >= QUALIFY_SCORE && kinds >= 4 && (zone?.confluence ?? 0) >= 2;
  const grade: InstitutionalSetup["grade"] = qualified
    ? score >= 80
      ? "prime"
      : "strong"
    : score >= 40
      ? "forming"
      : "none";

  const side: InstitutionalSetup["side"] = qualified ? "accumulation" : "none";

  /* ---- Levels, not predictions ---- */
  const invalidateBelow = zone ? zone.low : null;
  const confirmAbove =
    srLevels
      .filter((l) => l.kind === "resistance" && l.price > price)
      .sort((a, b) => a.price - b.price)[0]?.price ?? profile.vah ?? null;
  const objective =
    srLevels
      .filter((l) => l.kind === "resistance" && confirmAbove != null && l.price > confirmAbove)
      .sort((a, b) => a.price - b.price)[0]?.price ??
    liquidity.levels
      .filter((l) => !l.swept && l.price > price)
      .sort((a, b) => a.price - b.price)[0]?.price ??
    null;

  const headline = qualified
    ? `${grade === "prime" ? "Prime" : "Strong"} accumulation footprint — ${zone!.confluence} kinds of evidence at ${fmt(zone!.mid)}`
    : kinds < 4
      ? `Only ${kinds} kinds of evidence present — not a footprint, just marks`
      : (zone?.confluence ?? 0) < 2
        ? "Evidence is scattered across different prices rather than landing on one area"
        : `Footprint forming, score ${score} below the ${QUALIFY_SCORE} threshold`;

  const explanation: string[] = [
    headline,
    // The claim, stated exactly as far as it goes.
    `What this says: ${zone ? `${zone.confluence} independent kinds of evidence (${zone.sources.join(", ")}) land inside ${fmt(zone.low)}–${fmt(zone.high)}` : "the evidence does not converge on one price"}. One mark is noise and two is a coincidence; several different mechanisms pointing at the same band is the signature of size being worked there.`,
    `What this does not say: where price goes next. The levels below follow from the evidence; whether the market reaches them does not, and nothing here estimates the odds of it.`,
  ];
  for (const e of evidence) if (e.found) explanation.push(`✓ ${e.label}: ${e.detail}`);
  for (const e of evidence) if (!e.found) explanation.push(`✗ ${e.label}: ${e.detail}`);
  if (zone) {
    explanation.push(
      `The area is ${fmt(zone.low)}–${fmt(zone.high)}, ${Math.abs(zone.distancePct).toFixed(2)}% ${zone.distancePct < 0 ? "below" : "above"} price. A close below ${fmt(zone.low)} says whoever was there has stopped defending it${confirmAbove != null ? `; clearing ${fmt(confirmAbove)} is what would show the position being marked up${objective != null ? `, with the next mapped level at ${fmt(objective)}` : ""}` : ""}.`
    );
  }

  return {
    symbol,
    timeframe,
    price,
    side,
    zone,
    zones: zones.slice(0, 5),
    evidence,
    score,
    qualified,
    grade,
    openInterestChangePct: oiChangePct,
    confirmAbove,
    invalidateBelow,
    objective,
    headline,
    explanation,
  };
}
