import { analyzeMarketStructure } from "./marketStructure";
import { Candle, StructureEvent, SwingPoint } from "./types";

/**
 * A break of structure, and whether anything was behind it.
 *
 * Every chart breaks structure constantly. On any given close a large share of
 * the universe has taken out some swing high, and a scanner that lists them is
 * listing noise — the event is close to free. What is not free is a break that
 * *displaced*: one bar that cleared the level decisively, on volume, with the
 * aggressive flow on the same side, and that then held when price came back to
 * check it.
 *
 * So this engine is not a break detector. It is a filter on breaks, and most
 * of what it does is refuse them.
 *
 * ## Why the state matters more than the score
 *
 * The same break is a different trade at every point in its life. Fresh off
 * the level there is no risk-defining structure yet; twenty bars later the
 * geometry is gone and the only entries left are chasing. In between there is
 * a retest, which is the one point where the level that was broken is both
 * close enough to stop against and proven enough to lean on.
 *
 * Collapsing that into a single "BOS found" flag is what makes structure
 * scanners useless in practice: they tell you something happened without
 * telling you whether it is still actionable. The state machine here is the
 * actual output, and the score only ranks within a state.
 *
 * ## What it deliberately does not claim
 *
 * A held retest is not a prediction. It is the condition under which a
 * continuation trade has a defined invalidation and a sensible reward — which
 * is a statement about geometry, not about what price will do. Failed retests
 * are reported with equal prominence for exactly that reason.
 */

/** Bars of context for the volume and range baselines. */
const CONTEXT = 30;
/** Beyond this many bars since the break, momentum is history. */
const STALE_BARS = 30;
/** A break bar must clear the level by this share of ATR to count as displacement. */
const MIN_DISPLACEMENT_ATR = 0.5;
/** Volume multiple below which a break is drifting through, not breaking. */
const MIN_VOLUME_X = 1.15;
/** Within this share of ATR of the level, price is *at* the retest. */
const RETEST_BAND_ATR = 0.35;
/** Beyond this many ATR from the level, the entry geometry is gone. */
const EXTENDED_ATR = 3;
/** Bars a retest must hold before it counts as held rather than still open. */
const HELD_BARS = 2;
/** Score at or above which a break is worth acting on. */
const QUALIFY_SCORE = 60;

export type BosState =
  /** price is pressing the level but has not closed through it */
  | "forming"
  /** the break bar is the most recent closed bar */
  | "fresh_break"
  /** broken, price has left the level, no retest yet */
  | "retest_pending"
  /** price is back at the broken level right now */
  | "retesting"
  /** came back, held, and turned away — the geometry the scanner exists for */
  | "retest_held"
  /** came back and traded through: the break did not hold */
  | "retest_failed"
  /** ran without a retest and is now too far to stop against */
  | "extended"
  /** the break is old enough that it is context, not momentum */
  | "stale";

export interface BosCheck {
  key: string;
  label: string;
  found: boolean;
  detail: string;
  /** contribution to the momentum score when found */
  weight: number;
}

export interface BosTrade {
  side: "BUY" | "SELL";
  /** a limit at the level — deliberately not the current price */
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  riskReward: number;
  note: string;
}

export interface BosMomentumSetup {
  symbol: string;
  timeframe: string;
  /** false when no break of structure was found in the window at all */
  found: boolean;
  direction: "bullish" | "bearish" | null;
  state: BosState;
  /** the swing price that was broken */
  level: number;
  /** when the swing that got broken was made */
  brokenSwingTime: number;
  /** when the break happened */
  breakTime: number;
  barsSinceBreak: number;
  price: number;
  /** signed distance from the level, in ATR */
  distanceAtr: number;
  distancePct: number;
  /** 0-100, from the checks that passed */
  momentum: number;
  grade: "A" | "B" | "C" | null;
  /** true only in the states where a defined entry actually exists */
  actionable: boolean;
  checks: BosCheck[];
  trade: BosTrade | null;
  headline: string;
  narrative: string[];
  caveats: string[];
}

/** Human-readable meaning of each state, used by the scanner UI. */
export const BOS_STATE_LABEL: Record<BosState, string> = {
  forming: "Pressing the level",
  fresh_break: "Just broke",
  retest_pending: "Waiting for the retest",
  retesting: "Retesting now",
  retest_held: "Retest held",
  retest_failed: "Retest failed",
  extended: "Extended — geometry gone",
  stale: "Stale",
};

