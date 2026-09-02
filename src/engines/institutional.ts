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
  DeltaAnalysis,
  InstitutionalAnalogue,
  InstitutionalEvidence,
  InstitutionalFunding,
  InstitutionalHistory,
  InstitutionalMark,
  InstitutionalRange,
  InstitutionalSetup,
  InstitutionalSideRead,
  InstitutionalZone,
  LiquidationDeltaResult,
  MarketStructureResult,
  OrderFlowEvents,
  PremiumDiscount,
  Zone,
} from "./types";

/**
 * Institutional footprint — where size was worked, and what that implies.
 *
 * Large positions cannot be filled at one price. They are worked over hours or
 * days, and they leave the same marks every time: unfilled gaps left by the
 * impulses away, order blocks at the origin of those impulses, aggression that
 * fails to move price because it is being absorbed, forced flow whose supply
 * gets taken, and rejection wicks where price was refused. None of those is
 * conclusive alone — every one of them also occurs by accident.
 *
 * So this engine does one thing: it collects the marks and asks **how many
 * independent kinds land on the same price band**. One is noise. Two is a
 * coincidence. Several different mechanisms pointing at the same 0.6% of price
 * is the signature of someone working an order there, and it is the only claim
 * in this file the evidence actually supports.
 *
 * ## Both sides, always
 *
 * The checklist runs twice — once for accumulation (demand gaps, demand
 * blocks, *selling* absorbed, forced supply bought) and once for distribution
 * (supply gaps, supply blocks, *buying* absorbed, forced demand sold into).
 * Reporting only the buy side made every chart look like somebody was
 * accumulating, because the absence of a supply read was never shown. Both
 * scores are returned: a demand read means considerably more when the supply
 * read next to it is weak than when both are lit up.
 *
 * ## Located against the range
 *
 * Where a balance area exists, evidence is scored partly on where inside it
 * the zone sits — demand at the range low, supply at the range high. That is
 * what makes the checklist actionable rather than abstract: the range
 * boundaries are where reactions actually happened, so "a demand cluster" and
 * "a demand cluster at the low the market has defended four times" are
 * different claims. Where no range exists the item scores zero and says so;
 * taking a lookback high and low out of a trending market would produce two
 * arbitrary numbers wearing the costume of levels.
 *
 * ## Funding: the positioning half
 *
 * The chart says where size was worked; funding says who is paying to sit on
 * the other side of it. That is the one input here that is a *cost* rather
 * than an inference — whoever pays funding is the crowded side, and they are
 * charged for it every settlement. Accumulation therefore wants shorts paying;
 * distribution wants longs paying. Funding agreeing with the side being read
 * argues against the footprint rather than for it, and is scored that way.
 *
 * ## What "where the market is headed" means here
 *
 * A *level*, not a direction with a probability attached. The output names the
 * area, the level that would confirm the read and the level that would refute
 * it, because those are facts about the chart that follow from the evidence.
 * Whether price reaches them does not, and no amount of confluence makes it so.
 *
 * The one forward-looking figure here is `history`, and it is **measured**: how
 * comparable areas earlier in this same series behaved when price returned to
 * them. That is a record, with its sample size attached and suppressed
 * entirely when too few cases exist. It is not a forecast, and a hold rate
 * from this window is not an edge — the sample is one symbol, one timeframe,
 * one loaded window, and survivorship in a trend will flatter whichever side
 * the trend favoured.
 */

/** Bands within this % of each other are treated as the same area. */
const ZONE_TOLERANCE_PCT = 0.6;
/**
 * Hard ceiling on how wide one area may grow.
 *
 * Clustering by distance to the running midpoint lets a dense run of marks
 * chain: each is within tolerance of the mean, the mean drifts, and the band
 * ends up spanning several percent. A band that wide is not "an area" — price
 * can sit inside it for days, and it can never be closed through, which
 * silently turned every historical sample into a hold.
 */
const MAX_ZONE_WIDTH_PCT = 2.5;
/** Evidence further than this from price is history, not a live area. */
const MAX_DISTANCE_PCT = 12;
/**
 * Raised alongside the checklist, every time it grows. Adding items must not
 * make qualification easier — a longer list with an unchanged bar is a
 * loosened filter wearing the costume of a more thorough one.
 *
 * The arithmetic, so the next change can follow it: ten items carried 120
 * points of weight and the bar was 64 (53% of what was available) on 5 found
 * items (50% of the list). Funding adds a eleventh item and 10 more points, so
 * the bar moves to 68 of 130 (52%) on 6 of 11 (55%).
 */
const QUALIFY_SCORE = 68;
const QUALIFY_KINDS = 6;

/* Range detection */
const RANGE_LOOKBACK = 60;
const RANGE_MAX_WIDTH_PCT = 25;
const RANGE_MIN_BARS = 24;
/** a close within this fraction of the range's width counts as a touch */
const RANGE_EDGE = 0.2;
const RANGE_MIN_TOUCHES = 2;

/* Historical analogues */
const FORWARD_BARS = 20;
const MIN_SAMPLES = 4;

type Side = "accumulation" | "distribution";

/** Exported alongside `measureHistory` so tests can drive it directly. */
export interface Mark {
  source: string;
  low: number;
  high: number;
  /** index of the bar the mark finished forming on */
  index: number;
  /** short chart label; absent on history-only marks, which are never drawn */
  label?: string;
}

interface Cluster extends InstitutionalZone {
  formedIndex: number;
}

