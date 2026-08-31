import { analyzeDelta } from "./deltaAnalysis";
import { analyzeMarketStructure } from "./marketStructure";
import { detectSupportResistance } from "./supportResistance";
import { Candle, RecoveryEvidence, RecoveryEpisode, RecoverySetup } from "./types";

/**
 * Deep-drawdown recovery scanner — coins a long way down that are being bought.
 *
 * The premise is sound and the temptation attached to it is dangerous, so both
 * are worth stating plainly.
 *
 * **Sound:** an asset 90% below its high needs a 10x to get back, and the
 * people who buy the bottom of a multi-year decline do not buy it in a day.
 * They accumulate through a base, and that leaves the same traces as any other
 * accumulation — volume drying up into the low, higher lows forming, delta
 * refusing to follow price down, supply exhausting.
 *
 * **Dangerous:** the base rate is brutal. Most assets 90% down go to 95% down.
 * A scanner that ranked by drawdown alone would be a list of things still
 * falling, and dressing that up as opportunity is how people lose money
 * enthusiastically. So drawdown here is a *filter*, never a score: it decides
 * what is eligible, and the evidence decides what ranks.
 *
 * ## What this can and cannot tell you
 *
 * It can tell you: how far down this is, how long it has been building a base,
 * whether the decline has stopped accelerating, whether structure has turned,
 * whether volume and delta look like accumulation rather than capitulation,
 * and what **this specific coin** did after previous comparable episodes.
 *
 * It cannot tell you that any of these will multiply. Nothing in price history
 * supports that claim, and the arithmetic in `upside` is exactly that —
 * arithmetic. "Returning to the window high would be 8.4x" is a fact about two
 * numbers; it is not a forecast, a target, or a probability, and the engine
 * never presents it as one.
 *
 * ## "All-time" high, honestly
 *
 * This measures from the highest price in the **loaded window** — up to about
 * four years of daily futures candles. That is not the asset's all-time high:
 * the spot market usually predates the perpetual listing, sometimes by years,
 * and for a coin whose real peak came before its futures listing the true
 * drawdown is deeper than anything measurable here. `windowDays` is reported
 * on every result so the figure can be read for what it is.
 */

/** Minimum drawdown from the window high to be eligible at all. */
const MIN_DRAWDOWN_PCT = 70;
/** Bars needed before the measurements mean anything. */
const MIN_HISTORY = 200;
/** A close within this % of the window low counts as "at the base". */
const BASE_BAND_PCT = 25;
/** Bars used to judge whether the decline has stopped accelerating. */
const SLOPE_WINDOW = 60;
const QUALIFY_SCORE = 60;
const QUALIFY_KINDS = 4;

function pct(a: number, b: number): number {
  return b === 0 ? 0 : ((a - b) / b) * 100;
}

function slope(values: number[]): number {
  // Least-squares gradient, normalised by the mean so it compares across
  // coins at wildly different prices.
  const n = values.length;
  if (n < 2) return 0;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((s, v) => s + v, 0) / n;
  if (meanY === 0) return 0;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (values[i] - meanY);
    den += (i - meanX) ** 2;
  }
  return den === 0 ? 0 : (num / den / meanY) * 100;
}

/**
 * Previous episodes where this coin was as deep in drawdown as it is now, and
 * what happened over the following year.
 *
 * This is the part that answers "how did it behave last time" with something
 * other than a story. Each episode is a real stretch of this coin's own
 * history; the forward return is measured, not modelled. Sample sizes are
 * tiny by construction — a coin has only had a handful of such episodes — so
 * the aggregate is reported with its count attached and never as a rate.
 */
function findEpisodes(candles: Candle[], currentDrawdown: number): RecoveryEpisode[] {
  const out: RecoveryEpisode[] = [];
  const forward = 365;
  let runningHigh = candles[0].high;
  let inEpisode = false;
  let episodeStart = 0;

  for (let i = 1; i < candles.length; i++) {
    runningHigh = Math.max(runningHigh, candles[i].high);
    const dd = -pct(candles[i].close, runningHigh);

    // Entering: as deep as we are now, measured against the high that stood at
    // the time rather than today's — otherwise every early bar looks shallow.
    if (!inEpisode && dd >= currentDrawdown - 5) {
      inEpisode = true;
      episodeStart = i;
      continue;
    }
    // Leaving: recovered meaningfully off that low, so the episode is over and
    // its outcome can be measured.
    if (inEpisode && dd < currentDrawdown - 20) {
      inEpisode = false;
      const endIdx = Math.min(i + forward, candles.length - 1);
      if (episodeStart + 30 > candles.length - 1) continue;
      const entry = candles[episodeStart].close;
      const window = candles.slice(episodeStart, endIdx + 1);
      const peak = Math.max(...window.map((c) => c.high));
      const trough = Math.min(...window.map((c) => c.low));
      out.push({
        startTime: candles[episodeStart].time,
        endTime: candles[endIdx].time,
        drawdownPct: Number(dd.toFixed(1)),
        // Best and worst the position would have seen, which is the honest
        // pair — a 4x peak that first halved is not the same trade as a
        // steady 4x, and one number cannot say which happened.
        peakGainPct: Number(pct(peak, entry).toFixed(1)),
        worstDrawdownPct: Number(pct(trough, entry).toFixed(1)),
        barsToPeak: window.findIndex((c) => c.high === peak),
      });
    }
  }
  return out.slice(-6);
}

