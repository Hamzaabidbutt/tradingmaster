import { describe, expect, it } from "vitest";
import { analyzeDeltaExcursion } from "@/engines/deltaExcursion";
import { Candle } from "@/engines/types";

/**
 * The whole point is the distinction a closing delta destroys: a bar that was
 * +200 throughout and a bar that ran to +5,000 and gave it all back have the
 * same closing number and opposite meanings. So the tests that matter are the
 * ones asserting those two are classified differently — and the one asserting
 * that with no sub-candles the engine says nothing at all rather than guessing.
 */

const T0 = 1_700_000_000;
const BAR = 900;
const SUB = 60;

function bar(i: number, o: number, h: number, l: number, c: number): Candle {
  return { time: T0 + i * BAR, open: o, high: h, low: l, close: c, volume: 1000, takerBuyVolume: 500 };
}

/** Sub-bars for bar `i`, each given an explicit taker-buy share. */
function subs(i: number, shares: number[], volume = 100): Candle[] {
  return shares.map((share, k) => ({
    time: T0 + i * BAR + k * SUB,
    open: 100,
    high: 100.5,
    low: 99.5,
    close: 100,
    volume,
    takerBuyVolume: volume * share,
  }));
}

/** A quiet baseline of two-sided bars, so "large" has something to mean. */
function baseline(count: number): { bars: Candle[]; subs: Candle[] } {
  const bars: Candle[] = [];
  const sub: Candle[] = [];
  for (let i = 0; i < count; i++) {
    bars.push(bar(i, 100, 100.6, 99.4, 100.1));
    sub.push(...subs(i, [0.5, 0.52, 0.48, 0.5, 0.51, 0.49]));
  }
  return { bars, subs: sub };
}

describe("analyzeDeltaExcursion — when it declines to answer", () => {
  it("reports unavailable without a sub-series", () => {
    const r = analyzeDeltaExcursion(baseline(20).bars, null);
    expect(r.available).toBe(false);
    expect(r.bars).toEqual([]);
    expect(r.caveats.join(" ")).toMatch(/path cannot be recovered/i);
  });

  it("reports unavailable on an empty sub-series", () => {
    expect(analyzeDeltaExcursion(baseline(20).bars, []).available).toBe(false);
  });

  it("reports unavailable when the sub-series is too sparse to carry a path", () => {
    // One print inside a bar is a total, not a path.
    const { bars } = baseline(20);
    const sparse = bars.map((b) => ({ ...b, time: b.time }));
    const r = analyzeDeltaExcursion(bars, sparse);
    expect(r.available).toBe(false);
    expect(r.headline).toMatch(/too sparse/i);
  });

  it("never claims a direction it has not measured", () => {
    const r = analyzeDeltaExcursion(baseline(20).bars, null);
    expect(r.latestAbsorption).toBeNull();
  });
});

