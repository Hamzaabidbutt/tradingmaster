import { describe, expect, it } from "vitest";
import { BOS_STATE_LABEL, BosState, detectBosMomentum } from "@/engines/bosMomentum";
import { Candle } from "@/engines/types";

/**
 * Most of what this engine does is refuse breaks, so most of what is pinned
 * here is the refusals: a level drifted through on no volume, a break bar that
 * closed back on the level, and a break that was later reclaimed.
 *
 * The state machine is the engine's real output, so each state is exercised
 * separately — a scanner that finds a break without saying whether it is still
 * actionable has not answered the question that was asked.
 */

const T0 = 1_700_000_000;
const HOUR = 3600;

interface BarSpec {
  o?: number;
  h?: number;
  l?: number;
  c: number;
  v?: number;
  buyShare?: number;
}

function build(specs: BarSpec[]): Candle[] {
  return specs.map((s, i) => {
    const c = s.c;
    const volume = s.v ?? 1000;
    return {
      time: T0 + i * HOUR,
      open: s.o ?? c,
      high: s.h ?? Math.max(s.o ?? c, c) * 1.001,
      low: s.l ?? Math.min(s.o ?? c, c) * 0.999,
      close: c,
      volume,
      takerBuyVolume: volume * (s.buyShare ?? 0.5),
    };
  });
}

/**
 * A chart that makes a clear swing high, pulls back, then breaks it.
 *
 * `breakBar` shapes the breaking candle; `tail` is whatever happens after.
 */
function bosChart(breakBar: Partial<BarSpec> = {}, tail: BarSpec[] = []): Candle[] {
  const specs: BarSpec[] = [];
  // 40 bars of base, rising into a peak at 110, then a pullback to 100.
  for (let i = 0; i < 26; i++) specs.push({ c: 96 + i * 0.55 });
  for (let i = 0; i < 14; i++) specs.push({ c: 110 - i * 0.72 });
  for (let i = 0; i < 10; i++) specs.push({ c: 100 + i * 0.6 });
  // The break: through 110.
  specs.push({ o: 106, c: 114, h: 114.5, l: 105.8, v: 2600, buyShare: 0.78, ...breakBar });
  specs.push(...tail);
  return build(specs);
}

/** The swing high the chart above breaks. */
function levelOf(candles: Candle[]): number {
  return detectBosMomentum("X", "1h", candles).level;
}

describe("detectBosMomentum — refusals", () => {
  it("returns nothing on a series too short to have structure", () => {
    const r = detectBosMomentum("X", "1h", build([{ c: 100 }, { c: 101 }]));
    expect(r.found).toBe(false);
    expect(r.trade).toBeNull();
  });

  it("refuses to score a level drifted through on no volume", () => {
    const r = detectBosMomentum("X", "1h", bosChart({ v: 300, buyShare: 0.52 }));
    const vol = r.checks.find((c) => c.key === "volume")!;
    expect(vol.found).toBe(false);
    expect(vol.detail).toMatch(/nobody was defending/i);
  });

  it("refuses a break bar that closed back on the level", () => {
    // Pokes to 114 but closes at 110.2, barely through: a wick, not a break.
    const r = detectBosMomentum("X", "1h", bosChart({ o: 106, c: 110.2, h: 114.5, l: 105.8 }));
    expect(r.checks.find((c) => c.key === "displacement")!.found).toBe(false);
    expect(r.checks.find((c) => c.key === "close")!.found).toBe(false);
  });

  it("flags aggressive flow that went the other way", () => {
    const r = detectBosMomentum("X", "1h", bosChart({ buyShare: 0.2 }));
    const d = r.checks.find((c) => c.key === "delta")!;
    expect(d.found).toBe(false);
    expect(d.detail).toMatch(/absorption/i);
  });

  it("skips the flow check rather than passing it when takers are missing", () => {
    const candles = bosChart();
    candles[candles.length - 1] = { ...candles[candles.length - 1], takerBuyVolume: undefined };
    const r = detectBosMomentum("X", "1h", candles);
    const d = r.checks.find((c) => c.key === "delta")!;
    expect(d.found).toBe(false);
    expect(r.caveats.join(" ")).toMatch(/skipped rather than passed/i);
  });
});

describe("detectBosMomentum — a clean break", () => {
  it("finds it and scores the checks that passed", () => {
    const r = detectBosMomentum("X", "1h", bosChart());
    expect(r.found).toBe(true);
    expect(r.direction).toBe("bullish");
    expect(r.momentum).toBeGreaterThan(60);
    expect(r.checks.filter((c) => c.found).length).toBeGreaterThanOrEqual(4);
  });

  it("grades A only above the B threshold", () => {
    const strong = detectBosMomentum("X", "1h", bosChart());
    const weak = detectBosMomentum("X", "1h", bosChart({ v: 300, buyShare: 0.4, c: 110.4, h: 114 }));
    expect(strong.momentum).toBeGreaterThan(weak.momentum);
    expect(["A", "B"]).toContain(strong.grade);
    expect(weak.grade).toBe("C");
  });
});

