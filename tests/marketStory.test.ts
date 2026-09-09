import { describe, expect, it } from "vitest";
import { buildMarketStory, StoryInputs } from "@/engines/marketStory";
import { Candle, DeltaAnalysis, LiquidationDeltaPoint, VwapResult } from "@/engines/types";

/**
 * A four-act structure can be imposed on any chart if you squint, which would
 * make it decoration rather than a read. So the tests that matter most are the
 * ones asserting a boring market produces a boring story — one phase, and an
 * interpretation that says nothing happened.
 */

const T0 = 1_700_000_000;
const HOUR = 3600;

function bars(specs: { c: number; buyShare?: number; v?: number }[]): Candle[] {
  return specs.map((s, i) => {
    const v = s.v ?? 1000;
    return {
      time: T0 + i * HOUR,
      open: i === 0 ? s.c : specs[i - 1].c,
      high: Math.max(s.c, i === 0 ? s.c : specs[i - 1].c) * 1.002,
      low: Math.min(s.c, i === 0 ? s.c : specs[i - 1].c) * 0.998,
      close: s.c,
      volume: v,
      takerBuyVolume: v * (s.buyShare ?? 0.5),
    };
  });
}

function liqs(n: number, over: (i: number) => Partial<LiquidationDeltaPoint> = () => ({})): LiquidationDeltaPoint[] {
  return Array.from({ length: n }, (_, i) => ({
    time: T0 + i * HOUR,
    longLiquidated: 100,
    shortLiquidated: 100,
    delta: 0,
    cumulative: 0,
    ...over(i),
  }));
}

const vwap = (current: number): VwapResult =>
  ({
    values: [],
    current,
    upperBand1: current,
    lowerBand1: current,
    upperBand2: current,
    lowerBand2: current,
    bands: [],
    position: "above",
    distancePct: 0,
    summary: [],
  }) as VwapResult;

function inputs(over: Partial<StoryInputs> = {}): StoryInputs {
  return {
    candles: bars(Array.from({ length: 60 }, () => ({ c: 100 }))),
    delta: null,
    liquidations: liqs(60),
    vwap: null,
    openInterest: [],
    anomalies: null,
    ...over,
  };
}

describe("buildMarketStory — refusals", () => {
  it("returns nothing rather than a story built from a handful of bars", () => {
    const r = buildMarketStory(inputs({ candles: bars([{ c: 100 }, { c: 101 }]) }));
    expect(r.phases).toHaveLength(0);
    expect(r.events).toHaveLength(0);
    expect(r.coherence).toBe(0);
    expect(r.note).toMatch(/describes noise/i);
  });

  it("tells a boring story about a boring market", () => {
    const r = buildMarketStory(inputs());
    expect(r.phases.every((p) => p.kind === "drift")).toBe(true);
    expect(r.interpretation).toMatch(/nothing happened/i);
    expect(r.interpretation).toMatch(/is a real answer/i);
  });
});

describe("buildMarketStory — phases", () => {
  it("merges adjacent slices of the same kind into one phase", () => {
    // Uniform heavy selling throughout: one phase, not eight.
    const selling = bars(Array.from({ length: 60 }, (_, i) => ({ c: 100 - i * 0.5, buyShare: 0.25 })));
    const r = buildMarketStory(inputs({ candles: selling }));
    expect(r.phases).toHaveLength(1);
    expect(r.phases[0].kind).toBe("selling");
    expect(r.phases[0].bars).toBeGreaterThan(50);
  });

  it("calls one-sided flow that price ignored absorption", () => {
    // Heavy selling, price flat: someone took the other side.
    const absorbed = bars(Array.from({ length: 60 }, () => ({ c: 100, buyShare: 0.25 })));
    const r = buildMarketStory(inputs({ candles: absorbed }));
    expect(r.phases[0].kind).toBe("absorption");
    expect(r.phases[0].summary).toMatch(/taking the other side passively/i);
  });

  it("calls heavy forced flow a liquidation phase", () => {
    const falling = bars(Array.from({ length: 60 }, (_, i) => ({ c: 100 - i * 0.5, buyShare: 0.25 })));
    // The last stretch carries far more forced volume than the baseline.
    const heavy = liqs(60, (i) => (i >= 50 ? { longLiquidated: 20_000 } : {}));
    const r = buildMarketStory(inputs({ candles: falling, liquidations: heavy }));
    expect(r.phases.some((p) => p.kind === "liquidation")).toBe(true);
  });

  it("adds a confirmation phase when price reclaims VWAP", () => {
    /* The reclaim has to land inside the tail window. A cross ten bars back
       is history rather than confirmation, and the engine is right to want it
       recent — otherwise "confirmed" becomes permanent once it ever happens. */
    const turning = bars([
      ...Array.from({ length: 55 }, () => ({ c: 98, buyShare: 0.4 })),
      ...Array.from({ length: 5 }, (_, i) => ({ c: 99 + i * 0.5, buyShare: 0.75 })),
    ]);
    const r = buildMarketStory(inputs({ candles: turning, vwap: vwap(99.5) }));
    expect(r.phases.some((p) => p.kind === "confirmation")).toBe(true);
    expect(r.events.some((e) => e.kind === "vwap" && /reclaimed/.test(e.text))).toBe(true);
  });

  it("dates every phase", () => {
    const selling = bars(Array.from({ length: 60 }, (_, i) => ({ c: 100 - i * 0.5, buyShare: 0.25 })));
    for (const p of buildMarketStory(inputs({ candles: selling })).phases) {
      expect(p.from).toBeGreaterThan(0);
      expect(p.to).toBeGreaterThanOrEqual(p.from);
    }
  });
});

