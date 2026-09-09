import { ema } from "./indicators";
import { analyzeMarketStructure } from "./marketStructure";
import { Bias, Candle } from "./types";

/**
 * The same market, read on several clocks at once.
 *
 * Most losing trades are higher-timeframe conflicts. A setup can be flawless
 * on a 15m chart and still be a short into a daily uptrend, and nothing on the
 * 15m chart says so — the information is simply not on it. The ribbon exists
 * so that fact is one glance away rather than a scroll and a timeframe switch,
 * because a check that costs a context switch is a check that does not happen.
 *
 * ## Two facts per timeframe, deliberately
 *
 * Structure (the sequence of highs and lows) and trend (price against a slow
 * average). They disagree often, and that is the point: structure turns first
 * and the average turns last, so a timeframe where they disagree is one that
 * is mid-transition. Collapsing them to a single arrow would throw away the
 * only interesting state and report a confident direction for a chart that
 * does not have one.
 *
 * ## What it does not do
 *
 * No full analysis pass per timeframe. This reads candles and nothing else —
 * no order flow, no footprint, no volume profile. It is a *context* strip, and
 * treating it as a signal source would be reading four charts shallowly
 * instead of one properly.
 */

/** Bars needed before a timeframe is worth reading at all. */
const MIN_BARS = 60;
/** The slow average. Long enough that it is not just restating structure. */
const TREND_EMA = 50;
/** Within this share of the average, price is on it rather than either side. */
const FLAT_BAND_PCT = 0.4;

export interface TimeframeRead {
  timeframe: string;
  /** the swing sequence: HH/HL vs LH/LL */
  structure: Bias;
  /** price against the slow average */
  trend: Bias;
  /** both facts agreeing is the only state that reads as a clean direction */
  aligned: boolean;
  /** distance from the slow average, percent — signed */
  distancePct: number;
  bars: number;
  note: string;
}

export interface AlignmentReport {
  reads: TimeframeRead[];
  /** timeframes whose two facts agree and point the same way as each other */
  consensus: Bias;
  /** how many timeframes point each way, over those with a clean direction */
  bullish: number;
  bearish: number;
  unclear: number;
  headline: string;
  note: string;
}

/** Read one timeframe. Returns null when there is not enough history. */
export function readTimeframe(timeframe: string, candles: Candle[]): TimeframeRead | null {
  if (candles.length < MIN_BARS) return null;

  const structureResult = analyzeMarketStructure(candles);
  const closes = candles.map((c) => c.close);
  const line = ema(closes, TREND_EMA);
  const avg = line[line.length - 1];
  const price = closes[closes.length - 1];

  let trend: Bias = "neutral";
  let distancePct = 0;
  if (avg != null && avg > 0) {
    distancePct = ((price - avg) / avg) * 100;
    // A flat band, because price crossing and re-crossing an average by a
    // hundredth of a percent is not a change of trend and should not flicker
    // the ribbon on every tick.
    if (Math.abs(distancePct) >= FLAT_BAND_PCT) {
      trend = distancePct > 0 ? "bullish" : "bearish";
    }
  }

  const structure = structureResult.trend;
  const aligned = structure === trend && structure !== "neutral";

  return {
    timeframe,
    structure,
    trend,
    aligned,
    distancePct: Number(distancePct.toFixed(2)),
    bars: candles.length,
    note: aligned
      ? `Structure and the ${TREND_EMA}-period average both read ${structure}.`
      : structure === "neutral" || trend === "neutral"
        ? `No clean direction: structure is ${structure}, price is ${Math.abs(distancePct) < FLAT_BAND_PCT ? "sitting on" : distancePct > 0 ? "above" : "below"} the average.`
        : `Structure reads ${structure} while price is ${distancePct > 0 ? "above" : "below"} the average — mid-transition. Structure turns first and the average turns last, so this is one of them having already moved.`,
  };
}

/**
 * Read several timeframes and say whether they agree.
 *
 * Pure and synchronous. Timeframes with too little history are dropped rather
 * than counted as neutral: a missing read and a genuinely directionless chart
 * are different things, and averaging the first into the second would let a
 * failed fetch quietly vote.
 */
export function readAlignment(series: { timeframe: string; candles: Candle[] }[]): AlignmentReport {
  const reads = series
    .map((s) => readTimeframe(s.timeframe, s.candles))
    .filter((r): r is TimeframeRead => r !== null);

  const bullish = reads.filter((r) => r.aligned && r.structure === "bullish").length;
  const bearish = reads.filter((r) => r.aligned && r.structure === "bearish").length;
  const unclear = reads.length - bullish - bearish;

  const consensus: Bias =
    bullish > 0 && bearish === 0 ? "bullish" : bearish > 0 && bullish === 0 ? "bearish" : "neutral";

  let headline: string;
  if (reads.length === 0) {
    headline = "No timeframe has enough history to read.";
  } else if (bullish > 0 && bearish > 0) {
    headline = `Timeframes disagree — ${bullish} bullish, ${bearish} bearish, ${unclear} unclear.`;
  } else if (consensus === "neutral") {
    headline = `No timeframe shows a clean direction (${unclear} of ${reads.length} unclear).`;
  } else {
    headline = `${bullish + bearish} of ${reads.length} timeframes read ${consensus}${unclear > 0 ? `, ${unclear} unclear` : ""}.`;
  }

  return {
    reads,
    consensus,
    bullish,
    bearish,
    unclear,
    headline,
    note:
      bullish > 0 && bearish > 0
        ? "Disagreement between timeframes is not a signal to fade the smaller one — it is a reason to size for the fact that the larger one can reassert itself at any point."
        : "Alignment is context, not an entry. Every timeframe agreeing says the trade is not fighting a higher clock; it says nothing about location or timing.",
  };
}