export const BOS_STATE_NOTE: Record<BosState, string> = {
  forming:
    "Price is pressing a swing level it has not closed through. Nothing has broken yet — this is the watchlist state, and roughly half of these never break at all.",
  fresh_break:
    "The break happened on the last closed bar. There is no risk-defining structure above or below it yet, so an entry here is a bet that the retest never comes.",
  retest_pending:
    "Broken and gone. The level is the reference for a return, but price is not there yet — nothing to do until it comes back or the move leaves without it.",
  retesting:
    "Price is at the broken level right now. This is the decision bar: it either holds and the break is confirmed, or it trades through and the break was a trap.",
  retest_held:
    "Came back to the broken level, held it, and turned away. The one state where the level is both close enough to stop against and proven enough to lean on.",
  retest_failed:
    "Came back and traded through. The break did not hold, which makes the level a failure point rather than support — and failed breaks tend to run hard the other way, because everyone positioned for the break is now offside.",
  extended:
    "Ran without ever retesting. The break may have been real and the trade is still gone: the only entries left are far from any level that could define a stop.",
  stale:
    "Old enough that it is context rather than momentum. The level still matters as structure; the break is no longer an event.",
};

function atr(candles: Candle[], period = 14): number {
  if (candles.length < 2) return 0;
  const slice = candles.slice(-Math.min(period + 1, candles.length));
  let sum = 0;
  let n = 0;
  for (let i = 1; i < slice.length; i++) {
    const c = slice[i];
    const prev = slice[i - 1];
    sum += Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
    n++;
  }
  return n > 0 ? sum / n : 0;
}