describe("buildMarketStory — the event feed", () => {
  it("dates every event and returns them in order", () => {
    const turning = bars([
      ...Array.from({ length: 50 }, () => ({ c: 98, buyShare: 0.3 })),
      ...Array.from({ length: 10 }, (_, i) => ({ c: 99 + i * 0.4, buyShare: 0.75 })),
    ]);
    const r = buildMarketStory(inputs({ candles: turning, vwap: vwap(99.5) }));
    expect(r.events.length).toBeGreaterThan(0);
    for (const e of r.events) expect(e.time).toBeGreaterThan(0);
    for (let k = 1; k < r.events.length; k++) {
      expect(r.events[k].time).toBeGreaterThanOrEqual(r.events[k - 1].time);
    }
  });

  it("folds dated anomalies into the same feed", () => {
    const r = buildMarketStory(
      inputs({
        anomalies: {
          anomalies: [
            {
              kind: "abnormal_volume",
              severity: "extreme",
              time: T0 + 30 * HOUR,
              label: "Abnormal volume",
              value: 9000,
              z: 6,
              samples: 60,
              direction: "neither",
              headline: "Volume 9x the average.",
              detail: "",
            },
          ],
          top: null,
          scanned: [],
          unavailable: [],
          note: "",
        },
      })
    );
    expect(r.events.some((e) => e.kind === "anomaly:abnormal_volume")).toBe(true);
  });

  it("reports an open-interest change as a dated event, not a level", () => {
    const r = buildMarketStory(
      inputs({
        openInterest: [
          { time: T0 + 58 * HOUR, openInterest: 1_000_000 },
          { time: T0 + 59 * HOUR, openInterest: 1_020_000 },
        ],
      })
    );
    const oi = r.events.find((e) => e.kind === "oi")!;
    expect(oi).toBeDefined();
    expect(oi.text).toMatch(/rose 2\.00%/);
    expect(oi.text).toMatch(/opening/);
  });
});

describe("buildMarketStory — honesty", () => {
  it("never forecasts", () => {
    const arc = bars([
      ...Array.from({ length: 30 }, (_, i) => ({ c: 100 - i * 0.4, buyShare: 0.25 })),
      ...Array.from({ length: 20 }, () => ({ c: 88, buyShare: 0.25 })),
      ...Array.from({ length: 10 }, (_, i) => ({ c: 89 + i * 0.5, buyShare: 0.75 })),
    ]);
    const r = buildMarketStory(inputs({ candles: arc, vwap: vwap(90) }));
    const text = `${r.interpretation} ${r.note} ${r.phases.map((p) => p.summary).join(" ")}`.toLowerCase();
    for (const banned of ["will rise", "will fall", "will reverse", "guaranteed", "buy here"]) {
      expect(text).not.toContain(banned);
    }
  });

  it("says coherence is not a probability", () => {
    const r = buildMarketStory(inputs());
    expect(r.note).toMatch(/not a probability/i);
    expect(r.note).toMatch(/measured against what happened next/i);
  });

  it("keeps coherence inside its range", () => {
    const arc = bars([
      ...Array.from({ length: 30 }, (_, i) => ({ c: 100 - i * 0.4, buyShare: 0.2 })),
      ...Array.from({ length: 20 }, () => ({ c: 88, buyShare: 0.2 })),
      ...Array.from({ length: 10 }, (_, i) => ({ c: 89 + i * 0.5, buyShare: 0.8 })),
    ]);
    const heavy = liqs(60, (i) => (i >= 28 && i <= 33 ? { longLiquidated: 20_000 } : {}));
    const r = buildMarketStory(inputs({ candles: arc, liquidations: heavy, vwap: vwap(90) }));
    expect(r.coherence).toBeGreaterThanOrEqual(0);
    expect(r.coherence).toBeLessThanOrEqual(100);
  });

  it("describes an unfinished absorption as unfinished", () => {
    const absorbed = bars(Array.from({ length: 60 }, () => ({ c: 100, buyShare: 0.25 })));
    const r = buildMarketStory(inputs({ candles: absorbed }));
    expect(r.interpretation).toMatch(/unfinished/i);
  });
});

describe("buildMarketStory — the summary matches the flow it quotes", () => {
  /* The bug this guards: the last branch of the classifier assigns a phase by
     price direction when the taker split is neutral, which is correct. The
     summary then claimed "aggressive buying led the tape" while quoting 42% —
     a sentence contradicting its own parenthesis. */
  it("does not claim aggression the share does not support", () => {
    const neutralButRising = bars(
      Array.from({ length: 60 }, (_, i) => ({ c: 100 + i * 0.6, buyShare: 0.5 }))
    );
    const r = buildMarketStory(inputs({ candles: neutralButRising }));
    for (const p of r.phases) {
      if (!/Aggressive/.test(p.summary)) continue;
      const quoted = Number(p.summary.match(/\((\d+)%/)?.[1] ?? "0");
      expect(quoted).toBeGreaterThanOrEqual(58);
    }
  });

  it("says who led when the flow genuinely led", () => {
    const buying = bars(Array.from({ length: 60 }, (_, i) => ({ c: 100 + i * 0.6, buyShare: 0.8 })));
    const r = buildMarketStory(inputs({ candles: buying }));
    expect(r.phases.some((p) => /Aggressive buying led the tape \(8\d%/.test(p.summary))).toBe(true);
  });

  it("says the split is unknown rather than assuming one", () => {
    const noTakers = bars(Array.from({ length: 60 }, (_, i) => ({ c: 100 + i * 0.6 }))).map((c) => ({
      ...c,
      takerBuyVolume: undefined,
    }));
    const r = buildMarketStory(inputs({ candles: noTakers }));
    for (const p of r.phases) {
      if (p.kind === "buying" || p.kind === "selling") {
        expect(p.summary).toMatch(/who was aggressive is unknown/i);
      }
    }
  });
});
