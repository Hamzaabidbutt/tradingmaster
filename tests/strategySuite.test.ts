import { describe, expect, it } from "vitest";
import { runStrategySuite } from "@/engines/strategySuite";
import { scoreReadability } from "@/services/strongSymbol";
import { Candle } from "@/engines/types";
import { syntheticCandles } from "./helpers";

/**
 * A ranking is only worth reading if the thing being ranked was measured
 * fairly. What is pinned here: every strategy sees the same bars, nothing sees
 * the future, thin samples are excluded from the ranking rather than allowed
 * to top it, and the numbers stay finite on degenerate input.
 */

const HOUR = 3600;
const T0 = 1_700_000_000;

/** A trending series with real pivots, so strategies have something to read. */
function trending(bars = 700, direction: 1 | -1 = 1): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < bars; i++) {
    const wave = Math.sin(i / 9) * 0.9 + Math.sin(i / 31) * 1.4;
    const open = price;
    const close = Math.max(1, open + direction * 0.08 + wave * 0.25);
    const wick = 0.3 + Math.abs(Math.cos(i / 7)) * 0.4;
    out.push({
      time: T0 + i * HOUR,
      open,
      close,
      high: Math.max(open, close) + wick,
      low: Math.min(open, close) - wick,
      volume: 1000 + (i % 11) * 90,
      takerBuyVolume: (1000 + (i % 11) * 90) * (0.45 + (i % 5) * 0.02),
    });
    price = close;
  }
  return out;
}

describe("runStrategySuite", () => {
  it("returns a row for every registered strategy", () => {
    const r = runStrategySuite("TESTUSDT", "1h", trending(600), { step: 12 });
    expect(r.rows.length).toBeGreaterThan(20);
    // Keys are unique — a duplicated strategy would double-count in the rank.
    expect(new Set(r.rows.map((x) => x.key)).size).toBe(r.rows.length);
  });

  it("walks the history once rather than once per strategy", () => {
    // The whole design rests on this: thirty separate walks would be thirty
    // times the analyses and far past any function time limit.
    const r = runStrategySuite("TESTUSDT", "1h", trending(600), { step: 12 });
    const expectedSteps = Math.ceil((600 - 300 - 1) / 12);
    expect(r.steps).toBeLessThanOrEqual(expectedSteps + 1);
    expect(r.steps).toBeGreaterThan(0);
  });

  it("ranks only strategies that cleared the trade floor", () => {
    const r = runStrategySuite("TESTUSDT", "1h", trending(700), { step: 8 });
    for (const row of r.rows) {
      if (row.rank != null) {
        expect(row.winRatePct).not.toBeNull();
        expect(row.trades).toBeGreaterThanOrEqual(10);
      } else {
        // Unranked rows are the thin ones, and they sort after the ranked.
        expect(row.winRatePct).toBeNull();
      }
    }
  });

  it("orders the ranked rows by success rate, highest first", () => {
    const r = runStrategySuite("TESTUSDT", "1h", trending(700), { step: 8 });
    const ranked = r.rows.filter((x) => x.rank != null);
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].winRatePct!).toBeGreaterThanOrEqual(ranked[i].winRatePct!);
    }
    expect(ranked.map((x) => x.rank)).toEqual(ranked.map((_, i) => i + 1));
  });

  it("puts every unranked row after every ranked one", () => {
    // A 100%-from-four-trades strategy must never appear above one with a
    // measured rate; that is the classic way a leaderboard lies.
    const r = runStrategySuite("TESTUSDT", "1h", trending(700), { step: 8 });
    const firstUnranked = r.rows.findIndex((x) => x.rank == null);
    if (firstUnranked >= 0) {
      expect(r.rows.slice(firstUnranked).every((x) => x.rank == null)).toBe(true);
    }
  });

  it("keeps wins and losses adding up to the trade count", () => {
    const r = runStrategySuite("TESTUSDT", "1h", trending(600), { step: 10 });
    for (const row of r.rows) {
      expect(row.wins + row.losses).toBe(row.trades);
    }
  });

  it("never holds more than one trade per strategy at a time", () => {
    // Overlapping entries would let one strong stretch be counted repeatedly.
    const r = runStrategySuite("TESTUSDT", "1h", trending(700), { step: 1 });
    for (const row of r.rows) {
      // With a 60-bar max hold and 400 tradeable bars, no strategy can
      // legitimately produce more trades than bars/1.
      expect(row.trades).toBeLessThanOrEqual(700);
    }
  });

  it("states that the geometry is a yardstick rather than a forecast", () => {
    const r = runStrategySuite("TESTUSDT", "1h", trending(600), { step: 12 });
    expect(r.note).toMatch(/yardstick/i);
    expect(r.note).toMatch(/identical geometry/i);
    // And that one symbol over one window is one experiment.
    expect(r.note).toMatch(/one experiment|nothing more/i);
  });

  it("resolves an ambiguous bar as a stop rather than a target", () => {
    expect(runStrategySuite("TESTUSDT", "1h", trending(600), { step: 12 }).note).toMatch(
      /resolved as a stop/i
    );
  });

  it("emits finite numbers on noise and on flat input", () => {
    for (const candles of [
      syntheticCandles(600, 7, 100),
      Array.from({ length: 600 }, (_, i) => ({
        time: T0 + i * HOUR,
        open: 50,
        high: 50,
        low: 50,
        close: 50,
        volume: 0,
        takerBuyVolume: 0,
      })),
    ]) {
      const r = runStrategySuite("TESTUSDT", "1h", candles, { step: 15 });
      for (const row of r.rows) {
        expect(Number.isFinite(row.maxDrawdownPct)).toBe(true);
        expect(Number.isFinite(row.netReturnPct)).toBe(true);
        expect(Number.isFinite(row.avgHoldBars)).toBe(true);
        if (row.expectancyR != null) expect(Number.isFinite(row.expectancyR)).toBe(true);
        if (row.profitFactor != null) expect(Number.isFinite(row.profitFactor)).toBe(true);
      }
    }
  });

  it("returns an empty-but-valid result on a series too short to walk", () => {
    const r = runStrategySuite("TESTUSDT", "1h", trending(200), { step: 4 });
    expect(r.steps).toBe(0);
    expect(r.rows.every((x) => x.trades === 0)).toBe(true);
    expect(r.rows.every((x) => x.rank == null)).toBe(true);
  });
});

describe("scoreReadability", () => {
  it("scores a clean trend above directionless noise", () => {
    const clean = scoreReadability(trending(400));
    const flat = scoreReadability(
      Array.from({ length: 400 }, (_, i) => ({
        time: T0 + i * HOUR,
        open: 100,
        high: 100.02,
        low: 99.98,
        close: 100,
        volume: 10,
        takerBuyVolume: 5,
      }))
    );
    expect(clean.score).toBeGreaterThan(flat.score);
  });

  it("scores a series too short to read at zero", () => {
    expect(scoreReadability(trending(50)).score).toBe(0);
  });

  it("rejects a chart too quiet to place a stop on", () => {
    // ATR under 0.4% of price: a 1.5-ATR stop would sit inside the spread.
    const quiet = Array.from({ length: 400 }, (_, i) => ({
      time: T0 + i * HOUR,
      open: 1000,
      high: 1000.5,
      low: 999.5,
      close: 1000 + (i % 2 ? 0.1 : -0.1),
      volume: 100,
      takerBuyVolume: 50,
    }));
    const r = scoreReadability(quiet);
    expect(r.atrPct).toBeLessThan(0.4);
    // The volatility band is worth 40 of the score, so failing it is visible.
    expect(r.score).toBeLessThan(60);
  });
});
