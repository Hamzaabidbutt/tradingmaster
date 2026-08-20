import { describe, expect, it } from "vitest";
import { analyzeCandleCloseExpansion } from "@/engines/candleCloseExpansion";
import { Candle } from "@/engines/types";
import { candle } from "./helpers";

const T0 = 1_700_000_000;
const HOUR = 3600;

/** The level every fixture below is built around. */
const LVL = 105;

/** Deterministic pseudo-random so fixtures are reproducible across runs. */
function lcg(seed: number) {
  let s = (seed * 2654435761) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Builds a series bar by bar, each bar opening where the last one closed.
 *
 * The noise is load-bearing: `findSwings` needs a STRICT fractal extreme, so
 * two bars sharing a high would cancel each other and the level would never be
 * detected at all.
 */
class Builder {
  bars: Candle[] = [];
  private rnd: () => number;
  private price = 100;

  constructor(seed = 5) {
    this.rnd = lcg(seed);
  }

  push(close: number, hi: number, lo: number, vol = 1000) {
    const open = this.price;
    this.bars.push(
      candle(
        T0 + this.bars.length * HOUR,
        open,
        Math.max(open, close, hi),
        Math.min(open, close, lo),
        close,
        vol,
        Math.round(vol * 0.5)
      )
    );
    this.price = close;
  }

  /** Drift toward `to` over `bars` candles. */
  walk(to: number, bars: number) {
    for (let i = 0; i < bars; i++) {
      const close = this.price + (to - this.price) / (bars - i) + (this.rnd() - 0.5) * 0.15;
      this.push(close, close + 0.18 + this.rnd() * 0.1, Math.min(this.price, close) - 0.18);
    }
  }

  /** Tag the level with a wick and reject back down — a respected touch. */
  tap() {
    this.walk(104.5, 6);
    this.push(103.3 + (this.rnd() - 0.5) * 0.3, LVL + 0.25 + this.rnd() * 0.2, 103.1, 1500);
    this.walk(101 + (this.rnd() - 0.5) * 0.4, 6);
  }

  /** Close through the level, then snap back inside within a few bars. */
  fakeBreak() {
    this.walk(104.4, 5);
    this.push(105.9, 106.1, 104.2, 1800);
    this.push(103.0, 106.0, 102.8, 2000);
    this.walk(101.5, 5);
  }
}

/** A resistance level that price has tagged and respected `taps` times. */
function respectedResistance(taps: number, seed = 5): Builder {
  const b = new Builder(seed);
  for (let t = 0; t < taps; t++) b.tap();
  return b;
}

/** Big body, close at the extreme, 2.6x volume, then three holding closes. */
function decisiveBreak(b: Builder): Candle[] {
  b.walk(104.3, 5);
  b.push(108.0, 108.2, 104.1, 2600);
  b.push(109.0, 109.3, 107.8, 2200);
  b.push(109.6, 110.0, 108.8, 2000);
  b.push(110.2, 110.5, 109.4, 1900);
  return b.bars;
}

describe("candle close expansion — decisive closes", () => {
  it("reads a decisive close beyond a well-respected level as high-probability expansion", () => {
    const r = analyzeCandleCloseExpansion(decisiveBreak(respectedResistance(5)));

    expect(r.keyLevel).not.toBeNull();
    expect(r.keyLevel!.price).toBeGreaterThan(104.5);
    expect(r.keyLevel!.price).toBeLessThan(105.6);
    expect(r.keyLevel!.respects).toBeGreaterThanOrEqual(3);

    expect(r.candleClose).toBe("above");
    expect(r.breakoutDirection).toBe("bullish");
    expect(r.expansionProbability).toBe("High");
    expect(r.expectedDirection).toBe("up");
    expect(r.decisiveness.verdict).toBe("decisive");

    // Every one of the six weighted checks should pass on a textbook break.
    expect(r.decisiveness.checks.every((c) => c.passed)).toBe(true);

    // A target above the level, and the level itself as the line that kills it.
    expect(r.expansionTarget!).toBeGreaterThan(r.keyLevel!.price);
    expect(r.invalidationLevel!).toBeCloseTo(r.keyLevel!.price, 6);
    expect(r.summary).toContain("bullish expansion");
  });

  it("does not treat a wick through the level as a breakout", () => {
    const b = respectedResistance(5);
    b.walk(104.2, 4);
    b.push(104.4, 106.2, 104.0, 1700); // pierces the level, closes back under

    const r = analyzeCandleCloseExpansion(b.bars);

    expect(r.candleClose).not.toBe("above");
    expect(r.breakoutDirection).toBe("none");
    expect(r.expansionProbability).toBe("Low");
    expect(r.expectedDirection).toBe("uncertain");
    expect(r.decisiveness.verdict).toBe("none");
    // Nothing to aim at and nothing to be stopped out of.
    expect(r.expansionTarget).toBeNull();
    expect(r.invalidationLevel).toBeNull();
    expect(r.summary).toContain("no confirmed close");
  });

  it("calls a barely-there close a weak break rather than an expansion", () => {
    const b = respectedResistance(5);
    b.walk(104.8, 4);
    b.push(105.55, 106.35, 104.7, 850); // just through, half body, thin volume

    const r = analyzeCandleCloseExpansion(b.bars);

    expect(r.candleClose).toBe("above");
    expect(r.decisiveness.verdict).toBe("weak");
    // A close through the level, but explicitly not a breakout to trade.
    expect(r.breakoutDirection).toBe("none");
    expect(r.expansionProbability).toBe("Low");
    expect(r.expectedDirection).toBe("uncertain");
    // The reasons it was rejected are surfaced, not swallowed.
    expect(r.decisiveness.checks.filter((c) => !c.passed).length).toBeGreaterThanOrEqual(3);
    for (const c of r.decisiveness.checks) {
      expect(c.label.length).toBeGreaterThan(3);
      expect(c.detail.length).toBeGreaterThan(10);
    }
    expect(r.summary).toContain("not a breakout");
  });

  it("drops a bullish expansion call once price closes back through the level", () => {
    const b = respectedResistance(5);
    b.walk(104.3, 5);
    b.push(108.0, 108.2, 104.1, 2600); // decisive break up...
    b.push(103.6, 108.1, 103.4, 2400); // ...immediately given back

    const r = analyzeCandleCloseExpansion(b.bars);

    expect(r.candleClose).toBe("below");
    expect(r.breakoutDirection).not.toBe("bullish");
    expect(r.expectedDirection).not.toBe("up");
  });
});

describe("candle close expansion — the level's track record", () => {
  it("suppresses probability when this level has a history of failing breaks", () => {
    const withFakes = new Builder(9);
    for (let t = 0; t < 2; t++) withFakes.tap();
    for (let f = 0; f < 3; f++) withFakes.fakeBreak();

    const suspect = analyzeCandleCloseExpansion(decisiveBreak(withFakes));
    const clean = analyzeCandleCloseExpansion(decisiveBreak(respectedResistance(5)));

    // Same textbook break candle in both cases...
    expect(suspect.decisiveness.verdict).toBe("decisive");
    expect(suspect.decisiveness.score).toBeGreaterThan(80);

    // ...but this level fakes out half the time, and that must cost it.
    expect(suspect.keyLevel!.historicalFalseBreakRate).toBeGreaterThan(0);
    expect(suspect.historicalPrecedents.length).toBeGreaterThan(0);
    expect(suspect.historicalPrecedents.some((p) => p.failed)).toBe(true);
    expect(suspect.expansionScore).toBeLessThan(clean.expansionScore);
    expect(clean.keyLevel!.historicalFalseBreakRate).toBe(0);
    expect(suspect.reason.join(" ")).toContain("false-break rate");
  });

  it("says so plainly when the level has no resolved break to learn from", () => {
    const r = analyzeCandleCloseExpansion(decisiveBreak(respectedResistance(5)));
    expect(r.historicalPrecedents).toHaveLength(0);
    expect(r.reason.join(" ")).toContain("no track record");
  });
});

describe("candle close expansion — degradation and integrity", () => {
  it("returns an honest empty read instead of guessing from thin history", () => {
    const r = analyzeCandleCloseExpansion(respectedResistance(2).bars.slice(0, 30));
    expect(r.keyLevel).toBeNull();
    expect(r.breakoutDirection).toBe("none");
    expect(r.expectedDirection).toBe("uncertain");
    expect(r.expansionProbability).toBe("Low");
    expect(r.summary).toContain("40 candles");
  });

  it("is a pure function of its candles", () => {
    const cs = decisiveBreak(respectedResistance(4, 21));
    expect(analyzeCandleCloseExpansion(cs)).toEqual(analyzeCandleCloseExpansion(cs));
  });

  it("keeps the score, the band and the direction mutually consistent", () => {
    for (let seed = 3; seed <= 9; seed++) {
      const r = analyzeCandleCloseExpansion(decisiveBreak(respectedResistance(4, seed)));

      expect(r.expansionScore).toBeGreaterThanOrEqual(0);
      expect(r.expansionScore).toBeLessThanOrEqual(95);
      expect(r.reason.length).toBeGreaterThan(0);

      // A band is never claimed above the score that earned it.
      if (r.expansionProbability === "High") expect(r.expansionScore).toBeGreaterThanOrEqual(55);
      if (r.expansionProbability === "Low") expect(r.expansionScore).toBeLessThan(55);

      // No direction without a confirmed breakout, and vice versa.
      if (r.breakoutDirection === "none") expect(r.expectedDirection).toBe("uncertain");
      if (r.expectedDirection === "up") expect(r.breakoutDirection).toBe("bullish");
      if (r.expectedDirection === "down") expect(r.breakoutDirection).toBe("bearish");

      // A target only ever sits on the far side of the level from the stop.
      if (r.expansionTarget !== null) {
        expect(r.invalidationLevel).not.toBeNull();
        if (r.expectedDirection === "up") expect(r.expansionTarget).toBeGreaterThan(r.invalidationLevel!);
        if (r.expectedDirection === "down") expect(r.expansionTarget).toBeLessThan(r.invalidationLevel!);
      }
    }
  });
});
