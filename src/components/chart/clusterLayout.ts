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
 * ## The zoom rule, and why it is a ladder rather than a threshold
 *
 * Figures only draw when there is genuinely room for them. A smear of
 * overlapping digits across the candles is worse than the candles alone,
 * because it hides the price action it was meant to annotate.
 *
 * That rule used to be a single threshold — two columns of figures, or
 * nothing — and the arithmetic made it unreachable. Two four-digit columns
 * need about fifty pixels of bar, which is eighteen bars across a nine-hundred
 * pixel chart. Nobody trades at eighteen bars on screen, so in practice the
 * toggle printed "zoom in" forever and never drew anything at any zoom a
 * person actually uses. A feature that cannot be reached is not a careful
 * feature, it is a broken one.
 *
 * So the refusal is now the last rung of a ladder rather than the first:
 *
 * - `double` — volume and delta side by side. What the terminals show, and
 *   what the widest bars still get.
 * - `single` — one column across the bar: the volume figure, in a cell
 *   coloured by that level's delta. Half the pixels, most of the information.
 * - `heat`  — no figures at all. Each level is one cell, its hue from the
 *   sign of the delta and its opacity from the volume, which is a cluster
 *   heatmap and is legible down to a few pixels of bar width.
 * - `none`  — genuinely nothing to show: fewer than three levels would fit,
 *   or the bar is thinner than a hairline.
 *
 * Every rung is honest about what it is: the heat rung claims nothing
 * numeric, so there are no unreadable digits to mislead anyone.
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
/**
 * Height of one price row when the cells carry no text.
 *
 * A heat cell has nothing to read, so the only thing it owes the eye is being
 * distinguishable from its neighbours. Two pixels is that floor.
 */
const HEAT_ROW_PX = 2;
/** Below this a bar is a hairline and its cells would be invisible anyway. */
const MIN_HEAT_WIDTH_PX = 3;

/**
 * How much of the footprint a bar has room to show.
 *
 * Ordered by how much it claims: `double` prints two figures per level,
 * `single` one, `heat` none, `none` draws nothing at all.
 */
export type ClusterMode = "double" | "single" | "heat" | "none";

export interface ClusterFit {
  /** what to draw — see {@link ClusterMode} */
  mode: ClusterMode;
  /** false when there is not enough room; nothing should be drawn */
  show: boolean;
  /** 0 in `heat` mode, where there is no text */
  fontPx: number;
  /**
   * Width of one column, in px.
   *
   * In `double` mode that is half the bar, less the gap between the pair. In
   * `single` and `heat` modes there is one column and this is the whole bar,
   * so a painter can lay out every mode from the same two numbers.
   */
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
 * Largest legible font for a figure of `digits` characters in a cell of the
 * given size, or 0 when no legible size fits.
 *
 * Capped by the row height as well as the column width, so tall rows on a
 * narrow bar do not print text that overflows sideways.
 */
function fontFor(usableWidthPx: number, rowHeightPx: number, digits: number): number {
  if (!(usableWidthPx > 0) || !(digits > 0)) return 0;
  const byWidth = usableWidthPx / (digits * CHAR_W_RATIO);
  const byHeight = rowHeightPx * ROW_TEXT_RATIO;
  const px = Math.floor(Math.min(byWidth, byHeight, MAX_FONT_PX));
  return px >= MIN_FONT_PX ? px : 0;
}

/**
 * Decide how much of a bar's footprint fits, and at what size.
 *
 * Pure. `barRangePx` is the pixel height of the bar's own high-to-low span,
 * which is what the rows have to divide up — not the height of the pane.
 *
 * `longestDigits` matters because the columns are sized to the widest figure
 * they will actually hold: sizing to a fixed guess either wastes half the bar
 * on a symbol trading in hundreds or clips the figures on one trading in
 * millions.
 *
 * Tries the rungs of the ladder in order and returns the first that fits, so
 * the display gets coarser as the bars narrow instead of disappearing. See the
 * module comment for why that ladder exists.
 */
export function clusterFit(
  barWidthPx: number,
  barRangePx: number,
  rows: number,
  longestDigits: number
): ClusterFit {
  const none = (reason: string): ClusterFit => ({
    mode: "none",
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
  const textRows = Math.min(rows, Math.floor(barRangePx / MIN_ROW_PX));
  if (textRows >= MIN_ROWS) {
    const rowHeight = barRangePx / textRows;
    const shared = { rowHeight, rowsToDraw: textRows, merged: textRows < rows, reason: "" };

    // Two columns plus the gap have to fit inside the bar's own width.
    const pairWidth = (barWidthPx - COLUMN_GAP_PX) / 2;
    const pairFont = fontFor(pairWidth - CELL_PAD_PX * 2, rowHeight, longestDigits);
    if (pairFont > 0) {
      return { mode: "double", show: true, fontPx: pairFont, columnWidth: pairWidth, ...shared };
    }

    /* One column across the whole bar. Half the pixels of the pair and most of
       the information: the figure is the volume at that level and the cell it
       sits in is coloured by the level's delta, so the reader still gets both
       numbers, one of them as colour. */
    const soloFont = fontFor(barWidthPx - CELL_PAD_PX * 2, rowHeight, longestDigits);
    if (soloFont > 0) {
      return { mode: "single", show: true, fontPx: soloFont, columnWidth: barWidthPx, ...shared };
    }
  }

  /* No figures fit. A heat cell has nothing to read, so it survives down to a
     couple of pixels a row and a few pixels of width — which is the zoom
     people actually trade at, and where this overlay used to give up. */
  const heatRows = Math.min(rows, Math.floor(barRangePx / HEAT_ROW_PX));
  if (barWidthPx >= MIN_HEAT_WIDTH_PX && heatRows >= MIN_ROWS) {
    return {
      mode: "heat",
      show: true,
      fontPx: 0,
      columnWidth: barWidthPx,
      rowHeight: barRangePx / heatRows,
      rowsToDraw: heatRows,
      merged: heatRows < rows,
      reason: "",
    };
  }

  return none(
    barWidthPx < MIN_HEAT_WIDTH_PX
      ? "Zoom in — the bars are thinner than a cluster cell."
      : "Zoom in — the bar is too short to hold even a few price levels."
  );
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
