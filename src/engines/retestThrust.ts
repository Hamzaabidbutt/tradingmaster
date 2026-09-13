import { Candle } from "./types";
import { findSwings } from "./marketStructure";

/**
 * Change of character, retest, thrust — and whether the thrust ever came.
 *
 * The shape is the one people draw on a screenshot with two arrows: a sustained
 * decline, a base, the first close back above the last lower-high (the change
 * of character), price coming back to that level to check it, and then the
 * expansion away from it. The last part is the reason anybody cares about the
 * first three.
 *
 * ## Why this is not the BOS scanner again
 *
 * `bosMomentum.ts` already finds breaks that get retested, and reports whether
 * the retest held. It stops there, and stopping there is the problem: "the
 * retest held" is a statement about the level, not about what the trade did.
 * A level can hold perfectly and go nowhere, and on most charts that is exactly
 * what it does. The state `retest_held` is silent on the only question the
 * setup is entered for.
 *
 * So this engine carries the sequence one step further, to the thrust, and then
 * does the thing that actually answers the question: it goes back through the
 * same symbol's own history, finds every completed instance of this sequence,
 * and measures what happened after each one.
 *
 * ## The number that matters, and its limits
 *
 * `precedent.boomRate` is a measured frequency from one symbol's loaded window.
 * It is not a probability, not an edge, and not a forecast. The samples are
 * small by construction — a few hundred bars contain a handful of these — and
 * a rate computed from four cases is a description of four cases. The engine
 * reports the count alongside the rate for exactly that reason, and says so in
 * its own note when the sample is too thin to mean anything.
 *
 * What it is good for: telling you that on *this* symbol, at *this* timeframe,
 * this pattern has previously gone on to expand seven times out of nine, or
 * one time out of six. Those are very different setups that look identical at
 * the moment of the retest, and there is no way to tell them apart by looking.
 *
 * ## What it refuses to do
 *
 * It will not report a live setup as having thrust. The thrust is the future
 * at the moment you would enter, and a scanner that showed you the sequence
 * only once the expansion had already happened would be showing you setups you
 * cannot take. `armed` — price in the retest zone right now — is the state the
 * whole engine exists to surface, and it is deliberately the state with the
 * least confirmation.
 */

/** Fractal width for the swings that define the level. */
const SWING_LOOKBACK = 3;
/** ATR lookback, matching the other engines so tolerances stay comparable. */
const ATR_PERIOD = 14;
/** Bars before the base low to look back for where the leg started. */
const LEG_WINDOW = 60;
/**
 * The prior leg has to be this many ATR before the sequence means anything.
 *
 * Without it, every minor wiggle produces a "change of character" — price is
 * always making the first higher high after some two-bar dip — and the scanner
 * becomes a list of noise with a reversal story attached.
 */
const MIN_LEG_ATR = 3;
/** Within this many ATR of the level counts as a retest. */
const RETEST_ATR = 0.6;
/** A close this far back through the level ends the sequence. */
const BREAK_ATR = 0.6;
/** Bars after the change of character to wait for the retest. */
const RETEST_WINDOW = 20;
/** A close this far past the level, on an expanded bar, is the thrust. */
const THRUST_ATR = 1.2;
/** Thrust bar range, as a multiple of the recent average. */
const THRUST_RANGE_X = 1.3;
/** Past this distance from the level there is no entry left to define. */
const EXTENDED_ATR = 4;
/** A thrust within this many bars is still "happening". */
const THRUST_FRESH_BARS = 3;
/** Bars over which a completed instance's follow-through is measured. */
const FOLLOW_BARS = 20;
/** How far a completed instance had to run to count as a boom. */
const BOOM_ATR = 3;
/** Below this many precedents, a rate is not a rate. */
const THIN_SAMPLE = 5;

export type ThrustState =
  /** the change of character has happened and price is back at the level now */
  | "armed"
  /** the retest happened and held, but nothing has expanded yet */
  | "held"
  /** the expansion is under way, within the last few bars */
  | "thrusting"
  /** it ran; there is no entry left against the level */
  | "extended"
  /** price closed back through the level after the change of character */
  | "failed"
  /** the leg and the base are there, but no change of character yet */
  | "forming";

export const THRUST_STATE_LABEL: Record<ThrustState, string> = {
  armed: "At the level now",
  held: "Retest held",
  thrusting: "Expanding",
  extended: "Already run",
  failed: "Level lost",
  forming: "No character change yet",
};

