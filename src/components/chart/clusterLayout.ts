/**
 * Printing the footprint onto the candles themselves.
 *
 * The footprint panel already holds every number this draws. The difference is
 * *where*: reading a level off a grid in a panel means matching a price in one
 * place against a candle in another, which nobody does mid-chart. Printed on
 * the bar, the volume and delta at each price sit next to the wick that made
 * them, which is the whole reason professional order-flow terminals put them
 * there.
 *
 * Two columns per bar, as on those terminals: traded volume at that price on
 * the left, net delta on the right. Both are heat-shaded, because a column of
 * twelve four-digit numbers is not readable as numbers — the eye finds the hot
 * cell first and reads the figure second.
 *
 * ## The zoom rule
 *
 * This only draws when there is genuinely room for it. Twelve rows of two
 * numbers needs both a wide bar and a tall one, and below either threshold the
 * honest thing is to draw nothing at all: a smear of overlapping digits across
 * the candles is worse than the candles alone, and it hides the price action
 * it was supposed to annotate. That is the same rule the numeric rows at the
 * bottom of the chart already follow.
 */

/** Smallest legible font for the cell figures. */
const MIN_FONT_PX = 7;
/** Above this the digits stop getting more readable and just take more room. */
const MAX_FONT_PX = 11;
/**
 * Share of a row's height the text may occupy, leaving the rest as breathing
 * space between the figure and the cell edges.
 */
const ROW_TEXT_RATIO = 0.7;
/**
 * A row shorter than this cannot hold a legible line of text.
 *
 * Derived from the font floor rather than picked independently, because the
 * two constants are the same constraint seen from either end and setting them
 * apart lets them contradict. They did: at 9px a row was tall enough to pass
 * the height check and then produced a 6px font, which failed the legibility
 * check — so every bar that merged down to the minimum row height was accepted
 * by one rule and rejected by the next, and the overlay drew nothing at any
 * zoom. Deriving it means that cannot happen again.
 */
const MIN_ROW_PX = Math.ceil(MIN_FONT_PX / ROW_TEXT_RATIO);
/** Rough width of one character in the monospace stack, per px of font size. */
const CHAR_W_RATIO = 0.62;
/** Padding inside each cell, both sides. */
const CELL_PAD_PX = 3;
/**
 * Gap between the volume column and the delta column.
 *
 * Exported because the painter has to place the second column at exactly the
 * offset the fit calculation reserved for it. A second copy of this number in
 * the drawing code is a copy that drifts, and the symptom would be a one-pixel
 * overlap nobody traces back to here.
 */
export const COLUMN_GAP_PX = 2;

export interface ClusterFit {
  /** false when there is not enough room; nothing should be drawn */
  show: boolean;
  fontPx: number;
  /** width of each of the two columns, in px */
  columnWidth: number;
  /** height of one price row, in px */
  rowHeight: number;
  /**
   * How many rows to actually draw.
   *
   * Not always the number of footprint levels. The footprint engine builds a
   * fixed twelve rows per candle whatever that candle's height, so a small bar
   * asks for twelve rows inside twenty pixels and could never qualify — which
   * made the whole overlay appear only on unusually tall candles and look
   * broken everywhere else. When twelve will not fit, adjacent levels are
   * merged into as many rows as the bar can hold, and the display gets coarser
   * rather than vanishing.
   */
  rowsToDraw: number;
  /** true when levels were merged to make them fit */
  merged: boolean;
  /** why it refused, for a tooltip or a legend — empty when it did not */
  reason: string;
}

/** Below this many rows the bar says too little to be worth the ink. */
const MIN_ROWS = 3;

/**
 * Decide whether the cluster numbers fit, and at what size.
 *
 * Pure. `barRangePx` is the pixel height of the bar's own high-to-low span,
 * which is what the rows have to divide up — not the height of the pane.
 *
 * `longestDigits` matters because the columns are sized to the widest figure
 * they will actually hold: sizing to a fixed guess either wastes half the bar
 * on a symbol trading in hundreds or clips the figures on one trading in
 * millions.
 */
