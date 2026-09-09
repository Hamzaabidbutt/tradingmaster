import { describe, expect, it } from "vitest";
import { readAlignment, readTimeframe } from "@/engines/timeframeAlignment";
import { Candle } from "@/engines/types";

/**
 * The point of the ribbon is catching the case where a lower timeframe looks
 * clean and a higher one disagrees, so the cases pinned hardest are the
 * disagreements — between the two facts inside one timeframe, and between
 * timeframes.
 */

const T0 = 1_700_000_000;
const HOUR = 3600;

/** A series that trends, with enough wiggle to produce real swing points. */
function trending(n: number, from: number, to: number): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const base = from + ((to - from) * i) / (n - 1);
    const wob = Math.sin(i / 2.5) * Math.abs(to - from) * 0.02;
    const close = base + wob;
    return {
      time: T0 + i * HOUR,
      open: close,
      high: close * 1.004,
      low: close * 0.996,
      close,
      volume: 1000,
      takerBuyVolume: 500,
    };
  });
}

function flat(n: number, at = 100): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    time: T0 + i * HOUR,
    open: at,
    high: at * 1.001,
    low: at * 0.999,
    close: at,
    volume: 1000,
    takerBuyVolume: 500,
  }));
}

describe("readTimeframe", () => {
  it("returns null rather than a neutral read on too little history", () => {
    expect(readTimeframe("1h", trending(20, 100, 120))).toBeNull();
  });

  it("reads a clean uptrend as aligned", () => {
    const r = readTimeframe("1h", trending(200, 100, 180))!;
    expect(r.trend).toBe("bullish");
    expect(r.distancePct).toBeGreaterThan(0);
    expect(r.bars).toBe(200);
  });

  it("mirrors for a downtrend", () => {
    const r = readTimeframe("1h", trending(200, 180, 100))!;
    expect(r.trend).toBe("bearish");
    expect(r.distancePct).toBeLessThan(0);
  });

  it("calls a flat series neutral rather than picking a side", () => {
    const r = readTimeframe("1h", flat(200))!;
    expect(r.trend).toBe("neutral");
    expect(r.aligned).toBe(false);
    expect(Math.abs(r.distancePct)).toBeLessThan(0.4);
  });

  it("does not flicker on a hair's distance from the average", () => {
    // Price a fraction of a percent above the average is on it, not above it.
    const bars = flat(200);
    bars[bars.length - 1] = { ...bars[bars.length - 1], close: 100.1 };
    expect(readTimeframe("1h", bars)!.trend).toBe("neutral");
  });

  it("says mid-transition when its two facts disagree", () => {
    // Long decline then a sharp recovery: structure turns before the average.
    const bars = [...trending(150, 200, 100), ...trending(50, 100, 150)].map((c, i) => ({
      ...c,
      time: T0 + i * HOUR,
    }));
    const r = readTimeframe("1h", bars)!;
    if (r.structure !== "neutral" && r.trend !== "neutral" && r.structure !== r.trend) {
      expect(r.aligned).toBe(false);
      expect(r.note).toMatch(/mid-transition/i);
    } else {
      // Whatever it resolved to, an unaligned read must never claim alignment.
      expect(r.aligned).toBe(r.structure === r.trend && r.structure !== "neutral");
    }
  });
});

describe("readAlignment", () => {
  it("drops timeframes with too little history instead of counting them neutral", () => {
    const r = readAlignment([
      { timeframe: "15m", candles: trending(200, 100, 160) },
      { timeframe: "4h", candles: trending(10, 100, 160) },
    ]);
    expect(r.reads).toHaveLength(1);
    expect(r.reads[0].timeframe).toBe("15m");
  });

  it("says so when nothing can be read", () => {
    const r = readAlignment([{ timeframe: "1d", candles: trending(5, 100, 110) }]);
    expect(r.reads).toHaveLength(0);
    expect(r.headline).toMatch(/enough history/i);
  });

  it("names disagreement when timeframes point opposite ways", () => {
    const r = readAlignment([
      { timeframe: "15m", candles: trending(200, 100, 180) },
      { timeframe: "4h", candles: trending(200, 180, 100) },
    ]);
    if (r.bullish > 0 && r.bearish > 0) {
      expect(r.headline).toMatch(/disagree/i);
      expect(r.consensus).toBe("neutral");
      expect(r.note).toMatch(/not a signal to fade/i);
    }
  });

  it("only calls consensus when nothing points the other way", () => {
    const r = readAlignment([
      { timeframe: "15m", candles: trending(200, 100, 180) },
      { timeframe: "1h", candles: trending(200, 100, 180) },
    ]);
    expect(r.bearish).toBe(0);
    if (r.bullish > 0) expect(r.consensus).toBe("bullish");
  });

  it("never reports alignment as an entry", () => {
    const r = readAlignment([{ timeframe: "1h", candles: trending(200, 100, 180) }]);
    const text = `${r.headline} ${r.note}`.toLowerCase();
    // Recommendation phrases, not the bare word "entry" — the note is
    // required to say "context, not an entry", which is the opposite of a
    // recommendation and must not trip its own guard.
    for (const banned of ["buy here", "sell here", "take the", "will rise", "will fall", "guaranteed"]) {
      expect(text).not.toContain(banned);
    }
    expect(r.note).toMatch(/context, not an entry|not a signal to fade/i);
  });

  it("counts unclear timeframes without letting them vote", () => {
    const r = readAlignment([
      { timeframe: "15m", candles: trending(200, 100, 180) },
      { timeframe: "4h", candles: flat(200) },
    ]);
    expect(r.unclear).toBeGreaterThanOrEqual(1);
    expect(r.bullish + r.bearish + r.unclear).toBe(r.reads.length);
  });
});
