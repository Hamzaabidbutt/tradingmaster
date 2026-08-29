import { describe, expect, it } from "vitest";
import { analyzeMarket } from "@/engines/analyzer";
import { syntheticCandles } from "./helpers";

/**
 * The feed's contract is that every line can be placed on the chart it
 * describes. That means two timestamps per insight, not one: the candle the
 * observation is about, and the moment the reading was produced. These tests
 * guard that separation, since collapsing it is the easy regression — the two
 * are equal on the live bar, so a bug only shows on older evidence.
 */
describe("insight bar anchoring", () => {
  const candles = syntheticCandles(300, 17, 100);
  const analysis = analyzeMarket("TESTUSDT", "1h", candles);
  const barTimes = new Set(candles.map((c) => c.time));
  const lastBar = candles[candles.length - 1].time;

  it("produces a feed", () => {
    expect(analysis.insights.length).toBeGreaterThan(0);
  });

  it("attributes older evidence to the bar it came from", () => {
    // Without this the suite would pass on a build that stamped every line
    // with the live bar: `barsAgo` would be uniformly 0 and every other
    // assertion here would still hold. At least one observation in this
    // fixture is genuinely historical, and must be reported as such.
    expect(analysis.insights.some((i) => i.barsAgo > 0)).toBe(true);
  });

  it("anchors every insight to a real candle in the series", () => {
    for (const ins of analysis.insights) {
      expect(barTimes.has(ins.barTime)).toBe(true);
    }
  });

  it("never claims a bar in the future", () => {
    for (const ins of analysis.insights) {
      expect(ins.barTime).toBeLessThanOrEqual(lastBar);
    }
  });

  it("keeps barsAgo consistent with barTime", () => {
    const indexOf = new Map(candles.map((c, i) => [c.time, i]));
    const lastIdx = candles.length - 1;
    for (const ins of analysis.insights) {
      expect(ins.barsAgo).toBe(lastIdx - indexOf.get(ins.barTime)!);
      expect(ins.barsAgo).toBeGreaterThanOrEqual(0);
    }
  });

  it("labels the bar with the timeframe it belongs to", () => {
    for (const ins of analysis.insights) {
      expect(ins.barTimeframe).toBe("1h");
    }
  });

  it("separates the reading time from the candle time", () => {
    // `time` is when the analysis ran, so it is uniform across the feed and
    // independent of which bar each observation came from.
    const readTimes = new Set(analysis.insights.map((i) => i.time));
    expect(readTimes.size).toBe(1);
    expect([...readTimes][0]).toBe(analysis.generatedAt);
  });

  it("gives every line a bounded conviction figure", () => {
    for (const ins of analysis.insights) {
      expect(ins.confidence).toBeGreaterThanOrEqual(0);
      expect(ins.confidence).toBeLessThanOrEqual(100);
      expect(Number.isInteger(ins.confidence)).toBe(true);
    }
  });

  it("ranks critical evidence above routine context", () => {
    const rank = { critical: 0, warning: 1, info: 2 } as const;
    for (let i = 1; i < analysis.insights.length; i++) {
      const prev = analysis.insights[i - 1];
      const curr = analysis.insights[i];
      expect(rank[prev.severity]).toBeLessThanOrEqual(rank[curr.severity]);
      if (prev.severity === curr.severity) {
        expect(prev.confidence).toBeGreaterThanOrEqual(curr.confidence);
      }
    }
  });

  it("counts confluence by distinct category, not by line", () => {
    const composite = analysis.insights.find((i) => i.category === "signal");
    expect(composite).toBeDefined();
    const text = composite!.detail;
    const match = text.match(/(\d+) distinct categor/);
    if (match) {
      const claimed = Number(match[1]);
      const categories = new Set(
        analysis.insights.filter((i) => i.confidence >= 55 && i.bias !== "neutral").map((i) => i.category)
      );
      // The claim can never exceed the number of categories in the feed —
      // that is the check that stops six order-flow lines reading as six
      // independent confirmations.
      expect(claimed).toBeLessThanOrEqual(categories.size);
    }
  });

  it("does not present conviction as odds of profit", () => {
    const composite = analysis.insights.find((i) => i.category === "signal")!;
    expect(composite.detail).toMatch(/not the odds a trade works/i);
  });
});
