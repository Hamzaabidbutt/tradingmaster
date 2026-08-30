import { describe, expect, it } from "vitest";
import { nextHoveredTime, shouldReleaseHover } from "@/components/chart/hoverState";

/**
 * The inspector floats over the chart it reads from, and its header and story
 * panel take pointer events. Crossing onto either makes the chart report both
 * "crosshair is over no bar" and "pointer left the container" — two signals
 * indistinguishable from the user genuinely leaving. Acting on them snapped
 * the panel back to the live bar, which read as the inspector refusing to
 * track that candle.
 */
describe("nextHoveredTime", () => {
  it("takes the bar the crosshair reports", () => {
    expect(nextHoveredTime(1700, null, false)).toBe(1700);
    expect(nextHoveredTime(1700, 1600, false)).toBe(1700);
  });

  it("clears the hover when the crosshair leaves the bars", () => {
    expect(nextHoveredTime(null, 1600, false)).toBeNull();
  });

  it("keeps the bar when the pointer has moved onto the card", () => {
    // The whole fix: the chart says "no bar" because the pointer is on the
    // panel, not because the user stopped inspecting.
    expect(nextHoveredTime(null, 1600, true)).toBe(1600);
  });

  it("still tracks a new bar while over the card", () => {
    // Over the card but the crosshair found a bar anyway — that is a real
    // reading and must win over the held value.
    expect(nextHoveredTime(1700, 1600, true)).toBe(1700);
  });

  it("does not invent a hover from nothing", () => {
    expect(nextHoveredTime(null, null, true)).toBeNull();
    expect(nextHoveredTime(null, null, false)).toBeNull();
  });
});

describe("shouldReleaseHover", () => {
  /** Minimal stand-in for the containment check the DOM would do. */
  const node = (contains: (n: Node) => boolean) => ({ contains }) as unknown as Node;
  const stranger = {} as Node;

  it("releases when the pointer genuinely leaves the chart", () => {
    expect(shouldReleaseHover(stranger, node(() => false), false)).toBe(true);
  });

  it("releases when the pointer leaves the window entirely", () => {
    // null relatedTarget means there is no element being entered.
    expect(shouldReleaseHover(null, node(() => false), false)).toBe(true);
  });

  it("holds when the pointer moved onto the card", () => {
    expect(shouldReleaseHover(stranger, node(() => true), false)).toBe(false);
  });

  it("holds when the card already reported the pointer over it", () => {
    // Belt and braces: the flag alone is enough, even if `relatedTarget` is
    // missing or the root ref has not been published yet.
    expect(shouldReleaseHover(null, null, true)).toBe(false);
    expect(shouldReleaseHover(stranger, null, true)).toBe(false);
  });

  it("releases when there is no card to move onto", () => {
    expect(shouldReleaseHover(stranger, null, false)).toBe(true);
  });
});
