import { describe, expect, it } from "vitest";
import { AnomalyInputs, detectAnomalies } from "@/engines/anomalies";
import { Candle, DeltaAnalysis, LiquidationDeltaPoint } from "@/engines/types";

/**
 * The property this engine has to hold above all others: an empty result must
 * not be ambiguous. "Nothing unusual" and "nothing was measured" are opposite
 * situations, and every detector that cannot run has to say so rather than
 * silently contributing nothing.
 */

const T0 = 1_700_000_000;
const HOUR = 3600;

function bars(n: number, over: (i: number) => Partial<Candle> = () => ({})): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    time: T0 + i * HOUR,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1000,
    takerBuyVolume: 500,
    ...over(i),
  }));
}

function delta(n: number, over: (i: number) => Partial<{ delta: number; cvd: number }> = () => ({})): DeltaAnalysis {
  return {
    series: Array.from({ length: n }, (_, i) => ({
      time: T0 + i * HOUR,
      delta: 10,
      cvd: 10 * i,
      price: 100,
      ...over(i),
    })),
    cvd: 0,
    cvdTrend: "neutral",
    divergences: [],
    trapBars: [],
    maxDelta: 0,
    minDelta: 0,
    summary: [],
  } as DeltaAnalysis;
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

function inputs(over: Partial<AnomalyInputs> = {}): AnomalyInputs {
  return {
    candles: bars(80),
    delta: delta(80),
    liquidations: liqs(80),
    openInterest: Array.from({ length: 40 }, (_, i) => ({
      time: T0 + i * HOUR,
      openInterest: 1_000_000,
    })),
    funding: { currentRatePct: 0.01, annualisedPct: 10, excessAnnualisedPct: 0 },
    ...over,
  };
}

describe("detectAnomalies — an empty result is never ambiguous", () => {
  it("finds nothing in a perfectly ordinary market, and says that is ordinary", () => {
    const r = detectAnomalies(inputs());
    expect(r.anomalies).toHaveLength(0);
    expect(r.unavailable).toHaveLength(0);
    expect(r.note).toMatch(/nothing unusual/i);
  });

  it("distinguishes 'nothing unusual' from 'nothing measured'", () => {
    const blind = detectAnomalies({
      candles: bars(5),
      delta: null,
      liquidations: [],
      openInterest: [],
      funding: null,
    });
    expect(blind.anomalies).toHaveLength(0);
    expect(blind.unavailable.length).toBeGreaterThan(0);
    expect(blind.note).toMatch(/nothing could be measured/i);
  });

  it("names the reason each unavailable detector could not run", () => {
    const r = detectAnomalies(inputs({ funding: null, openInterest: [] }));
    const kinds = r.unavailable.map((u) => u.kind);
    expect(kinds).toContain("funding_anomaly");
    expect(kinds).toContain("oi_jump");
    for (const u of r.unavailable) expect(u.why.length).toBeGreaterThan(10);
  });

  it("one missing input never suppresses the other detectors", () => {
    const r = detectAnomalies(
      inputs({
        funding: null,
        candles: bars(80, (i) => (i === 79 ? { volume: 90_000 } : {})),
      })
    );
    expect(r.anomalies.some((a) => a.kind === "abnormal_volume")).toBe(true);
  });
});

describe("detectAnomalies — the detectors", () => {
  it("flags abnormal volume against the symbol's own baseline", () => {
    const r = detectAnomalies(inputs({ candles: bars(80, (i) => (i === 79 ? { volume: 90_000 } : {})) }));
    const a = r.anomalies.find((x) => x.kind === "abnormal_volume")!;
    expect(a.severity).toBe("extreme");
    expect(a.samples).toBeGreaterThan(30);
    expect(a.direction).toBe("neither");
    expect(a.detail).toMatch(/no direction of its own/i);
  });

  it("flags extreme delta with its side", () => {
    const r = detectAnomalies(inputs({ delta: delta(80, (i) => (i === 79 ? { delta: 90_000 } : {})) }));
    const a = r.anomalies.find((x) => x.kind === "extreme_delta")!;
    expect(a.direction).toBe("up");
    expect(a.z).toBeGreaterThan(4);
  });

  it("flags extreme liquidation", () => {
    const r = detectAnomalies(
      inputs({ liquidations: liqs(80, (i) => (i === 79 ? { longLiquidated: 90_000 } : {})) })
    );
    const a = r.anomalies.find((x) => x.kind === "extreme_liquidation")!;
    expect(a.direction).toBe("down");
  });

  it("separates a cascade from one big liquidation bar", () => {
    const single = detectAnomalies(
      inputs({ liquidations: liqs(80, (i) => (i === 79 ? { longLiquidated: 90_000 } : {})) })
    );
    expect(single.anomalies.some((a) => a.kind === "liquidation_cascade")).toBe(false);

    const cascade = detectAnomalies(
      inputs({
        liquidations: liqs(80, (i) => (i >= 77 ? { longLiquidated: 9_000 } : {})),
      })
    );
    const c = cascade.anomalies.find((a) => a.kind === "liquidation_cascade")!;
    expect(c).toBeDefined();
    expect(c.detail).toMatch(/triggering more forced closes/i);
  });

  it("flags a sudden open-interest change", () => {
    const oi = Array.from({ length: 40 }, (_, i) => ({
      time: T0 + i * HOUR,
      openInterest: i === 39 ? 1_300_000 : 1_000_000,
    }));
    const a = detectAnomalies(inputs({ openInterest: oi })).anomalies.find((x) => x.kind === "oi_jump")!;
    expect(a).toBeDefined();
    expect(a.value).toBeGreaterThan(10);
  });

  it("flags price and open interest disagreeing", () => {
    // Price up, open interest down: short covering.
    const rising = bars(80, (i) => ({ close: 100 + i * 0.5, open: 100 + i * 0.5 }));
    const oi = Array.from({ length: 40 }, (_, i) => ({
      time: T0 + i * HOUR,
      openInterest: 1_000_000 - i * 5000,
    }));
    const a = detectAnomalies(inputs({ candles: rising, openInterest: oi })).anomalies.find(
      (x) => x.kind === "price_oi_divergence"
    )!;
    expect(a).toBeDefined();
    expect(a.detail).toMatch(/shorts closing|finite/i);
  });

  it("measures funding against the anchor, not against zero", () => {
    const onAnchor = detectAnomalies(
      inputs({ funding: { currentRatePct: 0.01, annualisedPct: 10.9, excessAnnualisedPct: 0 } })
    );
    expect(onAnchor.anomalies.some((a) => a.kind === "funding_anomaly")).toBe(false);

    const crowded = detectAnomalies(
      inputs({ funding: { currentRatePct: 0.1, annualisedPct: 110, excessAnnualisedPct: 99 } })
    );
    const a = crowded.anomalies.find((x) => x.kind === "funding_anomaly")!;
    expect(a.severity).toBe("extreme");
    expect(a.detail).toMatch(/squeeze/i);
  });

  it("flags volatility expansion", () => {
    const wide = bars(80, (i) => (i === 79 ? { high: 160, low: 40 } : {}));
    const a = detectAnomalies(inputs({ candles: wide })).anomalies.find(
      (x) => x.kind === "volatility_expansion"
    )!;
    expect(a).toBeDefined();
    expect(a.detail).toMatch(/cluster/i);
  });
});

describe("detectAnomalies — honesty", () => {
  it("says an anomaly is not a signal", () => {
    const r = detectAnomalies(inputs({ candles: bars(80, (i) => (i === 79 ? { volume: 90_000 } : {})) }));
    expect(r.note).toMatch(/not about direction|where to look, not what to do/i);
  });

  it("never tells the reader what to do", () => {
    const r = detectAnomalies(
      inputs({
        candles: bars(80, (i) => (i === 79 ? { volume: 90_000, high: 160, low: 40 } : {})),
        funding: { currentRatePct: 0.1, annualisedPct: 110, excessAnnualisedPct: 99 },
      })
    );
    const text = `${r.note} ${r.anomalies.map((a) => a.detail).join(" ")}`.toLowerCase();
    for (const banned of ["buy here", "sell here", "will reverse", "will rise", "guaranteed"]) {
      expect(text).not.toContain(banned);
    }
  });

  it("ranks the most severe first", () => {
    const r = detectAnomalies(
      inputs({
        candles: bars(80, (i) => (i === 79 ? { volume: 90_000, high: 160, low: 40 } : {})),
        delta: delta(80, (i) => (i === 79 ? { delta: 300 } : {})),
      })
    );
    const rank = { extreme: 3, unusual: 2, notable: 1 } as const;
    for (let k = 1; k < r.anomalies.length; k++) {
      expect(rank[r.anomalies[k - 1].severity]).toBeGreaterThanOrEqual(rank[r.anomalies[k].severity]);
    }
    expect(r.top).toBe(r.anomalies[0]);
  });

  it("dates every anomaly", () => {
    const r = detectAnomalies(inputs({ candles: bars(80, (i) => (i === 79 ? { volume: 90_000 } : {})) }));
    for (const a of r.anomalies) expect(a.time).toBeGreaterThan(0);
  });
});
