import { ema } from "./indicators";
import { Bias, Candle, LiquidationDeltaPoint } from "./types";

/**
 * Bars where the trend's own followers got taken out.
 *
 * A downtrend liquidating longs is unremarkable — that is the trend working,
 * and it happens on most bars of every decline. What is worth marking is the
 * opposite: a *downtrend* liquidating **shorts**, or an *uptrend* liquidating
 * **longs**. In both cases the people forced out were the ones positioned
 * correctly, and they were removed by a move against the direction they were
 * right about.
 *
 * That is the shakeout, and it is one of the few genuinely asymmetric events
 * on a leveraged chart. It matters for two separate reasons:
 *
 *  1. **It clears the fuel.** A trend carrying a crowd of leveraged
 *     trend-followers has a stack of forced sellers (or buyers) sitting under
 *     it. Once they are gone, the move that flushed them has nothing left to
 *     feed on, and the trend can continue without that overhang.
 *
 *  2. **It is where trend-followers are worst positioned.** Everyone stopped
 *     out here was correct about direction and wrong about size — which is
 *     also the population most likely to re-enter, and to do it late.
 *
 * ## What it does not tell you
 *
 * Whether the trend resumes. A shakeout and the first leg of a genuine
 * reversal look identical while they are happening: both are a sharp move
 * against the trend that liquidates the crowd. The difference is only visible
 * afterwards, in whether price reclaims. Marking the bar says the trend's
 * followers were removed here; it does not say they were removed wrongly.
 */

/** Bars of context for the liquidation baseline. */
const CONTEXT = 40;
/** The trend filter. Long enough that a two-bar wobble is not a trend change. */
const TREND_EMA = 50;
/** Counter-trend forced volume must be this multiple of the trailing average. */
const SPIKE_X = 2;
/** ...and this share of the bar's total forced flow, so a two-sided bar is not one. */
const SIDE_SHARE = 0.65;
/** Price must be this far from the trend average for a trend to exist at all. */
const TREND_BAND_PCT = 0.5;
/** Above this multiple, the squeeze is not merely present but violent. */
const SEVERE_X = 5;

export interface SqueezeCandle {
  time: number;
  index: number;
  /** which side was forced out — the side that was *with* the trend */
  side: "shorts" | "longs";
  /** the prevailing trend the liquidated side was aligned with */
  trend: "up" | "down";
  /** forced volume on that side, in quote terms as supplied */
  volume: number;
  /** against the trailing average of the same side */
  multiple: number;
  /** that side's share of the bar's total forced flow, 0-1 */
  share: number;
  severe: boolean;
  /** did price close back in the trend's direction on this bar? */
  reclaimed: boolean;
  note: string;
}

/**
 * Find the bars where the trend's own side was liquidated.
 *
 * Pure and synchronous. Returns an empty list — never a guess — when there is
 * no trend to be counter to, when liquidation data is missing, or when the
 * series is too short for a baseline. A shakeout is defined relative to a
 * trend, so a market without one cannot have any.
 */
export function findSqueezeCandles(
  candles: Candle[],
  liquidations: LiquidationDeltaPoint[]
): SqueezeCandle[] {
  if (candles.length < CONTEXT + 5 || liquidations.length < CONTEXT + 5) return [];

  const closes = candles.map((c) => c.close);
  const trendLine = ema(closes, TREND_EMA);
  const byTime = new Map(liquidations.map((l) => [l.time, l]));

  const out: SqueezeCandle[] = [];

  for (let i = CONTEXT; i < candles.length; i++) {
    const c = candles[i];
    const point = byTime.get(c.time);
    if (!point) continue;

    const avg = trendLine[i];
    if (avg == null || avg <= 0) continue;
    const distPct = ((c.close - avg) / avg) * 100;
    // No trend, no counter-trend. Price sitting on its own average is not an
    // uptrend having a shakeout — it is a range, and every flush in a range
    // would qualify.
    if (Math.abs(distPct) < TREND_BAND_PCT) continue;
    const trend: "up" | "down" = distPct > 0 ? "up" : "down";

    /* The side that was aligned with the trend is the one worth marking when
       it gets forced out: shorts in a downtrend, longs in an uptrend. */
    const alignedSide: "shorts" | "longs" = trend === "down" ? "shorts" : "longs";
    const forced = alignedSide === "shorts" ? point.shortLiquidated : point.longLiquidated;
    if (forced <= 0) continue;

    const total = point.shortLiquidated + point.longLiquidated;
    const share = total > 0 ? forced / total : 0;
    // A bar that liquidated both sides roughly equally is volatility, not a
    // squeeze of one crowd.
    if (share < SIDE_SHARE) continue;

    const window = candles.slice(i - CONTEXT, i);
    let sum = 0;
    let n = 0;
    for (const w of window) {
      const p = byTime.get(w.time);
      if (!p) continue;
      sum += alignedSide === "shorts" ? p.shortLiquidated : p.longLiquidated;
      n++;
    }
    if (n < CONTEXT / 2) continue;
    const avgForced = sum / n;
    if (avgForced <= 0) continue;
    const multiple = forced / avgForced;
    if (multiple < SPIKE_X) continue;

    // Did the bar end back in the trend's favour? A shakeout that closes back
    // with the trend has already done its work; one that closes against it is
    // still open as a question.
    const reclaimed = trend === "up" ? c.close > c.open : c.close < c.open;

    out.push({
      time: c.time,
      index: i,
      side: alignedSide,
      trend,
      volume: Number(forced.toFixed(2)),
      multiple: Number(multiple.toFixed(2)),
      share: Number(share.toFixed(3)),
      severe: multiple >= SEVERE_X,
      reclaimed,
      note:
        `${multiple.toFixed(1)}× the usual forced ${alignedSide === "shorts" ? "short" : "long"} volume, in a${trend === "up" ? "n uptrend" : " downtrend"}. ` +
        `The side being stopped out is the one that was positioned *with* the trend — a shakeout, not the trend working. ` +
        (reclaimed
          ? "The bar closed back in the trend's direction, so the flush was absorbed within it."
          : "The bar closed against the trend, so whether this was a shakeout or the start of a turn is not yet answered.") +
        " A shakeout and the first leg of a real reversal look identical while they happen; only what price does afterwards separates them.",
    });
  }

  return out;
}