export function clusterFit(
  barWidthPx: number,
  barRangePx: number,
  rows: number,
  longestDigits: number
): ClusterFit {
  const none = (reason: string): ClusterFit => ({
    show: false,
    fontPx: 0,
    columnWidth: 0,
    rowHeight: 0,
    rowsToDraw: 0,
    merged: false,
    reason,
  });

  if (rows <= 0) return none("No footprint rows for this bar.");
  if (!Number.isFinite(barWidthPx) || barWidthPx <= 0) return none("Bar width unknown.");
  if (!Number.isFinite(barRangePx) || barRangePx <= 0) return none("Bar has no height to divide.");

  /* Fit the rows to the bar rather than the bar to the rows. Twelve levels
     inside twenty pixels is not a display, so the levels are merged down to
     however many the bar can actually hold. */
  const rowsToDraw = Math.min(rows, Math.floor(barRangePx / MIN_ROW_PX));
  if (rowsToDraw < MIN_ROWS) {
    return none("Zoom in — the bar is too short to hold even a few readable price levels.");
  }
  const rowHeight = barRangePx / rowsToDraw;

  // Two columns plus the gap have to fit inside the bar's own width.
  const columnWidth = (barWidthPx - COLUMN_GAP_PX) / 2;
  const usable = columnWidth - CELL_PAD_PX * 2;
  if (usable <= 0) return none("Zoom in — the bar is too narrow for two columns.");

  /* Size the text to the widest figure the column will hold, then cap it by
     the row height so tall rows on a narrow bar do not print text that
     overflows sideways. */
  const byWidth = usable / (longestDigits * CHAR_W_RATIO);
  const byHeight = rowHeight * ROW_TEXT_RATIO;
  const fontPx = Math.floor(Math.min(byWidth, byHeight, MAX_FONT_PX));

  if (fontPx < MIN_FONT_PX) {
    return none("Zoom in — the figures would be too small to read.");
  }

  return {
    show: true,
    fontPx,
    columnWidth,
    rowHeight,
    rowsToDraw,
    merged: rowsToDraw < rows,
    reason: "",
  };
}

/**
 * Heat for the volume column, 0-1.
 *
 * Relative to the heaviest level in the *same bar*, not across the chart. A
 * bar's own point of control is the thing worth finding when your eye lands on
 * it, and normalising across the window would leave every level of a quiet bar
 * uniformly dim and hide its internal structure entirely.
 */
export function volumeHeat(volume: number, barMax: number): number {
  if (!(volume > 0) || !(barMax > 0)) return 0;
  return Math.min(1, volume / barMax);
}

/**
 * Heat for the delta column, −1 to 1.
 *
 * Signed, so a consumer can pick the colour from the sign and the intensity
 * from the magnitude. Normalised against the largest absolute delta in the
 * same bar for the same reason the volume column is.
 */
export function deltaHeat(delta: number, barMaxAbs: number): number {
  if (!(barMaxAbs > 0) || !Number.isFinite(delta)) return 0;
  const scaled = delta / barMaxAbs;
  return Math.max(-1, Math.min(1, scaled));
}

/**
 * Digits in the widest figure a set of cells will print.
 *
 * Counts the rendered string rather than the number, so a minus sign and a
 * thousands separator are both paid for — a column sized for "2412" clips
 * "-1341", which is exactly the figure a reader most wants to see.
 */
export function widestLabel(values: number[], format: (v: number) => string): number {
  let widest = 1;
  for (const v of values) {
    const len = format(v).length;
    if (len > widest) widest = len;
  }
  return widest;
}

/* ------------------------------------------------------------------ *
 * Merging levels down to the rows that fit
 * ------------------------------------------------------------------ */

export interface MergedRow {
  volume: number;
  delta: number;
  /** how many footprint levels went into this row */
  levels: number;
}

/**
 * Collapse a bar's price levels into `targetRows` contiguous buckets.
 *
 * Adjacent levels only, and in the order given, because the rows are a price
 * ladder: merging non-adjacent levels would put volume from two separate
 * prices on one line and label it with neither. Volume and delta are summed,
 * which is the only correct aggregation for both — a merged row is genuinely
 * "everything that traded between these two prices".
 *
 * Buckets are sized to distribute the remainder rather than dumping it on the
 * last row: with twelve levels in five rows, four rows of two and one of four
 * would make the bottom of every bar look like its heaviest level.
 */
export function mergeRows(volumes: number[], deltas: number[], targetRows: number): MergedRow[] {
  const n = Math.min(volumes.length, deltas.length);
  if (n === 0 || targetRows <= 0) return [];
  if (targetRows >= n) {
    return volumes.slice(0, n).map((v, i) => ({ volume: v, delta: deltas[i], levels: 1 }));
  }

  const out: MergedRow[] = [];
  for (let r = 0; r < targetRows; r++) {
    // Proportional boundaries spread the remainder evenly across the ladder.
    const from = Math.floor((r * n) / targetRows);
    const to = Math.floor(((r + 1) * n) / targetRows);
    let volume = 0;
    let delta = 0;
    for (let i = from; i < to; i++) {
      volume += volumes[i];
      delta += deltas[i];
    }
    out.push({ volume, delta, levels: Math.max(0, to - from) });
  }
  return out;
}
