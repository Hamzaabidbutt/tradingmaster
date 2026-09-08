import { describe, expect, it } from "vitest";
import { ConflictInputs, detectConflicts } from "@/engines/conflicts";
import type { PositioningRead, ValueMigration } from "@/engines/positioning";
import { Candle } from "@/engines/types";

/**
 * The property that matters most here is that a check never falls through to
 * "aligned" when it could not run. Silence meaning agreement is the failure
 * this engine exists to avoid, so every detector is exercised with its inputs
 * missing as well as present.
 */

const T0 = 1_700_000_000;
const HOUR = 3600;

function bar(i: number, close: number, buyShare = 0.5): Candle {
  return {
    time: T0 + i * HOUR,
    open: close,
    high: close * 1.002,
    low: close * 0.998,
    close,
    volume: 1000,
    takerBuyVolume: 1000 * buyShare,
  };
}

const positioning = (over: Partial<PositioningRead> = {}): PositioningRead => ({
  quadrant: "new_longs",
  label: "New longs opening",
  pricePct: 2,
  oiPct: 3,
  barsCovered: 12,
  participation: "opening",
  deltaAgrees: true,
  strength: 40,
  headline: "",
  mechanism: "",
  caveats: [],
  ...over,
});

const migration = (over: Partial<ValueMigration> = {}): ValueMigration => ({
  direction: "higher",
  current: { high: 110, low: 100, poc: 105 },
  prior: { high: 100, low: 90, poc: 95 },
  overlap: 0.1,
  headline: "",
  detail: "",
  caveats: [],
  ...over,
});

/** A complete DeltaAnalysis, so the stubs satisfy the real type rather than a cast. */
function deltaStub(series: ConflictInputs["delta"]["series"]): ConflictInputs["delta"] {
  return {
    series,
    cvd: series.length ? series[series.length - 1].cvd : 0,
    cvdTrend: "neutral",
    divergences: [],
    trapBars: [],
    maxDelta: 0,
    minDelta: 0,
    summary: [],
  };
}

/** Inputs with everything present and agreeing, as the baseline to perturb. */
function inputs(over: Partial<ConflictInputs> = {}): ConflictInputs {
  const candles = Array.from({ length: 40 }, (_, i) => bar(i, 100 + i * 0.5, 0.6));
  return {
    candles,
    structure: {
      swings: [
        { index: 10, time: T0 + 10 * HOUR, price: 104, kind: "high", degree: "major", label: "HH" },
        { index: 30, time: T0 + 30 * HOUR, price: 114, kind: "high", degree: "major", label: "HH" },
        { index: 5, time: T0 + 5 * HOUR, price: 100, kind: "low", degree: "major", label: "HL" },
        { index: 25, time: T0 + 25 * HOUR, price: 110, kind: "low", degree: "major", label: "HL" },
      ],
      events: [],
      trend: "bullish",
      internalTrend: "bullish",
      isRange: false,
      reversalProbability: 30,
      continuationProbability: 70,
      summary: [],
    },
    delta: deltaStub(
      Array.from({ length: 40 }, (_, i) => ({
        time: T0 + i * HOUR,
        delta: 100,
        cvd: 100 * (i + 1),
        price: 100 + i * 0.5,
      }))
    ),
    volumeProfile: {
      acceptance: "inside_value",
      vah: 115,
      val: 95,
      poc: 105,
    } as ConflictInputs["volumeProfile"],
    positioning: positioning(),
    migration: migration(),
    fundingPayer: "shorts",
    ...over,
  };
}

describe("detectConflicts — reporting shape", () => {
  it("always returns one result per detector", () => {
    const r = detectConflicts(inputs());
    expect(r.checks).toHaveLength(5);
    expect(r.checks.every((c) => ["conflict", "aligned", "unavailable"].includes(c.status))).toBe(true);
  });

  it("counts aligned and unavailable separately — silence never means agreement", () => {
    const r = detectConflicts(
      inputs({
        migration: null,
        positioning: positioning({ quadrant: null, participation: null, caveats: ["no series"] }),
        fundingPayer: null,
      })
    );
    const unavailable = r.checks.filter((c) => c.status === "unavailable");
    expect(unavailable.length).toBeGreaterThanOrEqual(3);
    expect(unavailable.every((c) => c.status !== "aligned")).toBe(true);
    expect(r.unavailableCount).toBe(unavailable.length);
  });

  it("says so when nothing at all could be checked", () => {
    const r = detectConflicts(
      inputs({
        candles: [],
        migration: null,
        delta: deltaStub([]),
        positioning: positioning({ quadrant: null, participation: null, caveats: ["none"] }),
        fundingPayer: null,
      })
    );
    expect(r.conflicts).toHaveLength(0);
    expect(r.headline).toMatch(/nothing could be checked/i);
  });

  it("reports a clean board as agreement, not as an empty list", () => {
    const r = detectConflicts(inputs());
    expect(r.conflicts).toHaveLength(0);
    expect(r.alignedCount).toBeGreaterThan(0);
    expect(r.headline).toMatch(/no conflicts/i);
  });
});