function mean(values: number[]): number {
  return values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

const EMPTY = (symbol: string, timeframe: string, price: number): BosMomentumSetup => ({
  symbol,
  timeframe,
  found: false,
  direction: null,
  state: "stale",
  level: 0,
  brokenSwingTime: 0,
  breakTime: 0,
  barsSinceBreak: 0,
  price,
  distanceAtr: 0,
  distancePct: 0,
  momentum: 0,
  grade: null,
  actionable: false,
  checks: [],
  trade: null,
  headline: "No break of structure in the recent window.",
  narrative: [],
  caveats: [],
});

/**
 * Read the most recent break of structure and where it is in its life.
 *
 * Pure and synchronous. The forming state is derived rather than detected: it
 * is what a chart looks like when the nearest swing has *not* been broken, and
 * reporting it costs nothing while being the only state that gives any warning.
 */
export function detectBosMomentum(
  symbol: string,
  timeframe: string,
  candles: Candle[]
): BosMomentumSetup {
  const price = candles[candles.length - 1]?.close ?? 0;
  if (candles.length < CONTEXT + 20) return EMPTY(symbol, timeframe, price);

  const structure = analyzeMarketStructure(candles);
  const range = atr(candles);
  if (range <= 0) return EMPTY(symbol, timeframe, price);

  const last = candles[candles.length - 1];
  const events = structure.events.filter((e) => e.scope === "external");
  const event = events[events.length - 1];

  if (!event) return forming(symbol, timeframe, candles, structure.swings, range);

  const breakIndex = candles.findIndex((c) => c.time === event.time);
  if (breakIndex < 1) return forming(symbol, timeframe, candles, structure.swings, range);

  const barsSinceBreak = candles.length - 1 - breakIndex;
  if (barsSinceBreak > STALE_BARS) {
    const stale = forming(symbol, timeframe, candles, structure.swings, range);
    return {
      ...stale,
      state: "stale",
      headline: `Last break of structure was ${barsSinceBreak} bars ago — context, not momentum.`,
    };
  }

  const bullish = event.direction === "bullish";
  const level = event.price;
  const breakBar = candles[breakIndex];
  const context = candles.slice(Math.max(0, breakIndex - CONTEXT), breakIndex);
  const meanVolume = mean(context.map((c) => c.volume));
  const meanRange = mean(context.map((c) => c.high - c.low));

  /* ---------------- the checks ---------------- */
  const checks: BosCheck[] = [];

  const displacement = Math.abs(breakBar.close - level) / range;
  checks.push({
    key: "displacement",
    label: "Closed clear of the level",
    found: displacement >= MIN_DISPLACEMENT_ATR,
    detail: `Break bar closed ${displacement.toFixed(2)} ATR beyond ${level.toFixed(6).replace(/0+$/, "")}. A break that closes on the level is a touch, not a break.`,
    weight: 22,
  });

  const volumeX = meanVolume > 0 ? breakBar.volume / meanVolume : 0;
  checks.push({
    key: "volume",
    label: "Volume behind the break",
    found: volumeX >= MIN_VOLUME_X,
    detail: `${volumeX.toFixed(2)}× the previous ${context.length} bars' average. Structure taken out on below-average volume is price drifting through a level nobody was defending.`,
    weight: 18,
  });

  const barRange = breakBar.high - breakBar.low;
  const expansion = meanRange > 0 ? barRange / meanRange : 0;
  checks.push({
    key: "expansion",
    label: "Range expanded",
    found: expansion >= 1.3,
    detail: `Break bar range was ${expansion.toFixed(2)}× normal. Displacement is the signature of one side being in a hurry; a normal-sized bar through a level is not displacement.`,
    weight: 14,
  });

  const taker = breakBar.takerBuyVolume;
  const delta = taker != null ? taker - (breakBar.volume - taker) : null;
  const deltaAgrees = delta == null ? null : bullish ? delta > 0 : delta < 0;
  checks.push({
    key: "delta",
    label: "Aggressive flow agreed",
    found: deltaAgrees === true,
    detail:
      delta == null
        ? "No taker breakdown on this bar, so the flow behind the break could not be checked."
        : deltaAgrees
          ? `Net taker delta ${delta > 0 ? "+" : ""}${delta.toFixed(0)} — the side that broke the level was also the side crossing the spread.`
          : `Net taker delta ${delta > 0 ? "+" : ""}${delta.toFixed(0)}, against the break. The level gave way while the aggression was on the other side, which is what absorption into a break looks like.`,
    weight: 16,
  });

  const closeStrength =
    barRange > 0
      ? bullish
        ? (breakBar.close - breakBar.low) / barRange
        : (breakBar.high - breakBar.close) / barRange
      : 0;
  checks.push({
    key: "close",
    label: "Closed at the extreme",
    found: closeStrength >= 0.6,
    detail: `Closed ${(closeStrength * 100).toFixed(0)}% toward the ${bullish ? "high" : "low"} of its own range. A break bar with a long wick back is the level rejecting, not yielding.`,
    weight: 12,
  });

  const after = candles.slice(breakIndex + 1);
  const reclaimed = after.some((c) => (bullish ? c.close < level : c.close > level));
  checks.push({
    key: "no-reclaim",
    label: "Level not reclaimed",
    found: !reclaimed,
    detail: reclaimed
      ? "Price has closed back through the level since the break. Whatever happened on the break bar, the market did not accept it."
      : "No close back through the level since the break.",
    weight: 18,
  });

  const passed = checks.filter((c) => c.found);
  const momentum = Math.min(100, passed.reduce((s, c) => s + c.weight, 0));
  const grade: "A" | "B" | "C" = momentum >= 78 ? "A" : momentum >= QUALIFY_SCORE ? "B" : "C";

  /* ---------------- the state ---------------- */
  const distance = bullish ? price - level : level - price;
  const distanceAtr = distance / range;
  const atLevel = Math.abs(distance) <= RETEST_BAND_ATR * range;

  // Did price come back to the level at any point after the break?
  let touchedIndex = -1;
  for (let i = breakIndex + 1; i < candles.length; i++) {
    const c = candles[i];
    const touched = bullish ? c.low <= level + RETEST_BAND_ATR * range : c.high >= level - RETEST_BAND_ATR * range;
    if (touched) {
      touchedIndex = i;
      break;
    }
  }

  let state: BosState;
  if (reclaimed) {
    state = "retest_failed";
  } else if (barsSinceBreak === 0) {
    state = "fresh_break";
  } else if (atLevel) {
    state = "retesting";
  } else if (touchedIndex >= 0 && candles.length - 1 - touchedIndex >= HELD_BARS) {
    state = "retest_held";
  } else if (distanceAtr > EXTENDED_ATR) {
    state = "extended";
  } else {
    state = "retest_pending";
  }

  /* ---------------- the trade ---------------- */
  const swingBefore = priorSwing(structure.swings, event, bullish);
  const trade = buildTrade({ state, bullish, level, price, range, swingBefore, momentum });

  const caveats: string[] = [];
  if (delta == null) caveats.push("No taker breakdown on the break bar, so the flow check was skipped rather than passed.");
  if (barsSinceBreak === 0) {
    caveats.push(
      "The break bar is the most recent closed bar. Everything downstream of it — the retest, the hold — has not happened yet and cannot be scored."
    );
  }
  if (!swingBefore) {
    caveats.push("No prior swing to anchor a stop against, so the stop is placed off ATR instead of off structure.");
  }
  caveats.push(
    "Momentum scores the break, not the outcome. A high score says the break had size, flow and follow-through behind it — plenty of those still fail."
  );

  return {
    symbol,
    timeframe,
    found: true,
    direction: bullish ? "bullish" : "bearish",
    state,
    level,
    brokenSwingTime: event.brokenSwingTime,
    breakTime: event.time,
    barsSinceBreak,
    price,
    distanceAtr: Number(distanceAtr.toFixed(2)),
    distancePct: level !== 0 ? Number(((distance / level) * 100).toFixed(2)) : 0,
    momentum,
    grade,
    actionable: state === "retesting" || state === "retest_held" || state === "retest_pending",
    checks,
    trade,
    headline: `${bullish ? "Bullish" : "Bearish"} BOS through ${level.toFixed(6).replace(/0+$/, "")} — ${BOS_STATE_LABEL[state].toLowerCase()}, momentum ${momentum}/100.`,
    narrative: [
      `${bullish ? "Broke above" : "Broke below"} the swing at ${level.toFixed(6).replace(/0+$/, "")}, ${barsSinceBreak === 0 ? "on the last closed bar" : `${barsSinceBreak} bars ago`}.`,
      `${passed.length} of ${checks.length} momentum checks passed.`,
      BOS_STATE_NOTE[state],
    ],
    caveats,
  };
}

/** The swing on the other side of the break, to anchor a stop against. */
function priorSwing(swings: SwingPoint[], event: StructureEvent, bullish: boolean): SwingPoint | null {
  const wanted = bullish ? "low" : "high";
  const before = swings.filter((s) => s.kind === wanted && s.time < event.time);
  return before.length > 0 ? before[before.length - 1] : null;
}

/**
 * Geometry per state.
 *
 * The entry is a limit at the broken level in every state that has one, never
 * the current price. Chasing a break is the mistake this whole engine exists
 * to avoid, and an entry that price may never return to is honest about that:
 * it either fills at a sensible price or it does not fill, which is a better
 * outcome than filling at a bad one.
 */
function buildTrade(o: {
  state: BosState;
  bullish: boolean;
  level: number;
  price: number;
  range: number;
  swingBefore: SwingPoint | null;
  momentum: number;
}): BosTrade | null {
  // States with no defined entry say so rather than inventing one.
  if (o.state === "forming" || o.state === "stale" || o.state === "extended" || o.state === "retest_failed") {
    return null;
  }
  if (o.momentum < QUALIFY_SCORE) return null;

  const side: "BUY" | "SELL" = o.bullish ? "BUY" : "SELL";
  const entry = o.level;
  const anchor = o.swingBefore?.price;
  // Structure first, ATR as the fallback — and a floor either way, so a stop
  // never lands inside the noise of the level it is protecting.
  const raw = anchor ?? (o.bullish ? o.level - o.range * 1.2 : o.level + o.range * 1.2);
  const minGap = o.range * 0.6;
  const stopLoss = o.bullish
    ? Math.min(raw, entry - minGap)
    : Math.max(raw, entry + minGap);

  const risk = Math.abs(entry - stopLoss);
  if (risk <= 0) return null;
  const tp1 = o.bullish ? entry + risk * 1.5 : entry - risk * 1.5;
  const tp2 = o.bullish ? entry + risk * 3 : entry - risk * 3;

  return {
    side,
    entry: Number(entry.toFixed(8)),
    stopLoss: Number(stopLoss.toFixed(8)),
    tp1: Number(tp1.toFixed(8)),
    tp2: Number(tp2.toFixed(8)),
    riskReward: Number((Math.abs(tp2 - entry) / risk).toFixed(2)),
    note:
      o.state === "retest_pending"
        ? "A resting limit at the broken level. Price has not come back yet and may never — the order either fills where the geometry works or it does not fill."
        : "Entry at the broken level, stop beyond the swing that preceded the break.",
  };
}

/** The pre-break state: nearest unbroken swing, and how close price is to it. */
function forming(
  symbol: string,
  timeframe: string,
  candles: Candle[],
  swings: SwingPoint[],
  range: number
): BosMomentumSetup {
  const price = candles[candles.length - 1].close;
  const base = EMPTY(symbol, timeframe, price);

  const above = swings.filter((s) => s.kind === "high" && s.price > price);
  const below = swings.filter((s) => s.kind === "low" && s.price < price);
  const nearestHigh = above.length > 0 ? above.reduce((a, b) => (a.price < b.price ? a : b)) : null;
  const nearestLow = below.length > 0 ? below.reduce((a, b) => (a.price > b.price ? a : b)) : null;

  const upDist = nearestHigh ? (nearestHigh.price - price) / range : Infinity;
  const downDist = nearestLow ? (price - nearestLow.price) / range : Infinity;
  const target = upDist <= downDist ? nearestHigh : nearestLow;
  const dist = Math.min(upDist, downDist);
  if (!target || !Number.isFinite(dist) || dist > 1.5) return base;

  const bullish = target.kind === "high";
  return {
    ...base,
    found: false,
    direction: bullish ? "bullish" : "bearish",
    state: "forming",
    level: target.price,
    brokenSwingTime: target.time,
    distanceAtr: Number(dist.toFixed(2)),
    distancePct: Number((((target.price - price) / price) * 100).toFixed(2)),
    headline: `Pressing the swing ${bullish ? "high" : "low"} at ${target.price.toFixed(6).replace(/0+$/, "")} — ${dist.toFixed(2)} ATR away, not broken.`,
    narrative: [BOS_STATE_NOTE.forming],
    caveats: [
      "Nothing has broken. This is a watchlist entry, and a level being approached is not evidence that it gives way — a good share of these reject instead.",
    ],
  };
}
