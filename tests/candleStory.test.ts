import { describe, expect, it } from "vitest";
import { buildCandleStory } from "@/engines/candleStory";
import { CandleStats } from "@/engines/candleStats";
import { Candle, FullAnalysis } from "@/engines/types";
import { candle } from "./helpers";

const T0 = 1_700_000_000;
const bars: Candle[] = Array.from({ length: 5 }, (_, i) =>
  candle(T0 + i * 900, 100, 101, 99, 100.5, 1000, 500)
);
const BAR = T0 + 4 * 900;

function stats(over: Partial<CandleStats> = {}): CandleStats {
  return {
    time: BAR,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    range: 2,
    rangePct: 2,
    changePct: 0.5,
    volume: 10_000,
    buyVolume: 3_000,
    sellVolume: 7_000,
    deltaVolume: -4_000,
    buyPct: 30,
    liquidationDelta: 0,
    liquidationCumulative: 0,
    cvd: -5_000,
    bullish: true,
    volumeMultiple: 1,
    ...over,
  };
}

/** An analysis with only the fields the story reads. */
function analysis(over: Record<string, unknown> = {}): FullAnalysis {
  return {
    price: 100.5,
    orderFlowEvents: { absorptions: [], exhaustions: [], trapped: [], deltaSpikeLevels: [] },
    delta: { divergences: [], trapBars: [] },
    srLevels: [],
    volumeProfile: { poc: 100 },
    pressureMap: { whales: [] },
    ...over,
  } as unknown as FullAnalysis;
}

const text = (lines: ReturnType<typeof buildCandleStory>) =>
  lines.map((l) => l.text).join(" ").toLowerCase();

describe("candle story — aggression", () => {
  it("names the aggressor and the delta", () => {
    const s = buildCandleStory(stats(), bars, analysis());
    expect(text(s)).toContain("sellers were the aggressors");
    expect(text(s)).toContain("30%");
  });

  it("calls out delta disagreeing with the body as absorption", () => {
    // Sellers hit the bid all bar, and the candle still closed up.
    const s = buildCandleStory(stats({ bullish: true, deltaVolume: -4000 }), bars, analysis());
    expect(text(s)).toContain("delta and the body disagree");
    expect(text(s)).toContain("absorbed");
  });

  it("does not claim absorption when delta agrees with the body", () => {
    const s = buildCandleStory(stats({ bullish: true, deltaVolume: 4000, buyPct: 70 }), bars, analysis());
    expect(text(s)).not.toContain("delta and the body disagree");
  });

  it("flags heavy volume that went nowhere", () => {
    const s = buildCandleStory(stats({ volumeMultiple: 3.2, rangePct: 0.1 }), bars, analysis());
    expect(text(s)).toContain("3.2×");
    expect(text(s)).toContain("going nowhere");
  });
});

describe("candle story — evidence is bar-specific", () => {
  it("includes an absorption event anchored on this bar", () => {
    const s = buildCandleStory(
      stats(),
      bars,
      analysis({
        orderFlowEvents: {
          absorptions: [{ time: BAR, side: "buy", atKeyLevel: true, strength: 80, explanation: "buyers soaked it up" }],
          exhaustions: [],
          trapped: [],
          deltaSpikeLevels: [],
        },
      })
    );
    expect(text(s)).toContain("buyers soaked it up");
  });

  it("ignores events belonging to a different bar", () => {
    // Ten bars away — a story that swept these in would read as specific
    // while describing something else entirely.
    const s = buildCandleStory(
      stats(),
      bars,
      analysis({
        orderFlowEvents: {
          absorptions: [{ time: BAR - 9000, side: "buy", atKeyLevel: true, strength: 80, explanation: "elsewhere entirely" }],
          exhaustions: [],
          trapped: [],
          deltaSpikeLevels: [],
        },
      })
    );
    expect(text(s)).not.toContain("elsewhere entirely");
  });

  it("reports forced flow on the bar, and its absence", () => {
    const flush = buildCandleStory(stats({ liquidationDelta: -8000 }), bars, analysis());
    expect(text(flush)).toContain("long liquidation");
    expect(text(flush)).toContain("mechanical");

    const quiet = buildCandleStory(stats({ liquidationDelta: 0 }), bars, analysis());
    expect(text(quiet)).toContain("no forced flow");
  });

  it("says so when the bar is outside the analysed window", () => {
    const s = buildCandleStory(stats({ liquidationDelta: null, cvd: null }), bars, analysis());
    expect(text(s)).toContain("outside the analysed window");
  });

  it("mentions a whale print on this bar with its price", () => {
    const s = buildCandleStory(
      stats(),
      bars,
      analysis({
        pressureMap: {
          whales: [
            { time: BAR, price: 100.25, side: "buy", volume: 50_000, multiple: 12, notional: 0, distancePct: -0.2, posture: "defending", note: "" },
          ],
        },
      })
    );
    expect(text(s)).toContain("100.25");
    expect(text(s)).toContain("defending");
  });
});

