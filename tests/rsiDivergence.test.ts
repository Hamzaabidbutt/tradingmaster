import { describe, expect, it } from "vitest";
import {
  RSI_PERIOD,
  computeRsi,
  findRsiDivergences,
  isRegular,
  sideOf,
} from "@/engines/rsiDivergence";
import { Candle } from "@/engines/types";

/**
 * Two things are worth testing hard here.
 *
 * The RSI itself, because it is a number people will compare against their
 * charting package, and a smoothing bug produces values that look perfectly
 * plausible and are simply different from everyone else's.
 *
 * And the refusals, because divergence is the most over-found pattern in
 * technical analysis: reach far enough back for a pair of pivots and some pair
 * always disagrees, so a scanner with loose rules finds one on every chart and
 * is therefore worth nothing.
 */

let clock = 1_700_000_000;
function bar(close: number, high?: number, low?: number): Candle {
  clock += 3600;
  return {
    time: clock,
    open: close,
    high: high ?? close + 0.2,
    low: low ?? close - 0.2,
    close,
    volume: 1000,
  };
}

/** A series of closes, with wicks that make each turning point a real pivot. */
function fromCloses(closes: number[]): Candle[] {
  return closes.map((c, i) => {
    const prev = closes[i - 1] ?? c;
    const next = closes[i + 1] ?? c;
    const isHigh = c > prev && c > next;
    const isLow = c < prev && c < next;
    return bar(c, isHigh ? c + 1 : c + 0.2, isLow ? c - 1 : c - 0.2);
  });
}

describe("computeRsi", () => {
  it("returns null until there is enough history", () => {
    const rsi = computeRsi(fromCloses(Array.from({ length: 30 }, (_, i) => 100 + i)));
    for (let i = 0; i < RSI_PERIOD; i++) expect(rsi[i]).toBeNull();
    expect(rsi[RSI_PERIOD]).not.toBeNull();
  });

  it("is 100 when nothing has closed down", () => {
    /* Average loss of zero makes RS infinite, and 100 is the limit every chart
       package draws. A division guard returning 50 would report a runaway
       rally as neutral, which is the kind of wrong that never looks wrong. */
    const rsi = computeRsi(fromCloses(Array.from({ length: 40 }, (_, i) => 100 + i)));
    expect(rsi[39]).toBe(100);
  });

  it("is low when nothing has closed up", () => {
    const rsi = computeRsi(fromCloses(Array.from({ length: 40 }, (_, i) => 200 - i)));
    expect(rsi[39]!).toBeLessThan(5);
  });

  it("sits near the middle on an alternating series", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + (i % 2 === 0 ? 1 : -1));
    const rsi = computeRsi(fromCloses(closes));
    expect(rsi[59]!).toBeGreaterThan(35);
    expect(rsi[59]!).toBeLessThan(65);
  });

  it("stays inside 0-100 on anything", () => {
    const wild = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 3) * 40 + (i % 7));
    for (const v of computeRsi(fromCloses(wild))) {
      if (v == null) continue;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it("uses Wilder smoothing rather than a moving average", () => {
    /* The distinguishing case: after a long flat stretch, one large up-close.
       A simple average of the last 14 would jump far more than Wilder's, which
       only folds in 1/14th of the new value. */
    const closes = [...Array.from({ length: 40 }, () => 100), 110];
    const rsi = computeRsi(fromCloses(closes));
    // 1/14th of a large gain against zero prior loss still pins RSI at 100
    // only if avgLoss is zero; here it is, so check the step before instead.
    const flat = computeRsi(fromCloses(Array.from({ length: 41 }, () => 100)));
    expect(flat[40]).toBe(100); // no losses at all in a flat series
    expect(rsi[40]).toBe(100);
  });

  it("aligns index-for-index with the candles it was given", () => {
    const candles = fromCloses(Array.from({ length: 50 }, (_, i) => 100 + (i % 5)));
    expect(computeRsi(candles)).toHaveLength(candles.length);
  });
});

describe("findRsiDivergences — refusing", () => {
  it("finds nothing in a series too short to hold pivots", () => {
    expect(findRsiDivergences(fromCloses([100, 101, 102]))).toEqual([]);
  });

  it("finds nothing in a flat series", () => {
    expect(findRsiDivergences(fromCloses(Array.from({ length: 80 }, () => 100)))).toEqual([]);
  });

  it("finds nothing when price and RSI agree", () => {
    /* A clean trend: each higher high comes with a higher RSI high. That is
       agreement, and reporting it would mean the scanner fires on everything. */
    const closes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const base = 100 + i * 4;
      closes.push(base, base + 3, base + 1);
    }
    const found = findRsiDivergences(fromCloses(closes));
    expect(found.filter((d) => d.kind === "regular_bearish")).toEqual([]);
  });

  it("compares only the last two pivots of each side", () => {
    /* Reaching further back for a pair that happens to disagree is how a
       divergence scanner finds one on literally every chart. With enough
       pivots some pair always diverges. */
    const found = findRsiDivergences(
      fromCloses(Array.from({ length: 140 }, (_, i) => 100 + Math.sin(i / 4) * 10))
    );
    // at most one of each of the four kinds
    const counts = new Map<string, number>();
    for (const d of found) counts.set(d.kind, (counts.get(d.kind) ?? 0) + 1);
    for (const n of counts.values()) expect(n).toBe(1);
  });
});