export function detectRecovery(
  symbol: string,
  candles: Candle[],
  openInterest?: number[] | null
): RecoverySetup {
  const price = candles[candles.length - 1]?.close ?? 0;
  const empty: RecoverySetup = {
    symbol,
    price,
    windowDays: candles.length,
    windowHigh: 0,
    windowLow: 0,
    drawdownPct: 0,
    offLowPct: 0,
    baseDays: 0,
    eligible: false,
    evidence: [],
    score: 0,
    qualified: false,
    grade: "none",
    upside: { toWindowHigh: 0, toHalfway: 0, nextSupply: null },
    episodes: [],
    invalidation: null,
    headline: "Not enough history",
    explanation: ["This contract has too little daily history to measure a drawdown against."],
  };
  if (candles.length < MIN_HISTORY || price <= 0) return empty;

  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const windowHigh = Math.max(...highs);
  const windowLow = Math.min(...lows);
  const drawdownPct = -pct(price, windowHigh);
  const offLowPct = pct(price, windowLow);

  if (drawdownPct < MIN_DRAWDOWN_PCT) {
    return {
      ...empty,
      windowHigh,
      windowLow,
      drawdownPct: Number(drawdownPct.toFixed(1)),
      offLowPct: Number(offLowPct.toFixed(1)),
      headline: `Down ${drawdownPct.toFixed(0)}% — not deep enough to be a recovery candidate`,
      explanation: [
        `This scanner only considers contracts at least ${MIN_DRAWDOWN_PCT}% below the highest price in the loaded window. At ${drawdownPct.toFixed(0)}% this one is in an ordinary correction, not the kind of decline the checklist is built to read.`,
      ],
    };
  }

  /* ---- Measurements ---- */
  const baseBand = windowLow * (1 + BASE_BAND_PCT / 100);
  // Consecutive recent days spent inside the band above the low: a base is a
  // long stay, not a single touch.
  let baseDays = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].close <= baseBand) baseDays++;
    else break;
  }

  const structure = analyzeMarketStructure(candles);
  const delta = analyzeDelta(candles);
  const srLevels = detectSupportResistance(candles, "1d");

  const recent = candles.slice(-SLOPE_WINDOW);
  const earlier = candles.slice(-SLOPE_WINDOW * 2, -SLOPE_WINDOW);
  const recentSlope = slope(recent.map((c) => c.close));
  const earlierSlope = slope(earlier.map((c) => c.close));

  const evidence: RecoveryEvidence[] = [];

  /* 1. A base rather than a falling knife. */
  const based = baseDays >= 30;
  evidence.push({
    key: "base",
    label: "Extended base at the low",
    found: based,
    weight: 18,
    score: based ? Math.min(18, 8 + Math.floor(baseDays / 20)) : 0,
    detail: based
      ? `${baseDays} consecutive days inside ${BASE_BAND_PCT}% of the window low. Size cannot be accumulated in a falling market — it needs a period where price stops going down and supply can be absorbed at a level. That is what a base is, and this one has lasted ${baseDays} days.`
      : `Only ${baseDays} days inside ${BASE_BAND_PCT}% of the low. Without a base this is a decline in progress, and buying a decline in progress is the single most expensive mistake this scanner exists to avoid.`,
  });

  /* 2. The decline has stopped accelerating. */
  const decelerating = recentSlope > earlierSlope;
  evidence.push({
    key: "deceleration",
    label: "Decline has stopped accelerating",
    found: decelerating && recentSlope > -0.5,
    weight: 14,
    score: decelerating ? (recentSlope > 0 ? 14 : recentSlope > -0.5 ? 9 : 4) : 0,
    detail: `Trend gradient over the last ${SLOPE_WINDOW} days is ${recentSlope.toFixed(2)}% per day against ${earlierSlope.toFixed(2)}% over the ${SLOPE_WINDOW} before it. ${
      decelerating
        ? recentSlope > 0
          ? "The decline has not merely slowed, it has turned."
          : "Still falling, but more slowly — the first thing that changes when selling runs out."
        : "Still accelerating downward, which is the opposite of exhaustion."
    }`,
  });

  /* 3. Structure turning: higher lows off the bottom. */
  const hl = structure.swings.filter((s) => s.label === "HL").length;
  const hh = structure.swings.filter((s) => s.label === "HH").length;
  const turning = hl >= 2;
  evidence.push({
    key: "structure",
    label: "Higher lows forming",
    found: turning,
    weight: 14,
    score: turning ? (hh >= 1 ? 14 : 9) : 0,
    detail: turning
      ? `${hl} higher low${hl > 1 ? "s" : ""}${hh > 0 ? ` and ${hh} higher high${hh > 1 ? "s" : ""}` : ""} in the recent swings. A higher low is the visible half of absorption: sellers got a worse price than last time and stopped earlier.`
      : `No higher-low sequence yet (${hl} HL, ${hh} HH). Price is still making its lows in the same place or lower, so nothing in structure says the selling has finished.`,
  });

  /* 4. Volume drying up into the low. */
  const lateVol = candles.slice(-60).reduce((s, c) => s + c.volume, 0) / 60;
  const midVol = candles.slice(-240, -60).reduce((s, c) => s + c.volume, 0) / 180;
  const dryingUp = midVol > 0 && lateVol < midVol * 0.8;
  evidence.push({
    key: "volume_dryup",
    label: "Volume dried up into the low",
    found: dryingUp,
    weight: 12,
    score: dryingUp ? Math.min(12, 6 + (1 - lateVol / midVol) * 20) : 0,
    detail:
      midVol <= 0
        ? "No usable volume history to compare against."
        : dryingUp
          ? `Recent volume is ${((lateVol / midVol) * 100).toFixed(0)}% of the prior period's. Sellers exhausting themselves shows up as declining volume on the way down — there is nobody left who wants out at these prices.`
          : `Recent volume is ${((lateVol / midVol) * 100).toFixed(0)}% of the prior period's, so selling pressure has not visibly dried up.`,
  });

  /* 5. Delta divergence: price down, buying not following. */
  const bullDiv = delta.divergences.filter((d) => d.kind.includes("bullish"));
  evidence.push({
    key: "divergence",
    label: "Bullish delta divergence",
    found: bullDiv.length > 0,
    weight: 12,
    score: bullDiv.length > 0 ? Math.min(12, 6 + bullDiv.length * 3) : 0,
    detail:
      bullDiv.length > 0
        ? `${bullDiv.length} bullish divergence on the daily series: price made the lower low, cumulative delta did not. The selling that produced the low was not backed by aggression.`
        : "No bullish delta divergence on the daily series — cumulative delta has been confirming the lows rather than refusing them.",
  });

  /* 6. Reclaimed a long moving average. */
  const ma200 = candles.slice(-200).reduce((s, c) => s + c.close, 0) / 200;
  const ma50 = candles.slice(-50).reduce((s, c) => s + c.close, 0) / 50;
  const reclaimed = price > ma50;
  evidence.push({
    key: "reclaim",
    label: "Reclaimed the 50-day average",
    found: reclaimed,
    weight: 10,
    score: reclaimed ? (price > ma200 ? 10 : 7) : 0,
    detail: reclaimed
      ? `Price is above its 50-day average${price > ma200 ? " and its 200-day" : " though still below the 200-day"}. After a decline this long, trading back above the shorter average is the first mechanical sign the trend has changed rather than paused.`
      : `Price is still below its 50-day average. Nothing here has broken the downtrend yet.`,
  });

  /* 7. Open interest building while price is flat. */
  let oiChangePct: number | null = null;
  if (openInterest && openInterest.length >= 4) {
    const first = openInterest[0];
    const last = openInterest[openInterest.length - 1];
    oiChangePct = first > 0 ? ((last - first) / first) * 100 : 0;
  }
  const oiBuilding = oiChangePct != null && oiChangePct > 5;
  evidence.push({
    key: "open_interest",
    label: "Open interest building at the base",
    found: oiBuilding,
    weight: 10,
    score: oiBuilding ? 10 : oiChangePct == null ? 0 : oiChangePct > 0 ? 4 : 0,
    detail:
      oiChangePct == null
        ? "No open-interest history available for this contract."
        : oiBuilding
          ? `Open interest is up ${oiChangePct.toFixed(1)}% while price has been based. Positions are being opened down here, not closed — someone is choosing to carry risk at these prices.`
          : `Open interest is ${oiChangePct >= 0 ? "up" : "down"} ${Math.abs(oiChangePct).toFixed(1)}%, so there is no meaningful build-up of positions at the base.`,
  });

  const rawScore = evidence.reduce((s, e) => s + e.score, 0);
  const score = Math.round(Math.max(0, Math.min(100, rawScore)));
  const kinds = evidence.filter((e) => e.found).length;
  const qualified = score >= QUALIFY_SCORE && kinds >= QUALIFY_KINDS && based;
  const grade: RecoverySetup["grade"] = qualified
    ? score >= 80
      ? "prime"
      : "strong"
    : score >= 35
      ? "forming"
      : "none";

  /* ---- Arithmetic, labelled as arithmetic ---- */
  const nextSupply =
    srLevels
      .filter((l) => l.kind === "resistance" && l.price > price)
      .sort((a, b) => a.price - b.price)[0]?.price ?? null;
  const upside = {
    toWindowHigh: Number((windowHigh / price).toFixed(2)),
    toHalfway: Number(((price + (windowHigh - price) / 2) / price).toFixed(2)),
    nextSupply,
  };

  const episodes = findEpisodes(candles, drawdownPct);
  // The base itself is the thesis; losing it ends the thesis.
  const invalidation = windowLow;

  const headline = qualified
    ? `${grade === "prime" ? "Prime" : "Strong"} recovery base — ${drawdownPct.toFixed(0)}% down, ${baseDays} days based, ${kinds}/${evidence.length} signs`
    : !based
      ? `${drawdownPct.toFixed(0)}% down but no base yet — a decline in progress`
      : `${drawdownPct.toFixed(0)}% down, ${kinds}/${evidence.length} signs — below the bar`;

  const explanation: string[] = [
    headline,
    `Down ${drawdownPct.toFixed(1)}% from ${windowHigh.toFixed(6).replace(/0+$/, "")}, and ${offLowPct.toFixed(1)}% up off the window low. Measured over ${candles.length} daily candles — the highest price *in that window*, which is not necessarily this asset's all-time high, because spot usually trades long before the perpetual is listed.`,
    `What this says: the decline is deep, and ${kinds} of ${evidence.length} accumulation signs are present. What it does not say is that price will recover. Most assets this far down go further down; the base rate for deep-drawdown recovery is poor, and no amount of evidence on one chart changes it.`,
    `The arithmetic, which is not a target: returning to the window high would be ${upside.toWindowHigh}× from here, and halfway back ${upside.toHalfway}×. Those are facts about two prices. Whether the market goes there is a different question this engine does not answer.`,
    `Invalidation is the window low at ${invalidation.toFixed(6).replace(/0+$/, "")} — below it the base has failed and the thesis with it.`,
  ];
  for (const e of evidence) if (e.found) explanation.push(`✓ ${e.label}: ${e.detail}`);
  for (const e of evidence) if (!e.found) explanation.push(`✗ ${e.label}: ${e.detail}`);

  if (episodes.length > 0) {
    const peaks = episodes.map((e) => e.peakGainPct);
    const median = [...peaks].sort((a, b) => a - b)[Math.floor(peaks.length / 2)];
    explanation.push(
      `This coin has been this deep ${episodes.length} time${episodes.length > 1 ? "s" : ""} before in the loaded window. Median best-case gain in the year after: ${median.toFixed(0)}%, with the worst drawdown along the way reaching ${Math.min(...episodes.map((e) => e.worstDrawdownPct)).toFixed(0)}%. ${episodes.length < 3 ? "Far too few cases to be a rate — they are listed so you can look at them individually rather than trust an average of two." : "Still a small sample from one coin's history, and the peak is the best price it ever traded, not an exit anyone actually got."}`
    );
  } else {
    explanation.push(
      "No previous episode this deep in the loaded window, so there is no precedent from this coin's own history to compare against."
    );
  }

  return {
    symbol,
    price,
    windowDays: candles.length,
    windowHigh,
    windowLow,
    drawdownPct: Number(drawdownPct.toFixed(1)),
    offLowPct: Number(offLowPct.toFixed(1)),
    baseDays,
    eligible: true,
    evidence,
    score,
    qualified,
    grade,
    upside,
    episodes,
    invalidation,
    headline,
    explanation,
  };
}
