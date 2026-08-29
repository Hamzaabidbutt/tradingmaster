import { describe, expect, it } from "vitest";
import { splitCvdByDirection, SeriesPoint } from "@/components/chart/cvdSeries";

const hasValue = (p: SeriesPoint): p is { time: number; value: number } => "value" in p;
const values = (points: SeriesPoint[]) => points.filter(hasValue).map((p) => p.time);

function series(...cvd: number[]) {
  return cvd.map((v, i) => ({ time: i, cvd: v }));
}

describe("cvd colour split", () => {
  it("puts a purely rising line entirely in the up series", () => {
    const { up, down } = splitCvdByDirection(series(1, 2, 3, 4));
    expect(values(up)).toEqual([0, 1, 2, 3]);
    expect(values(down)).toEqual([]);
    // The down series still carries whitespace at every time, so the two
    // series stay aligned on the same scale.
    expect(down).toHaveLength(4);
  });

  it("puts a purely falling line entirely in the down series", () => {
    const { up, down } = splitCvdByDirection(series(4, 3, 2, 1));
    expect(values(down)).toEqual([0, 1, 2, 3]);
    expect(values(up)).toEqual([]);
  });

  it("shares the turning point with both series so the join has no gap", () => {
    // Rises to index 2, then falls. Index 2 must appear in both.
    const { up, down } = splitCvdByDirection(series(1, 2, 3, 2, 1));
    expect(values(up)).toEqual([0, 1, 2]);
    expect(values(down)).toEqual([2, 3, 4]);
  });

  it("handles a line that turns repeatedly", () => {
    const { up, down } = splitCvdByDirection(series(1, 3, 1, 3, 1));
    expect(values(up)).toEqual([0, 1, 2, 3]);
    expect(values(down)).toEqual([1, 2, 3, 4]);
  });

  it("emits whitespace rather than omitting points, so lines break instead of jumping", () => {
    const { down } = splitCvdByDirection(series(1, 2, 3, 4));
    // Every timestamp is present; none carries a value.
    expect(down.map((p) => p.time)).toEqual([0, 1, 2, 3]);
    expect(down.some(hasValue)).toBe(false);
  });

  it("treats a flat step as rising rather than dropping it from both", () => {
    // Neither series may skip a point — a flat segment still has to be drawn.
    const { up, down } = splitCvdByDirection(series(5, 5, 5));
    expect(values(up)).toEqual([0, 1, 2]);
    expect(values(down)).toEqual([]);
  });

  it("survives an empty series and a single point", () => {
    expect(splitCvdByDirection([])).toEqual({ up: [], down: [] });
    const one = splitCvdByDirection(series(7));
    expect(values(one.up)).toEqual([0]);
    expect(one.down).toHaveLength(1);
  });

  it("keeps both series the same length as the input", () => {
    const input = series(1, 5, 2, 9, 9, 3, 4);
    const { up, down } = splitCvdByDirection(input);
    expect(up).toHaveLength(input.length);
    expect(down).toHaveLength(input.length);
  });

  it("covers every segment — no segment is left uncoloured", () => {
    const input = series(1, 5, 2, 9, 9, 3, 4);
    const { up, down } = splitCvdByDirection(input);
    for (let i = 1; i < input.length; i++) {
      const inUp = hasValue(up[i - 1]) && hasValue(up[i]);
      const inDown = hasValue(down[i - 1]) && hasValue(down[i]);
      expect(inUp || inDown).toBe(true);
    }
  });
});
