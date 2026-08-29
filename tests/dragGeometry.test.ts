import { describe, expect, it } from "vitest";
import { clampPosition, nextPosition, samePosition } from "@/components/chart/dragGeometry";

const CARD = { width: 248, height: 300 };
const CHART = { width: 1000, height: 600 };

describe("clampPosition", () => {
  it("leaves a position inside the container alone", () => {
    expect(clampPosition({ x: 100, y: 80 }, CARD, CHART)).toEqual({ x: 100, y: 80 });
  });

  it("stops the card leaving the right or bottom edge", () => {
    // 1000 - 248 = 752, 600 - 300 = 300.
    expect(clampPosition({ x: 5000, y: 5000 }, CARD, CHART)).toEqual({ x: 752, y: 300 });
  });

  it("stops the card leaving the top or left edge", () => {
    expect(clampPosition({ x: -40, y: -90 }, CARD, CHART)).toEqual({ x: 0, y: 0 });
  });

  it("does not clamp against a container that has not been laid out", () => {
    // The bug this exists to prevent: ResizeObserver fires the moment it
    // starts observing, which can be before the chart has a size. Clamping
    // then yields max 0 and pins the card to the corner — permanently, since
    // the position is persisted.
    expect(clampPosition({ x: 400, y: 200 }, CARD, { width: 0, height: 0 })).toEqual({
      x: 400,
      y: 200,
    });
    expect(clampPosition({ x: 400, y: 200 }, { width: 0, height: 0 }, CHART)).toEqual({
      x: 400,
      y: 200,
    });
  });

  it("pins to the origin when the card is larger than the container", () => {
    // Nothing better is available, and 0 at least keeps it reachable.
    expect(clampPosition({ x: 50, y: 50 }, { width: 900, height: 900 }, { width: 400, height: 300 }))
      .toEqual({ x: 0, y: 0 });
  });

  it("rounds to whole pixels", () => {
    expect(clampPosition({ x: 10.4, y: 20.6 }, CARD, CHART)).toEqual({ x: 10, y: 21 });
  });
});

describe("nextPosition", () => {
  const origin = { x: 60, y: 120 }; // the chart's top-left in viewport space

  it("keeps the grab point under the cursor", () => {
    // Card grabbed 30px in from its left, 12px down from its top; pointer now
    // at viewport (400, 300) → card corner sits 30/12 up-left of that, then
    // converted into chart-relative coordinates.
    const pos = nextPosition({ x: 400, y: 300 }, { x: 30, y: 12 }, origin, CARD, CHART);
    expect(pos).toEqual({ x: 400 - 60 - 30, y: 300 - 120 - 12 });
  });

  it("does not let a fast drag throw the card out of the chart", () => {
    const pos = nextPosition({ x: 9999, y: 9999 }, { x: 0, y: 0 }, origin, CARD, CHART);
    expect(pos).toEqual({ x: 752, y: 300 });
  });

  it("handles a drag back past the origin", () => {
    const pos = nextPosition({ x: 0, y: 0 }, { x: 30, y: 12 }, origin, CARD, CHART);
    expect(pos).toEqual({ x: 0, y: 0 });
  });
});

describe("samePosition", () => {
  it("compares by value, not identity", () => {
    expect(samePosition({ x: 1, y: 2 }, { x: 1, y: 2 })).toBe(true);
    expect(samePosition({ x: 1, y: 2 }, { x: 1, y: 3 })).toBe(false);
  });
});