describe("candle story — honesty", () => {
  const s = buildCandleStory(stats(), bars, analysis());

  it("frames the closing section as what to watch, not what will happen", () => {
    const next = s.filter((l) => l.section === "next");
    expect(next).toHaveLength(1);
    expect(next[0].text.toLowerCase()).toContain("not a forecast");
  });

  it("never asserts an outcome", () => {
    const t = text(s);
    expect(t).not.toContain("will go");
    expect(t).not.toContain("will reverse");
    expect(t).not.toContain("is going to");
    expect(t).not.toMatch(/\bexpect\s+price\b/);
  });

  it("names both the level that confirms and the level that refutes", () => {
    const next = s.find((l) => l.section === "next")!;
    // A bullish bar: the low undoes it, the high carries it.
    expect(next.text).toContain("99");
    expect(next.text).toContain("101");
  });
});

describe("candle story — shape", () => {
  it("always produces an aggression line and a next line", () => {
    const s = buildCandleStory(stats(), bars, null);
    expect(s.some((l) => l.section === "aggression")).toBe(true);
    expect(s.some((l) => l.section === "next")).toBe(true);
  });

  it("works with no analysis at all", () => {
    const s = buildCandleStory(stats(), bars, null);
    expect(s.length).toBeGreaterThan(1);
    expect(s.every((l) => l.text.length > 0)).toBe(true);
  });
});

describe("candle story — wicks", () => {
  it("explains a long upper wick as rejection from above", () => {
    // Body 100–100.2, high 103: most of the range is wick above.
    const s = buildCandleStory(
      stats({ open: 100, close: 100.2, high: 103, low: 99.9, range: 3.1, bullish: true }),
      bars,
      analysis()
    );
    const wick = s.filter((l) => l.section === "wick");
    expect(wick).toHaveLength(1);
    expect(wick[0].text).toContain("Long upper wick");
    expect(wick[0].text).toContain("could not stay");
    expect(wick[0].tone).toBe("bear");
  });

  it("explains a long lower wick as demand found", () => {
    const s = buildCandleStory(
      stats({ open: 100, close: 100.1, high: 100.2, low: 97, range: 3.2, bullish: true }),
      bars,
      analysis()
    );
    const wick = s.find((l) => l.section === "wick")!;
    expect(wick.text).toContain("Long lower wick");
    expect(wick.tone).toBe("bull");
  });

  it("calls wicks on both ends indecision rather than a signal", () => {
    const s = buildCandleStory(
      stats({ open: 100, close: 100.1, high: 101.5, low: 98.5, range: 3, bullish: true }),
      bars,
      analysis()
    );
    const wick = s.find((l) => l.section === "wick")!;
    expect(wick.text).toContain("both");
    expect(wick.text).toContain("not a signal");
  });

  it("says so when a bar is nearly all body", () => {
    const s = buildCandleStory(
      stats({ open: 99, close: 101, high: 101.05, low: 98.95, range: 2.1, bullish: true }),
      bars,
      analysis()
    );
    expect(s.find((l) => l.section === "wick")!.text).toContain("Little wick");
  });
});

