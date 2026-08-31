import { describe, expect, it } from "vitest";
import { findStrongCandles } from "@/engines/strongCandles";
import { Candle, LiquidationDeltaPoint } from "@/engines/types";
import { candle } from "./helpers";

const T0 = 1_700_000_000;

/** `n` ordinary bars, then one built to order. */
function series(special: Partial<Candle> & { volume: number; takerBuyVolume: number }): Candle[] {
  const bars: Candle[] = Array.from({ length: 40 }, (_, i) =>
    candle(T0 + i * 60, 100, 100.5, 99.5, 100, 1000, 500)
  );
  bars.push(
    candle(
      T0 + 40 * 60,
      100,
      101,
      99,
      100.5,
      special.volume,
      special.takerBuyVolume
    )
  );
  return bars;
}

const SPECIAL = T0 + 40 * 60;
const forcedOn = (time: number, size: number): LiquidationDeltaPoint[] => [
  { time, longLiquidated: size, shortLiquidated: 0, delta: -size, cumulative: -size },
];

describe("strong candles", () => {
  it("ignores a bar on ordinary volume however one-sided", () => {
    // 95% buying, but only average size — nothing happened here.
    const found = findStrongCandles(series({ volume: 1000, takerBuyVolume: 950 }));
    expect(found.get(SPECIAL)).toBeUndefined();
  });

  it("marks three times average volume on its own, however balanced", () => {
    // 5x volume, delta near zero, no forced flow. This used to be hidden,
    // because balanced delta failed the one-sided test — so the single most
    // visible thing on the chart went unmarked. Heavy two-way trade at one
    // price is what absorption looks like; it earns the highlight by size.
    const found = findStrongCandles(series({ volume: 5000, takerBuyVolume: 2500 }));
    const mark = found.get(SPECIAL);
    expect(mark).toBeDefined();
    expect(mark!.volumeMultiple).toBeGreaterThanOrEqual(3);
    expect(mark!.reasons[0]).toMatch(/× average volume/);
  });

  it("marks exactly three times average volume, not just above it", () => {
    // Boundary: the rule is "at least 3x", so 3.0 itself must qualify.
    const found = findStrongCandles(series({ volume: 3000, takerBuyVolume: 1500 }));
    expect(found.get(SPECIAL)?.volumeMultiple).toBe(3);
  });

  it("still requires corroboration between two and three times average", () => {
    // 2.5x on balanced delta with no forced flow is common enough to be noise;
    // marking it would put yellow on a third of the chart.
    const quiet = findStrongCandles(series({ volume: 2500, takerBuyVolume: 1250 }));
    expect(quiet.get(SPECIAL)).toBeUndefined();

    // The same size with one-sided delta does qualify.
    const oneSided = findStrongCandles(series({ volume: 2500, takerBuyVolume: 2100 }));
    expect(oneSided.get(SPECIAL)).toBeDefined();

    // And so does the same size with forced flow behind it.
    const forced = findStrongCandles(
      series({ volume: 2500, takerBuyVolume: 1250 }),
      forcedOn(SPECIAL, 700)
    );
    expect(forced.get(SPECIAL)).toBeDefined();
  });

  it("marks outsized volume with one-sided delta as strong", () => {
    const found = findStrongCandles(series({ volume: 5000, takerBuyVolume: 4200 }));
    const mark = found.get(SPECIAL);
    expect(mark?.strength).toBe("strong");
    expect(mark?.volumeMultiple).toBeGreaterThanOrEqual(2);
    expect(mark?.deltaShare).toBeGreaterThan(0.35);
  });

  it("marks outsized volume with forced flow as strong even when two-sided", () => {
    const found = findStrongCandles(
      series({ volume: 5000, takerBuyVolume: 2500 }),
      forcedOn(SPECIAL, 900)
    );
    expect(found.get(SPECIAL)?.strength).toBe("strong");
  });

  it("reserves extreme for volume, delta and forced flow together", () => {
    const found = findStrongCandles(
      series({ volume: 6000, takerBuyVolume: 5200 }),
      forcedOn(SPECIAL, 1200)
    );
    const mark = found.get(SPECIAL);
    expect(mark?.strength).toBe("extreme");
    expect(mark?.reasons.join(" ")).toContain("forced flow");
  });

  it("judges a bar against the bars before it, not including itself", () => {
    // A single huge bar must not raise its own yardstick out of qualifying.
    const found = findStrongCandles(series({ volume: 50_000, takerBuyVolume: 45_000 }));
    expect(found.get(SPECIAL)?.volumeMultiple).toBeGreaterThan(40);
  });

  it("still classifies bars the liquidation window does not reach", () => {
    // Forced-flow data covers only the analysed window; an older bar is not
    // weaker for being older, it simply has one fewer piece of evidence.
    const found = findStrongCandles(series({ volume: 5000, takerBuyVolume: 4200 }), []);
    expect(found.get(SPECIAL)?.strength).toBe("strong");
    expect(found.get(SPECIAL)?.forced).toBe(0);
  });

  it("records why a bar was marked", () => {
    const found = findStrongCandles(series({ volume: 5000, takerBuyVolume: 4200 }));
    const reasons = found.get(SPECIAL)!.reasons.join(" ");
    expect(reasons).toContain("× average volume");
    expect(reasons).toContain("net buying");
  });

  it("handles short series and zero-volume bars", () => {
    expect(findStrongCandles([]).size).toBe(0);
    expect(findStrongCandles([candle(T0, 1, 1, 1, 1, 0, 0)]).size).toBe(0);
  });
});
