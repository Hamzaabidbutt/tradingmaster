import { Candle, SwingPoint, Trendline } from "./types";

/**
 * Automatic trendlines, drawn the way they are worth drawing.
 *
 * Any two points define a line, which is why hand-drawn trendlines are the
 * most abused tool in technical analysis: with enough candles on screen you can
 * always find two highs to connect, and the line will look like it meant
 * something. It did not. A line through two points is a line through two
 * points.
 *
 * So this engine treats a two-point line as a *candidate* and nothing more.
 * A candidate becomes a trendline only if:
 *
 *  1. **Price respected it in between.** Every bar between the anchors has to
 *     stay on the correct side, within tolerance. A "resistance" line that
 *     price traded straight through on its way between the two anchors is not
 *     resistance, it is a line that happens to touch two highs.
 *  2. **Something else touched it.** At least one further bar has to come back
 *     to it. Two anchors and no third touch is the definition of a line fitted
 *     to noise, and the touch count is reported so the reader can weigh it.
 *
 * Tolerance is measured in ATR rather than percent, because the same 0.3% is a
 * precise touch on a quiet day and a mile away on a volatile one.
 *
 * ## What a trendline is not
 *
 * It is not a prediction, and a break of one is not a signal. What it is: a
 * record of where price has repeatedly turned, projected forward so you can see
 * where that would next happen if the behaviour continued. Whether it continues
 * is exactly what nobody knows. Broken lines are kept and marked rather than
 * deleted, because where a line failed is as informative as where it held.
 */

/** ATR lookback for the touch tolerance. */
const ATR_PERIOD = 14;
/** A bar counts as touching when it comes within this many ATR of the line. */
const TOUCH_ATR = 0.35;
/** A close beyond the line by more than this many ATR breaks it. */
const BREAK_ATR = 0.5;
/** Bars a candidate must span, so two adjacent swings do not make a trend. */
const MIN_SPAN_BARS = 12;
/** Touches required, anchors included. Three means one confirmation. */
const MIN_TOUCHES = 3;
/** How many lines to keep per side. */
const MAX_PER_SIDE = 3;
/** Lines whose projected price sits within this % of each other are duplicates. */
const DEDUPE_PCT = 0.6;
/**
 * Drop lines projecting further than this from price.
 *
 * A steep line anchored far back can still be technically valid — plenty of
 * touches, never violated between its anchors — while projecting to a price
 * the market left months ago. It is a true fact about old bars and useless as
 * a level: nobody is going to trade against a line 70% below spot, and drawing
 * it only costs the chart a line and the ranking a slot.
 */
const MAX_DISTANCE_PCT = 30;

function atr(candles: Candle[], period = ATR_PERIOD): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = Math.max(1, candles.length - period); i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1].close;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev)));
  }
  return trs.length > 0 ? trs.reduce((s, v) => s + v, 0) / trs.length : 0;
}

/** Price of the line at a given bar index. */
function priceAt(a: SwingPoint, b: SwingPoint, index: number): number {
  const span = b.index - a.index;
  if (span === 0) return a.price;
  return a.price + ((b.price - a.price) / span) * (index - a.index);
}

/**
 * Build trendlines from the swing points already detected by the structure
 * engine, rather than re-deriving pivots. Sharing the swings is the point:
 * a trendline drawn through different highs than the ones the structure panel
 * is talking about would quietly be describing a different chart.
 */
