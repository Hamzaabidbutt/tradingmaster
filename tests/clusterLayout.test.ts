import { describe, expect, it } from "vitest";
import { clusterFit, deltaHeat, mergeRows, volumeHeat, widestLabel } from "@/components/chart/clusterLayout";

/**
 * The rule this enforces is that nothing is drawn unless it can be read. A
 * smear of overlapping digits across the candles is worse than the candles
 * alone, because it hides the price action it was meant to annotate — so the
 * tests that matter most are the refusals.
 */

describe("clusterFit — when it refuses", () => {
  it("refuses a bar with no rows", () => {
    expect(clusterFit(120, 400, 0, 4).show).toBe(false);
  });

  it("refuses an unmeasurable bar", () => {
    expect(clusterFit(0, 400, 12, 4).show).toBe(false);
    expect(clusterFit(NaN, 400, 12, 4).show).toBe(false);
    expect(clusterFit(120, 0, 12, 4).show).toBe(false);
    expect(clusterFit(120, NaN, 12, 4).show).toBe(false);
  });

  it("refuses a bar too short to hold even a few rows", () => {
    // 20px of height cannot hold three readable rows at any row count.
    const fit = clusterFit(200, 20, 12, 4);
    expect(fit.show).toBe(false);
    expect(fit.reason).toMatch(/zoom in/i);
  });

  it("refuses a bar too narrow for two columns", () => {
    const fit = clusterFit(4, 400, 12, 4);
    expect(fit.show).toBe(false);
    expect(fit.reason).toMatch(/zoom in/i);
  });

  it("refuses when the figures would be smaller than legible", () => {
    // Wide enough rows, but five-digit figures in a 20px bar means ~2px text.
    const fit = clusterFit(20, 400, 12, 5);
    expect(fit.show).toBe(false);
    expect(fit.reason).toMatch(/too small to read/i);
  });

  it("gives a reason whenever it refuses", () => {
    for (const fit of [
      clusterFit(200, 20, 12, 4),
      clusterFit(4, 400, 12, 4),
      clusterFit(20, 400, 12, 5),
      clusterFit(120, 400, 0, 4),
    ]) {
      expect(fit.show).toBe(false);
      expect(fit.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("clusterFit — when it fits", () => {
  it("accepts a genuinely zoomed-in bar", () => {
    const fit = clusterFit(140, 480, 12, 4);
    expect(fit.show).toBe(true);
    expect(fit.reason).toBe("");
    expect(fit.fontPx).toBeGreaterThanOrEqual(7);
    expect(fit.rowHeight).toBeCloseTo(40, 5);
  });

  it("splits the width into two columns", () => {
    const fit = clusterFit(140, 480, 12, 4);
    expect(fit.columnWidth * 2).toBeLessThan(140);
    expect(fit.columnWidth).toBeGreaterThan(60);
  });

  it("never exceeds the largest useful font", () => {
    expect(clusterFit(2000, 4000, 12, 4).fontPx).toBeLessThanOrEqual(11);
  });

  it("shrinks the font for wider figures in the same space", () => {
    // A symbol trading in millions must not clip against one trading in tens.
    const narrow = clusterFit(140, 480, 12, 3);
    const wide = clusterFit(140, 480, 12, 8);
    expect(wide.fontPx).toBeLessThanOrEqual(narrow.fontPx);
  });

  it("caps the font by row height so text does not overflow sideways", () => {
    // A very wide bar with short rows: height, not width, has to decide.
    const fit = clusterFit(600, 132, 12, 4);
    expect(fit.show).toBe(true);
    expect(fit.fontPx).toBeLessThanOrEqual(fit.rowHeight);
  });

  it("merges levels rather than refusing when twelve will not fit", () => {
    /* The footprint engine builds a fixed twelve rows whatever the candle's
       height. Demanding all twelve made the overlay appear only on unusually
       tall candles and look broken everywhere else. */
    const fit = clusterFit(140, 60, 12, 4);
    expect(fit.show).toBe(true);
    expect(fit.merged).toBe(true);
    expect(fit.rowsToDraw).toBeLessThan(12);
    expect(fit.rowsToDraw).toBeGreaterThanOrEqual(3);
  });

  it("draws every level when they all fit", () => {
    const fit = clusterFit(140, 480, 12, 4);
    expect(fit.rowsToDraw).toBe(12);
    expect(fit.merged).toBe(false);
  });

  it("never draws more rows than the bar has levels", () => {
    const fit = clusterFit(140, 2000, 6, 4);
    expect(fit.rowsToDraw).toBe(6);
    expect(fit.merged).toBe(false);
  });

  it("keeps every row at or above the legible height", () => {
    for (const range of [40, 60, 90, 150, 300, 900]) {
      const fit = clusterFit(160, range, 12, 4);
      if (fit.show) expect(fit.rowHeight).toBeGreaterThanOrEqual(10);
    }
  });

  it("never accepts a row height it will then reject for its font", () => {
    /* The two constants are the same constraint from either end, and setting
       them apart let them contradict: a 9px row passed the height check and
       produced a 6px font that failed the legibility check, so the overlay
       drew nothing at any zoom. Every accepted fit must clear both. */
    for (let range = 20; range <= 1200; range += 7) {
      for (const width of [60, 90, 140, 260, 500]) {
        const fit = clusterFit(width, range, 12, 4);
        if (!fit.show) continue;
        expect(fit.fontPx).toBeGreaterThanOrEqual(7);
        expect(fit.rowsToDraw).toBeGreaterThanOrEqual(3);
        expect(fit.rowHeight * fit.rowsToDraw).toBeCloseTo(range, 5);
      }
    }
  });

  it("accepts the shape a real zoomed-in bar actually has", () => {
    // ~80px wide, ~119px tall, four-character figures: the case that used to
    // fall into the gap between the two constants.
    const fit = clusterFit(80, 119, 12, 4);
    expect(fit.show).toBe(true);
    expect(fit.fontPx).toBeGreaterThanOrEqual(7);
  });

  it("is monotone in width — more room never means less font", () => {
    let previous = 0;
    for (const w of [80, 120, 200, 400, 800]) {
      const fit = clusterFit(w, 480, 12, 4);
      expect(fit.fontPx).toBeGreaterThanOrEqual(previous);
      previous = fit.fontPx;
    }
  });
});

describe("volumeHeat", () => {
  it("is relative to the bar's own heaviest level", () => {
    // Normalising across the window would leave a quiet bar uniformly dim and
    // hide its internal structure entirely.
    expect(volumeHeat(500, 1000)).toBe(0.5);
    expect(volumeHeat(1000, 1000)).toBe(1);
  });

  it("is zero for an empty level or an empty bar", () => {
    expect(volumeHeat(0, 1000)).toBe(0);
    expect(volumeHeat(500, 0)).toBe(0);
    expect(volumeHeat(-5, 1000)).toBe(0);
  });

  it("never exceeds one", () => {
    expect(volumeHeat(5000, 1000)).toBe(1);
  });
});

describe("deltaHeat", () => {
  it("keeps the sign so the colour can come from it", () => {
    expect(deltaHeat(500, 1000)).toBe(0.5);
    expect(deltaHeat(-500, 1000)).toBe(-0.5);
  });

  it("clamps to the unit range both ways", () => {
    expect(deltaHeat(9000, 1000)).toBe(1);
    expect(deltaHeat(-9000, 1000)).toBe(-1);
  });

  it("is zero when there is nothing to scale against", () => {
    expect(deltaHeat(500, 0)).toBe(0);
    expect(deltaHeat(NaN, 1000)).toBe(0);
  });
});

describe("widestLabel", () => {
  it("measures the rendered string, not the number", () => {
    // A column sized for "2412" clips "-1341", which is the figure a reader
    // most wants to see.
    const fmt = (v: number) => v.toFixed(0);
    expect(widestLabel([2412, -1341], fmt)).toBe(5);
  });

  it("pays for a thousands separator when the format adds one", () => {
    const fmt = (v: number) => v.toLocaleString("en-US");
    expect(widestLabel([1234567], fmt)).toBe("1,234,567".length);
  });

  it("never returns zero", () => {
    expect(widestLabel([], (v) => String(v))).toBe(1);
  });
});

describe("mergeRows", () => {
  const volumes = [10, 20, 30, 40, 50, 60];
  const deltas = [1, -2, 3, -4, 5, -6];

  it("returns the levels untouched when they all fit", () => {
    const rows = mergeRows(volumes, deltas, 6);
    expect(rows.map((r) => r.volume)).toEqual(volumes);
    expect(rows.every((r) => r.levels === 1)).toBe(true);
  });

  it("returns the levels untouched when asked for more rows than there are", () => {
    expect(mergeRows(volumes, deltas, 99)).toHaveLength(6);
  });

  it("sums volume and delta into each bucket", () => {
    const rows = mergeRows(volumes, deltas, 3);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.volume)).toEqual([30, 70, 110]);
    expect(rows.map((r) => r.delta)).toEqual([-1, -1, -1]);
  });

  it("conserves the totals whatever the row count", () => {
    const totalV = volumes.reduce((a, b) => a + b, 0);
    const totalD = deltas.reduce((a, b) => a + b, 0);
    for (const target of [1, 2, 3, 4, 5, 6]) {
      const rows = mergeRows(volumes, deltas, target);
      expect(rows.reduce((a, r) => a + r.volume, 0)).toBe(totalV);
      expect(rows.reduce((a, r) => a + r.delta, 0)).toBe(totalD);
    }
  });

  it("merges only adjacent levels, in order", () => {
    // The rows are a price ladder: a bucket spanning non-adjacent levels would
    // put volume from two separate prices on one line and label it with neither.
    const rows = mergeRows([1, 2, 4, 8, 16, 32], [0, 0, 0, 0, 0, 0], 2);
    expect(rows[0].volume).toBe(1 + 2 + 4);
    expect(rows[1].volume).toBe(8 + 16 + 32);
  });

  it("spreads the remainder instead of dumping it on the last row", () => {
    /* Twelve levels in five rows as four twos and one four would make the top
       of every bar look like its heaviest level. */
    const twelve = Array.from({ length: 12 }, () => 1);
    const rows = mergeRows(twelve, twelve, 5);
    const sizes = rows.map((r) => r.levels);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });

  it("returns nothing for nothing", () => {
    expect(mergeRows([], [], 4)).toEqual([]);
    expect(mergeRows(volumes, deltas, 0)).toEqual([]);
  });
});
