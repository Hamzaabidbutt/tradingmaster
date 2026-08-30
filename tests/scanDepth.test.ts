import { describe, expect, it } from "vitest";
import { DEFAULT_SCAN_DEPTH, takeDepth } from "@/services/scanService";

/**
 * The sweep used to stop at the top 100 symbols by volume, on the belief that a
 * full pass would blow Binance's rate limit. That belief rested on a wrong
 * weight figure — `/fapi/v1/klines` costs 2 at a 400-bar limit, not 10 — so the
 * cap was answering a narrower question than the UI implied.
 *
 * These pin the sentinel, because "0 means everything" is exactly the kind of
 * convention that gets silently re-read as "nothing".
 */
describe("scan depth", () => {
  const universe = Array.from({ length: 530 }, (_, i) => `SYM${i}`);

  it("defaults to the whole universe", () => {
    expect(DEFAULT_SCAN_DEPTH).toBe(0);
    expect(takeDepth(universe, DEFAULT_SCAN_DEPTH)).toHaveLength(530);
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
