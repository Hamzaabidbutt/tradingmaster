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