export const THRUST_STATE_NOTE: Record<ThrustState, string> = {
  armed:
    "Price is inside the retest zone on the last closed bar. This is the point the sequence exists to find, and also the point with the least confirmation — the thrust is still the future.",
  held:
    "Price came back to the level, held it, and has moved away without expanding yet. The geometry is intact; the move is not proven.",
  thrusting:
    "The expansion is under way. Entering here means entering without the level to stop against, which is the trade the retest was meant to avoid.",
  extended:
    "It ran. Shown so the sequence can be studied, not taken — the level is too far away to define risk against.",
  failed:
    "Price closed back through the level. The change of character did not hold, and the level is now a place sellers defended.",
  forming:
    "A real leg and a base, but price has not yet closed above the last lower high. Nothing has changed character.",
};

export interface ThrustCheck {
  label: string;
  pass: boolean;
  detail: string;
}

/**
 * What this symbol did after previous instances of the same sequence.
 *
 * Measured on the loaded window only, so the sample is whatever history was
 * fetched — never a long-run base rate, and never presented as one.
 */
export interface ThrustPrecedent {
  /** completed instances found, each with a full follow window after it */
  count: number;
  /** median best excursion in the run's direction, in ATR, over the follow window */
  medianPeakAtr: number;
  /** share that reached the boom threshold before losing the level */
  boomRate: number;
  /** share that lost the level first */
  failRate: number;
  followBars: number;
  boomThresholdAtr: number;
  /** plain-language reading, including when the sample is too small to read */
  note: string;
}

export interface RetestThrustSetup {
  state: ThrustState;
  direction: "long" | "short";
  /** the swing the change of character cleared — what the retest leans on */
  level: number;
  /** unix seconds of the bar that changed character, or null if none yet */
  chochTime: number | null;
  /** unix seconds of the base pivot the sequence grew from */
  baseTime: number;
  /** size of the leg into the base, in ATR */
  legAtr: number;
  /** bars from the base pivot to the last bar */
  barsSinceBase: number;
  /** bars since the change of character, or null */
  barsSinceChoch: number | null;
  /** how deep into the level the retest went, in ATR; negative = never reached */
  retestDepthAtr: number | null;
  /** unix seconds of the retest's extreme bar, or null */
  retestTime: number | null;
  /** size of the thrust in ATR, or null if it has not thrust */
  thrustAtr: number | null;
  /** thrust bar volume against the recent average, or null */
  thrustVolumeX: number | null;
  /** where price sits relative to the level now, in ATR */
  distanceAtr: number;
  checks: ThrustCheck[];
  /** passed checks out of the total */
  score: number;
  precedent: ThrustPrecedent;
  note: string;
}

function atr(candles: Candle[], end: number, period = ATR_PERIOD): number {
  const from = Math.max(1, end - period + 1);
  if (end < 1) return 0;
  let sum = 0;
  let n = 0;
  for (let i = from; i <= end; i++) {
    const c = candles[i];
    const prev = candles[i - 1].close;
    sum += Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
    n++;
  }
  return n > 0 ? sum / n : 0;
}

function averageRange(candles: Candle[], end: number, period = ATR_PERIOD): number {
  const from = Math.max(0, end - period + 1);
  let sum = 0;
  for (let i = from; i <= end; i++) sum += candles[i].high - candles[i].low;
  const n = end - from + 1;
  return n > 0 ? sum / n : 0;
}

