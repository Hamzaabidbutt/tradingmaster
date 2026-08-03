import { describe, expect, it } from "vitest";
import { canApplyLiveFrame, selectBarsToAppend } from "@/components/chart/feed";
import { candle } from "./helpers";

const bars = (times: number[]) => times.map((t) => candle(t, 100, 101, 99, 100));

describe("chart feed reconciliation", () => {
  it("returns everything when the series is empty", () => {
    const { bars: out, nextHead } = selectBarsToAppend(bars([10, 20, 30]), 0);
    expect(out).toHaveLength(3);
    expect(nextHead).toBe(30);
  });

  it("appends only bars at or after the series head", () => {
    const { bars: out, nextHead } = selectBarsToAppend(bars([10, 20, 30, 40]), 30);
    expect(out.map((b) => b.time)).toEqual([30, 40]);
    expect(nextHead).toBe(40);
  });

  it("never regresses the head when a stale poll arrives", () => {
    // The websocket already opened bar 50; a cached REST response ends at 40.
    const { bars: out, nextHead } = selectBarsToAppend(bars([10, 20, 30, 40]), 50);
    expect(out).toHaveLength(0);
    // This is the regression: the head must stay at 50, not fall back to 40.
    expect(nextHead).toBe(50);
  });

  it("stays consistent across a stale poll followed by a fresh one", () => {
    let head = 50;
    // Stale response — nothing to push, head holds.
    head = selectBarsToAppend(bars([30, 40]), head).nextHead;
    expect(head).toBe(50);
    // Fresh response catches up; only bars >= head are pushed.
    const fresh = selectBarsToAppend(bars([40, 50, 60]), head);
    expect(fresh.bars.map((b) => b.time)).toEqual([50, 60]);
    expect(fresh.nextHead).toBe(60);
  });

  it("allows re-updating the head bar itself (final values on close)", () => {
    const { bars: out, nextHead } = selectBarsToAppend(bars([40, 50]), 50);
    expect(out.map((b) => b.time)).toEqual([50]);
    expect(nextHead).toBe(50);
  });

  it("handles an empty candle array without moving the head", () => {
    const { bars: out, nextHead } = selectBarsToAppend([], 50);
    expect(out).toHaveLength(0);
    expect(nextHead).toBe(50);
  });
});

describe("live frame gating", () => {
  it("refuses frames while the series is empty", () => {
    expect(canApplyLiveFrame(100, 0)).toBe(false);
  });

  it("accepts the current bar and newer bars", () => {
    expect(canApplyLiveFrame(50, 50)).toBe(true);
    expect(canApplyLiveFrame(60, 50)).toBe(true);
  });

  it("rejects stale frames from a reconnect or a previous symbol", () => {
    expect(canApplyLiveFrame(40, 50)).toBe(false);
  });
});
