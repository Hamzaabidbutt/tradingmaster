import { findSwings } from "./marketStructure";
import { Candle } from "./types";

/**
 * Price and cumulative delta pulling in opposite directions.
 *
 * Cumulative volume delta is the running total of who crossed the spread. When
 * price makes a higher high and CVD makes a lower one, the second push was
 * achieved on *less* net buying than the first: the buyers lifting the offer
 * are doing less work each time, and someone is selling into it passively.
 * That is distribution. The mirror — a lower low on rising CVD — is
 * accumulation.
 *
 * ## Why this draws two lines rather than printing a label
 *
 * The claim is about *slope*, and a slope is a comparison between two points.
 * A marker saying "divergence" asks to be believed; two lines — one through
 * the price pivots, one through the CVD readings at the same times — show the
 * thing itself, and let the reader see how far apart the slopes actually are.
 * A marginal divergence and a screaming one look completely different drawn
 * and identical labelled.
 *
 * ## What it is not
 *
 * Not a reversal signal, and the single most over-traded pattern in order flow
 * for exactly that reason. Divergences persist — a market can make higher
 * highs on falling delta for weeks — and plenty end by simply ceasing to
 * diverge rather than by turning. What a divergence buys you is a reason to
 * demand more evidence before trusting the move, not a reason to take the
 * other side of it.
 */

/** Swing lookback for the pivots the lines are drawn through. */
const PIVOT_LOOKBACK = 5;
/** Pivots closer than this in percent are the same level, not two. */
const MIN_PRICE_GAP_PCT = 0.25;
/** CVD must disagree by at least this share of its own range to count. */
const MIN_CVD_SHARE = 0.08;
/** Bars apart the two pivots must be, so a divergence spans real time. */
const MIN_BARS_APART = 4;
/** How far back to look for pivots. */
const WINDOW = 120;

export type DivergenceKind = "bearish" | "bullish";

export interface DivergencePoint {
  time: number;
  price: number;
  cvd: number;
}

export interface CvdDivergence {
  kind: DivergenceKind;
  /** the earlier pivot */
  from: DivergencePoint;
  /** the later pivot */
  to: DivergencePoint;
  /** price change between the pivots, percent */
  pricePct: number;
  /** cvd change between the pivots, as a share of the window's cvd range */
  cvdShare: number;
  barsApart: number;
  /** 0-100, from how cleanly the two slopes oppose */
  strength: number;
  label: string;
  note: string;
}

/**
 * Find the most recent price/CVD divergence on each side.
 *
 * Pure and synchronous. Returns at most one bearish and one bullish
 * divergence — the latest of each — because a chart with six overlapping
 * divergence lines on it is unreadable, and older ones have already been
 * answered by what price did next.
 *
 * `cvdSeries` is expected to be aligned to `candles` by time. Bars with no CVD
 * reading are skipped rather than interpolated: inventing a value to draw a
 * line through is inventing the evidence the line is supposed to show.
 */
export function findCvdDivergences(
  candles: Candle[],
  cvdSeries: { time: number; cvd: number }[]
): CvdDivergence[] {
  if (candles.length < 30 || cvdSeries.length < 10) return [];

  const window = candles.slice(-WINDOW);
  const cvdAt = new Map(cvdSeries.map((p) => [p.time, p.cvd]));

  // The CVD range over the window, so "how much CVD disagreed" is expressed
  // in units of what CVD actually does here rather than in raw contracts.
  const readings = window.map((c) => cvdAt.get(c.time)).filter((v): v is number => v != null);
  if (readings.length < 10) return [];
  const cvdRange = Math.max(...readings) - Math.min(...readings);
  if (cvdRange <= 0) return [];

  const highs = findSwings(window, PIVOT_LOOKBACK, "minor").filter((s) => s.kind === "high");
  const lows = findSwings(window, PIVOT_LOOKBACK, "minor").filter((s) => s.kind === "low");

  const out: CvdDivergence[] = [];

  for (const kind of ["bearish", "bullish"] as const) {
    const pivots = kind === "bearish" ? highs : lows;
    if (pivots.length < 2) continue;

    // Walk back from the most recent pivot looking for a partner that makes
    // the comparison meaningful: far enough apart in time and in price.
    const latest = pivots[pivots.length - 1];
    const latestCvd = cvdAt.get(latest.time);
    if (latestCvd == null) continue;

    for (let j = pivots.length - 2; j >= 0; j--) {
      const earlier = pivots[j];
      const earlierCvd = cvdAt.get(earlier.time);
      if (earlierCvd == null) continue;

      const barsApart = latest.index - earlier.index;
      if (barsApart < MIN_BARS_APART) continue;

      const pricePct =
        earlier.price !== 0 ? ((latest.price - earlier.price) / earlier.price) * 100 : 0;
      if (Math.abs(pricePct) < MIN_PRICE_GAP_PCT) continue;

      const cvdDelta = latestCvd - earlierCvd;
      const cvdShare = cvdDelta / cvdRange;

      // The divergence itself: price one way, CVD the other, both by enough
      // to be more than measurement noise.
      const diverges =
        kind === "bearish"
          ? pricePct > 0 && cvdShare <= -MIN_CVD_SHARE
          : pricePct < 0 && cvdShare >= MIN_CVD_SHARE;
      if (!diverges) continue;

      const strength = Math.round(
        Math.min(100, Math.min(50, Math.abs(pricePct) * 12) + Math.min(50, Math.abs(cvdShare) * 120))
      );

      out.push({
        kind,
        from: { time: earlier.time, price: earlier.price, cvd: earlierCvd },
        to: { time: latest.time, price: latest.price, cvd: latestCvd },
        pricePct: Number(pricePct.toFixed(2)),
        cvdShare: Number(cvdShare.toFixed(3)),
        barsApart,
        strength,
        label: kind === "bearish" ? "PRICE ↑ CVD ↓" : "PRICE ↓ CVD ↑",
        note:
          kind === "bearish"
            ? `Price made a higher high (+${pricePct.toFixed(2)}%) while cumulative delta made a lower one. The second push was achieved on less net buying than the first — buyers are doing more work for less, which is what someone selling into strength looks like from this side. It is a reason to want more before trusting the advance, not a short signal: divergences persist, and many end by simply ceasing to diverge.`
            : `Price made a lower low (${pricePct.toFixed(2)}%) while cumulative delta made a higher one. Sellers got less for more — someone was buying into the weakness passively. A reason to want more before trusting the decline, not a long signal on its own.`,
      });
      break; // one per side: the most recent, drawn against its best partner
    }
  }

  return out;
}