function fmt(v: number): string {
  return v.toFixed(v >= 1000 ? 2 : v >= 1 ? 4 : 6).replace(/0+$/, "").replace(/\.$/, "");
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Index of the bar carrying `time`, or -1. */
function indexOfTime(candles: Candle[], time: number): number {
  for (let i = candles.length - 1; i >= 0; i--) if (candles[i].time === time) return i;
  return -1;
}

/**
 * Merge overlapping marks into areas, counting *kinds* rather than instances.
 *
 * Three order blocks stacked at one price is one mechanism repeating, not three
 * independent confirmations, and counting them as three is how a confluence
 * score becomes meaningless. `confluence` therefore counts distinct sources.
 */
function buildZones(
  marks: Mark[],
  price: number,
  limitDistance = true,
  candles?: Candle[]
): Cluster[] {
  if (marks.length === 0) return [];
  const tolerance = (price * ZONE_TOLERANCE_PCT) / 100;
  const sorted = [...marks].sort((a, b) => (a.low + a.high) / 2 - (b.low + b.high) / 2);

  const maxWidth = (price * MAX_ZONE_WIDTH_PCT) / 100;
  const clusters: Mark[][] = [];
  for (const mark of sorted) {
    const last = clusters[clusters.length - 1];
    if (!last) {
      clusters.push([mark]);
      continue;
    }
    const lastMid = last.reduce((s, m) => s + (m.low + m.high) / 2, 0) / last.length;
    const mid = (mark.low + mark.high) / 2;
    // Both conditions matter: near the running midpoint *and* the band stays
    // narrow enough to still be a level rather than a region.
    const wouldSpan =
      Math.max(...last.map((m) => m.high), mark.high) -
      Math.min(...last.map((m) => m.low), mark.low);
    if (Math.abs(mid - lastMid) <= tolerance && wouldSpan <= maxWidth) last.push(mark);
    else clusters.push([mark]);
  }

  return clusters
    .map((cluster) => {
      const low = Math.min(...cluster.map((m) => m.low));
      const high = Math.max(...cluster.map((m) => m.high));
      const mid = (low + high) / 2;
      const sources = [...new Set(cluster.map((m) => m.source))];
      // The area is only complete once its last mark has printed.
      const formedIndex = Math.max(...cluster.map((m) => m.index));
      return {
        low,
        high,
        mid,
        distancePct: Number((((mid - price) / price) * 100).toFixed(3)),
        confluence: sources.length,
        sources,
        formedIndex,
        // The *first* mark's bar, not the last: the box should start where the
        // evidence began accumulating, which is where a reader looking at the
        // chart expects to find it.
        startTime: candles?.[Math.min(...cluster.map((m) => m.index))]?.time,
      };
    })
    .filter((z) => !limitDistance || Math.abs(z.distancePct) <= MAX_DISTANCE_PCT)
    .sort((a, b) => b.confluence - a.confluence || Math.abs(a.distancePct) - Math.abs(b.distancePct));
}

/**
 * The balance area price is currently working inside, or null.
 *
 * Deliberately conservative. A "range" that nobody has traded against twice is
 * just a lookback window, and locating a checklist against it would dress up an
 * arbitrary number as a defended level.
 */
export function detectRange(
  candles: Candle[],
  structure: MarketStructureResult
): InstitutionalRange | null {
  if (candles.length < RANGE_MIN_BARS) return null;
  // Trust the structure engine's own call first; fall back to a flat trend,
  // since a market with no direction is the case a range describes.
  if (!structure.isRange && structure.trend !== "neutral") return null;

  const window = candles.slice(-RANGE_LOOKBACK);
  if (window.length < RANGE_MIN_BARS) return null;

  const high = Math.max(...window.map((c) => c.high));
  const low = Math.min(...window.map((c) => c.low));
  const width = high - low;
  if (width <= 0 || low <= 0) return null;

  const widthPct = (width / low) * 100;
  if (!Number.isFinite(widthPct) || widthPct > RANGE_MAX_WIDTH_PCT) return null;

  const edge = width * RANGE_EDGE;
  const touchesLow = window.filter((c) => c.low <= low + edge).length;
  const touchesHigh = window.filter((c) => c.high >= high - edge).length;
  // Both boundaries must have been visited more than once, or this is a leg
  // with one spike at each end rather than an area being defended.
  if (touchesLow < RANGE_MIN_TOUCHES || touchesHigh < RANGE_MIN_TOUCHES) return null;

  const price = candles[candles.length - 1].close;
  return {
    high,
    low,
    mid: (high + low) / 2,
    position: Math.max(0, Math.min(1, (price - low) / width)),
    bars: window.length,
    touchesLow,
    touchesHigh,
  };
}

/**
 * Reduce a funding series to a positioning read.
 *
 * Sign convention is Binance's: a **positive** rate means longs pay shorts, so
 * a positive average marks longs as the crowded side. `consistency` is what
 * separates a genuine standing cost from a single outlier settlement — three
 * weeks of steady −0.02% is a crowd being bled, while one −0.3% print in an
 * otherwise flat series is a squeeze that has already happened.
 *
 * `cumulativePct` is the sum rather than the mean because that is the number
 * that actually matters to the crowded side: what holding this position has
 * cost them so far, which is what eventually forces the exit.
 */
export function summariseFunding(points: { rate: number }[]): InstitutionalFunding | null {
  if (points.length < 3) return null;
  const rates = points.map((p) => p.rate);
  const mean = rates.reduce((s, r) => s + r, 0) / rates.length;
  const sameSign = rates.filter((r) => (mean >= 0 ? r >= 0 : r < 0)).length;
  const avgRatePct = mean * 100;
  // Below a basis point per settlement the rate is noise around the anchor,
  // not anybody paying to hold anything.
  const payer: InstitutionalFunding["payer"] =
    Math.abs(avgRatePct) < 0.001 ? "balanced" : avgRatePct > 0 ? "longs" : "shorts";
  return {
    avgRatePct: Number(avgRatePct.toFixed(5)),
    latestRatePct: Number((rates[rates.length - 1] * 100).toFixed(5)),
    samples: rates.length,
    consistency: Number((sameSign / rates.length).toFixed(3)),
    payer,
    cumulativePct: Number((rates.reduce((s, r) => s + r, 0) * 100).toFixed(4)),
  };
}

interface Ctx {
  candles: Candle[];
  price: number;
  structure: MarketStructureResult;
  orderBlocks: Zone[];
  fvgs: Zone[];
  delta: DeltaAnalysis;
  liqDelta: LiquidationDeltaResult;
  events: OrderFlowEvents;
  pd: PremiumDiscount;
  range: InstitutionalRange | null;
  oiChangePct: number | null;
  funding: InstitutionalFunding | null;
}

/* ------------------------------------------------------------------ *
 * The checklist, run once per side
 * ------------------------------------------------------------------ */

function collectSide(
  side: Side,
  ctx: Ctx
): { evidence: InstitutionalEvidence[]; marks: Mark[]; annotations: Mark[] } {
  const buy = side === "accumulation";
  const { candles, price, structure, orderBlocks, fvgs, delta, liqDelta, events, pd, range } = ctx;
  const evidence: InstitutionalEvidence[] = [];
  const marks: Mark[] = [];
  /**
   * Marks that are drawn but never clustered.
   *
   * Divergence and structure are checklist items about a *sequence* rather than
   * an area, so feeding them into `buildZones` would inflate a band's
   * confluence count with evidence that does not actually locate anything.
   * They still belong on the chart — the reader wants to see the swing the tick
   * came from — so they are kept in a parallel list that scoring never sees.
   */
  const annotations: Mark[] = [];
  const lastIdx = candles.length - 1;

  const wanted: Zone["direction"] = buy ? "bullish" : "bearish";
  /** on the demand side we look below price, on the supply side above it */
  const inReach = (z: Zone) => (buy ? z.top <= price * 1.02 : z.bottom >= price * 0.98);

  /* ---- 1. Unfilled imbalance ---- */
  const gaps = fvgs.filter((z) => z.direction === wanted && z.status !== "filled" && inReach(z));
  for (const g of gaps) {
    marks.push({
      source: "fvg",
      label: "FVG",
      low: g.bottom,
      high: g.top,
      index: Math.max(0, indexOfTime(candles, g.startTime)),
    });
  }
  evidence.push({
    key: "fvg",
    label: buy ? "Unfilled demand gap" : "Unfilled supply gap",
    found: gaps.length > 0,
    weight: 14,
    score: gaps.length > 0 ? Math.min(14, 7 + gaps.length * 3) : 0,
    price: gaps[0] ? (gaps[0].top + gaps[0].bottom) / 2 : null,
    detail:
      gaps.length > 0
        ? `${gaps.length} unfilled ${buy ? "bullish" : "bearish"} gap${gaps.length > 1 ? "s" : ""} ${buy ? "below" : "above"} price — the market left in a hurry and has not come back to trade the inventory it skipped. Gaps like these mark where the impulse started, not where it ended.`
        : `No unfilled ${buy ? "demand" : "supply"} gap ${buy ? "below" : "above"} price; any move ${buy ? "up" : "down"} from here would start from ground that has since been fully traded.`,
  });

  /* ---- 2. Unmitigated blocks ---- */
  const blocks = orderBlocks.filter(
    (z) => z.direction === wanted && z.status !== "mitigated" && inReach(z)
  );
  for (const ob of blocks) {
    marks.push({
      source: "order_block",
      label: "OB",
      low: ob.bottom,
      high: ob.top,
      index: Math.max(0, indexOfTime(candles, ob.startTime)),
    });
  }
  evidence.push({
    key: "order_block",
    label: buy ? "Unmitigated demand block" : "Unmitigated supply block",
    found: blocks.length > 0,
    weight: 14,
    score: blocks.length > 0 ? Math.min(14, 8 + blocks.length * 3) : 0,
    price: blocks[0] ? (blocks[0].top + blocks[0].bottom) / 2 : null,
    detail:
      blocks.length > 0
        ? `${blocks.length} unmitigated ${buy ? "demand" : "supply"} block${blocks.length > 1 ? "s" : ""} ${buy ? "below" : "above"} — the last ${buy ? "selling before an impulse up" : "buying before an impulse down"}, which is where the ${buy ? "buying" : "selling"} that caused the impulse was actually filled.`
        : `No unmitigated ${buy ? "demand" : "supply"} block ${buy ? "below" : "above"} price.`,
  });

  /* ---- 3. Absorption: aggression that failed to move price ----
     Side "buy" means buyers absorbed the sellers; side "sell" means sellers
     absorbed the buyers — i.e. buying absorbed, which is the distribution
     mechanism and the mirror of the one this engine used to check alone. */
  const absorbSide = buy ? "buy" : "sell";
  const absorptions = events.absorptions.filter((a) => a.side === absorbSide);
  for (const a of absorptions) {
    marks.push({
      source: "absorption",
      label: a.atKeyLevel ? "ABS★" : "ABS",
      low: a.price * 0.999,
      high: a.price * 1.001,
      index: Math.max(0, indexOfTime(candles, a.time)),
    });
  }
  const atKey = absorptions.some((a) => a.atKeyLevel);
  evidence.push({
    key: "absorption",
    label: buy ? "Selling absorbed" : "Buying absorbed",
    found: absorptions.length > 0,
    weight: 16,
    score: absorptions.length > 0 ? (atKey ? 16 : 10) : 0,
    price: absorptions[0]?.price ?? null,
    detail:
      absorptions.length > 0
        ? `${absorptions.length} ${absorbSide}-side absorption event${absorptions.length > 1 ? "s" : ""}: heavy ${buy ? "selling hit the bid and price did not fall" : "buying lifted the offer and price did not rise"}. Someone was standing there with resting size — the most direct evidence in this list, because it is the mechanism itself rather than a trace of it.${atKey ? " At least one landed on a mapped level." : ""}`
        : `No ${absorbSide}-side absorption — ${buy ? "selling" : "buying"} here has been moving price, which is what it does when nobody is on the other side of it.`,
  });

  /* ---- 4. Forced flow being taken ---- */
  const forced = liqDelta.series.filter((p) => (buy ? p.longLiquidated : p.shortLiquidated) > 0);
  const forcedTotal = forced.reduce((s, p) => s + (buy ? p.longLiquidated : p.shortLiquidated), 0);
  let faded = false;
  if (forced.length > 0) {
    const worst = forced.reduce((a, b) =>
      (buy ? a.longLiquidated : a.shortLiquidated) >= (buy ? b.longLiquidated : b.shortLiquidated)
        ? a
        : b
    );
    const idx = indexOfTime(candles, worst.time);
    const bar = idx >= 0 ? candles[idx] : undefined;
    if (bar) {
      const mid = (bar.high + bar.low) / 2;
      // Demand: forced selling that price has since climbed back above.
      // Supply: forced buying that price has since fallen back below.
      faded = buy ? price > mid : price < mid;
      marks.push({
        source: "liquidation",
        label: "LIQ",
        low: buy ? bar.low : mid,
        high: buy ? mid : bar.high,
        index: Math.max(0, idx),
      });
    }
  }
  evidence.push({
    key: "liquidation",
    label: buy ? "Forced supply absorbed" : "Forced demand absorbed",
    found: forcedTotal > 0 && faded,
    weight: 14,
    score: forcedTotal > 0 ? (faded ? 14 : 5) : 0,
    price: null,
    detail:
      forcedTotal > 0
        ? faded
          ? `Forced ${buy ? "long liquidation" : "short liquidation"} printed here and price has since ${buy ? "reclaimed" : "given back"} it. Margin engines ${buy ? "sell" : "buy"} without regard to value; someone took the other side of that, which is exactly how size gets filled at a good price.`
          : `Forced flow is present but price has not ${buy ? "reclaimed" : "given back"} it — the ${buy ? "supply" : "demand"} may still be coming, so this is not yet evidence of anyone absorbing it.`
        : `No forced ${buy ? "selling" : "buying"} in the window, so there has been no ${buy ? "discounted supply" : "panicked demand"} for anyone to take.`,
  });

  /* ---- 5. Divergence ---- */
  const wantedDiv = buy ? "bullish" : "bearish";
  const divergences = delta.divergences.filter((d) => d.kind.includes(wantedDiv));
  for (const d of divergences) {
    const idx = indexOfTime(candles, d.time);
    if (idx < 0) continue;
    annotations.push({
      source: "divergence",
      label: "DIV",
      low: d.pricePoint * 0.999,
      high: d.pricePoint * 1.001,
      index: idx,
    });
  }
  evidence.push({
    key: "divergence",
    label: buy ? "Bullish delta divergence" : "Bearish delta divergence",
    found: divergences.length > 0,
    weight: 11,
    score: divergences.length > 0 ? Math.min(11, 6 + divergences.length * 3) : 0,
    price: divergences[0]?.pricePoint ?? null,
    detail:
      divergences.length > 0
        ? `${divergences.length} ${wantedDiv} divergence: price made the ${buy ? "lower low" : "higher high"}, cumulative delta did not. The ${buy ? "selling that produced the low" : "buying that produced the high"} was not backed by aggression.`
        : `No ${wantedDiv} delta divergence — cumulative delta has been confirming the price ${buy ? "lows" : "highs"} rather than refusing them.`,
  });

  /* ---- 6. Rejection wicks ---- */
  const start = Math.max(0, candles.length - 20);
  const rejections: { bar: Candle; index: number }[] = [];
  for (let i = start; i <= lastIdx; i++) {
    const c = candles[i];
    const range_ = Math.max(c.high - c.low, 1e-12);
    const wick = buy ? Math.min(c.open, c.close) - c.low : c.high - Math.max(c.open, c.close);
    if (wick / range_ >= 0.5) rejections.push({ bar: c, index: i });
  }
  for (const r of rejections) {
    marks.push({
      source: "rejection",
      label: "REJ",
      low: buy ? r.bar.low : Math.max(r.bar.open, r.bar.close),
      high: buy ? Math.min(r.bar.open, r.bar.close) : r.bar.high,
      index: r.index,
    });
  }
  evidence.push({
    key: "rejection",
    label: buy ? "Rejection from below" : "Rejection from above",
    found: rejections.length >= 2,
    weight: 11,
    score: rejections.length >= 2 ? Math.min(11, rejections.length * 4) : rejections.length * 3,
    price: buy
      ? (rejections[rejections.length - 1]?.bar.low ?? null)
      : (rejections[rejections.length - 1]?.bar.high ?? null),
    detail:
      rejections.length > 0
        ? `${rejections.length} bar${rejections.length > 1 ? "s" : ""} in the last 20 left ${buy ? "a lower" : "an upper"} wick over half their range — price was taken ${buy ? "down and bought back" : "up and sold back"} each time. Repetition is the point: once is a ${buy ? "bounce" : "fade"}, repeatedly is someone working an order.`
        : `No repeated rejection wicks ${buy ? "under" : "over"} the recent bars.`,
  });

  /* ---- 7. Location within the dealing range ---- */
  const wantedZone = buy ? "discount" : "premium";
  const atLocation = pd.currentZone === wantedZone;
  evidence.push({
    key: "location",
    label: buy ? "Discount location" : "Premium location",
    found: atLocation,
    weight: 9,
    score: atLocation ? 9 : pd.currentZone === "equilibrium" ? 4 : 0,
    price: null,
    detail: atLocation
      ? `Price sits in the ${wantedZone} half of the dealing range (${(pd.positionInRange * 100).toFixed(0)}%). Size is worked where it is ${buy ? "cheap" : "expensive"}, which is not usually where it is obvious.`
      : `Price is at ${(pd.positionInRange * 100).toFixed(0)}% of the dealing range (${pd.currentZone}) — not where ${buy ? "accumulation" : "distribution"} normally happens.`,
  });

  /* ---- 8. Structure: HH/HL, or LH/LL ---- */
  const swings = structure.swings;
  const labels = swings.filter((s) => s.label).slice(-6);
  const hh = labels.filter((s) => s.label === "HH").length;
  const hl = labels.filter((s) => s.label === "HL").length;
  const lh = labels.filter((s) => s.label === "LH").length;
  const ll = labels.filter((s) => s.label === "LL").length;
  const stepping = buy ? hh > 0 && hl > 0 : lh > 0 && ll > 0;
  const trendAgrees = buy ? structure.trend === "bullish" : structure.trend === "bearish";
  // The swings the item is actually claiming. Labelling them on the chart is
  // the difference between "structure steps up" and being able to check it.
  for (const s of labels) {
    if (buy ? s.label !== "HH" && s.label !== "HL" : s.label !== "LH" && s.label !== "LL") continue;
    annotations.push({
      source: "structure",
      label: s.label!,
      low: s.price * 0.999,
      high: s.price * 1.001,
      index: s.index,
    });
  }
  evidence.push({
    key: "structure",
    label: buy ? "Higher highs and higher lows" : "Lower highs and lower lows",
    found: stepping,
    weight: 11,
    score: stepping ? (trendAgrees ? 11 : 7) : 0,
    price: buy
      ? (structure.lastHigherLow?.price ?? null)
      : (structure.lastLowerHigh?.price ?? null),
    detail: stepping
      ? `Recent swings step ${buy ? `up — ${hh} higher high${hh > 1 ? "s" : ""} and ${hl} higher low${hl > 1 ? "s" : ""}` : `down — ${lh} lower high${lh > 1 ? "s" : ""} and ${ll} lower low${ll > 1 ? "s" : ""}`}. ${buy ? "A higher low is the visible half of absorption: sellers got a worse price than last time and stopped earlier." : "A lower high is the visible half of distribution: buyers paid less than last time and gave up sooner."} Structure reads ${structure.trend}${trendAgrees ? "" : ", which does not agree with this side — the steps are there but the trend is not"}.`
      : `No ${buy ? "higher-high / higher-low" : "lower-high / lower-low"} sequence in the recent swings (${hh} HH, ${hl} HL, ${lh} LH, ${ll} LL). ${buy ? "Price is not yet stepping up, so any buying here has not shown in structure." : "Price is not yet stepping down, so any selling here has not shown in structure."}`,
  });

  /* ---- 9. Position inside the current range ---- */
  const wantedEdge = buy ? "low" : "high";
  const atEdge =
    range != null && (buy ? range.position <= 0.35 : range.position >= 0.65);
  evidence.push({
    key: "range_location",
    label: buy ? "At the range low" : "At the range high",
    found: atEdge,
    weight: 10,
    score: atEdge ? (range!.position <= 0.2 || range!.position >= 0.8 ? 10 : 7) : 0,
    price: range ? (buy ? range.low : range.high) : null,
    detail:
      range == null
        ? "No balance area to locate against — the market is trending, and a range picked out of a trend is two arbitrary numbers dressed as levels. This item scores nothing rather than inventing a boundary."
        : atEdge
          ? `Price is at ${(range.position * 100).toFixed(0)}% of a range running ${fmt(range.low)}–${fmt(range.high)} over ${range.bars} bars, so it sits at the ${wantedEdge} the market has come back to ${buy ? range.touchesLow : range.touchesHigh} times. A ${buy ? "demand" : "supply"} cluster at a boundary that has already been defended is a different claim from one in the middle of the range.`
          : `Price is at ${(range.position * 100).toFixed(0)}% of the ${fmt(range.low)}–${fmt(range.high)} range — not at the ${wantedEdge}, so this evidence is not being read at the edge where the reactions have happened.`,
  });

  /* ---- 10. Funding: who is paying to hold the other side ----
     The mirror image of the side being read. Accumulation wants *shorts*
     paying — a crowd short into an area that will not break, bleeding every
     settlement, is the cohort whose exit becomes the move. Distribution wants
     longs paying. Funding that agrees with the side being read is the weakest
     possible version of this item, because it means the crowd is already
     positioned the way the footprint points. */
  const funding = ctx.funding;
  const wantedPayer = buy ? "shorts" : "longs";
  const payerOpposes = funding != null && funding.payer === wantedPayer;
  // One outlier settlement is a squeeze that already happened; a standing cost
  // is a crowd still carrying the position.
  const persistent = funding != null && funding.consistency >= 0.7 && funding.samples >= 6;
  const fundingFound = payerOpposes && persistent;
  evidence.push({
    key: "funding",
    label: buy ? "Shorts are paying to stay short" : "Longs are paying to stay long",
    found: fundingFound,
    weight: 10,
    score: fundingFound
      ? // Scaled by how expensive the position actually is. A tenth of a basis
        // point per settlement is technically the right sign and costs nobody
        // anything; the item should not score the same as a crowd paying 0.05%
        // three times a day.
        Math.min(10, 5 + Math.min(5, Math.abs(funding!.avgRatePct) * 200))
      : payerOpposes
        ? 3
        : 0,
    price: null,
    detail:
      funding == null
        ? "No funding history available, so who is paying to hold the other side of this cannot be read."
        : fundingFound
          ? `${wantedPayer === "shorts" ? "Shorts" : "Longs"} have paid funding on ${(funding.consistency * 100).toFixed(0)}% of the last ${funding.samples} settlements, averaging ${funding.avgRatePct.toFixed(4)}% and ${funding.cumulativePct.toFixed(3)}% cumulative. Funding is a cost, not an opinion — the side paying it is the crowded one, and it is being charged every settlement to stay there. Price refusing to go their way while they pay for the privilege is the positioning half of ${buy ? "accumulation" : "distribution"}.`
          : payerOpposes
            ? `${wantedPayer === "shorts" ? "Shorts" : "Longs"} are paying on average, but inconsistently (${(funding.consistency * 100).toFixed(0)}% of ${funding.samples} settlements). That reads as one or two spikes rather than a standing cost — a squeeze that has already happened, not a crowd still carrying it.`
            : funding.payer === "balanced"
              ? `Funding is flat (${funding.avgRatePct.toFixed(4)}% average) — nobody is paying meaningfully to hold either side, so there is no crowded cohort here for the move to come from.`
              : `${funding.payer === "longs" ? "Longs" : "Shorts"} are the ones paying (${funding.avgRatePct.toFixed(4)}% average), which is the *same* side this read points. The crowd is already positioned this way, so funding argues against the footprint rather than for it.`,
  });

  /* ---- 11. Open interest ---- */
  const oi = ctx.oiChangePct;
  const oiBuilding = oi != null && oi > 2;
  evidence.push({
    key: "open_interest",
    label: "Open interest building",
    found: oiBuilding,
    weight: 10,
    score: oiBuilding ? 10 : oi == null ? 0 : oi > 0 ? 4 : 0,
    price: null,
    detail:
      oi == null
        ? "No open-interest history available, so whether positions are being opened or closed here cannot be read."
        : oiBuilding
          ? `Open interest is up ${oi.toFixed(1)}% over the window — new positions are being opened, not existing ones closed. Absorption with rising OI is someone building; absorption with falling OI is someone leaving.`
          : `Open interest is ${oi >= 0 ? "up" : "down"} ${Math.abs(oi).toFixed(1)}% — ${oi < 0 ? `positions are closing, so any ${buy ? "buying" : "selling"} here is more likely ${buy ? "covering" : "unwinding"} than building.` : "no meaningful build-up."}`,
  });

  return { evidence, marks, annotations };
}

/**
 * Internal index-keyed marks to chart-ready ones.
 *
 * Filtered by the checklist's own verdict, which is not a formality: several
 * items have a threshold above one occurrence. A single rejection wick is a
 * mark but not a tick (the item wants two), and forced flow that price has not
 * reclaimed is a mark but not a tick either. Drawing those would put a symbol
 * on the candles for an item the card next to it reports as unmet, and a
 * reader has no way to tell which of the two is lying.
 */
function toChartMarks(
  marks: Mark[],
  candles: Candle[],
  evidence: InstitutionalEvidence[]
): InstitutionalMark[] {
  const found = new Set(evidence.filter((e) => e.found).map((e) => e.key));
  const out: InstitutionalMark[] = [];
  for (const m of marks) {
    const bar = candles[m.index];
    if (!bar || !m.label || !found.has(m.source)) continue;
    out.push({ source: m.source, label: m.label, low: m.low, high: m.high, time: bar.time });
  }
  return out.sort((a, b) => a.time - b.time);
}

function scoreSide(
  side: Side,
  evidence: InstitutionalEvidence[],
  zones: Cluster[],
  marks: InstitutionalMark[]
): InstitutionalSideRead {
  const zone = zones.find((z) => z.confluence >= 2) ?? zones[0] ?? null;
  const raw = evidence.reduce((s, e) => s + e.score, 0);
  // Confluence is the thesis of this engine, so it is scored explicitly rather
  // than left as an emergent property of the individual weights.
  const confluenceBonus = zone ? Math.min(15, Math.max(0, zone.confluence - 1) * 5) : 0;
  const score = Math.round(Math.max(0, Math.min(100, raw + confluenceBonus)));
  const kinds = evidence.filter((e) => e.found).length;
  return {
    side,
    zone,
    zones: zones.slice(0, 5),
    evidence,
    marks,
    kinds,
    score,
    qualified: score >= QUALIFY_SCORE && kinds >= QUALIFY_KINDS && (zone?.confluence ?? 0) >= 2,
  };
}

/* ------------------------------------------------------------------ *
 * Historical analogues — what happened last time this shape appeared
 * ------------------------------------------------------------------ */

/**
 * Marks across the **whole** series, for the historical pass only.
 *
 * Deliberately not the live read's marks. Those are filtered to what is in
 * reach of current price, still unfilled, and — for rejection wicks — inside
 * the last twenty bars, because that is what makes them a statement about
 * *now*. Every one of those filters is wrong for history: an area only becomes
 * a usable sample once it is old, filled and far behind, which is exactly what
 * the live filters throw away. Reusing them yielded one sample per symbol.
 *
 * Absorption is excluded because its marks are single price points from the
 * footprint window rather than areas with a formation bar.
 */
function collectHistoricalMarks(side: Side, ctx: Ctx): Mark[] {
  const buy = side === "accumulation";
  const { candles, fvgs, orderBlocks, liqDelta } = ctx;
  const wanted: Zone["direction"] = buy ? "bullish" : "bearish";
  const marks: Mark[] = [];

  for (const z of [...fvgs, ...orderBlocks]) {
    if (z.direction !== wanted) continue;
    const idx = indexOfTime(candles, z.startTime);
    if (idx < 0) continue;
    marks.push({
      source: z.type === "fvg" ? "fvg" : "order_block",
      low: z.bottom,
      high: z.top,
      index: idx,
    });
  }

  // Rejection wicks across the entire series, not just the recent window.
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const range_ = Math.max(c.high - c.low, 1e-12);
    const wick = buy ? Math.min(c.open, c.close) - c.low : c.high - Math.max(c.open, c.close);
    if (wick / range_ < 0.5) continue;
    marks.push({
      source: "rejection",
      low: buy ? c.low : Math.max(c.open, c.close),
      high: buy ? Math.min(c.open, c.close) : c.high,
      index: i,
    });
  }

  for (const p of liqDelta.series) {
    const size = buy ? p.longLiquidated : p.shortLiquidated;
    if (size <= 0) continue;
    const idx = indexOfTime(candles, p.time);
    if (idx < 0) continue;
    const bar = candles[idx];
    const mid = (bar.high + bar.low) / 2;
    marks.push({
      source: "liquidation",
      low: buy ? bar.low : mid,
      high: buy ? mid : bar.high,
      index: idx,
    });
  }

  return marks;
}