export function detectTrendlines(candles: Candle[], swings: SwingPoint[]): Trendline[] {
  if (candles.length < MIN_SPAN_BARS * 2 || swings.length < 2) return [];
  const unit = atr(candles);
  if (unit <= 0) return [];
  const touchTol = unit * TOUCH_ATR;
  const breakTol = unit * BREAK_ATR;
  const lastIdx = candles.length - 1;
  const price = candles[lastIdx].close;

  const out: Trendline[] = [];

  for (const kind of ["resistance", "support"] as const) {
    const wantHigh = kind === "resistance";
    const pts = swings.filter((s) => (wantHigh ? s.kind === "high" : s.kind === "low"));
    const found: Trendline[] = [];

    for (let i = 0; i < pts.length - 1; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const a = pts[i];
        const b = pts[j];
        if (b.index - a.index < MIN_SPAN_BARS) continue;
        // A rising resistance line and a falling support line are both
        // legitimate (channels), so slope direction is not constrained here.

        /* 1. Respected between the anchors. */
        let respected = true;
        for (let k = a.index + 1; k < b.index; k++) {
          const line = priceAt(a, b, k);
          const beyond = wantHigh ? candles[k].high - line : line - candles[k].low;
          if (beyond > touchTol) {
            respected = false;
            break;
          }
        }
        if (!respected) continue;

        /* 2. Touches, across the whole series. */
        const touchTimes: number[] = [];
        for (let k = a.index; k <= lastIdx; k++) {
          const line = priceAt(a, b, k);
          const gap = wantHigh
            ? Math.abs(candles[k].high - line)
            : Math.abs(candles[k].low - line);
          if (gap <= touchTol) touchTimes.push(candles[k].time);
        }
        if (touchTimes.length < MIN_TOUCHES) continue;

        /* 3. Break — the first decisive close through, after the second
              anchor. Kept rather than discarded: a line that broke is still a
              fact about the chart, and where it broke often becomes the level
              that matters next. */
        let brokenTime: number | null = null;
        for (let k = b.index + 1; k <= lastIdx; k++) {
          const line = priceAt(a, b, k);
          const beyond = wantHigh ? candles[k].close - line : line - candles[k].close;
          if (beyond > breakTol) {
            brokenTime = candles[k].time;
            break;
          }
        }

        const projected = priceAt(a, b, lastIdx);
        if (!Number.isFinite(projected) || projected <= 0) continue;
        if (Math.abs((projected - price) / price) * 100 > MAX_DISTANCE_PCT) continue;

        found.push({
          id: `${kind}-${a.time}-${b.time}`,
          kind,
          from: { time: a.time, price: a.price, index: a.index },
          to: { time: b.time, price: b.price, index: b.index },
          slopePerBar: (b.price - a.price) / (b.index - a.index),
          touches: touchTimes.length,
          touchTimes,
          broken: brokenTime != null,
          brokenTime,
          projectedPrice: projected,
          distancePct: Number((((projected - price) / price) * 100).toFixed(3)),
          // Touches are the evidence; an unbroken line and a recent second
          // anchor both add to how live the line is. Deliberately simple —
          // a more elaborate score would imply a precision this does not have.
          strength: Math.round(
            Math.min(100, touchTimes.length * 18) *
              (brokenTime == null ? 1 : 0.45) *
              (1 - Math.min(0.4, (lastIdx - b.index) / (candles.length * 2)))
          ),
        });
      }
    }

    /* Dedupe: many anchor pairs describe the same line. Keep the strongest of
       each cluster, comparing where they sit *now* and how they are sloped —
       two lines converging on today's price from different angles are
       different lines and both are kept. */
    found.sort((a, b) => b.strength - a.strength || b.touches - a.touches);
    const kept: Trendline[] = [];
    for (const line of found) {
      const duplicate = kept.some((k) => {
        const near =
          Math.abs(k.projectedPrice - line.projectedPrice) / Math.max(1e-9, line.projectedPrice) <
          DEDUPE_PCT / 100;
        const sameSlope =
          Math.abs(k.slopePerBar - line.slopePerBar) <= Math.abs(line.slopePerBar) * 0.25 + unit * 0.02;
        return near && sameSlope;
      });
      if (!duplicate) kept.push(line);
      if (kept.length >= MAX_PER_SIDE) break;
    }
    out.push(...kept);
  }

  return out.sort((a, b) => b.strength - a.strength);
}
