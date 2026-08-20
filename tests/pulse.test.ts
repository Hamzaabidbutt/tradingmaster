import { describe, expect, it } from "vitest";
import { buildPulse } from "@/engines/pulse";
import { formatCountdown } from "@/hooks/useCandleCountdown";
import { candle, syntheticCandles } from "./helpers";

describe("market pulse engine", () => {
  it("returns null when there is not enough data", () => {
    expect(buildPulse([])).toBeNull();
    expect(buildPulse([candle(1, 100, 101, 99, 100)])).toBeNull();
  });

  it("summarises the window with complementary odds", () => {
    const p = buildPulse(syntheticCandles(90), { windowMinutes: 5 })!;
    expect(p).not.toBeNull();
    expect(p.windowMinutes).toBe(5);
    expect(p.bullishOdds + p.bearishOdds).toBe(100);
    expect(p.bullishOdds).toBeGreaterThanOrEqual(10);
    expect(p.bullishOdds).toBeLessThanOrEqual(90);
    expect(p.verdict.length).toBeGreaterThan(30);
    expect(p.keyTakeaways.length).toBeGreaterThan(0);
  });

  it("keeps the window high/low consistent with the candles used", () => {
    const candles = syntheticCandles(60);
    const p = buildPulse(candles, { windowMinutes: 5 })!;
    const window = candles.slice(-5);
    expect(p.high).toBe(Math.max(...window.map((c) => c.high)));
    expect(p.low).toBe(Math.min(...window.map((c) => c.low)));
    expect(p.priceEnd).toBe(window[window.length - 1].close);
  });

  it("identifies a bearish candle that closed with positive delta", () => {
    // 4 quiet bars, then a red bar whose taker-buy volume dominates.
    const base = Array.from({ length: 30 }, (_, i) =>
      candle(1000 + i * 60, 100, 100.2, 99.8, 100, 1000, 500)
    );
    // volume 4000, takerBuy 3200 => delta +2400 while the candle closes down.
    const trap = candle(1000 + 30 * 60, 100, 100.3, 99.0, 99.2, 4000, 3200);
    const p = buildPulse([...base, trap], { windowMinutes: 5 })!;

    const hit = p.absorptionCandles.find((a) => a.type === "bearish_positive_delta");
    expect(hit).toBeDefined();
    expect(hit!.delta).toBeGreaterThan(0);
    expect(hit!.close).toBeLessThan(hit!.open);
    expect(hit!.note).toContain("POSITIVE delta");
  });

  it("identifies a bullish candle that closed with negative delta", () => {
    const base = Array.from({ length: 30 }, (_, i) =>
      candle(1000 + i * 60, 100, 100.2, 99.8, 100, 1000, 500)
    );
    // volume 4000, takerBuy 800 => delta -2400 while the candle closes up.
    const trap = candle(1000 + 30 * 60, 100, 101.2, 99.9, 101, 4000, 800);
    const p = buildPulse([...base, trap], { windowMinutes: 5 })!;

    const hit = p.absorptionCandles.find((a) => a.type === "bullish_negative_delta");
    expect(hit).toBeDefined();
    expect(hit!.delta).toBeLessThan(0);
    expect(hit!.close).toBeGreaterThan(hit!.open);
  });

  it("locates the most traded price where volume concentrated", () => {
    // Heavy trade around 100, one thin excursion to 110.
    const heavy = Array.from({ length: 20 }, (_, i) =>
      candle(1000 + i * 60, 100, 100.3, 99.7, 100, 8000, 4000)
    );
    const thin = candle(1000 + 20 * 60, 100, 110, 100, 109, 100, 60);
    const p = buildPulse([...heavy, thin], { windowMinutes: 5 })!;
    // POC should stay near 100, not follow the thin excursion.
    expect(Math.abs(p.poc - 100)).toBeLessThan(6);
    expect(p.mostTradedPrices.length).toBeGreaterThan(0);
    const shares = p.mostTradedPrices.map((m) => m.share);
    // Shares are sorted descending.
    expect(shares).toEqual([...shares].sort((a, b) => b - a));
  });

  it("produces an institutional zone with ordered bounds", () => {
    const p = buildPulse(syntheticCandles(80), { windowMinutes: 5 })!;
    for (const z of p.institutionalZones) {
      expect(z.priceHigh).toBeGreaterThan(z.priceLow);
      expect(z.share).toBeGreaterThan(0);
      expect(z.share).toBeLessThanOrEqual(1);
      expect(["accumulation", "distribution", "neutral"]).toContain(z.side);
    }
  });

  it("aligns the next-move direction with the odds", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const p = buildPulse(syntheticCandles(80, seed), { windowMinutes: 5 })!;
      if (p.nextMove.direction === "bullish") expect(p.bullishOdds).toBeGreaterThanOrEqual(58);
      if (p.nextMove.direction === "bearish") expect(p.bearishOdds).toBeGreaterThanOrEqual(58);
      // Every factor must carry an explanation.
      for (const f of p.factors) expect(f.detail.length).toBeGreaterThan(5);
    }
  });
});

