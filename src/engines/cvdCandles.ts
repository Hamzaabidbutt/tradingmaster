import { BarExcursion, Candle } from "./types";

/**
 * Cumulative delta drawn as candles rather than as a line.
 *
 * A CVD line answers one question — is net aggression rising or falling — and
 * throws away the rest. Plotting the same series as candles keeps three more
 * facts per bar that the line collapses:
 *
 *  - **The body** is the bar's net delta: where the CVD opened and where it
 *    closed. A line shows only the close.
 *  - **The wicks** are how far the CVD travelled *inside* the bar. A long upper
 *    wick on a small body is buyers pressing and being handed back — the line
 *    draws that as a gentle rise, which is the opposite of what happened.
 *  - **The shape** can then be read the way price candles are read. A CVD doji
 *    after a run of large bodies is the aggression running out, and it looks
 *    like a doji.
 *
 * The most useful pattern this exposes is the one a line structurally cannot:
 * CVD candles making higher highs while *price* candles do not, or a CVD bar
 * whose wick dwarfs its body. Both are absorption, and both are invisible on a
 * line.
 *
 * ## Where the wicks come from, and when there are none
 *
 * A wick is a statement about the path the CVD took inside the bar, and a path
 * cannot be recovered from a bar's net total. When an intrabar reconstruction
 * is supplied — the same one `deltaExcursion` builds from lower-timeframe
 * candles — the wicks are real. When it is not, the high and low collapse onto
 * the body, and that is reported rather than hidden: those bars are drawn
 * wickless because the true range is *unknown and at least this large*, not
 * because the CVD happened to move in a straight line.
 *
 * Inventing plausible wicks there would be worse than having none. The whole
 * reason to draw this as candles is the wicks, so a fabricated one would be
 * fabricating the signal.
 */

export interface CvdCandle {
  time: number;
  /** cumulative delta before this bar traded */
  open: number;
  high: number;
  low: number;
  /** cumulative delta after this bar */
  close: number;
  /** the bar's own net delta — close minus open */
  delta: number;
  /** true when high and low came from a real intrabar path */
  wicked: boolean;
}

export type CvdFidelity = "sub_bar" | "bar" | "mixed";

export interface CvdCandleSeries {
  candles: CvdCandle[];
  /** how many bars carry real wicks */
  wickedBars: number;
  fidelity: CvdFidelity;
  headline: string;
  caveats: string[];
}

const EMPTY: CvdCandleSeries = {
  candles: [],
  wickedBars: 0,
  fidelity: "bar",
  headline: "No candles to build a cumulative delta series from.",
  caveats: [],
};

/**
 * Taker buy volume, clamped into the bar's own total.
 *
 * Real Binance fixtures carry bars whose taker-buy figure exceeds the volume
 * that produced it; unclamped, one of those drags the whole cumulative series
 * off by more than the rest of the window puts back.
 */
function buyOf(c: Candle): number {
  const raw = c.takerBuyVolume ?? c.volume / 2;
  return Math.min(Math.max(raw, 0), c.volume);
}

/**
 * Build the CVD candle series.
 *
 * Pure and synchronous. `excursions` is optional — without it every bar is
 * wickless and the result says so.
 *
 * The cumulative running total is always accumulated from the *candles*, never
 * from the excursions, because the two are built from different sources and
 * only one of them covers the whole window. Mixing them would leave a step in
 * the series wherever the excursion window began. The excursion contributes
 * the wicks alone.
 */