describe("detectBosMomentum — the state machine", () => {
  const stateOf = (tail: BarSpec[] = []): BosState =>
    detectBosMomentum("X", "1h", bosChart({}, tail)).state;

  it("calls the break bar itself a fresh break", () => {
    expect(stateOf()).toBe("fresh_break");
  });

  it("waits for the retest while price holds away from the level", () => {
    // Clear of the level but inside the extended threshold. The fixture's ATR
    // is small, so 115 would already be four ATR out and correctly extended.
    expect(stateOf([{ c: 111.5 }, { c: 111.8 }])).toBe("retest_pending");
  });

  it("says retesting while price is back at the level", () => {
    const candles = bosChart({}, [{ c: 115 }]);
    const level = levelOf(candles);
    expect(stateOf([{ c: 115 }, { c: level, l: level * 0.999 }])).toBe("retesting");
  });

  it("says held once price came back, held and turned away", () => {
    const level = levelOf(bosChart());
    // Touch the level, then two bars clear of it without closing through.
    expect(stateOf([{ c: 112, l: level * 0.999 }, { c: 114 }, { c: 116 }])).toBe("retest_held");
  });

  it("says failed the moment price closes back through the level", () => {
    const level = levelOf(bosChart());
    expect(stateOf([{ c: level - 2 }])).toBe("retest_failed");
    expect(BOS_STATE_LABEL.retest_failed).toMatch(/failed/i);
  });

  it("calls a run without a retest extended", () => {
    expect(stateOf([{ c: 130 }, { c: 145 }, { c: 160 }])).toBe("extended");
  });

  it("calls an old break stale rather than momentum", () => {
    /* The tail has to drift *down* gently. A tail that creeps up — even at
       two hundredths a bar — makes a fresh swing high and then breaks it, and
       the engine correctly reports that newer break instead of the old one.
       Declining from 114 makes no new high and never closes back through the
       level, so the original break simply ages. */
    const tail = Array.from({ length: 34 }, (_, i) => ({ c: 114 - i * 0.04 }));
    expect(stateOf(tail)).toBe("stale");
  });

  it("reports the pre-break state when nothing has broken", () => {
    // A chart that rises to a peak and pulls back, never taking it out.
    const specs: BarSpec[] = [];
    for (let i = 0; i < 30; i++) specs.push({ c: 96 + i * 0.5 });
    for (let i = 0; i < 30; i++) specs.push({ c: 111 - i * 0.12 });
    const r = detectBosMomentum("X", "1h", build(specs));
    expect(["forming", "stale"]).toContain(r.state);
    if (r.state === "forming") {
      expect(r.found).toBe(false);
      expect(r.trade).toBeNull();
      expect(r.caveats.join(" ")).toMatch(/not evidence that it gives way/i);
    }
  });
});

describe("detectBosMomentum — trade geometry", () => {
  it("entries at the broken level, never at the current price", () => {
    const level = levelOf(bosChart());
    const r = detectBosMomentum("X", "1h", bosChart({}, [{ c: 112, l: level * 0.999 }, { c: 114 }, { c: 116 }]));
    expect(r.trade).not.toBeNull();
    expect(r.trade!.entry).toBeCloseTo(level, 4);
    expect(r.trade!.entry).not.toBeCloseTo(r.price, 2);
  });

  it("puts the stop below the entry on a long, with real distance", () => {
    const level = levelOf(bosChart());
    const r = detectBosMomentum("X", "1h", bosChart({}, [{ c: 112, l: level * 0.999 }, { c: 114 }, { c: 116 }]));
    const t = r.trade!;
    expect(t.side).toBe("BUY");
    expect(t.stopLoss).toBeLessThan(t.entry);
    expect(t.tp1).toBeGreaterThan(t.entry);
    expect(t.tp2).toBeGreaterThan(t.tp1);
    expect(t.riskReward).toBeGreaterThan(1);
  });

  it("offers no trade in the states that have no defined entry", () => {
    const level = levelOf(bosChart());
    for (const tail of [
      [{ c: 130 }, { c: 145 }, { c: 160 }], // extended
      [{ c: level - 2 }], // failed
    ]) {
      expect(detectBosMomentum("X", "1h", bosChart({}, tail)).trade).toBeNull();
    }
  });

  it("offers no trade below the qualifying score however good the state looks", () => {
    const weak = bosChart({ v: 250, buyShare: 0.35, c: 110.3, h: 114 }, [{ c: 111 }, { c: 112 }, { c: 113 }]);
    const r = detectBosMomentum("X", "1h", weak);
    expect(r.momentum).toBeLessThan(60);
    expect(r.trade).toBeNull();
  });
});

describe("detectBosMomentum — honesty", () => {
  it("never claims the break predicts the outcome", () => {
    const r = detectBosMomentum("X", "1h", bosChart());
    const text = `${r.headline} ${r.narrative.join(" ")} ${r.caveats.join(" ")}`.toLowerCase();
    for (const banned of ["will continue", "will rise", "will fall", "guaranteed", "cannot fail"]) {
      expect(text).not.toContain(banned);
    }
    expect(r.caveats.join(" ")).toMatch(/plenty of those still fail/i);
  });

  it("marks only the states with a live entry as actionable", () => {
    const level = levelOf(bosChart());
    const held = detectBosMomentum("X", "1h", bosChart({}, [{ c: 112, l: level * 0.999 }, { c: 114 }, { c: 116 }]));
    const extended = detectBosMomentum("X", "1h", bosChart({}, [{ c: 130 }, { c: 145 }, { c: 160 }]));
    expect(held.actionable).toBe(true);
    expect(extended.actionable).toBe(false);
  });

  it("says a fresh break has nothing downstream of it scored yet", () => {
    const r = detectBosMomentum("X", "1h", bosChart());
    expect(r.state).toBe("fresh_break");
    expect(r.caveats.join(" ")).toMatch(/has not happened yet/i);
  });
});
