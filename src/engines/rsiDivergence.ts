import { findSwings } from "./marketStructure";
import { Candle } from "./types";

/**
 * Price and RSI pulling in opposite directions.
 *
 * RSI is the ratio of average gain to average loss over a lookback — a
 * measure of how one-sided recent closes have been. When price makes a higher
 * high and RSI makes a lower one, the second push came on weaker momentum than
 * the first: the same ground was covered with less conviction behind it.
 *
 * ## Regular and hidden are different claims
 *
 * Both are reported, and the distinction matters more than the name suggests:
 *
 * - **Regular** — price higher high, RSI lower high (or the mirror). The
 *   classic reversal reading: the move is running out of fuel.
 * - **Hidden** — price *lower* high, RSI *higher* high (or the mirror). Read
 *   as continuation: the pullback came on stronger momentum than the last one,
 *   which is what a healthy trend correction looks like.
 *
 * They point opposite ways from the same machinery, so collapsing them into
 * one "divergence" label would produce a list where half the rows mean the
 * reverse of the other half.
 *
 * ## What this is not
 *
 * Not a reversal signal. Divergence is the single most over-traded pattern in
 * technical analysis, and the reason is that it *looks* predictive while being
 * one of the least reliable things on a chart. Markets make higher highs on
 * falling RSI for weeks at a time, and plenty of divergences end by simply
 * ceasing to diverge rather than by turning. In a strong trend RSI diverges
 * almost continuously, which is exactly when acting on it is most expensive.
 *
 * What a divergence buys you is a reason to demand more evidence before
 * trusting a move — not a reason to take the other side of it.
 */

/** Wilder's default, and the one every chart package draws. */
export const RSI_PERIOD = 14;
/** Swing lookback for the pivots the comparison is drawn between. */
const PIVOT_LOOKBACK = 5;
/** Pivots closer than this in percent are the same level, not two. */
const MIN_PRICE_GAP_PCT = 0.25;
/** RSI must disagree by at least this many points to count as disagreeing. */
const MIN_RSI_GAP = 3;
/** Bars apart the two pivots must be, so a divergence spans real time. */
const MIN_BARS_APART = 4;
/** How far back to look for pivots. */
const WINDOW = 120;

export type RsiDivergenceKind =
  /** price higher high, RSI lower high — momentum failing into strength */
  | "regular_bearish"
  /** price lower low, RSI higher low — selling losing force */
  | "regular_bullish"
  /** price lower high, RSI higher high — read as downtrend continuation */
  | "hidden_bearish"
  /** price higher low, RSI lower low — read as uptrend continuation */
  | "hidden_bullish";

export const RSI_DIVERGENCE_LABEL: Record<RsiDivergenceKind, string> = {
  regular_bearish: "Regular bearish",
  regular_bullish: "Regular bullish",
  hidden_bearish: "Hidden bearish",
  hidden_bullish: "Hidden bullish",
};

export const RSI_DIVERGENCE_NOTE: Record<RsiDivergenceKind, string> = {
  regular_bearish:
    "A higher high on lower RSI: the second push covered more ground with less one-sided buying behind it. Read as momentum failing, not as a top.",
  regular_bullish:
    "A lower low on higher RSI: the second flush went further on less one-sided selling. Read as selling losing force, not as a bottom.",
  hidden_bearish:
    "A lower high on higher RSI — the opposite shape, and read the opposite way. The bounce carried more momentum than the last one and still failed lower, which is what a downtrend's corrections look like.",
  hidden_bullish:
    "A higher low on lower RSI. The pullback was shallower in price than in momentum, which is the ordinary shape of a trend correction rather than a warning.",
};

/** true for the two kinds normally read as reversal rather than continuation. */
export function isRegular(kind: RsiDivergenceKind): boolean {
  return kind === "regular_bearish" || kind === "regular_bullish";
}

/** The side a reader would take if they acted on it. */
export function sideOf(kind: RsiDivergenceKind): "long" | "short" {
  return kind === "regular_bullish" || kind === "hidden_bullish" ? "long" : "short";
}

export interface RsiPoint {
  time: number;
  price: number;
  rsi: number;
}

export interface RsiDivergence {
  kind: RsiDivergenceKind;
  /** the earlier pivot */
  from: RsiPoint;
  /** the later pivot — what "most recent" is measured by */
  to: RsiPoint;
  /** price change between the pivots, percent */
  pricePct: number;
  /** RSI change between the pivots, in RSI points */
  rsiDelta: number;
  barsApart: number;
  /** 0-100, from how cleanly the two slopes oppose */
  strength: number;
  label: string;
  note: string;
}