export function buildCvdCandles(
  candles: Candle[],
  excursions?: BarExcursion[] | null
): CvdCandleSeries {
  if (candles.length === 0) return EMPTY;

  const paths = new Map<number, BarExcursion>();
  for (const e of excursions ?? []) paths.set(e.time, e);

  const out: CvdCandle[] = [];
  let running = 0;
  let wickedBars = 0;
  let haveTaker = false;

  for (const c of candles) {
    if (c.takerBuyVolume != null) haveTaker = true;
    const buy = buyOf(c);
    const delta = buy - (c.volume - buy);
    const open = running;
    const close = open + delta;
    running = close;

    const path = paths.get(c.time);
    /* The wick must always contain the body. The running total comes from the
       candles and the excursion from a sub-series, so the two can disagree by
       a rounding's worth — and a candle whose high sits below its close is not
       a coarser candle, it is an invalid one that the chart library rejects. */
    const high = path ? Math.max(open + path.maxDelta, open, close) : Math.max(open, close);
    const low = path ? Math.min(open + path.minDelta, open, close) : Math.min(open, close);
    if (path) wickedBars++;

    out.push({
      time: c.time,
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(close.toFixed(2)),
      delta: Number(delta.toFixed(2)),
      wicked: path != null,
    });
  }

  const fidelity: CvdFidelity =
    wickedBars === 0 ? "bar" : wickedBars === out.length ? "sub_bar" : "mixed";

  const caveats: string[] = [];
  if (!haveTaker) {
    caveats.push(
      "No taker breakdown on these candles, so each bar's delta is a half-and-half split of its volume. The series is a placeholder, not a measurement."
    );
  }
  if (fidelity !== "sub_bar") {
    caveats.push(
      fidelity === "bar"
        ? "No intrabar reconstruction supplied, so every bar is drawn wickless. That is not a claim the delta moved in a straight line inside the bar — it is that the path is unknown, and the true range is at least the body."
        : `${out.length - wickedBars} of ${out.length} bars have no intrabar reconstruction and are drawn wickless. Their true range is unknown and at least the body.`
    );
  }
  caveats.push(
    "Cumulative delta starts at zero on the first bar of this window, so the level is relative to where you are looking. Only the shape and the direction carry meaning across windows."
  );

  const last = out[out.length - 1];
  return {
    candles: out,
    wickedBars,
    fidelity,
    headline: `Cumulative delta ${last.close >= 0 ? "+" : ""}${last.close.toFixed(0)} over ${out.length} bars, last bar ${last.delta >= 0 ? "+" : ""}${last.delta.toFixed(0)}.`,
    caveats,
  };
}

/**
 * Bars whose CVD wick dwarfs its body.
 *
 * The pattern the line cannot draw: aggression pressed hard inside the bar and
 * finished with almost none of it. Only meaningful on bars that actually have
 * a reconstructed path, so wickless ones are skipped rather than counted as
 * having no rejection — absence of a wick here means absence of data.
 */
export interface CvdRejection {
  time: number;
  side: "upper" | "lower";
  /** wick length against the body, as a multiple */
  ratio: number;
  note: string;
}

/** A wick this many times the body before it is worth marking. */
const REJECTION_X = 2;
/** Bodies below this share of the window's typical body are too small to divide by. */
const MIN_BODY_SHARE = 0.1;

export function findCvdRejections(series: CvdCandleSeries): CvdRejection[] {
  const wicked = series.candles.filter((c) => c.wicked);
  if (wicked.length < 5) return [];

  const bodies = wicked.map((c) => Math.abs(c.close - c.open)).sort((a, b) => a - b);
  const typicalBody = bodies[Math.floor(bodies.length / 2)];
  if (typicalBody <= 0) return [];
  const floor = typicalBody * MIN_BODY_SHARE;

  const out: CvdRejection[] = [];
  for (const c of wicked) {
    const body = Math.abs(c.close - c.open);
    // A near-zero body makes every wick infinitely large. Measured against the
    // window's typical body so the guard scales with the market.
    const denom = Math.max(body, floor);
    const upper = c.high - Math.max(c.open, c.close);
    const lower = Math.min(c.open, c.close) - c.low;

    if (upper >= denom * REJECTION_X && upper >= lower) {
      out.push({
        time: c.time,
        side: "upper",
        ratio: Number((upper / denom).toFixed(2)),
        note: `Cumulative delta ran ${upper.toFixed(0)} above where the bar closed it — buyers pressed and kept almost none of it. A line would draw this stretch as a gentle rise.`,
      });
    } else if (lower >= denom * REJECTION_X && lower > upper) {
      out.push({
        time: c.time,
        side: "lower",
        ratio: Number((lower / denom).toFixed(2)),
        note: `Cumulative delta ran ${lower.toFixed(0)} below where the bar closed it — sellers pressed and kept almost none of it.`,
      });
    }
  }
  return out;
}
