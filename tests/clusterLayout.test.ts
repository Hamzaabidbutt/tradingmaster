import { describe, expect, it } from "vitest";
import { clusterFit, deltaHeat, mergeRows, volumeHeat, widestLabel } from "@/components/chart/clusterLayout";

/**
 * Two rules pull against each other here.
 *
 * No unreadable figures: a smear of overlapping digits across the candles is
 * worse than the candles alone, because it hides the price action it was meant
 * to annotate. And no unreachable feature: the first version of this enforced
 * the first rule with a single threshold — two columns of figures or nothing —
 * which needed fifty pixels of bar and so printed "zoom in" at every zoom
 * anybody trades at.
 *
 * The ladder is how both hold. Figures appear only where they can be read;
 * below that the cells stay and only the text goes. So the tests that matter
 * are which rung a given bar lands on, and that the refusal rung is reached
 * only when there is genuinely nothing left to draw.
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

  it("refuses a bar too short to hold even a few cells", () => {
    // 5px of height cannot hold three cells even at the heat rung.
    const fit = clusterFit(200, 5, 12, 4);
    expect(fit.show).toBe(false);
    expect(fit.mode).toBe("none");
    expect(fit.reason).toMatch(/zoom in/i);
  });

  it("refuses a bar thinner than a single cell", () => {
    const fit = clusterFit(2, 400, 12, 4);
    expect(fit.show).toBe(false);
    expect(fit.mode).toBe("none");
    expect(fit.reason).toMatch(/zoom in/i);
  });

  it("gives a reason whenever it refuses", () => {
    for (const fit of [
      clusterFit(200, 5, 12, 4),
      clusterFit(2, 400, 12, 4),
      clusterFit(120, 400, 0, 4),
    ]) {
      expect(fit.show).toBe(false);
      expect(fit.reason.length).toBeGreaterThan(0);
    }
  });

  it("never returns a reason for a rung that drew something", () => {
    for (const [w, h] of [[140, 480], [30, 480], [6, 300], [4, 120]] as const) {
      const fit = clusterFit(w, h, 12, 4);
      if (fit.show) expect(fit.reason).toBe("");
    }
  });
});

describe("clusterFit — the ladder", () => {
  it("gives the widest bars both columns", () => {
    expect(clusterFit(140, 480, 12, 4).mode).toBe("double");
  });

  it("drops to one column before it drops the figures", () => {
    /* The gap between the two rungs is the whole point: a bar that cannot hold
       two four-digit columns can very often hold one. */
    const fit = clusterFit(30, 480, 12, 4);
    expect(fit.mode).toBe("single");
    expect(fit.fontPx).toBeGreaterThanOrEqual(7);
    expect(fit.columnWidth).toBe(30);
  });

  it("drops to heat rather than to nothing at a real trading zoom", () => {
    /* ~6px per bar is roughly 140 bars on a 900px chart, which is what people
       actually look at. The old single-threshold rule drew nothing here, so
       the toggle appeared broken at every usable zoom. */
    const fit = clusterFit(6, 300, 12, 4);
    expect(fit.show).toBe(true);
    expect(fit.mode).toBe("heat");
    expect(fit.fontPx).toBe(0);
    expect(fit.rowsToDraw).toBeGreaterThanOrEqual(3);
  });

  it("claims no text it cannot draw", () => {
    // fontPx is what the painter sets on the context; heat must report none.
    for (let w = 3; w <= 200; w += 1) {
      const fit = clusterFit(w, 400, 12, 4);
      if (fit.mode === "heat") expect(fit.fontPx).toBe(0);
      if (fit.mode !== "heat" && fit.show) expect(fit.fontPx).toBeGreaterThanOrEqual(7);
    }
  });

  it("is monotone in width — a wider bar never shows less", () => {
    /* Zooming in must never take information away. Rank the rungs and check
       the sequence only ever climbs. */
    const rank = { none: 0, heat: 1, single: 2, double: 3 };
    let previous = 0;
    for (let w = 2; w <= 300; w += 2) {
      const r = rank[clusterFit(w, 480, 12, 4).mode];
      expect(r).toBeGreaterThanOrEqual(previous);
      previous = r;
    }
  });

  it("keeps the heat rung reachable for tall thin bars", () => {
    const fit = clusterFit(4, 120, 12, 4);
    expect(fit.mode).toBe("heat");
    expect(fit.rowHeight * fit.rowsToDraw).toBeCloseTo(120, 5);
  });

  it("gives every drawn rung a block that exactly covers the bar's range", () => {
    for (let h = 6; h <= 600; h += 13) {
      for (const w of [4, 8, 20, 40, 90, 200]) {
        const fit = clusterFit(w, h, 12, 4);
        if (!fit.show) continue;
        expect(fit.rowHeight * fit.rowsToDraw).toBeCloseTo(h, 5);
        expect(fit.rowsToDraw).toBeGreaterThanOrEqual(3);
        expect(fit.rowsToDraw).toBeLessThanOrEqual(12);
      }
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
       drew nothing at any zoom. Every rung that prints text must clear both. */
    for (let range = 20; range <= 1200; range += 7) {
      for (const width of [60, 90, 140, 260, 500]) {
        const fit = clusterFit(width, range, 12, 4);
        if (!fit.show) continue;
        if (fit.mode !== "heat") expect(fit.fontPx).toBeGreaterThanOrEqual(7);
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
