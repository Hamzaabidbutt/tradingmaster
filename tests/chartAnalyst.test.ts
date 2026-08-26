import { describe, expect, it } from "vitest";
import { analyzeChart } from "@/engines/chartAnalyst";
import { Candle } from "@/engines/types";
import { candle, syntheticCandles } from "./helpers";

const T0 = 1_700_000_000;
const HOUR = 3600;

/** Deterministic pseudo-random so fixtures are reproducible across runs. */
function lcg(seed: number) {
  let s = (seed * 2654435761) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Walks price along straight legs with a little noise so swings are strict. */
class Series {
  bars: Candle[] = [];
  private rnd: () => number;
  constructor(seed: number, private price: number) {
    this.rnd = lcg(seed);
  }
  leg(to: number, bars: number): this {
    const step = (to - this.price) / bars;
    for (let i = 0; i < bars; i++) {
      const open = this.price;
      const close = open + step + (this.rnd() - 0.5) * Math.abs(step) * 0.35;
      const w = Math.abs(step) * (0.15 + this.rnd() * 0.25) + 0.02;
      this.bars.push(
        candle(T0 + this.bars.length * HOUR, open, Math.max(open, close) + w, Math.min(open, close) - w, close, 1000, 500)
      );
      this.price = close;
    }
    return this;
  }
  get last(): number {
    return this.price;
  }
}

/**
 * Deep history containing a repeated V-shaped motif, where `after` decides
 * what followed each occurrence. The series ends on the motif, so the current
 * window IS the pattern and the analogue search has something to find.
 */
function motifHistory(repeats: number, after: (i: number) => "up" | "down", seed = 3): Candle[] {
  const s = new Series(seed, 100);
  for (let r = 0; r < repeats; r++) {
    const p = s.last;
    s.leg(p * 0.92, 15).leg(p, 15); // the motif
    if (after(r) === "up") s.leg(s.last * 1.08, 15);
    else s.leg(s.last * 0.92, 15);
    // Filler that is deliberately not V-shaped, so matches are the motif.
    s.leg(s.last * 1.02, 13).leg(s.last * 0.99, 12);
  }
  const p = s.last;
  return s.leg(p * 0.92, 15).leg(p, 15).bars;
}

describe("chart analyst — analogue search", () => {
  it("finds the planted motif and reads its consistent aftermath", () => {
    const deep = motifHistory(6, () => "up");
    const r = analyzeChart(deep.slice(-240), deep);

    expect(r.historicalMatches.length).toBeGreaterThanOrEqual(3);
    // The plant is a near-identical repeat, so similarity should be high.
    expect(r.historicalMatches[0].similarity).toBeGreaterThanOrEqual(80);
    expect(r.expectedNextMove.direction).toBe("bullish");
    expect(r.expectedNextMove.magnitudePct).toBeGreaterThan(0);
    expect(r.expectedNextMove.target).toBeGreaterThan(deep[deep.length - 1].close);
    // Matches are ordered by closeness.
    const sims = r.historicalMatches.map((m) => m.similarity);
    expect(sims).toEqual([...sims].sort((a, b) => b - a));
  });

  it("mirrors the read when the same motif consistently resolved lower", () => {
    const deep = motifHistory(6, () => "down");
    const r = analyzeChart(deep.slice(-240), deep);
    expect(r.expectedNextMove.direction).toBe("bearish");
    expect(r.expectedNextMove.magnitudePct).toBeLessThan(0);
    expect(r.bearishScenario.probability).toBeGreaterThan(r.bullishScenario.probability);
  });

  it("loses confidence and refuses a direction when the analogues disagree", () => {
    const agree = analyzeChart(motifHistory(6, () => "up").slice(-240), motifHistory(6, () => "up"));
    const split = motifHistory(6, (i) => (i % 2 === 0 ? "up" : "down"));
    const disagree = analyzeChart(split.slice(-240), split);

    // Same shape, same sample size — only the outcomes differ.
    expect(disagree.confidence).toBeLessThan(agree.confidence);
    // With the past split down the middle, claiming a direction would be a lie.
    expect(disagree.expectedNextMove.direction).toBe("neutral");
    // And an abstention must not be dressed up as a level: a target equal to
    // spot reads as a real number when it is really "no answer".
    expect(disagree.expectedNextMove.target).toBeNull();
    expect(disagree.expectedNextMove.invalidation).toBeNull();
    expect(disagree.expectedNextMove.rationale.join(" ")).toContain("no target or invalidation");
    // The directional case still projects both.
    expect(agree.expectedNextMove.target).not.toBeNull();
    expect(agree.expectedNextMove.invalidation).not.toBeNull();
  });

  it("never reaches certainty, and keeps the two scenarios complementary", () => {
    for (let seed = 1; seed <= 5; seed++) {
      const deep = motifHistory(6, () => "up", seed);
      const r = analyzeChart(deep.slice(-240), deep);
      expect(r.confidence).toBeLessThanOrEqual(88);
      expect(r.bullishScenario.probability + r.bearishScenario.probability).toBe(100);
    }
  });
});

describe("chart analyst — independence", () => {
  /**
   * The spec's hard constraint: this module reads the chart and nothing else.
   * That is enforced structurally — `analyzeChart` accepts only candles — so
   * the test asserts the observable consequence: order-flow information can be
   * changed arbitrarily and the analysis cannot move.
   */
  it("ignores order-flow information entirely", () => {
    const deep = motifHistory(5, () => "up");
    const cs = deep.slice(-240);

    // Same OHLC, wildly different volume / taker-buy split. If any of this
    // leaked into the analysis, these two results would diverge.
    const heavyBuying = cs.map((c) => ({ ...c, volume: c.volume * 9, takerBuyVolume: c.volume * 8.9 }));
    const heavySelling = cs.map((c) => ({ ...c, volume: c.volume * 9, takerBuyVolume: c.volume * 0.1 }));

    const a = analyzeChart(heavyBuying, deep);
    const b = analyzeChart(heavySelling, deep);

    expect(a.expectedNextMove).toEqual(b.expectedNextMove);
    expect(a.confidence).toBe(b.confidence);
    expect(a.historicalMatches).toEqual(b.historicalMatches);
    expect(a.currentPattern.shapes).toEqual(b.currentPattern.shapes);
    expect(a.bullishScenario).toEqual(b.bullishScenario);
  });

  it("is a pure function of its candles — repeat calls agree exactly", () => {
    const deep = motifHistory(5, () => "down", 11);
    expect(analyzeChart(deep.slice(-240), deep)).toEqual(analyzeChart(deep.slice(-240), deep));
  });
});

describe("chart analyst — degradation", () => {
  it("returns an honest empty read below 30 bars instead of inventing one", () => {
    const r = analyzeChart(syntheticCandles(20));
    expect(r.historicalMatches).toHaveLength(0);
    expect(r.expectedNextMove.direction).toBe("neutral");
    expect(r.confidence).toBe(5);
    expect(r.currentPattern.priceAction.join(" ")).toContain("30 bars");
  });

  it("works without a deep series, falling back to the candles it was given", () => {
    const cs = syntheticCandles(300, 5);
    const r = analyzeChart(cs);
    expect(r.historyBars).toBe(cs.length);
    expect(r.windowBars).toBeGreaterThanOrEqual(12);
    expect(r.windowBars).toBeLessThanOrEqual(30);
    expect(r.patternExplanation.length).toBeGreaterThan(0);
    expect(r.confidence).toBeGreaterThanOrEqual(5);
  });

  it("keeps every match's forward window strictly outside the current one", () => {
    const deep = motifHistory(6, () => "up");
    const cs = deep.slice(-240);
    const r = analyzeChart(cs, deep);
    const currentStart = deep.length - r.windowBars;
    for (const m of r.historicalMatches) {
      // A match that overlapped the present would be scoring against itself.
      expect(m.startIndex + r.windowBars).toBeLessThanOrEqual(currentStart);
      expect(m.similarity).toBeGreaterThanOrEqual(35);
      expect(m.endTime).toBeGreaterThan(m.startTime);
    }
  });
});
