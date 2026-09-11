/**
 * Keeping marker labels off each other.
 *
 * lightweight-charts draws a marker's text centred under (or over) its bar and
 * makes no attempt to avoid collisions. That is fine when marks are rare, but
 * this chart puts absorption, exhaustion, traps, sweeps, structure breaks,
 * shakeouts and aggressive bars in the same two lanes — and order-flow events
 * cluster by nature. Five consecutive bars of buy absorption is one story, and
 * the library renders it as five overlapping labels that smear into a solid
 * unreadable block. That is exactly what happened at the bottom of the value
 * edge setup: `SUPPLY ABSORBED ★` printed three times across adjacent bars with
 * `SELLERS TRAPPED` underneath, and not one of the four could be read.
 *
 * The per-engine run collapsers (`strongestPerRun`, `strongestSqueezePerRun`)
 * already fix this *within* one kind of event. They cannot fix it across kinds,
 * because no engine knows what the others are about to draw. This does, because
 * it runs last, over the finished list.
 *
 * ## What it does
 *
 * Reserves a horizontal span for each label it keeps and refuses to place a
 * later one that would overlap. Contested space goes to the higher-priority
 * marker, so what survives a crowded area is the trap rather than the third
 * aggressive-bar label.
 *
 * ## What it deliberately does not do
 *
 * Invent a measurement. When the bar spacing is unknown — before the chart has
 * laid out, or on a series too short to measure — nothing is dropped. A chart
 * that silently hides events because it could not work out how wide they were
 * is worse than a crowded one.
 */

/** Structural shape this module needs; a superset of the library's marker. */
export interface PlaceableMarker {
  /** unix seconds */
  time: number;
  position: "aboveBar" | "belowBar" | "inBar";
  text?: string;
  /**
   * Higher wins a contested slot. Absent is treated as 0, so a caller that
   * sets no priorities gets plain newest-first behaviour rather than an error.
   */
  priority?: number;
}

export interface ThinOptions {
  /** horizontal pixels between two adjacent bars at the current zoom */
  pxPerBar: number;
  /** seconds between two adjacent bars on this timeframe */
  barSeconds: number;
  /**
   * Approximate width of one character at the marker font size. The library
   * renders marker text at the layout font size (12px) in the chart's sans
   * stack; these labels are upper-case, which is wider than the average glyph,
   * so this errs high on purpose. Too small and labels still touch.
   */
  charPx?: number;
  /** breathing room either side of a label, plus the shape's own glyph */
  padPx?: number;
}

const DEFAULT_CHAR_PX = 7.2;
const DEFAULT_PAD_PX = 14;

/**
 * The horizontal span one marker needs, in seconds of chart time.
 *
 * Textless markers still occupy their shape, so they get the padding alone
 * rather than zero — two arrows drawn on top of each other are as unreadable
 * as two labels.
 */
function spanSeconds(marker: PlaceableMarker, opts: Required<ThinOptions>): number {
  const textPx = (marker.text?.length ?? 0) * opts.charPx;
  const widthPx = textPx + opts.padPx;
  return (widthPx / opts.pxPerBar) * opts.barSeconds;
}

/**
 * Drop markers whose labels would overlap one already placed.
 *
 * Pure. Returns a new array sorted ascending by time, which is what
 * `setMarkers` requires; the input is left alone.
 */
export function thinMarkers<T extends PlaceableMarker>(markers: T[], opts: ThinOptions): T[] {
  const byTime = (a: T, b: T) => a.time - b.time;
  // No usable measurement — see the note above on not hiding events on a guess.
  if (!Number.isFinite(opts.pxPerBar) || opts.pxPerBar <= 0) return [...markers].sort(byTime);
  if (!Number.isFinite(opts.barSeconds) || opts.barSeconds <= 0) return [...markers].sort(byTime);

  const resolved: Required<ThinOptions> = {
    pxPerBar: opts.pxPerBar,
    barSeconds: opts.barSeconds,
    charPx: opts.charPx ?? DEFAULT_CHAR_PX,
    padPx: opts.padPx ?? DEFAULT_PAD_PX,
  };

  /* Lanes do not collide with each other: a label above the bar and one below
     it are drawn in different bands, so they may share an x position. */
  const lanes = new Map<string, T[]>();
  for (const m of markers) {
    const lane = lanes.get(m.position);
    if (lane) lane.push(m);
    else lanes.set(m.position, [m]);
  }

  const kept: T[] = [];
  for (const lane of lanes.values()) {
    /* Priority first, then recency. Recency is the right tie-break because a
       marker's usefulness decays: what happened four bars ago is a live read,
       what happened ninety bars ago is history the user can zoom into. */
    const order = [...lane].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || b.time - a.time);
    const taken: { from: number; to: number }[] = [];

    for (const m of order) {
      const half = spanSeconds(m, resolved) / 2;
      const from = m.time - half;
      const to = m.time + half;
      if (taken.some((t) => from < t.to && to > t.from)) continue;
      taken.push({ from, to });
      kept.push(m);
    }
  }

  return kept.sort(byTime);
}

/**
 * Bar interval in seconds, as the median gap between consecutive bars.
 *
 * The median rather than the first gap: exchange downtime and the occasional
 * missing bar leave holes in the series, and a single sampled gap that happens
 * to land on one would report a 4-hour timeframe as daily.
 */
export function barIntervalSeconds(times: number[]): number {
  if (times.length < 2) return 0;
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return 0;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}