describe("candle story — stop hunts", () => {
  /** 25 bars ranging 99–101, then the bar under test. */
  function withRange(high: number, low: number, close: number): Candle[] {
    const prior = Array.from({ length: 25 }, (_, i) =>
      candle(T0 + i * 900, 100, 101, 99, 100, 1000, 500)
    );
    prior.push(candle(T0 + 25 * 900, 100, high, low, close, 3000, 1500));
    return prior;
  }
  const HUNT_BAR = T0 + 25 * 900;

  it("names a sweep of the highs a buy-stop hunt", () => {
    const series = withRange(103, 99.5, 100);
    const s = buildCandleStory(
      stats({ time: HUNT_BAR, high: 103, low: 99.5, close: 100, open: 100 }),
      series,
      analysis()
    );
    const stops = s.find((l) => l.section === "stops")!;
    expect(stops.text).toContain("Buy-stop hunt");
    // The naming is counter-intuitive, so the explanation has to carry it.
    expect(stops.text).toContain("forced buying");
    expect(stops.tone).toBe("bear");
  });

  it("names a sweep of the lows a sell-stop hunt", () => {
    const series = withRange(100.5, 97, 100);
    const s = buildCandleStory(
      stats({ time: HUNT_BAR, high: 100.5, low: 97, close: 100, open: 100 }),
      series,
      analysis()
    );
    const stops = s.find((l) => l.section === "stops")!;
    expect(stops.text).toContain("Sell-stop hunt");
    expect(stops.text).toContain("forced selling");
    expect(stops.tone).toBe("bull");
  });

  it("does not call a clean breakout a stop hunt", () => {
    // Takes out the high and *closes above it* — that is a breakout, and
    // calling every breakout a hunt is how the idea stopped meaning anything.
    const series = withRange(103, 100, 102.8);
    const s = buildCandleStory(
      stats({ time: HUNT_BAR, high: 103, low: 100, close: 102.8, open: 100 }),
      series,
      analysis()
    );
    expect(s.find((l) => l.section === "stops")!.text).toContain("No stop hunt");
  });

  it("reports no hunt when the bar stays inside the prior range", () => {
    const series = withRange(100.8, 99.2, 100.4);
    const s = buildCandleStory(
      stats({ time: HUNT_BAR, high: 100.8, low: 99.2, close: 100.4, open: 100 }),
      series,
      analysis()
    );
    expect(s.find((l) => l.section === "stops")!.text).toContain("No stop hunt");
  });
});

describe("candle story — what the forced flow produced", () => {
  /** A flush bar followed by `after` bars going one way. */
  function withFollowThrough(direction: 1 | -1): Candle[] {
    const out = Array.from({ length: 10 }, (_, i) =>
      candle(T0 + i * 900, 100, 100.5, 99.5, 100, 1000, 500)
    );
    out.push(candle(T0 + 10 * 900, 100, 100.2, 96, 96.5, 8000, 800));
    for (let i = 0; i < 3; i++) {
      const base = direction > 0 ? 97 + i : 95 - i;
      out.push(candle(T0 + (11 + i) * 900, base, base + 0.8, base - 0.8, base, 1200, 600));
    }
    return out;
  }
  const FLUSH = T0 + 10 * 900;

  it("reports a reversal off the flush low as the cohort being cleared", () => {
    const s = buildCandleStory(
      stats({ time: FLUSH, low: 96, high: 100.2, close: 96.5, liquidationDelta: -5000 }),
      withFollowThrough(1),
      analysis()
    );
    const forced = s.filter((l) => l.section === "forced").map((l) => l.text).join(" ");
    expect(forced).toContain("What it produced");
    expect(forced).toContain("cleared");
  });

  it("reports continuation as a leg of the cascade, not the end", () => {
    const s = buildCandleStory(
      stats({ time: FLUSH, low: 96, high: 100.2, close: 96.5, liquidationDelta: -5000 }),
      withFollowThrough(-1),
      analysis()
    );
    const forced = s.filter((l) => l.section === "forced").map((l) => l.text).join(" ");
    expect(forced).toContain("kept going");
    expect(forced).toContain("rather than the end");
  });

  it("declines to judge the newest bar", () => {
    const series = withFollowThrough(1);
    const last = series[series.length - 1];
    const s = buildCandleStory(
      stats({ time: last.time, liquidationDelta: -4000 }),
      series,
      analysis()
    );
    const forced = s.filter((l) => l.section === "forced").map((l) => l.text).join(" ");
    expect(forced).toContain("cannot be read yet");
  });
});
