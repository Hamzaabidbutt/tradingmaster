/**
 * Splitting the cumulative-delta line into rising and falling segments.
 *
 * lightweight-charts line series carry one colour for the whole series, so a
 * two-tone line means two series drawn over the same points, each blank where
 * the other is live.
 *
 * The subtlety is the *transition* point. A point where the line changes
 * direction belongs to a rising segment on one side and a falling segment on
 * the other, so it has to appear in **both** series — otherwise each line stops
 * one point short and the join shows as a gap. Whitespace (`{ time }` with no
 * value) is what breaks a line cleanly; omitting the point entirely makes
 * lightweight-charts connect straight across the hole instead, which is worse
 * than the gap it was meant to avoid.
 */

export interface CvdInput {
  time: number;
  cvd: number;
}

/** A value point, or whitespace that breaks the line at this timestamp. */
export type SeriesPoint = { time: number; value: number } | { time: number };

export interface SplitCvd {
  /** segments where cumulative delta rose */
  up: SeriesPoint[];
  /** segments where it fell */
  down: SeriesPoint[];
}

export function splitCvdByDirection(series: CvdInput[]): SplitCvd {
  const up: SeriesPoint[] = [];
  const down: SeriesPoint[] = [];
  if (series.length === 0) return { up, down };

  // A single point has no direction; give it to `up` so it is still drawn
  // rather than silently vanishing.
  if (series.length === 1) {
    up.push({ time: series[0].time, value: series[0].cvd });
    down.push({ time: series[0].time });
    return { up, down };
  }

  /** Is the segment ending at index `i` a rising one? */
  const risingInto = (i: number) => series[i].cvd >= series[i - 1].cvd;

  for (let i = 0; i < series.length; i++) {
    const before = i > 0 ? risingInto(i) : null;
    const after = i < series.length - 1 ? risingInto(i + 1) : null;
    // Belongs to a series if either adjoining segment is of that direction.
    const inUp = before === true || after === true;
    const inDown = before === false || after === false;

    up.push(inUp ? { time: series[i].time, value: series[i].cvd } : { time: series[i].time });
    down.push(inDown ? { time: series[i].time, value: series[i].cvd } : { time: series[i].time });
  }
  return { up, down };
}