/**
 * Wilder's RSI, aligned index-for-index with `candles`.
 *
 * `null` until there are enough closes to compute one — deliberately, rather
 * than seeding with a partial average. A smoothed indicator that starts from a
 * made-up value disagrees with every chart package for the first fifty bars,
 * and the disagreement is invisible unless you go looking for it.
 */
export function computeRsi(candles: Candle[], period = RSI_PERIOD): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = candles[i].close - candles[i - 1].close;
    if (change >= 0) gains += change;
    else losses -= change;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  /* A window with no down closes has an average loss of zero, which makes RS
     infinite. 100 is the correct limit and the value every chart draws; a
     division guard that returns 50 instead would quietly report a runaway
     rally as neutral. */
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    // Wilder's smoothing, not a simple moving average of the last `period`.
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function strengthOf(pricePct: number, rsiDelta: number, barsApart: number): number {
  /* Saturating rather than clipped, the same shape the other engines use: a
     clipped ratio gives every strong reading the same 100 and throws away the
     ordering exactly where a ranking matters most. */
  const price = Math.abs(pricePct);
  const rsi = Math.abs(rsiDelta);
  const span = Math.min(1, barsApart / 30);
  const p = price / (price + 1.5);
  const r = rsi / (rsi + 8);
  return Math.round(100 * (0.45 * p + 0.45 * r + 0.1 * span));
}

/**
 * The most recent divergence of each kind, or an empty list.
 *
 * Pure and synchronous. At most one of each kind, because a list holding six
 * overlapping divergences on one symbol is six ways of saying the same thing,
 * and the older ones have already been answered by whatever price did next.
 */
export function findRsiDivergences(candles: Candle[], period = RSI_PERIOD): RsiDivergence[] {
  if (candles.length < Math.max(30, period + PIVOT_LOOKBACK * 2 + 2)) return [];

  const rsi = computeRsi(candles, period);
  const offset = Math.max(0, candles.length - WINDOW);
  const window = candles.slice(offset);
  const swings = findSwings(window, PIVOT_LOOKBACK, "minor");

  const pointAt = (index: number): RsiPoint | null => {
    const abs = offset + index;
    const value = rsi[abs];
    if (value == null) return null;
    return { time: candles[abs].time, price: candles[abs].close, rsi: value };
  };

  const out: RsiDivergence[] = [];

  const consider = (
    kind: RsiDivergenceKind,
    a: RsiPoint,
    b: RsiPoint,
    barsApart: number,
    priceOk: boolean,
    rsiOk: boolean
  ) => {
    if (!priceOk || !rsiOk) return;
    if (barsApart < MIN_BARS_APART) return;
    const pricePct = ((b.price - a.price) / a.price) * 100;
    const rsiDelta = b.rsi - a.rsi;
    if (Math.abs(pricePct) < MIN_PRICE_GAP_PCT) return;
    if (Math.abs(rsiDelta) < MIN_RSI_GAP) return;
    out.push({
      kind,
      from: a,
      to: b,
      pricePct,
      rsiDelta,
      barsApart,
      strength: strengthOf(pricePct, rsiDelta, barsApart),
      label: RSI_DIVERGENCE_LABEL[kind],
      note: RSI_DIVERGENCE_NOTE[kind],
    });
  };

  /* Only the last two pivots of each side are compared. Reaching further back
     for a pair that happens to diverge is how a divergence scanner finds one
     on literally every chart — with enough pivots, some pair always
     disagrees. */
  const highs = swings.filter((s) => s.kind === "high").slice(-2);
  const lows = swings.filter((s) => s.kind === "low").slice(-2);

  if (highs.length === 2) {
    const a = pointAt(highs[0].index);
    const b = pointAt(highs[1].index);
    /* Counted from the pivot indices, not from the timestamps. Dividing the
       time gap by the interval is right only where the series has no gaps, and
       a halted or newly-listed contract has plenty. */
    const apart = highs[1].index - highs[0].index;
    if (a && b) {
      consider("regular_bearish", a, b, apart, b.price > a.price, b.rsi < a.rsi);
      consider("hidden_bearish", a, b, apart, b.price < a.price, b.rsi > a.rsi);
    }
  }
  if (lows.length === 2) {
    const a = pointAt(lows[0].index);
    const b = pointAt(lows[1].index);
    const apart = lows[1].index - lows[0].index;
    if (a && b) {
      consider("regular_bullish", a, b, apart, b.price < a.price, b.rsi > a.rsi);
      consider("hidden_bullish", a, b, apart, b.price > a.price, b.rsi < a.rsi);
    }
  }

  // Newest first, which is the order a scanner wants and a chart does not care.
  return out.sort((x, y) => y.to.time - x.to.time);
}
