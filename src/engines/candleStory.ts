import { CandleStats } from "./candleStats";
import { Candle, FullAnalysis } from "./types";

/**
 * The story of one candle, in sentences.
 *
 * The inspector already prints the numbers. Numbers are not a read: "delta
 * −44.7K, buy 21%" tells you sellers were the aggressors, but not that they
 * were aggressive *into a level that held*, which is the difference between a
 * breakdown and a trap. This assembles what the other engines already know
 * about that specific bar into an ordered account of it.
 *
 * Each line is tagged so the UI can colour and order them, and every line is
 * about *this* bar — no line is included unless the evidence for it names this
 * bar's timestamp or price. A story that quietly drifts into describing the
 * session as a whole is worse than no story, because it reads as specific.
 *
 * ## On "what happens next"
 *
 * The last section is deliberately titled *what to watch*, not *what will
 * happen*. It names the level that would confirm the read and the level that
 * would refute it, both of which are facts about the chart. It never states an
 * outcome or a probability of one — the same rule the rest of the platform
 * follows, and the one most easily lost in a narrative voice.
 */

export type StoryTone = "bull" | "bear" | "neutral" | "warn";

export interface StoryLine {
  /** grouping for the UI, in the order the sections are meant to read */
  section:
    | "aggression"
    | "wick"
    | "stops"
    | "absorption"
    | "divergence"
    | "forced"
    | "context"
    | "next";
  tone: StoryTone;
  text: string;
}

/** Bars either side of the inspected candle that still count as "at" it. */
const NEAR_BARS = 1;

function fmtSize(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${abs.toFixed(abs < 10 ? 2 : 0)}`;
}

function fmtPrice(v: number): string {
  return v.toFixed(v >= 1000 ? 2 : v >= 1 ? 4 : 6).replace(/0+$/, "").replace(/\.$/, "");
}

/** True when `time` is this bar or immediately adjacent to it. */
function nearBar(time: number, barTime: number, barSeconds: number): boolean {
  return Math.abs(time - barTime) <= barSeconds * NEAR_BARS;
}

/** Bars of prior range a sweep is measured against. */
const LOOKBACK = 20;

/**
 * Did this bar reach through a prior extreme and fail to hold it?
 *
 * That is what a stop hunt looks like from the outside: price trades past a
 * level where stop orders rest, those stops execute, and price closes back on
 * the other side — the move existed to reach the orders, not to go somewhere.
 *
 * The naming trips people up, so it is spelled out in the output. Stops
 * resting **above** the market are *buy* stops — short-sellers' protective
 * orders and breakout buy-stops — and triggering them forces *buying*.
 * Stops below are *sell* stops, and triggering them forces selling. So a
 * sweep of the highs is a buy-stop hunt that usually resolves lower, which
 * reads backwards until you follow the order types through.
 *
 * Requires a close back inside the prior range. Without that this is simply a
 * breakout, and calling every breakout a stop hunt is how the concept became
 * useless.
 */
function detectStopHunt(
  stats: CandleStats,
  candles: Candle[]
): { kind: "buy_stops" | "sell_stops"; text: string } | null {
  const index = candles.findIndex((c) => c.time === stats.time);
  if (index < 5) return null;
  const prior = candles.slice(Math.max(0, index - LOOKBACK), index);
  if (prior.length < 5) return null;

  const priorHigh = Math.max(...prior.map((c) => c.high));
  const priorLow = Math.min(...prior.map((c) => c.low));

  if (stats.high > priorHigh && stats.close < priorHigh) {
    const beyond = ((stats.high - priorHigh) / priorHigh) * 100;
    return {
      kind: "buy_stops",
      text: `Buy-stop hunt: the bar traded ${beyond.toFixed(2)}% above the prior ${prior.length}-bar high (${fmtPrice(priorHigh)}) to ${fmtPrice(stats.high)}, then closed back below it at ${fmtPrice(stats.close)}. Stops resting above the market are buy stops — short-sellers' protection and breakout buyers — so reaching them forced buying, and that buying was sold into. The move went up to fill orders, not to go higher.`,
    };
  }

  if (stats.low < priorLow && stats.close > priorLow) {
    const beyond = ((priorLow - stats.low) / priorLow) * 100;
    return {
      kind: "sell_stops",
      text: `Sell-stop hunt: the bar traded ${beyond.toFixed(2)}% below the prior ${prior.length}-bar low (${fmtPrice(priorLow)}) to ${fmtPrice(stats.low)}, then closed back above it at ${fmtPrice(stats.close)}. Stops resting below the market are sell stops — longs' protection and breakdown sellers — so reaching them forced selling, and that selling was bought. The move went down to fill orders, not to go lower.`,
    };
  }

  return null;
}

