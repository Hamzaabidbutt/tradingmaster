import { describe, expect, it } from "vitest";
import { detectTrendlines } from "@/engines/trendlines";
import { findSwings } from "@/engines/marketStructure";
import { Candle } from "@/engines/types";
import { syntheticCandles } from "./helpers";

/**
 * Any two points define a line, which is exactly why an automatic trendline
 * engine is easy to write and hard to trust. These tests are almost entirely
 * about what it must *refuse* to draw.
 */

const HOUR = 3600;
const t = (i: number) => 1_700_000_000 + i * HOUR;

/**
 * Build a series from a per-bar high and low. Wicks are what trendlines are
 * fitted to, so the fixtures specify them directly rather than deriving them.
 */
function series(n: number, at: (i: number) => { high: number; low: number }): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const { high, low } = at(i);
    const mid = (high + low) / 2;
    out.push({
      time: t(i),
      open: mid - (high - low) * 0.1,
      close: mid + (high - low) * 0.1,
      high,
      low,
      volume: 1000,
      takerBuyVolume: 500,
    });
  }
  return out;
}

/** Swings the way the analyzer finds them. */
function swingsOf(candles: Candle[]) {
  return [
    ...findSwings(candles, 5, "major"),
    ...findSwings(candles, 2, "minor"),
  ].sort((a, b) => a.index - b.index);
}

/**
 * A descending resistance line: highs step down along a straight line, with
 * three clean touches, and price stays under it in between.
 */
function descendingResistance(): Candle[] {
  const line = (i: number) => 120 - i * 0.25;
  return series(120, (i) => {
    // Touch the line at three places; sit well below it everywhere else.
    const touch = i === 12 || i === 48 || i === 88;
    const high = touch ? line(i) : line(i) - 3 - Math.abs(Math.sin(i / 4)) * 2;
    return { high, low: high - 2 };
  });
}

