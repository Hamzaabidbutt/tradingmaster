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
  section: "aggression" | "absorption" | "divergence" | "forced" | "context" | "next";
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

  /* ---- 2. Did the engines see absorption or exhaustion here ---- */
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

  /* ---- 3. Divergence ---- */
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

  /* ---- 4. Forced flow and positioning ---- */
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

  const whale = analysis?.pressureMap?.whales.find((w) => at(w.time));
  if (whale) {
    lines.push({
      section: "forced",
      tone: whale.side === "buy" ? "bull" : "bear",
      text: `Large print here: ${fmtSize(whale.volume)} ${whale.side} at ${fmtPrice(whale.price)} (${whale.multiple.toFixed(1)}× average bar volume), currently ${whale.posture}.`,
    });
  }

  /* ---- 5. Where the bar sits ---- */
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

  /* ---- 6. What to watch — levels, never outcomes ---- */
  const confirm = stats.bullish ? stats.high : stats.low;
  const refute = stats.bullish ? stats.low : stats.high;
  lines.push({
    section: "next",
    tone: "neutral",
    text: `What to watch, not a forecast: trading back through ${fmtPrice(refute)} undoes whatever this bar established; holding and clearing ${fmtPrice(confirm)} carries it forward. Which of the two happens is exactly the part no engine here claims to know.`,
  });

  return lines;
}
