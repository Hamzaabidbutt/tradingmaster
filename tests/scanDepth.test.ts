import { describe, expect, it } from "vitest";
import { DEFAULT_SCAN_DEPTH, takeDepth } from "@/services/scanService";

/**
 * The default depth is bounded for latency, not for rate limits: a 400-bar
 * klines call costs 2 weight, so a full ~530-symbol pass fits the budget
 * comfortably — it just takes long enough that the page feels broken. Callers
 * that want everything pass `depth=0`.
 *
 * These pin the sentinel, because "0 means everything" is exactly the kind of
 * convention that gets silently re-read as "nothing".
 */
describe("scan depth", () => {
  const universe = Array.from({ length: 530 }, (_, i) => `SYM${i}`);

  it("defaults to a bounded prefix rather than the whole universe", () => {
    // Full coverage is affordable on Binance weight but slow enough in wall
    // clock that every scan felt broken. The bound is about latency, and the
    // sentinel below is what lets a caller opt back into everything.
    expect(DEFAULT_SCAN_DEPTH).toBeGreaterThan(0);
    expect(takeDepth(universe, DEFAULT_SCAN_DEPTH)).toHaveLength(DEFAULT_SCAN_DEPTH);
  });

  it("treats zero as all, never as none", () => {
    // The failure this guards is silent and total: a `slice(0, 0)` returns an
    // empty array, and every scanner would report "0 scanned" as if the market
    // had nothing in it.
    expect(takeDepth(universe, 0)).toHaveLength(530);
    expect(takeDepth(universe, undefined)).toHaveLength(530);
    expect(takeDepth(universe, -5)).toHaveLength(530);
  });

  it("still honours an explicit limit", () => {
    expect(takeDepth(universe, 50)).toHaveLength(50);
    expect(takeDepth(universe, 50)[0]).toBe("SYM0");
  });

  it("does not pad when the limit exceeds the universe", () => {
    expect(takeDepth(universe, 9999)).toHaveLength(530);
  });

  it("preserves volume order, which is what makes a truncated sweep usable", () => {
    const taken = takeDepth(universe, 10);
    expect(taken).toEqual(universe.slice(0, 10));
  });
});