describe("analyzeDeltaExcursion — the distinction it exists for", () => {
  it("separates steady buying from a run that was handed back", () => {
    const { bars, subs: base } = baseline(20);

    // Bar 20: buying all the way through and the bar closes at its high.
    const steadyBars = [...bars, bar(20, 100, 101, 99.9, 100.95)];
    const steadySubs = [...base, ...subs(20, [0.95, 0.95, 0.95, 0.95, 0.95, 0.95], 500)];

    // Bar 20 alternative: the same peak buying, then sold back, closing at
    // the low. Same kind of size, opposite meaning.
    const absorbedBars = [...bars, bar(20, 100, 101, 99.5, 99.6)];
    const absorbedSubs = [...base, ...subs(20, [0.95, 0.95, 0.95, 0.05, 0.05, 0.05], 500)];

    const steady = analyzeDeltaExcursion(steadyBars, steadySubs);
    const absorbed = analyzeDeltaExcursion(absorbedBars, absorbedSubs);

    expect(steady.bars[steady.bars.length - 1].verdict).toBe("clean_buying");
    expect(absorbed.bars[absorbed.bars.length - 1].verdict).toBe("absorbed_buying");
  });

  it("detects selling being absorbed on a bar that closes high", () => {
    const { bars, subs: base } = baseline(20);
    const allBars = [...bars, bar(20, 100, 100.5, 99, 100.45)];
    const allSubs = [...base, ...subs(20, [0.05, 0.05, 0.05, 0.95, 0.95, 0.95], 500)];
    const r = analyzeDeltaExcursion(allBars, allSubs);
    expect(r.bars[r.bars.length - 1].verdict).toBe("absorbed_selling");
    expect(r.latestAbsorption?.time).toBe(T0 + 20 * BAR);
  });

  it("records the peak and the trough, not just the close", () => {
    const { bars, subs: base } = baseline(20);
    const allBars = [...bars, bar(20, 100, 101, 99.5, 99.6)];
    const allSubs = [...base, ...subs(20, [0.95, 0.95, 0.95, 0.05, 0.05, 0.05], 500)];
    const last = analyzeDeltaExcursion(allBars, allSubs).bars.at(-1)!;
    expect(last.maxDelta).toBeGreaterThan(last.closeDelta);
    expect(last.gaveBackUp).toBeCloseTo(last.maxDelta - last.closeDelta, 1);
    expect(last.samples).toBe(6);
  });

  it("calls a bar that only ever went one way clean, however ordinary its size", () => {
    /* The bug this pins: classification used to require 1.5× the window's
       typical excursion before a bar could be called clean, so on a stretch
       where every bar looked alike nothing cleared its own median and all of
       them came back "two-sided" — including bars whose delta rose steadily
       and never once went negative. "Both sides had a go" is a false claim
       about that tape, not a cautious one. */
    const bars: Candle[] = [];
    const sub: Candle[] = [];
    for (let i = 0; i < 21; i++) {
      bars.push(bar(i, 100, 100.6, 99.9, 100.5));
      sub.push(...subs(i, [0.9, 0.9, 0.9, 0.9, 0.9, 0.9]));
    }
    const last = analyzeDeltaExcursion(bars, sub).bars.at(-1)!;
    expect(last.minDelta).toBe(0);
    expect(last.verdict).toBe("clean_buying");
  });

  it("never says both sides had a go when only one did", () => {
    const bars: Candle[] = [];
    const sub: Candle[] = [];
    for (let i = 0; i < 21; i++) {
      bars.push(bar(i, 100, 100.6, 99.9, 100.0));
      // Runs up, gives it all back, but the bar does not close low enough in
      // its range to qualify as absorption: two_sided by elimination.
      sub.push(...subs(i, [0.9, 0.9, 0.9, 0.1, 0.1, 0.1]));
    }
    const last = analyzeDeltaExcursion(bars, sub).bars.at(-1)!;
    expect(last.verdict).toBe("two_sided");
    expect(last.minDelta).toBe(0);
    expect(last.note).not.toMatch(/both sides had a go/i);
  });

  it("calls a bar where both sides ran and neither kept it two-sided", () => {
    const { bars, subs: base } = baseline(20);
    // Big run up, big run down, closing mid-range — nobody won.
    const allBars = [...bars, bar(20, 100, 101, 99, 100)];
    const allSubs = [...base, ...subs(20, [0.95, 0.95, 0.05, 0.05, 0.95, 0.05], 500)];
    expect(analyzeDeltaExcursion(allBars, allSubs).bars.at(-1)!.verdict).toBe("two_sided");
  });

  it("does not call an ordinary bar absorbed just because it closed low", () => {
    /* Closing at the low is one of three conditions, and on its own it is the
       weakest. This bar's delta peaks at +4 against a baseline whose typical
       excursion is also 4, so there was never a run to give back — which is
       what separates absorption from a bar that simply drifted down. */
    const { bars, subs: base } = baseline(20);
    const allBars = [...bars, bar(20, 100, 100.3, 99.7, 99.75)];
    const allSubs = [...base, ...subs(20, [0.52, 0.48, 0.51, 0.49, 0.5, 0.5])];
    expect(analyzeDeltaExcursion(allBars, allSubs).bars.at(-1)!.verdict).toBe("two_sided");
  });
});

describe("analyzeDeltaExcursion — honesty", () => {
  it("never claims price reverses", () => {
    const { bars, subs: base } = baseline(20);
    const allBars = [...bars, bar(20, 100, 101, 99.5, 99.6)];
    const allSubs = [...base, ...subs(20, [0.95, 0.95, 0.95, 0.05, 0.05, 0.05], 500)];
    const r = analyzeDeltaExcursion(allBars, allSubs);
    const text = (r.headline + r.bars.map((b) => b.note).join(" ")).toLowerCase();
    for (const banned of ["will reverse", "will fall", "guaranteed", "expect price"]) {
      expect(text).not.toContain(banned);
    }
  });

  it("says a large seller stepping away looks the same as absorption", () => {
    const { bars, subs: base } = baseline(20);
    const allBars = [...bars, bar(20, 100, 101, 99.5, 99.6)];
    const allSubs = [...base, ...subs(20, [0.95, 0.95, 0.95, 0.05, 0.05, 0.05], 500)];
    expect(analyzeDeltaExcursion(allBars, allSubs).caveats.join(" ")).toMatch(/steps away/i);
  });

  it("says the path is only sequenced to the sub-bar resolution", () => {
    const { bars, subs: base } = baseline(20);
    expect(analyzeDeltaExcursion(bars, base).caveats.join(" ")).toMatch(/net out before this sees them/i);
  });

  it("emits finite numbers throughout", () => {
    const { bars, subs: base } = baseline(20);
    for (const b of analyzeDeltaExcursion(bars, base).bars) {
      for (const v of [b.closeDelta, b.maxDelta, b.minDelta, b.gaveBackUp, b.gaveBackDown, b.closePosition]) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it("handles a zero-range bar without dividing by it", () => {
    const { bars, subs: base } = baseline(20);
    const allBars = [...bars, bar(20, 100, 100, 100, 100)];
    const allSubs = [...base, ...subs(20, [0.5, 0.5, 0.5, 0.5, 0.5, 0.5])];
    const last = analyzeDeltaExcursion(allBars, allSubs).bars.at(-1)!;
    expect(Number.isFinite(last.closePosition)).toBe(true);
  });

  it("clamps a taker-buy figure that exceeds the bar's own volume", () => {
    // Real fixtures carry these; an unclamped share drives the delta past the
    // volume that produced it.
    const { bars, subs: base } = baseline(20);
    const broken = base.map((s, i) => (i % 7 === 0 ? { ...s, takerBuyVolume: s.volume * 3 } : s));
    for (const b of analyzeDeltaExcursion(bars, broken).bars) {
      expect(Math.abs(b.maxDelta)).toBeLessThanOrEqual(b.samples * 100 + 1);
    }
  });
});