describe("market pulse — hour-long window", () => {
  it("defaults to a 60-minute window", () => {
    const p = buildPulse(syntheticCandles(400))!;
    expect(p.windowMinutes).toBe(60);
  });

  it("keeps the baseline strictly wider than the window", () => {
    // 60m window wants a 240m baseline; 400 bars is enough to give it one.
    const p = buildPulse(syntheticCandles(400), { windowMinutes: 60 })!;
    expect(p.baselineMinutes).toBe(240);
    expect(p.baselineMinutes).toBeGreaterThan(p.windowMinutes);
    expect(p.baselineDegraded).toBe(false);
  });

  it("does not pin volumeMultiple to 1.0 the way a self-referential baseline would", () => {
    // Quiet hours, then a genuinely busy final hour. Measured against itself
    // this would read 1.00x; measured against the wider baseline it must not.
    const quiet = Array.from({ length: 240 }, (_, i) =>
      candle(1000 + i * 60, 100, 100.2, 99.8, 100, 1000, 500)
    );
    const busy = Array.from({ length: 60 }, (_, i) =>
      candle(1000 + (240 + i) * 60, 100, 100.6, 99.4, 100.1, 4000, 2200)
    );
    const p = buildPulse([...quiet, ...busy], { windowMinutes: 60 })!;
    expect(p.volumeMultiple).toBeGreaterThan(1.5);
    expect(p.rangeMultiple).toBeGreaterThan(1.5);
  });

  it("flags a degraded baseline when history is too short to define normal", () => {
    // 70 bars cannot support a 240m baseline behind a 60m window.
    const p = buildPulse(syntheticCandles(70), { windowMinutes: 60 })!;
    expect(p.baselineDegraded).toBe(true);
    expect(p.baselineMinutes).toBeLessThan(p.windowMinutes * 2);
  });

  it("caps display lists but preserves the true counts", () => {
    // Every bar closes red on positive delta => 60 absorption candidates.
    const bars = Array.from({ length: 300 }, (_, i) =>
      candle(1000 + i * 60, 100, 100.4, 99.6, 99.9, 1200, 900)
    );
    const p = buildPulse(bars, { windowMinutes: 60 })!;
    expect(p.absorptionTotalCount).toBeGreaterThan(p.absorptionCandles.length);
    expect(p.absorptionCandles.length).toBeLessThanOrEqual(12);
    expect(p.bigTrades.length).toBeLessThanOrEqual(12);
    expect(p.bigTradesTotalCount).toBeGreaterThanOrEqual(p.bigTrades.length);
    expect(p.sweeps.length).toBeLessThanOrEqual(10);
    expect(p.sweepsTotalCount).toBeGreaterThanOrEqual(p.sweeps.length);
  });

  it("still produces complementary odds and a verdict over an hour", () => {
    for (let seed = 1; seed <= 6; seed++) {
      const p = buildPulse(syntheticCandles(400, seed), { windowMinutes: 60 })!;
      expect(p.bullishOdds + p.bearishOdds).toBe(100);
      expect(p.verdict.length).toBeGreaterThan(30);
      expect(p.keyTakeaways.length).toBeGreaterThan(0);
    }
  });
});

describe("candle countdown formatting", () => {
  it("formats mm:ss under an hour", () => {
    expect(formatCountdown(0)).toBe("00:00");
    expect(formatCountdown(59)).toBe("00:59");
    expect(formatCountdown(65)).toBe("01:05");
    expect(formatCountdown(3599)).toBe("59:59");
  });

  it("formats h:mm:ss past an hour", () => {
    expect(formatCountdown(3600)).toBe("1:00:00");
    expect(formatCountdown(7325)).toBe("2:02:05");
  });

  it("formats days for long timeframes", () => {
    expect(formatCountdown(86400 * 2 + 3661)).toBe("2d 01:01:01");
  });
});
