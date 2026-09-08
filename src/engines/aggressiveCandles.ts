import { Candle } from "./types";

/**
 * Bars where one side did the trading, not both.
 *
 * Every candle has a buyer and a seller for every contract — that is what a
 * trade is — so "buying volume" on its own is meaningless. What is not
 * meaningless is *who crossed the spread*. Taker buy volume is the share that
 * lifted the offer rather than resting on the bid, and a bar where 75% of the
 * volume was takers hitting one direction is a bar where one side was in a
 * hurry and the other was accommodating.
 *
 * ## Why size matters as much as skew
 *
 * A 90% buy-share bar on a tenth of average volume is three trades and a
 * rounding error. Aggression is a claim about *conviction*, and conviction
 * without participation is not conviction — so a bar has to be both one-sided
 * and busy to qualify. That pairing is the whole filter; skew alone would mark
 * a third of every quiet session.
 *
 * ## What it does not mean
 *
 * Aggressive buying is not bullish on its own, and this is the trap the label
 * invites. Buyers paying up into resistance that holds is how a trap starts —
 * the aggression was real and it still lost. What the mark says is "one side
 * forced the issue here"; whether they were right is answered by what price
 * did next, which is exactly what the absorption and exhaustion reads are for.
 */

/** Bars used for the volume and skew baselines. */
const CONTEXT = 30;
/** Taker share on one side that counts as one-sided. */
const SKEW = 0.68;
/** ...and the volume multiple that stops a quiet bar qualifying on skew alone. */
const VOLUME_X = 1.2;
/** Above this, the bar is not merely aggressive but lopsided. */
const EXTREME_SKEW = 0.8;

export interface AggressiveCandle {
  time: number;
  index: number;
  side: "buy" | "sell";
  /** taker share on the aggressive side, 0-1 */
  share: number;
  /** volume against the trailing mean */
  volumeMultiple: number;
  /** net taker delta in contracts, signed */
  delta: number;
  /** 0-100, from how far past both thresholds the bar sits */
  strength: number;
  extreme: boolean;
  note: string;
}

/**
 * Find the bars one side forced.
 *
 * Pure and synchronous. The forming bar is included — an aggressive bar in
 * progress is exactly the one a reader wants flagged — but its share can still
 * flip before it closes, which the note says.
 */
export function findAggressiveCandles(candles: Candle[]): AggressiveCandle[] {
  if (candles.length < CONTEXT + 2) return [];
  const out: AggressiveCandle[] = [];

  for (let i = CONTEXT; i < candles.length; i++) {
    const c = candles[i];
    if (c.volume <= 0 || c.takerBuyVolume == null) continue;

    const window = candles.slice(i - CONTEXT, i);
    const meanVolume = window.reduce((s, x) => s + x.volume, 0) / window.length;
    if (meanVolume <= 0) continue;
    const volumeMultiple = c.volume / meanVolume;
    if (volumeMultiple < VOLUME_X) continue;

    const buyShare = c.takerBuyVolume / c.volume;
    const side: "buy" | "sell" = buyShare >= 0.5 ? "buy" : "sell";
    const share = side === "buy" ? buyShare : 1 - buyShare;
    if (share < SKEW) continue;

    const delta = c.takerBuyVolume - (c.volume - c.takerBuyVolume);
    const extreme = share >= EXTREME_SKEW;
    // Both dimensions contribute, because either alone is a weaker claim: the
    // skew says one side crossed, the volume says enough of them did.
    const strength = Math.round(
      Math.min(100, ((share - SKEW) / (1 - SKEW)) * 60 + Math.min(40, (volumeMultiple - 1) * 25))
    );

    const isLast = i === candles.length - 1;
    out.push({
      time: c.time,
      index: i,
      side,
      share: Number(share.toFixed(3)),
      volumeMultiple: Number(volumeMultiple.toFixed(2)),
      delta: Number(delta.toFixed(2)),
      strength,
      extreme,
      note:
        `${(share * 100).toFixed(0)}% of ${volumeMultiple.toFixed(1)}× normal volume was takers ${side === "buy" ? "lifting the offer" : "hitting the bid"}. ` +
        `One side forced the issue here — which is a statement about who was in a hurry, not about who was right.` +
        (isLast ? " This bar is still forming, so the share can still flip before it closes." : ""),
    });
  }

  return out;
}

/** Bars apart that still counts as the same push. */
const RUN_GAP = 2;

/**
 * Collapse consecutive same-side bars to the strongest one in each run.
 *
 * Five adjacent bars of 75% taker selling is *one* push, not five signals, and
 * labelling every bar of it both overstates the count and — on a zoomed-out
 * chart — stacks the labels on top of each other until none of them is
 * readable. Keeping the strongest bar of each run is the honest summary: it
 * marks where the push was hardest and says how long it ran.
 *
 * A run breaks when the side changes or more than `RUN_GAP` bars pass without
 * one qualifying, so two pushes separated by a pause stay two marks.
 */
export function strongestPerRun(bars: AggressiveCandle[]): (AggressiveCandle & { runLength: number })[] {
  const out: (AggressiveCandle & { runLength: number })[] = [];
  let best: AggressiveCandle | null = null;
  let count = 0;
  let prev: AggressiveCandle | null = null;

  const flush = () => {
    if (best) out.push({ ...best, runLength: count });
    best = null;
    count = 0;
  };

  for (const b of bars) {
    const continues =
      prev != null && b.side === prev.side && b.index - prev.index <= RUN_GAP + 1;
    if (!continues) flush();
    if (!best || b.strength > best.strength) best = b;
    count++;
    prev = b;
  }
  flush();
  return out;
}
