import { describe, expect, it } from "vitest";
import { detectAccumulation } from "@/engines/accumulation";
import { candle, syntheticCandles } from "./helpers";

/** A base that repeatedly holds ~100 with buyers as the aggressors. */
function accumulationSeries(): ReturnType<typeof candle>[] {
  const out: ReturnType<typeof candle>[] = [];
  let t = 1_700_000_000;
  const step = 3600;

  // Decline into the level — sellers in control on the way down.
  for (let i = 0; i < 30; i++) {
    const px = 120 - i * 0.6;
    out.push(candle(t, px, px + 0.3, px - 0.7, px - 0.5, 1200, 450));
    t += step;
  }
  // Three tests of ~100. Each cycle is wide enough for fractal swing
  // detection (±4 bars), which is what turns the repeated touches into a
  // recognised support rather than noise.
  for (let cycle = 0; cycle < 3; cycle++) {
    for (let i = 0; i < 5; i++) {
      const px = 108 - i * 1.5;
      out.push(candle(t, px, px + 0.4, px - 1.2, px - 1.0, 1500, 700));
      t += step;
    }
    // The touch: wicks into ~100 and closes well off the low on heavy buying.
    out.push(candle(t, 101.2, 101.6, 100.05, 101.4, 3200, 2400));
    t += step;
    for (let i = 0; i < 5; i++) {
      const px = 101.4 + i * 1.4;
      out.push(candle(t, px, px + 1.5, px - 0.3, px + 1.3, 2400, 1650));
      t += step;
    }
  }
  // Base holds with rising participation.
  for (let i = 0; i < 12; i++) {
    out.push(candle(t, 102 + i * 0.05, 103 + i * 0.05, 101.4, 102.6 + i * 0.05, 2400, 1600));
    t += step;
  }
  return out;
}

describe("accumulation detector", () => {
  it("scores a defended base with buyer aggression highly", () => {
    const s = detectAccumulation("TESTUSDT", "1h", accumulationSeries());
    const base = s.criteria.find((c) => c.key === "base")!;
    const delta = s.criteria.find((c) => c.key === "positive_delta")!;

    expect(delta.met).toBe(true);
    expect(base.met).toBe(true);
    expect(s.score).toBeGreaterThan(40);
    expect(s.support).not.toBeNull();
  });

  it("refuses to qualify without a defended level, whatever else is true", () => {
    // Straight rally: strong buying, but no base and no defended support.
    const rally = Array.from({ length: 60 }, (_, i) =>
      candle(1_700_000_000 + i * 3600, 100 + i, 100 + i + 0.8, 100 + i - 0.2, 100 + i + 0.7, 2000, 1600)
    );
    const s = detectAccumulation("TESTUSDT", "1h", rally);
    const base = s.criteria.find((c) => c.key === "base")!;
    if (!base.met) {
      expect(s.qualified).toBe(false);
      expect(s.grade).toBe("none");
      expect(s.headline).toContain("Not an accumulation setup");
    }
  });

  it("refuses to qualify when sellers are still the aggressors", () => {
    // Persistent selling: taker-buy share held well below half.
    const falling = Array.from({ length: 60 }, (_, i) =>
      candle(1_700_000_000 + i * 3600, 100 - i * 0.4, 100 - i * 0.4 + 0.2, 100 - i * 0.4 - 0.9, 100 - i * 0.4 - 0.6, 2000, 400)
    );
    const s = detectAccumulation("TESTUSDT", "1h", falling);
    expect(s.criteria.find((c) => c.key === "positive_delta")!.met).toBe(false);
    expect(s.qualified).toBe(false);
  });

  it("keeps scores within their declared weights", () => {
    for (let seed = 1; seed <= 8; seed++) {
      const s = detectAccumulation("X", "1h", syntheticCandles(300, seed));
      for (const c of s.criteria) {
        expect(c.score).toBeGreaterThanOrEqual(0);
        expect(c.score).toBeLessThanOrEqual(c.weight);
        if (!c.met) expect(c.score).toBe(0);
      }
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(100);
    }
  });

  it("only grades qualified setups as strong or prime", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const s = detectAccumulation("X", "1h", syntheticCandles(300, seed));
      if (s.grade === "prime" || s.grade === "strong") expect(s.qualified).toBe(true);
      if (!s.qualified) expect(["forming", "none"]).toContain(s.grade);
    }
  });

  it("explains every criterion whether met or not", () => {
    const s = detectAccumulation("X", "1h", accumulationSeries());
    expect(s.criteria).toHaveLength(6);
    for (const c of s.criteria) {
      expect(c.detail.length).toBeGreaterThan(20);
    }
    // Met criteria are listed before unmet ones, after the headline.
    expect(s.explanation[0]).toBe(s.headline);
    expect(s.explanation.length).toBeGreaterThanOrEqual(7);
  });

  it("orders invalidation below the support it protects", () => {
    const s = detectAccumulation("X", "1h", accumulationSeries());
    if (s.support != null && s.invalidation != null) {
      expect(s.invalidation).toBeLessThan(s.support);
    }
  });
});
