import { describe, expect, it } from "vitest";
import { detectBullishEngulfing } from "@/engines/engulfing";
import { Candle } from "@/engines/types";
import { candle, syntheticCandles } from "./helpers";

/**
 * The engine's whole value is in what it *rejects*. The raw pattern is three
 * comparisons and will match on a few hundred perpetuals at any given close,
 * so these tests concentrate on the filters rather than on the shape.
 */

/**
 * The bar under test is always the *second to last*, so every fixture ends
 * with this quiet forming bar. Leaving it out would push the engulfing into
 * the unclosed slot the engine deliberately ignores.
 */
const FORMING = candle(0, 101, 101.4, 100.6, 100.9, 900, 450);

/** Flat base, then the tail bars are placed explicitly. */
function series(tail: Candle[]): Candle[] {
  const base = syntheticCandles(40, 7, 100);
  const start = base.length;
  return [
    ...base,
    ...tail.map((c, i) => ({ ...c, time: 1_700_000_000 + (start + i) * 3600 })),
  ];
}

describe("detectBullishEngulfing", () => {
  it("scores the last closed bar, not the forming one", () => {
    const s = series([
      candle(0, 100, 100.5, 97, 97.5, 1000, 300), // previous: bearish
      candle(0, 97.2, 101.5, 97, 101, 3000, 2400), // engulfing, closed
      candle(0, 101, 101.4, 100.6, 100.9, 900, 450), // forming — must be ignored
    ]);
    const r = detectBullishEngulfing("TESTUSDT", "4h", s);
    expect(r.engulfed).toBe(true);
    // The bar reported is the closed one, not the last element.
    expect(r.time).toBe(s[s.length - 2].time);
    expect(r.barsAgo).toBe(1);
  });

  it("does not fire when the forming bar is the only engulfing one", () => {
    const s = series([
      candle(0, 100, 100.5, 99.5, 100.1, 1000, 500),
      candle(0, 100.1, 100.3, 98, 98.2, 1000, 300), // last closed: bearish
      candle(0, 98, 101, 97.9, 100.9, 3000, 2400), // engulfing but unclosed
    ]);
    expect(detectBullishEngulfing("TESTUSDT", "4h", s).engulfed).toBe(false);
  });

  it("refuses to qualify a bar whose delta went the other way", () => {
    // Same shape as the confirming case, but taker buy volume is a minority:
    // the bar closed up because the seller stopped, not because buyers took it.
    const s = series([
      candle(0, 100, 100.5, 97, 97.5, 1000, 300),
      candle(0, 97.2, 101.5, 97, 101, 3000, 600), // 20% taker buy → negative delta
      FORMING,
    ]);
    const r = detectBullishEngulfing("TESTUSDT", "4h", s);
    expect(r.engulfed).toBe(true);
    expect(r.deltaConfirms).toBe(false);
    expect(r.qualified).toBe(false);
    expect(r.explanation.join(" ")).toMatch(/net \*selling\*|closed up on net/);
  });

  it("flags the full-range form separately from the body-only form", () => {
    const bodyOnly = detectBullishEngulfing(
      "TESTUSDT",
      "4h",
      series([
        candle(0, 100, 103, 96, 97.5, 1000, 300), // wide wicks
        candle(0, 97.2, 101.5, 97, 101, 3000, 2400), // covers body, not range
        FORMING,
      ])
    );
    const fullRange = detectBullishEngulfing(
      "TESTUSDT",
      "4h",
      series([
        candle(0, 100, 100.6, 97, 97.5, 1000, 300),
        candle(0, 97.2, 101.5, 96.5, 101, 3000, 2400), // takes out both extremes
        FORMING,
      ])
    );
    expect(bodyOnly.fullRange).toBe(false);
    expect(fullRange.fullRange).toBe(true);
    expect(fullRange.score).toBeGreaterThan(bodyOnly.score);
  });

  it("reports nothing when the last closed bar is not an engulfing", () => {
    const r = detectBullishEngulfing("TESTUSDT", "4h", syntheticCandles(60, 3, 100));
    if (!r.engulfed) {
      expect(r.qualified).toBe(false);
      expect(r.grade).toBe("none");
      expect(r.score).toBe(0);
    }
  });

  it("does not throw on short history", () => {
    const r = detectBullishEngulfing("TESTUSDT", "4h", syntheticCandles(5, 1, 100));
    expect(r.engulfed).toBe(false);
    expect(r.headline).toMatch(/history/i);
  });

  it("keeps score, grade and qualification consistent", () => {
    const s = series([
      candle(0, 100, 100.5, 97, 97.5, 1000, 300),
      candle(0, 97.2, 101.5, 96.9, 101, 3000, 2500),
      FORMING,
    ]);
    const r = detectBullishEngulfing("TESTUSDT", "4h", s);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
    if (r.qualified) {
      expect(["prime", "strong"]).toContain(r.grade);
      expect(r.deltaConfirms).toBe(true);
      expect(r.invalidation).not.toBeNull();
    } else {
      expect(["forming", "none"]).toContain(r.grade);
    }
  });

  it("qualifies a full-range engulfing that flow confirms", () => {
    // The positive path, asserted explicitly rather than left to the
    // conditional check above: without this, every filter test would still
    // pass if the engine simply never qualified anything.
    const s = series([
      candle(0, 100, 100.4, 96.5, 96.8, 1200, 240), // decisive bearish bar
      candle(0, 96.6, 103, 96.2, 102.6, 4000, 3400), // swallows it whole, on buying
      FORMING,
    ]);
    const r = detectBullishEngulfing("TESTUSDT", "4h", s);
    expect(r.engulfed).toBe(true);
    expect(r.deltaConfirms).toBe(true);
    expect(r.fullRange).toBe(true);
    expect(r.qualified).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(62);
  });

  it("puts invalidation at the engulfing bar's own low", () => {
    const s = series([
      candle(0, 100, 100.5, 97, 97.5, 1000, 300),
      candle(0, 97.2, 101.5, 96.4, 101, 3000, 2500),
      FORMING,
    ]);
    const r = detectBullishEngulfing("TESTUSDT", "4h", s);
    expect(r.invalidation).toBe(96.4);
  });
});