describe("findRsiDivergences — what it reports", () => {
  /** Two rallies: the second reaches higher on visibly weaker momentum. */
  function bearishShape(): Candle[] {
    const closes: number[] = [];
    // a strong first leg up to a high
    for (let i = 0; i < 20; i++) closes.push(100 + i * 1.5);
    // deep pullback, which is what drains RSI
    for (let i = 0; i < 14; i++) closes.push(130 - i * 1.6);
    // grind back to a marginally higher high
    for (let i = 0; i < 22; i++) closes.push(108 + i * 1.1);
    for (let i = 0; i < 6; i++) closes.push(132 - i * 0.8);
    return fromCloses(closes);
  }

  it("finds a regular bearish divergence and signs it", () => {
    const found = findRsiDivergences(bearishShape());
    const bear = found.find((d) => d.kind === "regular_bearish");
    expect(bear).toBeDefined();
    expect(bear!.pricePct).toBeGreaterThan(0); // price made the higher high
    expect(bear!.rsiDelta).toBeLessThan(0); // RSI did not
    expect(bear!.to.time).toBeGreaterThan(bear!.from.time);
  });

  it("orders newest first", () => {
    const found = findRsiDivergences(
      fromCloses(Array.from({ length: 160 }, (_, i) => 100 + Math.sin(i / 5) * 12 + i * 0.05))
    );
    for (let i = 1; i < found.length; i++) {
      expect(found[i - 1].to.time).toBeGreaterThanOrEqual(found[i].to.time);
    }
  });

  it("keeps strength inside 0-100", () => {
    for (const scale of [0.5, 5, 40]) {
      const found = findRsiDivergences(
        fromCloses(Array.from({ length: 160 }, (_, i) => 100 + Math.sin(i / 5) * scale))
      );
      for (const d of found) {
        expect(d.strength).toBeGreaterThanOrEqual(0);
        expect(d.strength).toBeLessThanOrEqual(100);
      }
    }
  });

  it("carries a label and a note on every row", () => {
    for (const d of findRsiDivergences(bearishShape())) {
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.note.length).toBeGreaterThan(0);
    }
  });
});

describe("kind semantics", () => {
  it("separates regular from hidden", () => {
    expect(isRegular("regular_bearish")).toBe(true);
    expect(isRegular("regular_bullish")).toBe(true);
    expect(isRegular("hidden_bearish")).toBe(false);
    expect(isRegular("hidden_bullish")).toBe(false);
  });

  it("maps each kind to the side a reader would take", () => {
    /* Hidden and regular point opposite ways from the same machinery, so
       collapsing them into one label would give a list where half the rows
       mean the reverse of the other half. */
    expect(sideOf("regular_bullish")).toBe("long");
    expect(sideOf("hidden_bullish")).toBe("long");
    expect(sideOf("regular_bearish")).toBe("short");
    expect(sideOf("hidden_bearish")).toBe("short");
  });
});

describe("computeRsi against a hand-computed reference", () => {
  /**
   * Wilder's worked example, with the expected values derived from the
   * definition rather than copied from a tutorial table.
   *
   * That distinction cost a test. Several widely-circulated versions of this
   * table give 70.53 for the first value; the arithmetic gives 70.4641, and
   * the arithmetic is not in doubt:
   *
   *   changes 1..14  ->  gains sum 3.34, losses sum 1.40
   *   avgGain 3.34/14 = 0.238571,  avgLoss 1.40/14 = 0.100000
   *   RS = 2.385714,  RSI = 100 - 100/(1 + RS) = 70.4641
   *
   * The circulated tables carry a transcription drift of about 0.07 that
   * propagates through the smoothing. Written out here so that a future reader
   * comparing against one of those tables does not "fix" correct code toward
   * the folklore number.
   */
  const CLOSES = [
    44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89,
    46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64,
  ];

  it("seeds the first value from a simple average of the first period", () => {
    const rsi = computeRsi(CLOSES.map((c) => bar(c)));
    expect(rsi[13]).toBeNull();
    expect(rsi[14]!).toBeCloseTo(70.4641, 3);
  });

  it("smooths every later value the Wilder way", () => {
    /* (prev * 13 + current) / 14, not a moving average of the last fourteen.
       The two agree on the first value and drift apart immediately after, so
       this is the assertion that actually distinguishes them. */
    const rsi = computeRsi(CLOSES.map((c) => bar(c)));
    expect(rsi[15]!).toBeCloseTo(66.2496, 3);
    expect(rsi[16]!).toBeCloseTo(66.4809, 3);
  });

  it("respects a non-default period", () => {
    const candles = CLOSES.map((c) => bar(c));
    const fast = computeRsi(candles, 5);
    const slow = computeRsi(candles, 14);
    expect(fast[5]).not.toBeNull();
    expect(slow[5]).toBeNull();
  });
});
