import { describe, expect, it } from "vitest";
import { readMarketRegime } from "@/engines/regime";
import { Candle } from "@/engines/types";
import { syntheticCandles } from "./helpers";

/**
 * The regime tag exists to be *measured against*, not to gate signals — so
 * what matters is that it is honest and stable, never that it is right about
 * the future. These pin three things: unknown stays distinct from neutral, the
 * volatility band is relative rather than absolute, and the label never
 * contradicts its own inputs.
 */

const H4 = 4 * 3600;
const t = (i: number) => 1_700_000_000 + i * H4;

function trending(direction: "up" | "down", bars = 200, noise = 0): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < bars; i++) {
    const step = direction === "up" ? 0.4 : -0.4;
    const wobble = noise * Math.sin(i / 5);
    const open = price;
    const close = price + step + wobble;
    out.push({
      time: t(i),
      open,
      high: Math.max(open, close) + 0.3,
      low: Math.min(open, close) - 0.3,
      close,
      volume: 1000,
      takerBuyVolume: 500,
    });
    price = close;
  }
  return out;
}

describe("readMarketRegime", () => {
  it("reports unknown rather than neutral when there is no history", () => {
    // These are different facts. Folding a failed read into "mixed" would put
    // signals into a bucket they were never measured in.
    const r = readMarketRegime([]);
    expect(r.label).toBe("unknown");
    expect(r.bars).toBe(0);
    expect(r.summary).toMatch(/no BTC history/i);
  });

  it("still reports unknown on a series too short to read", () => {
    const r = readMarketRegime(trending("up", 20));
    expect(r.label).toBe("unknown");
  });

  it("calls a sustained uptrend risk-on", () => {
    const r = readMarketRegime(trending("up"));
    expect(r.aboveMa).toBe(true);
    expect(r.changePct).toBeGreaterThan(0);
    expect(r.label).toBe("risk_on");
    expect(r.summary).toMatch(/alt longs have the market behind them/i);
  });

  it("calls a sustained downtrend risk-off", () => {
    const r = readMarketRegime(trending("down"));
    expect(r.aboveMa).toBe(false);
    expect(r.changePct).toBeLessThan(0);
    expect(r.label).toBe("risk_off");
    expect(r.summary).toMatch(/alt longs are fighting the market/i);
  });

  it("never labels risk-on while price is below its average", () => {
    // The label is derived from trend *and* location, and the two can
    // disagree — that disagreement is what "mixed" is for.
    for (const seed of [3, 11, 29, 47]) {
      const r = readMarketRegime(syntheticCandles(200, seed, 100));
      if (r.label === "risk_on") expect(r.aboveMa).toBe(true);
      if (r.label === "risk_off") expect(r.aboveMa).toBe(false);
    }
  });

  it("measures volatility against its own history, not an absolute", () => {
    // The same shape at a hundred times the price must read the same. An
    // absolute ATR threshold would call every high-priced asset volatile.
    const cheap = trending("up", 200, 0.5);
    const dear = cheap.map((c) => ({
      ...c,
      open: c.open * 100,
      high: c.high * 100,
      low: c.low * 100,
      close: c.close * 100,
    }));
    const a = readMarketRegime(cheap);
    const b = readMarketRegime(dear);
    expect(b.volatility).toBe(a.volatility);
    expect(b.atrPct).toBeCloseTo(a.atrPct, 3);
  });

  it("keeps the percentile and the band consistent", () => {
    for (const seed of [3, 11, 29, 47, 61]) {
      const r = readMarketRegime(syntheticCandles(200, seed, 100));
      expect(r.atrPercentile).toBeGreaterThanOrEqual(0);
      expect(r.atrPercentile).toBeLessThanOrEqual(100);
      if (r.volatility === "elevated") expect(r.atrPercentile).toBeGreaterThanOrEqual(75);
      if (r.volatility === "calm") expect(r.atrPercentile).toBeLessThanOrEqual(25);
    }
  });

  it("does not gate anything — it only describes", () => {
    // Guard against the tempting next step. If the engine ever starts
    // filtering by regime, the measurement becomes circular: you would only
    // see outcomes from the regime you already believed in.
    const r = readMarketRegime(trending("down"));
    expect(r).not.toHaveProperty("allow");
    expect(r).not.toHaveProperty("blocked");
    expect(Object.keys(r).sort()).toEqual(
      [
        "aboveMa",
        "atrPct",
        "atrPercentile",
        "bars",
        "changePct",
        "label",
        "summary",
        "timeframe",
        "trend",
        "volatility",
      ].sort()
    );
  });

  it("carries the reference timeframe through", () => {
    expect(readMarketRegime(trending("up"), "1d").timeframe).toBe("1d");
  });
});