/** Bar length in seconds, read off the series rather than a timeframe string. */
function barSeconds(candles: Candle[]): number {
  if (candles.length < 2) return 60;
  return Math.max(1, candles[candles.length - 1].time - candles[candles.length - 2].time);
}

export function buildCandleStory(
  stats: CandleStats,
  candles: Candle[],
  analysis: FullAnalysis | null
): StoryLine[] {
  const lines: StoryLine[] = [];
  const span = barSeconds(candles);
  const at = (t: number) => nearBar(t, stats.time, span);

  /* ---- 1. Who was aggressive ---- */
  const aggressor = stats.buyPct >= 55 ? "buyers" : stats.buyPct <= 45 ? "sellers" : "neither side";
  const bodyWord = stats.bullish ? "closed up" : "closed down";
  const agreed =
    (stats.bullish && stats.deltaVolume > 0) || (!stats.bullish && stats.deltaVolume < 0);

  lines.push({
    section: "aggression",
    tone: stats.deltaVolume > 0 ? "bull" : stats.deltaVolume < 0 ? "bear" : "neutral",
    text:
      aggressor === "neither side"
        ? `Two-sided bar: ${stats.buyPct.toFixed(0)}% of ${fmtSize(stats.volume)} lifted the ask, so neither side was clearly the aggressor. Delta ${stats.deltaVolume >= 0 ? "+" : ""}${fmtSize(stats.deltaVolume)}.`
        : `${aggressor === "buyers" ? "Buyers" : "Sellers"} were the aggressors — ${stats.buyPct.toFixed(0)}% of ${fmtSize(stats.volume)} ${aggressor === "buyers" ? "lifted the ask" : "hit the bid"}, delta ${stats.deltaVolume >= 0 ? "+" : ""}${fmtSize(stats.deltaVolume)}. The bar ${bodyWord}.`,
  });

  // Delta disagreeing with the body is the single most useful tell on a bar.
  if (!agreed && Math.abs(stats.deltaVolume) > 0) {
    lines.push({
      section: "absorption",
      tone: stats.bullish ? "bull" : "bear",
      text: `Delta and the body disagree: aggressive ${stats.deltaVolume < 0 ? "selling" : "buying"} could not ${stats.deltaVolume < 0 ? "push the close down" : "push the close up"}. Someone on the other side absorbed it with resting orders — the classic trapped-aggressor signature.`,
    });
  }

  if (stats.volumeMultiple != null && stats.volumeMultiple >= 1.5) {
    lines.push({
      section: "aggression",
      tone: "warn",
      text: `Volume ran ${stats.volumeMultiple.toFixed(1)}× the surrounding average${stats.rangePct < 0.3 ? ` while the bar covered only ${stats.rangePct.toFixed(2)}% — heavy trade going nowhere, which is what absorption looks like from the outside.` : "."}`,
    });
  }

  /* ---- 2. The wicks: where price went and was refused ---- */
  const bodyTop = Math.max(stats.open, stats.close);
  const bodyBottom = Math.min(stats.open, stats.close);
  const upperWick = stats.high - bodyTop;
  const lowerWick = bodyBottom - stats.low;
  const range = Math.max(stats.range, 1e-12);
  const upperShare = upperWick / range;
  const lowerShare = lowerWick / range;

  // A wick is price that traded and was refused. Which end it sits on says
  // who did the refusing, and a long one is the clearest single tell a bar
  // gives — more legible than the body, which only records where it ended.
  // Two-sided first. A bar with 47% wick above and 50% below is not a "long
  // lower wick" bar — the three-point difference is noise, and naming a
  // dominant side there invents a lean the bar does not have. Only call a
  // side when it is clearly the longer one.
  const balancedWicks =
    upperShare >= 0.3 &&
    lowerShare >= 0.3 &&
    Math.max(upperShare, lowerShare) < Math.min(upperShare, lowerShare) * 1.5;

  if (balancedWicks) {
    lines.push({
      section: "wick",
      tone: "warn",
      text: `Wicks on both ends (${(upperShare * 100).toFixed(0)}% above, ${(lowerShare * 100).toFixed(0)}% below) — the bar probed both directions and was refused both times. Two-sided rejection like this is indecision, not a signal.`,
    });
  } else if (upperShare >= 0.4 && upperShare > lowerShare) {
    lines.push({
      section: "wick",
      tone: "bear",
      text: `Long upper wick — ${(upperShare * 100).toFixed(0)}% of the bar's range sits above the body, from ${fmtPrice(bodyTop)} up to ${fmtPrice(stats.high)}. Price traded up there and could not stay: buyers were met by enough resting supply to push the close back down. The high is now a level the market has already rejected once.`,
    });
  } else if (lowerShare >= 0.4 && lowerShare > upperShare) {
    lines.push({
      section: "wick",
      tone: "bull",
      text: `Long lower wick — ${(lowerShare * 100).toFixed(0)}% of the range sits below the body, from ${fmtPrice(stats.low)} up to ${fmtPrice(bodyBottom)}. Price was taken down there and bid back up: sellers found demand rather than air. The low is a level that has already been defended once.`,
    });
  } else {
    lines.push({
      section: "wick",
      tone: "neutral",
      text: `Little wick either side — ${(((bodyTop - bodyBottom) / range) * 100).toFixed(0)}% of the range is body, so price held most of what it took. A bar that does not get pushed back is one nobody contested.`,
    });
  }

  /* ---- 3. Stop hunts ---- */
  const hunt = detectStopHunt(stats, candles);
  if (hunt) {
    lines.push({
      section: "stops",
      // A buy-stop hunt above resolves bearish; a sell-stop hunt below
      // resolves bullish — the sweep is against the side that got taken out.
      tone: hunt.kind === "buy_stops" ? "bear" : "bull",
      text: hunt.text,
    });
  } else {
    lines.push({
      section: "stops",
      tone: "neutral",
      text: `No stop hunt on this bar: it did not take out the prior ${LOOKBACK}-bar high or low and close back inside. Price moved through open space rather than through anyone's stops.`,
    });
  }

  /* ---- 4. Did the engines see absorption or exhaustion here ---- */
  const ev = analysis?.orderFlowEvents;
  const absorption = ev?.absorptions.find((a) => at(a.time));
  if (absorption) {
    lines.push({
      section: "absorption",
      tone: absorption.side === "buy" ? "bull" : "bear",
      text: `Absorption detected on this bar${absorption.atKeyLevel ? " at a mapped level" : " mid-range"}: ${absorption.explanation}`,
    });
  }
  const exhaustion = ev?.exhaustions.find((e) => at(e.time));
  if (exhaustion) {
    lines.push({
      section: "absorption",
      tone: exhaustion.side === "buy" ? "bear" : "bull",
      text: `${exhaustion.side === "buy" ? "Buyer" : "Seller"} exhaustion (${exhaustion.stage}): ${exhaustion.explanation}`,
    });
  }
  const trap = ev?.trapped.find((t) => at(t.time));
  if (trap) {
    lines.push({
      section: "absorption",
      // Trapped buyers are bearish for what follows, and vice versa.
      tone: trap.side === "buyers" ? "bear" : "bull",
      text: `Trapped ${trap.side} on this bar, with stops likely between ${fmtPrice(trap.stopZone.low)} and ${fmtPrice(trap.stopZone.high)}: ${trap.explanation}`,
    });
  }

  /* ---- 5. Divergence ---- */
  const divergence = analysis?.delta?.divergences.find((d) => at(d.time));
  if (divergence) {
    lines.push({
      section: "divergence",
      tone: divergence.kind.includes("bullish") ? "bull" : "bear",
      text: `${divergence.kind.replace(/_/g, " ")} divergence anchored here (strength ${divergence.strength}): ${divergence.explanation}`,
    });
  } else if (stats.cvd != null) {
    lines.push({
      section: "divergence",
      tone: "neutral",
      text: `No divergence anchored on this bar. Cumulative delta stands at ${stats.cvd >= 0 ? "+" : ""}${fmtSize(stats.cvd)}.`,
    });
  }

  const trapBar = analysis?.delta?.trapBars.find((t) => at(t.time));
  if (trapBar && !trap) {
    lines.push({
      section: "divergence",
      tone: trapBar.deltaDirection === "bullish" ? "bull" : "bear",
      text: `Flagged as a trap bar: the candle printed ${trapBar.candleDirection} while delta ran ${trapBar.deltaDirection} (${trapBar.delta >= 0 ? "+" : ""}${fmtSize(trapBar.delta)}).`,
    });
  }

  /* ---- 6. Forced flow and positioning ---- */
  if (stats.liquidationDelta == null) {
    lines.push({
      section: "forced",
      tone: "neutral",
      text: "This bar sits outside the analysed window, so forced-flow and CVD figures are not available for it.",
    });
  } else if (Math.abs(stats.liquidationDelta) > 0) {
    const flush = stats.liquidationDelta < 0;
    lines.push({
      section: "forced",
      tone: flush ? "bear" : "bull",
      text: `Forced flow on this bar: ${fmtSize(Math.abs(stats.liquidationDelta))} of ${flush ? "long liquidation — mechanical selling, not a decision" : "short liquidation — mechanical buying, not a decision"}. That supply is finite; it stops when the cohort is cleared.`,
    });
  } else {
    lines.push({
      section: "forced",
      tone: "neutral",
      text: "No forced flow registered on this bar — the trade here was voluntary, which tends to be more durable than a liquidation-driven move.",
    });
  }

  // What the forced flow actually achieved, measured on the bars after it.
  // Forced size is only half the story — the same flush is exhaustion if it
  // was absorbed and continuation if it was not, and the difference is
  // visible in what price did with it.
  if (stats.liquidationDelta != null && Math.abs(stats.liquidationDelta) > 0) {
    const flush = stats.liquidationDelta < 0;
    const index = candles.findIndex((c) => c.time === stats.time);
    const after = index >= 0 ? candles.slice(index + 1, index + 4) : [];
    if (after.length === 0) {
      lines.push({
        section: "forced",
        tone: "neutral",
        text: "This is the newest bar, so what the forced flow produced cannot be read yet — the next few bars are what say whether it was exhaustion or the start of a cascade.",
      });
    } else {
      const extreme = flush ? stats.low : stats.high;
      const answer = flush
        ? Math.max(...after.map((c) => c.high))
        : Math.min(...after.map((c) => c.low));
      const movePct = ((answer - extreme) / Math.max(extreme, 1e-9)) * 100;
      const reversed = flush ? movePct > 0.15 : movePct < -0.15;
      const wentOn = flush
        ? Math.min(...after.map((c) => c.low)) < stats.low
        : Math.max(...after.map((c) => c.high)) > stats.high;

      lines.push({
        section: "forced",
        tone: reversed ? (flush ? "bull" : "bear") : "warn",
        text: reversed
          ? `What it produced: price turned off the ${flush ? "flush low" : "squeeze high"} at ${fmtPrice(extreme)} and covered ${Math.abs(movePct).toFixed(2)}% the other way within ${after.length} bar${after.length === 1 ? "" : "s"}. Forced sellers were met by willing buyers — the cohort was cleared and the pressure with it.`
          : wentOn
            ? `What it produced: price kept going, taking out ${fmtPrice(extreme)} on the following bars. The cohort was not cleared here, so this was a leg of the cascade rather than the end of it.`
            : `What it produced: little — price has gone ${Math.abs(movePct).toFixed(2)}% since, neither reversing nor extending. Forced flow that moves nothing usually means the other side was already there in size.`,
      });
    }
  }

  const whale = analysis?.pressureMap?.whales.find((w) => at(w.time));
  if (whale) {
    lines.push({
      section: "forced",
      tone: whale.side === "buy" ? "bull" : "bear",
      text: `Large print here: ${fmtSize(whale.volume)} ${whale.side} at ${fmtPrice(whale.price)} (${whale.multiple.toFixed(1)}× average bar volume), currently ${whale.posture}.`,
    });
  }

  /* ---- 7. Where the bar sits ---- */
  const sr = analysis?.srLevels
    ?.filter((l) => Math.abs(l.price - stats.close) / Math.max(stats.close, 1e-9) < 0.004)
    .sort((a, b) => b.strength - a.strength)[0];
  if (sr) {
    lines.push({
      section: "context",
      tone: sr.kind === "support" ? "bull" : "bear",
      text: `The close sits on mapped ${sr.kind} at ${fmtPrice(sr.price)} (strength ${sr.strength}, ${sr.touches} touches) — flow at a level is worth more than the same flow in open space.`,
    });
  }

  const poc = analysis?.volumeProfile?.poc;
  if (poc != null) {
    const side = stats.close > poc ? "above" : stats.close < poc ? "below" : "at";
    lines.push({
      section: "context",
      tone: "neutral",
      text: `Closed ${side} the session POC (${fmtPrice(poc)})${side === "at" ? "" : ` by ${(Math.abs(stats.close - poc) / poc * 100).toFixed(2)}%`}.`,
    });
  }

  /* ---- 8. What to watch — levels, never outcomes ---- */
  const confirm = stats.bullish ? stats.high : stats.low;
  const refute = stats.bullish ? stats.low : stats.high;
  lines.push({
    section: "next",
    tone: "neutral",
    text: `What to watch, not a forecast: trading back through ${fmtPrice(refute)} undoes whatever this bar established; holding and clearing ${fmtPrice(confirm)} carries it forward. Which of the two happens is exactly the part no engine here claims to know.`,
  });

  return lines;
}
