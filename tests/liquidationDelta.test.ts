import { describe, expect, it } from "vitest";
import { analyzeLiquidationDelta } from "@/engines/liquidationDelta";
import { Candle } from "@/engines/types";
import { candle } from "./helpers";

/**
 * The property under test is timeframe agreement.
 *
 * A cascade is a real event at a real time. Whether the user can see it must
 * not depend on which timeframe button is pressed — which is exactly what went
 * wrong: the detector thresholds a bar against its own timeframe's averages,
 * so a short flush dominates a 5m bar and disappears inside a 15m one.
 */

const T0 = 1_700_000_000;

/**
 * `count` one-minute candles of quiet trade, with a seller-dominated flush
 * occupying `flushMinutes` starting at `flushAt`.
 *
 * The flush is deliberately sized to straddle the detector's 1.6× volume
 * threshold: 6000 extra on a 4000-volume 5m bar is 2.1× and registers, while
 * the same 6000 on a 12000-volume 15m bar is 1.37× and does not. A larger
 * flush would be caught on both timeframes and would test nothing — the bug
 * only exists for events that are big for one bar size and ordinary for the
 * next one up.
 */
function minuteCandles(count: number, flushAt: number, flushMinutes: number): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const t = T0 + i * 60;
    const inFlush = i >= flushAt && i < flushAt + flushMinutes;
    if (inFlush) {
      // Wide range, 3000 of volume, almost all of it hitting the bid.
      const open = price;
      const close = price - 0.6;
      out.push(candle(t, open, open + 0.05, close - 0.15, close, 3000, 300));
      price = close;
    } else {
      const open = price;
      const close = price + (i % 2 === 0 ? 0.03 : -0.03);
      out.push(candle(t, open, Math.max(open, close) + 0.05, Math.min(open, close) - 0.05, close, 800, 400));
      price = close;
    }
  }
  return out;
}

/** Roll 1m candles up into `minutes`-sized bars, as an exchange would. */
function rollUp(minutes: Candle[], size: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i + size <= minutes.length; i += size) {
    const slice = minutes.slice(i, i + size);
    out.push({
      time: slice[0].time,
      open: slice[0].open,
      high: Math.max(...slice.map((c) => c.high)),
      low: Math.min(...slice.map((c) => c.low)),
      close: slice[slice.length - 1].close,
      volume: slice.reduce((s, c) => s + c.volume, 0),
      takerBuyVolume: slice.reduce((s, c) => s + (c.takerBuyVolume ?? c.volume / 2), 0),
    });
  }
  return out;
}

const minutes = minuteCandles(300, 200, 2);
const bars5m = rollUp(minutes, 5);
const bars15m = rollUp(minutes, 15);

function totalForced(r: ReturnType<typeof analyzeLiquidationDelta>): number {
  return r.series.reduce((s, p) => s + p.longLiquidated + p.shortLiquidated, 0);
}

describe("liquidation delta — same-timeframe estimate", () => {
  it("sees a 2-minute flush on 5m bars", () => {
    const r = analyzeLiquidationDelta(bars5m);
    expect(r.fidelity).toBe("estimated");
    expect(totalForced(r)).toBeGreaterThan(0);
  });

  it("loses the same flush on 15m bars — the reported bug", () => {
    // Diluted across twelve minutes of ordinary trade, the bar is no longer
    // outsized against its own averages, so nothing registers.
    const r = analyzeLiquidationDelta(bars15m);
    expect(r.fidelity).toBe("estimated");
    expect(totalForced(r)).toBe(0);
  });
});

describe("liquidation delta — sub-candle reconstruction", () => {
  it("recovers the flush on 15m when 1m candles are supplied", () => {
    const r = analyzeLiquidationDelta(bars15m, 60, minutes);
    expect(r.fidelity).toBe("sub_candle");
    expect(totalForced(r)).toBeGreaterThan(0);
    expect(r.dominantSide).toBe("long"); // longs were the side forced out
  });

  it("puts the forced volume on the bar that actually contains it", () => {
    const r = analyzeLiquidationDelta(bars15m, 60, minutes);
    const hit = r.series.filter((p) => p.longLiquidated > 0);
    expect(hit).toHaveLength(1);
    // Minute 200 falls in the 15m bar that opened at minute 195.
    expect(hit[0].time).toBe(T0 + 195 * 60);
  });

  it("reports a comparable size on 5m and 15m", () => {
    // The whole point: one event, one size, whatever the chart is sampled at.
    const five = totalForced(analyzeLiquidationDelta(bars5m, 60, minutes));
    const fifteen = totalForced(analyzeLiquidationDelta(bars15m, 60, minutes));
    expect(five).toBeGreaterThan(0);
    expect(fifteen).toBeGreaterThan(0);
    expect(Math.abs(five - fifteen) / Math.max(five, fifteen)).toBeLessThan(0.001);
  });

  it("says which path produced the numbers", () => {
    const sub = analyzeLiquidationDelta(bars15m, 60, minutes);
    const est = analyzeLiquidationDelta(bars15m);
    expect(sub.summary.join(" ")).toContain("reconstructed from lower-timeframe");
    expect(est.summary.join(" ")).toContain("estimated from these bars directly");
  });
});

describe("liquidation delta — guards", () => {
  it("falls back to the estimate when sub-candles are too sparse to trust", () => {
    // A handful of 1m bars cannot cover a 60-bar window; under-reporting
    // silently would be worse than estimating and saying so.
    const r = analyzeLiquidationDelta(bars15m, 60, minutes.slice(-10));
    expect(r.fidelity).toBe("estimated");
  });

  it("handles no sub-candles, null, and a short series", () => {
    expect(analyzeLiquidationDelta(bars15m, 60, null).fidelity).toBe("estimated");
    expect(analyzeLiquidationDelta(bars15m, 60, []).fidelity).toBe("estimated");
    const tiny = analyzeLiquidationDelta(bars15m.slice(0, 3));
    expect(tiny.series).toEqual([]);
    expect(tiny.fidelity).toBe("estimated");
  });

  it("keeps the cumulative line consistent with the per-bar deltas", () => {
    const r = analyzeLiquidationDelta(bars15m, 60, minutes);
    let running = 0;
    for (const p of r.series) {
      running += p.delta;
      expect(p.cumulative).toBeCloseTo(running, 6);
    }
  });
});
