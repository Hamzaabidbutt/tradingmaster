import { Candle } from "./types";

/**
 * Staircase runs: consecutive candles walking a straight line.
 *
 * The shape this looks for is the one people point at on a chart and call "a
 * clean trend" — each bar's low above the last bar's low and each high above
 * the last bar's high, repeated, so the lows themselves fall on a line you
 * could draw with a ruler. Every step holds the step below it.
 *
 * ## Why this is not the trendline engine
 *
 * `trendlines.ts` connects *swing pivots* across a long window: two anchors far
 * apart, validated by what price did in between. It answers "where has this
 * market repeatedly turned?" and the bars between the anchors are free to do
 * whatever they like.
 *
 * This answers a different question — "is price walking a line right now,
 * bar by bar?" — and the bars between are the entire subject. A run of eight
 * consecutive higher lows is a fact about those eight bars. It is not a swing
 * structure, it does not need a third touch, and it stops the moment one bar
 * takes out the previous bar's low. The two engines can disagree about the
 * same chart without either being wrong.
 *
 * ## What it refuses to smooth over
 *
 * A staircase is defined by the steps holding, so the run ends at the first bar
 * that breaks one. There is no tolerance band for "nearly held": a bar that
 * traded below the previous bar's low ended the run, and stretching the
 * definition to keep a pretty run alive would mean the number reported is not
 * the thing measured.
 *
 * Straightness is reported, not required. A run whose lows accelerate away from
 * the line is still a run — it is a parabola rather than a staircase, and its
 * low `r2` says so rather than the run being dropped as if it never happened.
 *
 * ## What it is not
 *
 * Not a signal, and not a prediction. A ladder is a description of bars that
 * have already closed. Runs end — that is what makes them runs — and the fact
 * that eight bars held a line says nothing about the ninth. What it is good
 * for is finding, across a universe, the handful of symbols currently doing
 * this at all, which is otherwise a thing you can only spot by looking.
 */

/** Bars a run needs before it is a staircase rather than a coincidence. */
export const MIN_BARS = 4;
/** ATR lookback, matching the other engines so tolerances stay comparable. */
const ATR_PERIOD = 14;
/**
 * A run has to cover this much ground in ATR before it counts.
 *
 * Four consecutive higher lows inside a fifth of an average bar's range is
 * arithmetically a staircase and visually nothing at all. Without this, quiet
 * chop outranks real legs because chop produces more of these runs.
 */
const MIN_MOVE_ATR = 1;
/** Straightness at which a run stops earning more for being straighter. */
const R2_MIDPOINT = 0.25;
/** Run length, in bars beyond the minimum, worth half the length credit. */
const BARS_MIDPOINT = 4;
/** Move size, in ATR beyond the floor, worth half the size credit. */
const MOVE_MIDPOINT = 3;

export type LadderDirection = "up" | "down";

export interface CandleLadder {
  direction: LadderDirection;
  startIndex: number;
  endIndex: number;
  /** unix seconds, open time of the run's first bar */
  startTime: number;
  /** unix seconds, open time of the run's last bar */
  endTime: number;
  bars: number;
  /** move from the run's first open to its last close, in percent */
  movePct: number;
  /** the same move measured in ATR, which is what comparison across symbols needs */
  moveAtr: number;
  /**
   * How straight the steps are, 0-1.
   *
   * Least-squares fit through the lows of an up run (the highs of a down run) —
   * the line a person would draw under the staircase. 1 is a ruler; a run that
   * accelerates or stalls scores lower and is still reported.
   */
  r2: number;
  /** slope of that line per bar, as a percentage of the run's starting price */
  slopePctPerBar: number;
  /** share of the run's bars closing in the run's own direction, 0-1 */
  bodyShare: number;
  /** where the fitted line projects to at the last candle in the series */
  lineNow: number;
  /** bars between the run's last bar and the series' last bar; 0 means live */
  barsSinceEnd: number;
  /** a later bar closed through the fitted line — the staircase has given way */
  broken: boolean;
  /** 0-100, combining length, straightness, size and body agreement */
  score: number;
}

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

interface Fit {
  slope: number;
  intercept: number;
  r2: number;
}

/**
 * Least-squares line through the pivot of each bar in the run.
 *
 * `r2` is forced to 1 for a perfectly flat series rather than left as the 0/0
 * the formula produces: a flat line through flat points is an exact fit, and
 * reporting the worst possible straightness for the straightest possible case
 * is the kind of quiet inversion that makes a ranking meaningless.
 */
function fitLine(values: number[], startIndex: number): Fit {
  const n = values.length;
  if (n < 2) return { slope: 0, intercept: values[0] ?? 0, r2: 0 };

  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i++) {
    sumX += startIndex + i;
    sumY += values[i];
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    const dx = startIndex + i - meanX;
    sxy += dx * (values[i] - meanY);
    sxx += dx * dx;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = meanY - slope * meanX;

  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const predicted = slope * (startIndex + i) + intercept;
    ssRes += (values[i] - predicted) ** 2;
    ssTot += (values[i] - meanY) ** 2;
  }
  const r2 = ssTot === 0 ? 1 : Math.max(0, 1 - ssRes / ssTot);
  return { slope, intercept, r2 };
}

