import { describe, expect, it } from "vitest";
import { detectLiquidationReversal } from "@/engines/liquidationReversal";
import { Candle } from "@/engines/types";
import { candle, syntheticCandles } from "./helpers";

const T0 = 1_700_000_000;
const t = (i: number) => T0 + i * 900;

/**
 * A capitulation series: quiet chop, one violent seller-dominated bar, then a
 * recovery of a chosen size.
 *
 * `flushIndex` controls the one thing the engine cares most about — whether the
 * spike printed at the low of the window or somewhere on the way down.
 */
function flushSeries(opts: {
  /** bars after the flush; recovery is spread across them */
  after: number;
  /** where price ends up, as a % above the flush low */
  recoveryPct: number;
  /** true = price keeps making lower lows after the flush (spike was mid-move) */
  keepFalling?: boolean;
  /** true = the flush bar is ordinary in size (no forced signature) */
  orderly?: boolean;
}): Candle[] {
  const bars: Candle[] = [];
  // 0-39: quiet drift down from 100 to ~96. Ordinary volume, balanced flow.
  for (let i = 0; i < 40; i++) {
    const c = 100 - i * 0.1;
    bars.push(candle(t(i), c + 0.1, c + 0.25, c - 0.25, c, 1000, 500));
  }

  // 40: the flush. Huge range, huge volume, almost all of it seller-initiated.
  const open = 96;
  const low = 92;
  const close = 93;
  bars.push(
    opts.orderly
      ? candle(t(40), open, open + 0.2, low, close, 1100, 520)
      : candle(t(40), open, open + 0.2, low, close, 6000, 600)
  );

  // 41+: recovery, or continuation lower.
  const target = opts.keepFalling ? low * 0.97 : low * (1 + opts.recoveryPct / 100);
  for (let i = 0; i < opts.after; i++) {
    const p = close + ((target - close) * (i + 1)) / opts.after;
    // Buyers on the way back up, so post-flush delta is net positive.
    bars.push(candle(t(41 + i), p - 0.05, p + 0.15, p - 0.15, p, 1200, opts.keepFalling ? 500 : 800));
  }
  return bars;
}

describe("liquidation spike reversal — long flush at the low", () => {
  const setup = detectLiquidationReversal("TESTUSDT", "15m", flushSeries({ after: 4, recoveryPct: 4 }));

  it("finds the flush and puts it at the bottom", () => {
    expect(setup.spike).not.toBeNull();
    expect(setup.spike!.side).toBe("long");
    expect(setup.location).toBe("bottom");
    expect(setup.spike!.atExtreme).toBe(true);
    expect(setup.spike!.extreme).toBeCloseTo(92, 6);
  });

  it("measures the reversal the flush produced", () => {
    expect(setup.reversalPct).toBeGreaterThan(3);
    expect(setup.peakReversalPct).toBeGreaterThanOrEqual(setup.reversalPct);
  });

  it("calls the flow inferred, never measured, with no forced-order feed", () => {
    expect(setup.forced).toBe("inferred");
    expect(setup.forcedNote).toContain("estimate");
    expect(setup.qualified).toBe(true);
    expect(["strong", "prime"]).toContain(setup.grade);
  });

  it("upgrades to measured when live forced prints are supplied", () => {
    const candles = flushSeries({ after: 4, recoveryPct: 4 });
    const flushTime = candles[40].time;
    const withPrints = detectLiquidationReversal("TESTUSDT", "15m", candles, [
      { time: flushTime, side: "long", qty: 4200 },
    ]);
    expect(withPrints.forced).toBe("confirmed");
    expect(withPrints.forcedNote).toContain("measured");
    // A measured cascade should not score below the inferred version of itself.
    expect(withPrints.score).toBeGreaterThanOrEqual(setup.score);
  });

  it("puts the invalidation at the flush extreme", () => {
    expect(setup.invalidation).toBeCloseTo(92, 6);
    expect(setup.headline).toContain("long flush");
  });
});

describe("liquidation spike reversal — rejections", () => {
  it("refuses a spike that is not at the extreme", () => {
    // Price kept making lower lows after the flush: that was a leg of the
    // decline, not the end of it, however large the bar was.
    const setup = detectLiquidationReversal(
      "TESTUSDT",
      "15m",
      flushSeries({ after: 8, recoveryPct: 0, keepFalling: true })
    );
    expect(setup.spike).not.toBeNull();
    expect(setup.spike!.atExtreme).toBe(false);
    expect(setup.location).toBe("mid");
    expect(setup.qualified).toBe(false);
    expect(setup.headline).toContain("mid-move");
  });

  it("refuses an orderly bar with no forced signature", () => {
    const setup = detectLiquidationReversal(
      "TESTUSDT",
      "15m",
      flushSeries({ after: 4, recoveryPct: 4, orderly: true })
    );
    // The estimator registers nothing at all on an ordinary bar.
    expect(setup.qualified).toBe(false);
    expect(setup.forced).toBe("unlikely");
  });

  it("does not qualify a flush that has produced no reversal", () => {
    const setup = detectLiquidationReversal(
      "TESTUSDT",
      "15m",
      flushSeries({ after: 3, recoveryPct: 0 })
    );
    expect(setup.reversalPct).toBeLessThanOrEqual(1.2);
    expect(setup.qualified).toBe(false);
  });

  it("returns an empty setup with too little history", () => {
    const setup = detectLiquidationReversal("TESTUSDT", "15m", syntheticCandles(10));
    expect(setup.spike).toBeNull();
    expect(setup.headline).toContain("Not enough history");
  });

  it("reports no spike on ordinary two-sided trade", () => {
    const setup = detectLiquidationReversal("TESTUSDT", "15m", syntheticCandles(200, 11));
    if (setup.spike === null) {
      expect(setup.location).toBe("none");
      expect(setup.forced).toBe("unlikely");
    } else {
      // If the random walk happened to print one, it must still be classified,
      // not silently qualified.
      expect(typeof setup.score).toBe("number");
    }
  });
});

describe("liquidation spike reversal — short squeeze at the high", () => {
  /** Mirror of the flush: a violent buyer-dominated bar at the top. */
  function squeezeSeries(): Candle[] {
    const bars: Candle[] = [];
    for (let i = 0; i < 40; i++) {
      const c = 100 + i * 0.1;
      bars.push(candle(t(i), c - 0.1, c + 0.25, c - 0.25, c, 1000, 500));
    }
    bars.push(candle(t(40), 104, 108, 103.9, 107, 6000, 5400));
    // Fade back off the high.
    for (let i = 0; i < 4; i++) {
      const p = 107 - (i + 1) * 0.7;
      bars.push(candle(t(41 + i), p + 0.05, p + 0.15, p - 0.15, p, 1200, 400));
    }
    return bars;
  }

  it("detects the squeeze and locates it at the top", () => {
    const setup = detectLiquidationReversal("TESTUSDT", "15m", squeezeSeries());
    expect(setup.spike!.side).toBe("short");
    expect(setup.location).toBe("top");
    expect(setup.spike!.extreme).toBeCloseTo(108, 6);
    // Reversal is downward here, and still reported as a positive %.
    expect(setup.reversalPct).toBeGreaterThan(0);
    expect(setup.headline).toContain("squeeze");
  });
});
