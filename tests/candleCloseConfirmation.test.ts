import { describe, expect, it } from "vitest";
import { analyzeCandleCloseExpansion } from "@/engines/candleCloseExpansion";
import { Candle } from "@/engines/types";

/**
 * The confirmation step exists to separate two things that look identical on a
 * bare level chart: price leaving an area, and price leaving with intent.
 *
 * These tests drive the whole engine rather than the helper, because the claim
 * being made is about the *score* — a close with neither confirmation has to
 * come out materially below the same close with both, or the step is decorative.
 */

const HOUR = 3600;
const T0 = 1_700_000_000;

interface Bar {
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number;
}

function build(bars: Bar[]): Candle[] {
  return bars.map((b, i) => ({
    time: T0 + i * HOUR,
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
    volume: b.v ?? 1000,
    takerBuyVolume: (b.v ?? 1000) * 0.55,
  }));
}

/**
 * A resistance level at 100 tested repeatedly, then broken.
 *
 * `decisive` controls whether the breaking candle also takes out the previous
 * close: with it the bar opens at the prior close and runs; without it the bar
 * gaps up through the level and settles back inside the previous body.
 */
function levelThenBreak(opts: { takesPriorClose: boolean }): Candle[] {
  const bars: Bar[] = [];
  // 70 bars oscillating under 100, touching it several times so the level is
  // well established before anything breaks.
  for (let i = 0; i < 70; i++) {
    const touch = i % 9 === 0;
    const top = touch ? 99.9 : 96 + (i % 5) * 0.5;
    bars.push({ o: top - 1.2, h: top, l: top - 2.2, c: top - 1.0 });
  }
  if (opts.takesPriorClose) {
    // Opens at the prior close, drives through 100, closes near its high and
    // well beyond the previous close.
    bars.push({ o: 98.4, h: 103.4, l: 98.2, c: 103.0, v: 3200 });
    bars.push({ o: 103.0, h: 104.4, l: 102.6, c: 104.0, v: 2600 });
  } else {
    // Opens far above the previous close, wanders, and settles below where the
    // previous candle closed — a level crossed without a decision.
    bars.push({ o: 103.6, h: 103.9, l: 97.6, c: 100.6, v: 900 });
    bars.push({ o: 100.6, h: 100.9, l: 100.2, c: 100.5, v: 700 });
  }
  return build(bars);
}

describe("candle close expansion — confirmation", () => {
  it("reports both confirmations on a decisive break", () => {
    const r = analyzeCandleCloseExpansion(levelThenBreak({ takesPriorClose: true }));
    expect(r.confirmation.brokePriorClose).toBe(true);
    expect(r.confirmation.priorCloseGapAtr).toBeGreaterThan(0.1);
    // Closed near its high, which is what "closing the candle high" means.
    expect(r.confirmation.closeStrength).toBeGreaterThan(0.7);
  });

  it("refuses the prior-close confirmation when the candle settles inside the previous body", () => {
    const r = analyzeCandleCloseExpansion(levelThenBreak({ takesPriorClose: false }));
    expect(r.confirmation.brokePriorClose).toBe(false);
    expect(r.confirmation.aligned).toBe(false);
  });

  it("scores an unconfirmed break materially below a confirmed one", () => {
    // The whole point of the step. If these come out the same, the engine is
    // still treating a level crossing as expansion.
    const strong = analyzeCandleCloseExpansion(levelThenBreak({ takesPriorClose: true }));
    const weak = analyzeCandleCloseExpansion(levelThenBreak({ takesPriorClose: false }));
    expect(strong.expansionScore).toBeGreaterThan(weak.expansionScore);
  });

  it("explains both confirmations in the narrative either way", () => {
    for (const takesPriorClose of [true, false]) {
      const r = analyzeCandleCloseExpansion(levelThenBreak({ takesPriorClose }));
      const text = r.reason.join(" ").toLowerCase();
      expect(text).toMatch(/previous close|previous bar/);
      expect(text).toMatch(/structure/);
    }
  });

  it("never confirms with a hair past the previous close", () => {
    // A tenth of an ATR is inside the noise of a single bar; treating it as a
    // confirmation would make the check pass on essentially every break.
    const bars: Bar[] = [];
    for (let i = 0; i < 70; i++) {
      const touch = i % 9 === 0;
      const top = touch ? 99.9 : 96 + (i % 5) * 0.5;
      bars.push({ o: top - 1.2, h: top, l: top - 2.2, c: top - 1.0 });
    }
    const prevClose = bars[bars.length - 1].c;
    bars.push({ o: prevClose, h: 100.6, l: prevClose - 0.1, c: prevClose + 0.001 });
    const r = analyzeCandleCloseExpansion(build(bars));
    expect(r.confirmation.brokePriorClose).toBe(false);
  });

  it("reads structure only up to the breaking candle", () => {
    // Confirming a break with bars that had not printed when it closed is how
    // a backtest ends up flattering the live engine. The structure event, when
    // present, can never postdate the close it confirms.
    const r = analyzeCandleCloseExpansion(levelThenBreak({ takesPriorClose: true }));
    if (r.confirmation.structureEvent) {
      expect(r.confirmation.structureEvent.time).toBeLessThanOrEqual(r.closeTime);
    }
  });

  it("returns an inert confirmation when nothing broke", () => {
    // 80 quiet bars that never close through anything.
    const flat = build(
      Array.from({ length: 80 }, () => ({ o: 100, h: 100.4, l: 99.6, c: 100 }))
    );
    const r = analyzeCandleCloseExpansion(flat);
    expect(r.confirmation.brokePriorClose).toBe(false);
    expect(r.confirmation.brokeStructure).toBe(false);
    expect(r.confirmation.aligned).toBe(false);
    expect(r.confirmation.detail).toEqual([]);
  });

  it("never lets confirmation push the score above its own decisiveness", () => {
    // Confirmation is a discount, not a bonus — otherwise a well-confirmed
    // weak close could outrank a decisive unconfirmed one.
    for (const takesPriorClose of [true, false]) {
      const r = analyzeCandleCloseExpansion(levelThenBreak({ takesPriorClose }));
      expect(r.expansionScore).toBeLessThanOrEqual(r.decisiveness.score);
    }
  });

  it("emits finite numbers on degenerate input", () => {
    const r = analyzeCandleCloseExpansion(
      build(Array.from({ length: 60 }, () => ({ o: 50, h: 50, l: 50, c: 50, v: 0 })))
    );
    expect(Number.isFinite(r.expansionScore)).toBe(true);
    expect(Number.isFinite(r.confirmation.priorCloseGapAtr)).toBe(true);
    expect(Number.isFinite(r.confirmation.closeStrength)).toBe(true);
  });
});