function averageVolume(candles: Candle[], end: number, period = 20): number {
  const from = Math.max(0, end - period + 1);
  let sum = 0;
  for (let i = from; i <= end; i++) sum += candles[i].volume;
  const n = end - from + 1;
  return n > 0 ? sum / n : 0;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * One instance of the sequence, as found by walking forward from a base pivot.
 *
 * Internal: the public shape is `RetestThrustSetup`, which is this plus the
 * precedent study and the checklist.
 */
interface Sequence {
  direction: "long" | "short";
  baseIndex: number;
  level: number;
  legAtr: number;
  chochIndex: number | null;
  retestIndex: number | null;
  retestDepthAtr: number | null;
  thrustIndex: number | null;
  thrustAtr: number | null;
  thrustVolumeX: number | null;
  /** index at which price closed back through the level, if it did */
  failIndex: number | null;
  atrAtBase: number;
}

/**
 * Build the sequence that grows out of one base pivot, if any.
 *
 * Deterministic and forward-only: given the pivot, the level, the change of
 * character, the retest and the thrust are each the *first* thing that
 * qualifies, never the best-looking one. Picking the most flattering retest
 * from several candidates is how a backtest ends up describing a strategy
 * nobody could have followed live.
 */
function growSequence(
  candles: Candle[],
  swings: { index: number; price: number; kind: "high" | "low" }[],
  pivotPos: number,
  direction: "long" | "short"
): Sequence | null {
  const pivot = swings[pivotPos];
  const long = direction === "long";
  const range = atr(candles, pivot.index);
  if (!(range > 0)) return null;

  /* The level is the last opposing swing before the base — the final lower
     high of the decline, which is the line a change of character has to
     clear. */
  let level: number | null = null;
  for (let p = pivotPos - 1; p >= 0; p--) {
    const s = swings[p];
    if (s.kind === (long ? "high" : "low")) {
      level = s.price;
      break;
    }
  }
  if (level == null) return null;

  // The leg into the base has to be a real move, not a wiggle.
  const legFrom = Math.max(0, pivot.index - LEG_WINDOW);
  let extreme = candles[legFrom][long ? "high" : "low"];
  for (let i = legFrom; i <= pivot.index; i++) {
    const c = candles[i];
    if (long) extreme = Math.max(extreme, c.high);
    else extreme = Math.min(extreme, c.low);
  }
  const legAtr = Math.abs(extreme - pivot.price) / range;
  if (legAtr < MIN_LEG_ATR) return null;

  const seq: Sequence = {
    direction,
    baseIndex: pivot.index,
    level,
    legAtr,
    chochIndex: null,
    retestIndex: null,
    retestDepthAtr: null,
    thrustIndex: null,
    thrustAtr: null,
    thrustVolumeX: null,
    failIndex: null,
    atrAtBase: range,
  };

  // The change of character: the first close through the level.
  for (let i = pivot.index + 1; i < candles.length; i++) {
    const close = candles[i].close;
    if (long ? close > level : close < level) {
      seq.chochIndex = i;
      break;
    }
    /* A new extreme past the base means this base is not the one the sequence
       grows from — the decline simply continued, and a later pivot owns it. */
    if (long ? candles[i].low < pivot.price : candles[i].high > pivot.price) return null;
  }
  if (seq.chochIndex == null) return seq;

  // The retest: the first return to within tolerance of the level.
  const retestEnd = Math.min(candles.length - 1, seq.chochIndex + RETEST_WINDOW);
  for (let i = seq.chochIndex + 1; i <= retestEnd; i++) {
    const c = candles[i];
    if (long ? c.close < level - BREAK_ATR * range : c.close > level + BREAK_ATR * range) {
      seq.failIndex = i;
      return seq;
    }
    const reach = long ? c.low : c.high;
    const gap = long ? reach - level : level - reach;
    if (gap <= RETEST_ATR * range) {
      seq.retestIndex = i;
      /* Negative depth means it traded through the level and closed back —
         a deeper test than a touch, and worth telling apart from one. */
      seq.retestDepthAtr = gap / range;
      break;
    }
  }

  /* Whether or not a retest happened, a later close back through the level
     ends the sequence. A change of character that is given back has not become
     something else by never having been retested. */
  const failFrom = seq.retestIndex ?? seq.chochIndex;
  for (let i = failFrom + 1; i < candles.length; i++) {
    const c = candles[i];
    if (long ? c.close < level - BREAK_ATR * range : c.close > level + BREAK_ATR * range) {
      seq.failIndex = i;
      break;
    }
  }

  // The thrust: an expanded bar closing clear of the level.
  const thrustFrom = (seq.retestIndex ?? seq.chochIndex) + 1;
  const thrustTo = seq.failIndex ?? candles.length - 1;
  for (let i = thrustFrom; i <= thrustTo; i++) {
    const c = candles[i];
    const past = long ? c.close - level : level - c.close;
    if (past < THRUST_ATR * range) continue;
    const avgRange = averageRange(candles, i - 1);
    if (!(avgRange > 0) || c.high - c.low < THRUST_RANGE_X * avgRange) continue;
    seq.thrustIndex = i;
    seq.thrustAtr = past / range;
    const avgVol = averageVolume(candles, i - 1);
    seq.thrustVolumeX = avgVol > 0 ? c.volume / avgVol : null;
    break;
  }

  return seq;
}

/** Every sequence in the series, oldest first. */
function allSequences(candles: Candle[]): Sequence[] {
  const swings = findSwings(candles, SWING_LOOKBACK, "minor");
  if (swings.length < 3) return [];
  const out: Sequence[] = [];
  for (const direction of ["long", "short"] as const) {
    const want = direction === "long" ? "low" : "high";
    for (let p = 1; p < swings.length; p++) {
      if (swings[p].kind !== want) continue;
      const seq = growSequence(candles, swings, p, direction);
      if (seq) out.push(seq);
    }
  }
  return out.sort((a, b) => a.baseIndex - b.baseIndex);
}

/**
 * What happened after the sequences that had room to play out.
 *
 * Only instances whose retest is at least `FOLLOW_BARS` from the end are
 * counted, because an instance with five bars of follow window has not had the
 * chance to boom and counting it as a non-boom would bias the rate down by
 * exactly the amount of history missing.
 */
function studyPrecedent(
  candles: Candle[],
  sequences: Sequence[],
  direction: "long" | "short",
  excludeBaseIndex: number
): ThrustPrecedent {
  const long = direction === "long";
  const peaks: number[] = [];
  let booms = 0;
  let fails = 0;

  for (const seq of sequences) {
    if (seq.direction !== direction) continue;
    if (seq.baseIndex === excludeBaseIndex) continue;
    if (seq.retestIndex == null) continue;
    const start = seq.retestIndex;
    if (start + FOLLOW_BARS >= candles.length) continue;

    const range = seq.atrAtBase;
    if (!(range > 0)) continue;
    const from = candles[start].close;

    let peak = 0;
    let lost = false;
    for (let i = start + 1; i <= start + FOLLOW_BARS; i++) {
      const c = candles[i];
      const excursion = long ? c.high - from : from - c.low;
      peak = Math.max(peak, excursion / range);
      const broke = long
        ? c.close < seq.level - BREAK_ATR * range
        : c.close > seq.level + BREAK_ATR * range;
      /* The level going first is the outcome that matters, so a case that
         booms *after* being stopped out does not count as a boom. Measuring
         the peak over the whole window regardless would describe a trade
         nobody was still in. */
      if (broke) {
        lost = true;
        break;
      }
    }
    peaks.push(peak);
    if (lost) fails++;
    else if (peak >= BOOM_ATR) booms++;
  }

  const count = peaks.length;
  const boomRate = count > 0 ? booms / count : 0;
  const failRate = count > 0 ? fails / count : 0;
  const med = median(peaks);

  let note: string;
  if (count === 0) {
    note =
      "No completed instance of this sequence in the loaded window, so there is no precedent from this symbol's own history to compare against.";
  } else if (count < THIN_SAMPLE) {
    note = `Only ${count} previous instance${count === 1 ? "" : "s"} in the loaded window — far too few to be a rate. Median best excursion was ${med.toFixed(1)} ATR. Treat these as ${count} case${count === 1 ? "" : "s"} to look at individually, not as a frequency.`;
  } else {
    note = `${booms} of ${count} previous instances on this symbol reached ${BOOM_ATR} ATR before losing the level, and ${fails} lost the level first. Median best excursion ${med.toFixed(1)} ATR over ${FOLLOW_BARS} bars. A measured frequency from one symbol's loaded window — not a probability, and not a forecast.`;
  }

  return {
    count,
    medianPeakAtr: med,
    boomRate,
    failRate,
    followBars: FOLLOW_BARS,
    boomThresholdAtr: BOOM_ATR,
    note,
  };
}

/**
 * The state a sequence is in, before the caller refines it against the last bar.
 *
 * Deliberately does not decide `armed` — whether price is at the level *now* is
 * a question about the last bar, not about the sequence's own history, and the
 * caller has both.
 */
function stateOf(seq: Sequence, lastIndex: number): ThrustState {
  if (seq.chochIndex == null) return "forming";
  if (seq.failIndex != null) return "failed";
  if (seq.thrustIndex != null) {
    return lastIndex - seq.thrustIndex <= THRUST_FRESH_BARS ? "thrusting" : "extended";
  }
  return "held";
}

/**
 * The sequence worth showing for one symbol, or null.
 *
 * Prefers the most recent live sequence — one still leaning on its level — over
 * an older or higher-scoring dead one, for the same reason the ladder scanner
 * does: a scanner exists to say what is happening now, and a textbook sequence
 * that resolved forty bars ago is history.
 */
export function detectRetestThrust(candles: Candle[]): RetestThrustSetup | null {
  if (candles.length < LEG_WINDOW + RETEST_WINDOW) return null;
  const lastIndex = candles.length - 1;
  const range = atr(candles, lastIndex);
  if (!(range > 0)) return null;

  const sequences = allSequences(candles);
  if (sequences.length === 0) return null;

  /* The most recent change of character wins, whatever state it is in.
     Ordered by the change of character rather than the base, because that is
     the event that made the level current — two sequences can share a base and
     the later one is the one price is actually reacting to.

     Failed sequences are deliberately eligible. An earlier version filtered
     them out as "not live", which made `failed` almost unreachable: a setup
     you had been watching could break and the scanner would quietly show you
     something else instead of telling you the level was gone. Reporting a
     failure is the whole value of having the state. */
  const recent = sequences
    .filter((s) => s.chochIndex != null && lastIndex - s.chochIndex <= RETEST_WINDOW * 3)
    .sort((a, b) => (a.chochIndex ?? 0) - (b.chochIndex ?? 0));
  const chosen = recent[recent.length - 1] ?? sequences[sequences.length - 1];

  const long = chosen.direction === "long";
  const lastClose = candles[lastIndex].close;
  const distanceAtr = ((long ? lastClose - chosen.level : chosen.level - lastClose) / range);

  let state = stateOf(chosen, lastIndex);
  /* `armed` is the claim that price is at the level *now*, so it is decided by
     where the last bar actually traded rather than by when the first retest
     happened — a retest fifteen bars ago that price never left is still price
     at the level, and one it left is not. */
  if (state === "held" || state === "armed") {
    const reach = long ? candles[lastIndex].low : candles[lastIndex].high;
    const gap = (long ? reach - chosen.level : chosen.level - reach) / range;
    state = gap <= RETEST_ATR ? "armed" : "held";
  }
  if (state !== "failed" && state !== "forming" && distanceAtr > EXTENDED_ATR) {
    state = chosen.thrustIndex != null && lastIndex - chosen.thrustIndex <= THRUST_FRESH_BARS
      ? "thrusting"
      : "extended";
  }

  const checks: ThrustCheck[] = [
    {
      label: "Real leg into the base",
      pass: chosen.legAtr >= MIN_LEG_ATR,
      detail: `${chosen.legAtr.toFixed(1)} ATR from the leg's extreme to the base low.`,
    },
    {
      label: "Character changed",
      pass: chosen.chochIndex != null,
      detail:
        chosen.chochIndex == null
          ? "Price has not closed through the last opposing swing."
          : `Closed through ${chosen.level.toPrecision(6)} ${lastIndex - chosen.chochIndex} bars ago.`,
    },
    {
      label: "Came back and held",
      pass: chosen.retestIndex != null && chosen.failIndex == null,
      detail:
        chosen.retestIndex == null
          ? "No return to the level yet — the sequence has not been tested."
          : chosen.failIndex != null
            ? "Returned, then closed back through. The level did not hold."
            : `Returned to within ${(chosen.retestDepthAtr ?? 0).toFixed(2)} ATR and held.`,
    },
    {
      label: "Expanded away",
      pass: chosen.thrustIndex != null,
      detail:
        chosen.thrustIndex == null
          ? "Nothing has expanded away from the level yet."
          : `${(chosen.thrustAtr ?? 0).toFixed(1)} ATR clear on an expanded bar.`,
    },
    {
      label: "Volume behind the thrust",
      pass: (chosen.thrustVolumeX ?? 0) >= 1.2,
      detail:
        chosen.thrustVolumeX == null
          ? "No thrust bar to measure."
          : `${chosen.thrustVolumeX.toFixed(1)}× the recent average.`,
    },
  ];

  const precedent = studyPrecedent(candles, sequences, chosen.direction, chosen.baseIndex);

  return {
    state,
    direction: chosen.direction,
    level: chosen.level,
    chochTime: chosen.chochIndex == null ? null : candles[chosen.chochIndex].time,
    baseTime: candles[chosen.baseIndex].time,
    legAtr: chosen.legAtr,
    barsSinceBase: lastIndex - chosen.baseIndex,
    barsSinceChoch: chosen.chochIndex == null ? null : lastIndex - chosen.chochIndex,
    retestDepthAtr: chosen.retestDepthAtr,
    retestTime: chosen.retestIndex == null ? null : candles[chosen.retestIndex].time,
    thrustAtr: chosen.thrustAtr,
    thrustVolumeX: chosen.thrustVolumeX,
    distanceAtr,
    checks,
    score: checks.filter((c) => c.pass).length,
    precedent,
    note: THRUST_STATE_NOTE[state],
  };
}