/**
 * Find comparable areas earlier in the series and measure what price did when
 * it came back to them.
 *
 * An area is only usable as a sample once it has had `FORWARD_BARS` bars to
 * resolve, so recent areas — including the live one — are excluded by
 * construction. Measuring an outcome that has not happened yet would count the
 * present as if it were history.
 *
 * The sample is bounded by what the upstream detectors expose, not only by the
 * candles fetched: `detectFVGs` returns the most recent fifteen gaps, so gaps
 * further back are invisible here and the deep history leans on rejection
 * wicks and forced-flow bars, which are scanned in full. Worth knowing when
 * reading the sample count — it is a floor, not a census.
 *
 * Exported for tests: the outcome classification is the part worth pinning
 * down, and driving it through four upstream detectors to reach it would test
 * their thresholds rather than this logic.
 */
export function measureHistory(side: Side, marks: Mark[], candles: Candle[]): InstitutionalHistory {
  const buy = side === "accumulation";
  const lastIdx = candles.length - 1;
  const price = candles[lastIdx].close;
  const clusters = buildZones(marks, price, false).filter(
    (z) => z.confluence >= 2 && z.formedIndex + FORWARD_BARS <= lastIdx
  );

  const analogues: InstitutionalAnalogue[] = [];
  for (const z of clusters) {
    // First return to the area after it finished forming.
    let tap = -1;
    for (let i = z.formedIndex + 1; i <= lastIdx; i++) {
      if (candles[i].low <= z.high && candles[i].high >= z.low) {
        tap = i;
        break;
      }
    }
    if (tap < 0 || tap + FORWARD_BARS > lastIdx) {
      analogues.push({
        time: candles[z.formedIndex].time,
        low: z.low,
        high: z.high,
        confluence: z.confluence,
        sources: z.sources,
        tapTime: tap >= 0 ? candles[tap].time : null,
        outcome: "unresolved",
        favourablePct: 0,
        adversePct: 0,
      });
      continue;
    }

    const window = candles.slice(tap, tap + FORWARD_BARS + 1);
    const edge = buy ? z.low : z.high;
    const front = buy ? z.high : z.low;
    const best = buy
      ? Math.max(...window.map((c) => c.high))
      : Math.min(...window.map((c) => c.low));
    const worst = buy
      ? Math.min(...window.map((c) => c.low))
      : Math.max(...window.map((c) => c.high));
    // "Broke" means a *close* through the far edge, not a wick. A wick through
    // an area is the area being tested; a close through it is the area failing.
    const broke = window.some((c) => (buy ? c.close < z.low : c.close > z.high));

    analogues.push({
      time: candles[z.formedIndex].time,
      low: z.low,
      high: z.high,
      confluence: z.confluence,
      sources: z.sources,
      tapTime: candles[tap].time,
      outcome: broke ? "broke" : "held",
      favourablePct: Number((((buy ? best - front : front - best) / front) * 100).toFixed(2)),
      adversePct: Number((((buy ? edge - worst : worst - edge) / edge) * 100).toFixed(2)),
    });
  }

  const resolved = analogues.filter((a) => a.outcome !== "unresolved");
  const held = resolved.filter((a) => a.outcome === "held").length;
  const broke = resolved.length - held;
  const enough = resolved.length >= MIN_SAMPLES;

  const note = !enough
    ? `Only ${resolved.length} comparable area${resolved.length === 1 ? "" : "s"} with a resolved outcome in this window — below the ${MIN_SAMPLES} needed to quote a rate. The cases are listed, the rate is not, because a hit rate from ${resolved.length} is a number people read as an edge.`
    : `Of ${resolved.length} comparable ${buy ? "demand" : "supply"} areas earlier in this series, ${held} held and ${broke} broke when price returned, measured over the ${FORWARD_BARS} bars after the first tap. This is a record of one symbol on one timeframe inside the loaded window, not an edge: a trending market flatters whichever side the trend favoured, and the sample cannot see anything outside the bars fetched.`;

  return {
    samples: resolved.length,
    held,
    broke,
    holdRatePct: enough ? Number(((held / resolved.length) * 100).toFixed(1)) : null,
    medianFavourablePct: enough ? median(resolved.map((a) => a.favourablePct)) : null,
    medianAdversePct: enough ? median(resolved.map((a) => a.adversePct)) : null,
    analogues: analogues.slice(-6),
    note,
  };
}

