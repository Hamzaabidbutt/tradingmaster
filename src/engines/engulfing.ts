import { analyzeDelta } from "./deltaAnalysis";
import { analyzeMarketStructure } from "./marketStructure";
import { detectSupportResistance } from "./supportResistance";
import { Candle, EngulfingSetup } from "./types";

/**
 * Bullish engulfing detector.
 *
 * The pattern itself is trivial arithmetic — a bar whose body swallows the
 * previous bar's — and on its own it is close to worthless: on any given day a
 * few hundred perpetuals will print one. What separates a tradable engulfing
 * from noise is everything around it, so this scores four things the raw
 * pattern does not know about:
 *
 *   * **How completely** it engulfs. Covering the previous body is the
 *     definition; covering its whole range, wicks included, is a different
 *     event and much rarer.
 *   * **Whether flow agrees.** A bullish engulfing printed on net selling is
 *     a bar that closed up because the previous seller stopped, not because
 *     buyers arrived.
 *   * **Where it happened.** At a defended support it is a reversal; in open
 *     space mid-trend it is a continuation bar wearing the same shape.
 *   * **What it engulfed.** Swallowing a large, decisive bar means taking out
 *     everyone who sold it. Swallowing a doji means very little.
 *
 * `qualified` therefore requires more than the shape. A scanner that returned
 * every engulfing bar would return hundreds and be ignored, which is the same
 * as returning none.
 */

const QUALIFY_SCORE = 62;

function fmt(v: number): string {
  return v.toFixed(v >= 1000 ? 2 : v >= 1 ? 4 : 6).replace(/0+$/, "").replace(/\.$/, "");
}

export function detectBullishEngulfing(
  symbol: string,
  timeframe: string,
  candles: Candle[]
): EngulfingSetup {
  const price = candles[candles.length - 1]?.close ?? 0;
  const empty: EngulfingSetup = {
    symbol,
    timeframe,
    price,
    engulfed: false,
    time: 0,
    barsAgo: -1,
    bodyRatio: 0,
    fullRange: false,
    deltaConfirms: false,
    delta: 0,
    atSupport: false,
    trend: "neutral",
    score: 0,
    qualified: false,
    grade: "none",
    entry: null,
    invalidation: null,
    target: null,
    headline: "No bullish engulfing on the last closed bar",
    explanation: ["The most recently closed bar did not engulf the one before it."],
  };
  if (candles.length < 30 || price <= 0) {
    return { ...empty, headline: "Not enough history" };
  }

  // The *last closed* bar, not the forming one: an engulfing that has not
  // closed is not an engulfing, and half the value of the pattern is that the
  // close held.
  const current = candles[candles.length - 2];
  const previous = candles[candles.length - 3];
  if (!current || !previous) return empty;

  const currBody = Math.abs(current.close - current.open);
  const prevBody = Math.abs(previous.close - previous.open);
  const bullish = current.close > current.open;
  const prevBearish = previous.close < previous.open;

  // Textbook definition: a bullish bar whose body covers a bearish body.
  const engulfs =
    bullish && prevBearish && current.close >= previous.open && current.open <= previous.close;
  if (!engulfs || prevBody <= 0) return empty;

  const bodyRatio = currBody / prevBody;
  const fullRange = current.high >= previous.high && current.low <= previous.low;

  const delta = analyzeDelta(candles);
  const barDelta = delta.series.find((d) => d.time === current.time)?.delta ?? 0;
  const deltaConfirms = barDelta > 0;

  const structure = analyzeMarketStructure(candles);
  const srLevels = detectSupportResistance(candles, timeframe);
  const support = srLevels
    .filter((l) => l.kind === "support")
    .find((l) => Math.abs(current.low - l.price) / Math.max(l.price, 1e-9) < 0.01);
  const atSupport = Boolean(support);

  /* ---- Scoring ---- */
  let score = 24; // the pattern itself, and no more than that
  score += Math.min(18, (bodyRatio - 1) * 12);
  if (fullRange) score += 14;
  if (deltaConfirms) score += 18;
  if (atSupport) score += 16;
  // A reversal bar means more against the prevailing move than with it.
  if (structure.trend === "bearish") score += 8;
  else if (structure.trend === "bullish") score += 4;
  score = Math.round(Math.max(0, Math.min(100, score)));

  const qualified = score >= QUALIFY_SCORE && deltaConfirms;
  const grade: EngulfingSetup["grade"] = qualified
    ? score >= 82
      ? "prime"
      : "strong"
    : score >= 45
      ? "forming"
      : "none";

  const invalidation = current.low;
  const resistance = srLevels
    .filter((l) => l.kind === "resistance" && l.price > price)
    .sort((a, b) => a.price - b.price)[0];
  const risk = Math.abs(price - invalidation);
  const target = resistance?.price ?? (risk > 0 ? price + risk * 2 : null);

  const barsAgo = 1;
  const headline = qualified
    ? `${grade === "prime" ? "Prime" : "Strong"} bullish engulfing at ${fmt(current.close)}${atSupport ? " on support" : ""}`
    : `Bullish engulfing, score ${score} below the ${QUALIFY_SCORE} threshold${!deltaConfirms ? " — delta did not confirm" : ""}`;

  const explanation: string[] = [
    headline,
    `The bar closed at ${fmt(current.close)}, covering the previous body from ${fmt(previous.open)} down to ${fmt(previous.close)} — ${bodyRatio.toFixed(1)}× its size.${fullRange ? " It also took out the previous bar's full range, wicks included, which is the stronger form." : " It covers the body but not the full range."}`,
    deltaConfirms
      ? `Taker delta on the bar is +${barDelta.toFixed(0)} — buyers were the aggressors, so the close reflects buying rather than merely the absence of selling.`
      : `Taker delta on the bar is ${barDelta.toFixed(0)}, so the bar closed up on net *selling*. That is a bar the previous seller stopped pressing, not one buyers took — the shape is there and the flow behind it is not.`,
    atSupport && support
      ? `The low sits on mapped support at ${fmt(support.price)} (strength ${support.strength}, ${support.touches} touches) — an engulfing at a level is a different event from one in open space.`
      : "No mapped support under the bar's low, so this is an engulfing in open space — the pattern without the location.",
    `Structure is ${structure.trend}; ${structure.trend === "bearish" ? "a bullish engulfing against it is a reversal attempt" : structure.trend === "bullish" ? "this runs with the trend, so it is continuation rather than reversal" : "there is no trend for it to argue with"}.`,
    `Invalidation is the bar's own low at ${fmt(invalidation)} — below that the engulfing has been undone.${target != null ? ` First objective ${fmt(target)}${resistance ? " (nearest mapped resistance)" : " (2R, nothing mapped above)"}.` : ""}`,
  ];

  return {
    symbol,
    timeframe,
    price,
    engulfed: true,
    time: current.time,
    barsAgo,
    bodyRatio: Number(bodyRatio.toFixed(2)),
    fullRange,
    deltaConfirms,
    delta: Number(barDelta.toFixed(2)),
    atSupport,
    trend: structure.trend,
    score,
    qualified,
    grade,
    entry: current.close,
    invalidation,
    target,
    headline,
    explanation,
  };
}