/**
 * Saturating credit, the same shape the flow-alignment score uses.
 *
 * A clipped ratio gives every strong reading the same 1.0 and throws away the
 * ordering exactly where the ranking matters most. This has no ceiling to hit,
 * so a twenty-bar run still ranks above a twelve-bar one.
 */
function credit(value: number, midpoint: number): number {
  if (!(value > 0) || !(midpoint > 0)) return 0;
  return value / (value + midpoint);
}

/**
 * Every maximal staircase run in the series, strongest first.
 *
 * Maximal, so a run of eight is reported once as eight rather than as the five
 * overlapping runs of four it contains. Runs of both directions are returned
 * together; the caller filters.
 */
export function findCandleLadders(candles: Candle[]): CandleLadder[] {
  if (candles.length < MIN_BARS + 1) return [];
  const range = atr(candles);
  if (!(range > 0)) return [];

  const out: CandleLadder[] = [];
  const last = candles.length - 1;

  for (const direction of ["up", "down"] as const) {
    const steps = (i: number): boolean => {
      const c = candles[i];
      const p = candles[i - 1];
      return direction === "up"
        ? c.low > p.low && c.high > p.high
        : c.low < p.low && c.high < p.high;
    };

    let runStart = 0;
    for (let i = 1; i <= candles.length; i++) {
      /* The run continues while each bar steps past the one before it. Ending
         it at `candles.length` as well closes a run that reaches the final
         bar, which is the case a scanner cares about most. */
      if (i < candles.length && steps(i)) continue;

      const runEnd = i - 1;
      const bars = runEnd - runStart + 1;
      if (bars >= MIN_BARS) {
        const ladder = describe(candles, runStart, runEnd, direction, range, last);
        if (ladder) out.push(ladder);
      }
      runStart = i;
    }
  }

  return out.sort((a, b) => b.score - a.score);
}

function describe(
  candles: Candle[],
  startIndex: number,
  endIndex: number,
  direction: LadderDirection,
  range: number,
  lastIndex: number
): CandleLadder | null {
  const run = candles.slice(startIndex, endIndex + 1);
  const first = run[0];
  const final = run[run.length - 1];

  const move = direction === "up" ? final.close - first.open : first.open - final.close;
  const moveAtr = move / range;
  if (moveAtr < MIN_MOVE_ATR) return null;
  if (!(first.open > 0)) return null;

  /* The line goes under an up staircase and over a down one — the side the
     steps are standing on, which is the side a reader would draw it. */
  const pivots = run.map((c) => (direction === "up" ? c.low : c.high));
  const fit = fitLine(pivots, startIndex);
  const lineNow = fit.slope * lastIndex + fit.intercept;

  const inDirection = run.filter((c) =>
    direction === "up" ? c.close > c.open : c.close < c.open
  ).length;
  const bodyShare = inDirection / run.length;

  /* Broken once a later bar *closes* through the line. A wick through it is
     the line being tested, which is what lines are for; a close through it is
     the staircase no longer standing on it. */
  let broken = false;
  for (let i = endIndex + 1; i <= lastIndex; i++) {
    const line = fit.slope * i + fit.intercept;
    if (direction === "up" ? candles[i].close < line : candles[i].close > line) {
      broken = true;
      break;
    }
  }

  const score = Math.round(
    100 *
      (0.3 * credit(run.length - MIN_BARS + 1, BARS_MIDPOINT) +
        0.3 * credit(fit.r2, R2_MIDPOINT) +
        0.25 * credit(moveAtr - MIN_MOVE_ATR + 0.5, MOVE_MIDPOINT) +
        0.15 * bodyShare)
  );

  return {
    direction,
    startIndex,
    endIndex,
    startTime: first.time,
    endTime: final.time,
    bars: run.length,
    movePct: (move / first.open) * 100,
    moveAtr,
    r2: fit.r2,
    slopePctPerBar: (fit.slope / first.open) * 100,
    bodyShare,
    lineNow,
    barsSinceEnd: lastIndex - endIndex,
    broken,
    score,
  };
}

/**
 * The run worth showing for one symbol, or null.
 *
 * Prefers a live, unbroken run over a higher-scoring one that has already
 * ended: a scanner exists to say what is happening now, and a ladder that
 * finished twenty bars ago is history however clean it was. Among live runs,
 * and among stale ones, the score decides.
 */
export function strongestLadder(
  candles: Candle[],
  opts: { maxBarsSinceEnd?: number } = {}
): CandleLadder | null {
  const maxSince = opts.maxBarsSinceEnd ?? 2;
  const all = findCandleLadders(candles);
  if (all.length === 0) return null;
  const live = all.filter((l) => l.barsSinceEnd <= maxSince && !l.broken);
  return live[0] ?? all[0];
}