describe("detectConflicts — price against cumulative delta", () => {
  it("names a bearish divergence when a higher high comes on lower delta", () => {
    const base = inputs();
    const falling = base.delta.series.map((p, i) => ({ ...p, cvd: 5000 - i * 100 }));
    const r = detectConflicts(inputs({ delta: { ...base.delta, series: falling } }));
    const c = r.checks.find((x) => x.id === "cvd-divergence")!;
    expect(c.status).toBe("conflict");
    expect(c.argues).toBe("down");
    expect(c.reading).toMatch(/distribution/i);
  });

  it("names a bullish divergence on the mirror case", () => {
    const base = inputs();
    const r = detectConflicts(
      inputs({
        structure: {
          ...base.structure,
          trend: "bearish",
          swings: [
            { index: 10, time: T0 + 10 * HOUR, price: 114, kind: "low", degree: "major", label: "LL" },
            { index: 30, time: T0 + 30 * HOUR, price: 104, kind: "low", degree: "major", label: "LL" },
          ],
        },
        migration: migration({ direction: "lower" }),
      })
    );
    const c = r.checks.find((x) => x.id === "cvd-divergence")!;
    expect(c.status).toBe("conflict");
    expect(c.argues).toBe("up");
    expect(c.reading).toMatch(/accumulation/i);
  });

  it("ignores two swings that are barely apart", () => {
    const base = inputs();
    const falling = base.delta.series.map((p, i) => ({ ...p, cvd: 5000 - i * 100 }));
    const r = detectConflicts(
      inputs({
        delta: { ...base.delta, series: falling },
        structure: {
          ...base.structure,
          // 114.00 → 114.05 is four hundredths of a percent: noise, not a
          // higher high worth diverging against.
          swings: [
            { index: 10, time: T0 + 10 * HOUR, price: 114, kind: "high", degree: "major" },
            { index: 30, time: T0 + 30 * HOUR, price: 114.05, kind: "high", degree: "major" },
          ],
        },
      })
    );
    expect(r.checks.find((x) => x.id === "cvd-divergence")!.status).toBe("aligned");
  });

  it("reports unavailable rather than aligned on a short delta series", () => {
    const r = detectConflicts(
      inputs({ delta: deltaStub([]) })
    );
    expect(r.checks.find((x) => x.id === "cvd-divergence")!.status).toBe("unavailable");
  });
});

describe("detectConflicts — structure against value", () => {
  it("flags bullish swings while value migrates lower", () => {
    const c = detectConflicts(inputs({ migration: migration({ direction: "lower" }) })).checks.find(
      (x) => x.id === "structure-vs-value"
    )!;
    expect(c.status).toBe("conflict");
    expect(c.argues).toBe("down");
  });

  it("flags a trend read the auction has not confirmed", () => {
    const c = detectConflicts(
      inputs({ migration: migration({ direction: "overlapping", overlap: 0.82 }) })
    ).checks.find((x) => x.id === "structure-vs-value")!;
    expect(c.status).toBe("conflict");
    expect(c.argues).toBe("neither");
    expect(c.says).toMatch(/82%/);
  });

  it("is unavailable, not aligned, without a migration", () => {
    const c = detectConflicts(inputs({ migration: null })).checks.find(
      (x) => x.id === "structure-vs-value"
    )!;
    expect(c.status).toBe("unavailable");
  });
});

describe("detectConflicts — the remaining detectors", () => {
  it("flags a rally made of shorts closing", () => {
    const c = detectConflicts(
      inputs({
        positioning: positioning({
          quadrant: "short_covering",
          label: "Short covering",
          participation: "closing",
        }),
      })
    ).checks.find((x) => x.id === "advance-on-closing")!;
    expect(c.status).toBe("conflict");
    expect(c.reading).toMatch(/finite/i);
  });

  it("flags an extension above value that flow is not supporting", () => {
    const c = detectConflicts(
      inputs({
        candles: Array.from({ length: 40 }, (_, i) => bar(i, 100 + i * 0.5, 0.2)),
        volumeProfile: { acceptance: "above_value", vah: 115, val: 95, poc: 105 } as ConflictInputs["volumeProfile"],
      })
    ).checks.find((x) => x.id === "acceptance-vs-flow")!;
    expect(c.status).toBe("conflict");
    expect(c.argues).toBe("down");
  });

  it("flags new longs stacking onto a side already paying", () => {
    const c = detectConflicts({ ...inputs(), fundingPayer: "longs" }).checks.find(
      (x) => x.id === "funding-vs-positioning"
    )!;
    expect(c.status).toBe("conflict");
    expect(c.reading).toMatch(/squeeze/i);
  });

  it("treats flat funding as nothing to square, not as a conflict", () => {
    const c = detectConflicts({ ...inputs(), fundingPayer: "balanced" }).checks.find(
      (x) => x.id === "funding-vs-positioning"
    )!;
    expect(c.status).toBe("aligned");
  });
});

describe("detectConflicts — the headline", () => {
  it("says when the conflicts disagree with each other too", () => {
    const base = inputs();
    const r = detectConflicts(
      inputs({
        // Bearish CVD divergence (argues down) plus new shorts paying (argues up).
        delta: { ...base.delta, series: base.delta.series.map((p, i) => ({ ...p, cvd: 5000 - i * 100 })) },
        positioning: positioning({ quadrant: "new_shorts", label: "New shorts opening", pricePct: -2 }),
        fundingPayer: "shorts",
      })
    );
    expect(r.conflicts.length).toBeGreaterThanOrEqual(2);
    expect(r.headline).toMatch(/do not agree with each other/i);
  });

  it("never promises the divergence resolves", () => {
    const base = inputs();
    const r = detectConflicts(
      inputs({ delta: { ...base.delta, series: base.delta.series.map((p, i) => ({ ...p, cvd: 5000 - i * 100 })) } })
    );
    const text = `${r.headline} ${r.note} ${r.conflicts.map((c) => c.reading).join(" ")}`.toLowerCase();
    for (const banned of ["will reverse", "will fall", "will rise", "guaranteed", "is about to"]) {
      expect(text).not.toContain(banned);
    }
    expect(r.note).toMatch(/can persist|not a countertrend/i);
  });
});
