import { analyzeMarketStructure } from "./marketStructure";
import { Bias, Candle, MarketRegime } from "./types";

/**
 * The market's own weather, read off BTC.
 *
 * Every alt perpetual in this universe carries substantial BTC beta — during
 * trends the correlation runs 0.7–0.9 — so a long setup on an alt is partly a
 * long on BTC whether the setup knows it or not. Two identical footprints, one
 * printed while BTC was grinding up and one while it was breaking down, are not
 * the same trade and do not have the same base rate.
 *
 * Untagged, that difference is invisible in the aggregate. A source can look
 * mediocre overall while being genuinely good in one regime and actively bad in
 * the other, and no amount of staring at a blended win rate will separate them.
 * This module exists so that separation is a `groupBy` rather than a research
 * project.
 *
 * ## What it deliberately does not do
 *
 * It does not *gate* signals. Nothing here blocks a setup for being born in the
 * wrong weather, because that would assume the answer — the whole point is to
 * measure whether regime matters and by how much, on this app's own signals.
 * Filtering first and measuring later would make the measurement circular: you
 * would only ever see outcomes from the regime you already believed in.
 *
 * Once enough signals have resolved in each regime, the data can justify a
 * gate. Until then this is a label, not a rule.
 */

/** Bars of BTC history the read is drawn from. */
export const REGIME_BARS = 200;
/** Lookback for the trend-context moving average. */
const MA_PERIOD = 50;
/** ATR lookback, and the window its percentile is measured against. */
const ATR_PERIOD = 14;
const ATR_CONTEXT = 100;
/**
 * Move over the MA window that counts as a direction on its own, when the
 * swing detector has abstained. Deliberately large: this is a fallback for
 * unmistakable trends, not a second opinion on ambiguous ones.
 */
const DECISIVE_MOVE_PCT = 8;

function atrSeries(candles: Candle[], period: number): number[] {
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    trs.push(
      Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose))
    );
  }
  const out: number[] = [];
  for (let i = period - 1; i < trs.length; i++) {
    const slice = trs.slice(i - period + 1, i + 1);
    out.push(slice.reduce((s, v) => s + v, 0) / period);
  }
  return out;
}

/**
 * Read the regime from a BTC candle series.
 *
 * Pure and synchronous, like every other engine here, so it is testable
 * without a network and usable from a backtest that wants to reconstruct the
 * regime a historical signal was born into.
 */
export function readMarketRegime(candles: Candle[], timeframe = "4h"): MarketRegime {
  const unknown: MarketRegime = {
    trend: "neutral",
    label: "unknown",
    timeframe,
    changePct: 0,
    aboveMa: false,
    volatility: "normal",
    atrPct: 0,
    atrPercentile: 50,
    bars: candles.length,
    summary: "No BTC history available, so the regime this signal was born into is unknown.",
  };
  if (candles.length < MA_PERIOD + 5) return unknown;

  const price = candles[candles.length - 1].close;
  const structure = analyzeMarketStructure(candles);
  const trend: Bias = structure.trend;

  const ma =
    candles.slice(-MA_PERIOD).reduce((s, c) => s + c.close, 0) / MA_PERIOD;
  const aboveMa = price > ma;

  const first = candles[Math.max(0, candles.length - MA_PERIOD)].close;
  const changePct = first > 0 ? ((price - first) / first) * 100 : 0;

  const atrs = atrSeries(candles.slice(-Math.min(ATR_CONTEXT, candles.length)), ATR_PERIOD);
  const atr = atrs[atrs.length - 1] ?? 0;
  const atrPct = price > 0 ? (atr / price) * 100 : 0;
  // Percentile against its own recent history rather than an absolute
  // threshold: "volatile" means volatile *for BTC lately*, and an absolute
  // number would read every quiet month as calm and every active one as
  // extreme.
  const sorted = [...atrs].sort((a, b) => a - b);
  const rank = sorted.findIndex((v) => v >= atr);
  const atrPercentile =
    sorted.length > 1 ? Math.round(((rank < 0 ? sorted.length - 1 : rank) / (sorted.length - 1)) * 100) : 50;
  const volatility: MarketRegime["volatility"] =
    atrPercentile >= 75 ? "elevated" : atrPercentile <= 25 ? "calm" : "normal";

  /* The label is deliberately coarser than the inputs. Three buckets is what a
     per-regime win rate can actually be measured across without the sample
     splitting into slices of two.

     Structure is the primary read, but it cannot be the only one. The swing
     detector is a fractal and needs pivots to work with, so a smooth,
     low-noise trend — exactly the kind that matters most here — can leave it
     reporting `neutral` while price has moved 40%. Labelling that "mixed"
     would file unambiguously risk-off signals in the wrong bucket and quietly
     poison the comparison this whole feature exists for.

     So direction is confirmed by *either* structure or an unambiguous move,
     and location has a veto in both cases: a big rally that has since dropped
     below its average is not risk-on. */
  const decisiveMove = Math.abs(changePct) >= DECISIVE_MOVE_PCT;
  const label: MarketRegime["label"] =
    aboveMa && (trend === "bullish" || (decisiveMove && changePct > 0))
      ? "risk_on"
      : !aboveMa && (trend === "bearish" || (decisiveMove && changePct < 0))
        ? "risk_off"
        : "mixed";

  const summary =
    `BTC ${timeframe} structure is ${trend}, price ${aboveMa ? "above" : "below"} its ${MA_PERIOD}-bar average ` +
    `(${changePct >= 0 ? "+" : ""}${changePct.toFixed(1)}% over that span), volatility ${volatility} ` +
    `(ATR ${atrPct.toFixed(2)}% of price, ${atrPercentile}th percentile). ` +
    (label === "risk_on"
      ? "Alt longs have the market behind them here; alt shorts are fighting it."
      : label === "risk_off"
        ? "Alt longs are fighting the market here — the same setup that works in an uptrend has a different base rate in this one."
        : "Trend and location disagree, so the market is not clearly behind either side.");

  return {
    trend,
    label,
    timeframe,
    changePct: Number(changePct.toFixed(2)),
    aboveMa,
    volatility,
    atrPct: Number(atrPct.toFixed(3)),
    atrPercentile,
    bars: candles.length,
    summary,
  };
}