/* ------------------------------------------------------------------ */

export function detectInstitutional(
  symbol: string,
  timeframe: string,
  candles: Candle[],
  openInterest?: number[] | null,
  fundingHistory?: { rate: number }[] | null
): InstitutionalSetup {
  const price = candles[candles.length - 1]?.close ?? 0;
  const emptySide = (side: Side): InstitutionalSideRead => ({
    side,
    zone: null,
    zones: [],
    evidence: [],
    marks: [],
    kinds: 0,
    score: 0,
    qualified: false,
  });
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
    demand: emptySide("accumulation"),
    supply: emptySide("distribution"),
    range: null,
    history: {
      samples: 0,
      held: 0,
      broke: 0,
      holdRatePct: null,
      medianFavourablePct: null,
      medianAdversePct: null,
      analogues: [],
      note: "Not enough history to measure comparable areas.",
    },
    openInterestChangePct: null,
    funding: null,
    confirmLevel: null,
    invalidateLevel: null,
    objective: null,
    trade: null,
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
  const range = detectRange(candles, structure);

  let oiChangePct: number | null = null;
  if (openInterest && openInterest.length >= 4) {
    const first = openInterest[0];
    const last = openInterest[openInterest.length - 1];
    oiChangePct = first > 0 ? Number((((last - first) / first) * 100).toFixed(3)) : 0;
  }

  const funding = fundingHistory ? summariseFunding(fundingHistory) : null;

  const ctx: Ctx = {
    candles,
    price,
    structure,
    orderBlocks,
    fvgs,
    delta,
    liqDelta,
    events,
    pd,
    range,
    oiChangePct,
    funding,
  };

  const demandRaw = collectSide("accumulation", ctx);
  const supplyRaw = collectSide("distribution", ctx);
  const demand = scoreSide(
    "accumulation",
    demandRaw.evidence,
    buildZones(demandRaw.marks, price, true, candles),
    toChartMarks([...demandRaw.marks, ...demandRaw.annotations], candles, demandRaw.evidence)
  );
  const supply = scoreSide(
    "distribution",
    supplyRaw.evidence,
    buildZones(supplyRaw.marks, price, true, candles),
    toChartMarks([...supplyRaw.marks, ...supplyRaw.annotations], candles, supplyRaw.evidence)
  );

  // The dominant read. Ties go to demand only because something has to break
  // them; a tie is reported as such in the text rather than hidden.
  const lead = supply.score > demand.score ? supply : demand;
  const other = lead === demand ? supply : demand;
  const leadRaw = lead === demand ? demandRaw : supplyRaw;
  const buy = lead.side === "accumulation";

  const history = measureHistory(lead.side, collectHistoricalMarks(lead.side, ctx), candles);

  const qualified = lead.qualified;
  const score = lead.score;
  const grade: InstitutionalSetup["grade"] = qualified
    ? score >= 80
      ? "prime"
      : "strong"
    : score >= 40
      ? "forming"
      : "none";

  /* ---- Levels, not predictions ---- */
  const zone = lead.zone;
  const invalidateLevel = zone ? (buy ? zone.low : zone.high) : null;
  const confirmLevel = buy
    ? (srLevels
        .filter((l) => l.kind === "resistance" && l.price > price)
        .sort((a, b) => a.price - b.price)[0]?.price ??
      range?.high ??
      profile.vah ??
      null)
    : (srLevels
        .filter((l) => l.kind === "support" && l.price < price)
        .sort((a, b) => b.price - a.price)[0]?.price ??
      range?.low ??
      profile.val ??
      null);
  // The objective is the next level *beyond confirmation*, so both the mapped
  // and the liquidity fallback are measured from `confirmLevel` — not from
  // price. Measuring the fallback from price let it return a level short of
  // confirmation, which reads as an objective you reach before the thing that
  // would confirm the read has happened.
  const beyond = confirmLevel ?? price;
  const objective = buy
    ? (srLevels
        .filter((l) => l.kind === "resistance" && l.price > beyond)
        .sort((a, b) => a.price - b.price)[0]?.price ??
      liquidity.levels
        .filter((l) => !l.swept && l.price > beyond)
        .sort((a, b) => a.price - b.price)[0]?.price ??
      null)
    : (srLevels
        .filter((l) => l.kind === "support" && l.price < beyond)
        .sort((a, b) => b.price - a.price)[0]?.price ??
      liquidity.levels
        .filter((l) => !l.swept && l.price < beyond)
        .sort((a, b) => b.price - a.price)[0]?.price ??
      null);

  /* ---- Tradable geometry, only for a qualified read ----
     Built from the levels above rather than alongside them, so the trade can
     never disagree with the explanation. The stop sits a tenth of the zone's
     own width beyond the invalidation level: placing it exactly on the edge
     gets it taken by the wick that tests the area, which is the move the read
     expects rather than the one that refutes it. */
  let trade: InstitutionalSetup["trade"] = null;
  if (qualified && zone && invalidateLevel != null && confirmLevel != null) {
    const entry = buy ? zone.high : zone.low;
    const buffer = Math.max((zone.high - zone.low) * 0.1, entry * 0.0005);
    const stopLoss = buy ? invalidateLevel - buffer : invalidateLevel + buffer;
    const risk = Math.abs(entry - stopLoss);
    const tp1 = confirmLevel;
    // Objective when there is one; otherwise 2R, labelled as geometry in the
    // explanation rather than presented as a mapped level.
    const tp2 = objective ?? (buy ? entry + risk * 2 : entry - risk * 2);
    const tp3 = buy ? entry + (tp2 - entry) * 1.5 : entry - (entry - tp2) * 1.5;
    const reward = Math.abs(tp2 - entry);
    // A setup whose first target sits inside its own risk is not a setup. The
    // levels still stand and are still reported — only the trade is withheld.
    if (risk > 0 && (buy ? tp1 > entry : tp1 < entry) && reward / risk >= 1) {
      trade = {
        side: buy ? "BUY" : "SELL",
        entry,
        stopLoss,
        tp1,
        tp2,
        tp3,
        riskReward: Number((reward / risk).toFixed(2)),
        expectedMovePct: Number((((tp2 - entry) / entry) * 100).toFixed(2)),
      };
    }
  }

  const sideWord = buy ? "accumulation" : "distribution";
  const headline = qualified
    ? `${grade === "prime" ? "Prime" : "Strong"} ${sideWord} footprint — ${zone!.confluence} kinds of evidence at ${fmt(zone!.mid)}`
    : lead.kinds < QUALIFY_KINDS
      ? `Only ${lead.kinds} of ${lead.evidence.length} checklist items present on the ${buy ? "demand" : "supply"} side — marks, not a footprint`
      : (zone?.confluence ?? 0) < 2
        ? "Evidence is scattered across different prices rather than landing on one area"
        : `${sideWord[0].toUpperCase()}${sideWord.slice(1)} footprint forming, score ${score} below the ${QUALIFY_SCORE} threshold`;

  const explanation: string[] = [
    headline,
    `What this says: ${zone ? `${zone.confluence} independent kinds of evidence (${zone.sources.join(", ")}) land inside ${fmt(zone.low)}–${fmt(zone.high)}` : "the evidence does not converge on one price"}. One mark is noise and two is a coincidence; several different mechanisms pointing at the same band is the signature of size being worked there.`,
    `What this does not say: where price goes next. The levels below follow from the evidence; whether the market reaches them does not, and nothing here estimates the odds of it.`,
    // Both sides, side by side. A demand read is worth much less when the
    // supply read next to it is equally lit.
    other.score >= lead.score - 8
      ? `Both sides read close (${buy ? "demand" : "supply"} ${lead.score}, ${buy ? "supply" : "demand"} ${other.score}, ${other.kinds} items). That is not a footprint on either side — it is a market leaving marks in both directions, which is what a contested area looks like.`
      : `The other side is weaker: ${buy ? "supply" : "demand"} scores ${other.score} on ${other.kinds} items against this side's ${lead.score} on ${lead.kinds}. The asymmetry is the point — one-sided evidence is what separates a worked order from ordinary two-way trade.`,
    range
      ? `Range: ${fmt(range.low)}–${fmt(range.high)} over ${range.bars} bars, price at ${(range.position * 100).toFixed(0)}% (low touched ${range.touchesLow}×, high ${range.touchesHigh}×). The checklist is located against those boundaries.`
      : `No balance area: structure reads ${structure.trend}, so the checklist is located against price alone. Range position scores nothing rather than inventing a boundary out of a trend.`,
    history.note,
  ];
  if (trade) {
    explanation.push(
      `Trade geometry: ${trade.side} at ${fmt(trade.entry)}, stop ${fmt(trade.stopLoss)} (a fraction of the zone's width beyond invalidation, so the wick that tests the area does not take it), first target ${fmt(trade.tp1)}${objective != null ? `, second ${fmt(trade.tp2)} at the next mapped level` : `, second ${fmt(trade.tp2)} which is 2R geometry rather than a mapped level`}. Risk-reward ${trade.riskReward}. These follow from the levels above; they are not a separate opinion about where price will go.`
    );
  }
  for (const e of lead.evidence) if (e.found) explanation.push(`✓ ${e.label}: ${e.detail}`);
  for (const e of lead.evidence) if (!e.found) explanation.push(`✗ ${e.label}: ${e.detail}`);
  if (zone) {
    explanation.push(
      `The area is ${fmt(zone.low)}–${fmt(zone.high)}, ${Math.abs(zone.distancePct).toFixed(2)}% ${zone.distancePct < 0 ? "below" : "above"} price. A close ${buy ? "below" : "above"} ${fmt(invalidateLevel ?? zone.low)} says whoever was there has stopped defending it${confirmLevel != null ? `; ${buy ? "clearing" : "losing"} ${fmt(confirmLevel)} is what would show the position being ${buy ? "marked up" : "marked down"}${objective != null ? `, with the next mapped level at ${fmt(objective)}` : ""}` : ""}.`
    );
  }

  return {
    symbol,
    timeframe,
    price,
    side: qualified ? lead.side : "none",
    zone,
    zones: lead.zones,
    evidence: lead.evidence,
    score,
    qualified,
    grade,
    demand,
    supply,
    range,
    history,
    openInterestChangePct: oiChangePct,
    funding,
    confirmLevel,
    invalidateLevel,
    objective,
    trade,
    headline,
    explanation,
  };
}