describe("detectTrendlines", () => {
  it("returns nothing on a series too short to hold a trend", () => {
    expect(detectTrendlines(series(10, () => ({ high: 100, low: 99 })), [])).toEqual([]);
  });

  it("returns nothing when there are no swings to anchor to", () => {
    const c = descendingResistance();
    expect(detectTrendlines(c, [])).toEqual([]);
  });

  it("finds a descending resistance line price kept respecting", () => {
    const c = descendingResistance();
    const lines = detectTrendlines(c, swingsOf(c));
    const res = lines.filter((l) => l.kind === "resistance");
    expect(res.length).toBeGreaterThan(0);
    expect(res[0].touches).toBeGreaterThanOrEqual(3);
    expect(res[0].slopePerBar).toBeLessThan(0);
    expect(res[0].broken).toBe(false);
  });

  it("finds an ascending support line", () => {
    const line = (i: number) => 80 + i * 0.2;
    const c = series(120, (i) => {
      const touch = i === 10 || i === 50 || i === 92;
      const low = touch ? line(i) : line(i) + 3 + Math.abs(Math.cos(i / 5)) * 2;
      return { high: low + 2, low };
    });
    const lines = detectTrendlines(c, swingsOf(c)).filter((l) => l.kind === "support");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0].slopePerBar).toBeGreaterThan(0);
  });

  it("refuses a line price traded straight through between its anchors", () => {
    // Two highs that happen to line up, with a much higher spike between them.
    // Connecting them would produce a "resistance" line that resisted nothing.
    const c = series(120, (i) => {
      let high = 100;
      if (i === 20) high = 110;
      if (i === 90) high = 110;
      if (i === 55) high = 125; // straight through the candidate line
      return { high, low: high - 2 };
    });
    const lines = detectTrendlines(c, swingsOf(c));
    const spans = lines.filter(
      (l) => l.kind === "resistance" && l.from.index <= 20 && l.to.index >= 90
    );
    expect(spans).toEqual([]);
  });

  it("refuses a two-point line with no third touch", () => {
    // The classic overfit: two highs, nothing else near the line.
    const c = series(120, (i) => {
      const high = i === 20 ? 110 : i === 90 ? 105 : 90;
      return { high, low: high - 2 };
    });
    const lines = detectTrendlines(c, swingsOf(c));
    for (const l of lines) expect(l.touches).toBeGreaterThanOrEqual(3);
  });

  it("requires the anchors to be far enough apart to be a trend", () => {
    const c = descendingResistance();
    for (const l of detectTrendlines(c, swingsOf(c))) {
      expect(l.to.index - l.from.index).toBeGreaterThanOrEqual(12);
    }
  });

  it("marks a line as broken rather than deleting it", () => {
    // Descending resistance for 90 bars, then price closes decisively above.
    const line = (i: number) => 120 - i * 0.25;
    const c = series(120, (i) => {
      if (i > 95) return { high: 130, low: 126 };
      const touch = i === 12 || i === 48 || i === 88;
      const high = touch ? line(i) : line(i) - 3;
      return { high, low: high - 2 };
    });
    const lines = detectTrendlines(c, swingsOf(c)).filter((l) => l.kind === "resistance");
    expect(lines.length).toBeGreaterThan(0);
    const broken = lines.find((l) => l.broken);
    expect(broken).toBeDefined();
    expect(broken!.brokenTime).not.toBeNull();
    // Where a line failed is a fact worth keeping, so it stays in the output.
    expect(broken!.strength).toBeLessThan(100);
  });

  it("scores a broken line below an intact one with the same touches", () => {
    const c = descendingResistance();
    const intact = detectTrendlines(c, swingsOf(c)).find((l) => !l.broken);
    expect(intact).toBeDefined();
    expect(intact!.strength).toBeGreaterThan(0);
  });

  it("projects the line to the latest bar and measures from current price", () => {
    const c = descendingResistance();
    const [line] = detectTrendlines(c, swingsOf(c));
    expect(line).toBeDefined();
    const last = c[c.length - 1];
    const span = line.to.index - line.from.index;
    const expected =
      line.from.price + ((line.to.price - line.from.price) / span) * (c.length - 1 - line.from.index);
    expect(line.projectedPrice).toBeCloseTo(expected, 6);
    expect(line.distancePct).toBeCloseTo(((expected - last.close) / last.close) * 100, 2);
  });

  it("does not return many near-identical lines for one trend", () => {
    // Every anchor pair along the same line is a candidate; without deduping
    // a single trend would render as a dozen overlapping lines.
    const c = descendingResistance();
    const res = detectTrendlines(c, swingsOf(c)).filter((l) => l.kind === "resistance");
    expect(res.length).toBeLessThanOrEqual(3);
  });

  it("caps output so the chart stays readable", () => {
    for (const seed of [4, 19, 33, 57, 71]) {
      const c = syntheticCandles(300, seed, 100);
      const lines = detectTrendlines(c, swingsOf(c));
      expect(lines.length).toBeLessThanOrEqual(6);
    }
  });

  it("never emits a line with non-finite geometry", () => {
    for (const seed of [2, 15, 28, 44, 63, 88]) {
      const c = syntheticCandles(250, seed, 60);
      for (const l of detectTrendlines(c, swingsOf(c))) {
        for (const v of [l.slopePerBar, l.projectedPrice, l.distancePct, l.strength]) {
          expect(Number.isFinite(v)).toBe(true);
        }
        expect(l.projectedPrice).toBeGreaterThan(0);
        expect(l.touchTimes.length).toBe(l.touches);
        expect(l.to.index).toBeGreaterThan(l.from.index);
      }
    }
  });

  it("survives a flat series without inventing a trend", () => {
    // Every bar identical: there is no trend here, and any line drawn would be
    // an artefact of the tolerance rather than a feature of the market.
    const c = series(150, () => ({ high: 100, low: 99 }));
    const lines = detectTrendlines(c, swingsOf(c));
    for (const l of lines) expect(Math.abs(l.slopePerBar)).toBeLessThan(0.01);
  });
});
