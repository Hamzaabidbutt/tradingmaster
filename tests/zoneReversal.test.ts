import { describe, expect, it } from "vitest";
import { detectZoneReversal } from "@/engines/zoneReversal";
import { Candle } from "@/engines/types";
import { candle, syntheticCandles } from "./helpers";

const T0 = 1_700_000_000;
const t = (i: number) => T0 + i * 3600;

/**
 * A series containing one bullish fair value gap that price later returns to.
 *
 * Built explicitly rather than generated: the whole point of the engine is the
 * difference between a tap and a rejection, and only a hand-built series can
 * put those two cases one wick apart.
 */
function bullishGapSeries(opts: { reclaim: boolean; fillGap?: boolean }): Candle[] {
  const bars: Candle[] = [];
  // 0-24: chop, no gaps — every bar overlaps its neighbour.
  for (let i = 0; i < 25; i++) {
    const up = i % 2 === 0;
    bars.push(candle(t(i), 100, 101.2, 99.2, up ? 100.8 : 99.6, 1000, 500));
  }
  // 25-27: the displacement that leaves the gap. Bar 25's high (101.5) sits
  // below bar 27's low (102.0), so 101.5–102.0 is never traded through.
  bars.push(candle(t(25), 100.8, 101.5, 100.5, 101.0, 1200, 600));
  bars.push(candle(t(26), 101.0, 107.5, 101.0, 107.4, 4000, 3200));
  bars.push(candle(t(27), 107.4, 108.0, 102.0, 105.5, 3000, 1500));

  // 28-39: drift up to ~106 and back down toward the gap. Every bar's range
  // overlaps the bar two before it, so this leg leaves no further gaps of its
  // own — the fixture must contain exactly one zone or it stops being a test
  // of that zone.
  const up = [105.8, 106.2, 106.6, 106.4, 106.0, 105.6];
  up.forEach((c, i) => bars.push(candle(t(28 + i), c - 0.3, c + 0.9, c - 0.9, c, 1100, 560)));

  const down = [105.2, 104.6, 104.0, 103.4, 102.9, 102.6];
  down.forEach((c, i) => bars.push(candle(t(34 + i), c + 0.4, c + 0.9, c - 0.6, c, 1100, 500)));

  // 40: the test bar. It reaches into the gap; whether it closes back out of it
  // is the single thing that separates a reversal from a level being tested.
  const low = opts.fillGap ? 101.3 : 101.6;
  const close = opts.reclaim ? 102.55 : 101.75;
  bars.push(candle(t(40), 102.6, 102.7, low, close, 2600, opts.reclaim ? 1900 : 1200));

  // 41-44: follow-through, or the lack of it.
  const after = opts.reclaim ? [102.9, 103.1, 103.3, 103.5] : [101.8, 101.9, 101.85, 101.9];
  // The no-reclaim bars are kept tight: they must hover just above the gap
  // without dipping into its lower edge, or the gap would read as filled and
  // the case being tested (tapped, intact, not reclaimed) would not exist.
  const wickDown = opts.reclaim ? 0.8 : 0.15;
  const wickUp = opts.reclaim ? 0.5 : 0.2;
  after.forEach((c, i) =>
    bars.push(candle(t(41 + i), c - 0.1, c + wickUp, c - wickDown, c, 1200, opts.reclaim ? 800 : 600))
  );
  return bars;
}

describe("zone reversal — bullish FVG", () => {
  it("qualifies a rejection that closes back out of the gap", () => {
    const setup = detectZoneReversal("TESTUSDT", "1h", bullishGapSeries({ reclaim: true }));
    expect(setup.best).not.toBeNull();
    expect(setup.direction).toBe("bullish");
    expect(setup.qualified).toBe(true);
    expect(["strong", "prime"]).toContain(setup.grade);
    expect(setup.best!.reclaimed).toBe(true);
    expect(setup.best!.intact).toBe(true);
    expect(setup.best!.deltaConfirms).toBe(true);
    // The rejection wick is most of the bar's range.
    expect(setup.best!.rejectionWick).toBeGreaterThan(0.5);
    expect(setup.best!.reversalPct).toBeGreaterThan(0);
  });

  it("refuses to qualify a tap with no reclaim", () => {
    // Same zone, same wick — price simply never closed back above the gap.
    const setup = detectZoneReversal("TESTUSDT", "1h", bullishGapSeries({ reclaim: false }));
    expect(setup.best).not.toBeNull();
    expect(setup.best!.reclaimed).toBe(false);
    expect(setup.qualified).toBe(false);
    expect(setup.direction).toBe("neutral");
    expect(setup.headline).toContain("no reclaim");
  });

  it("drops a zone price has traded through", () => {
    // A gap filled to its far edge holds no unfilled orders, so it is not a
    // zone any more — it must not be scored as one.
    const setup = detectZoneReversal("TESTUSDT", "1h", bullishGapSeries({ reclaim: true, fillGap: true }));
    const gap = setup.reactions.find((r) => r.zoneType === "fvg" && r.direction === "bullish");
    expect(gap).toBeUndefined();
  });

  it("quotes invalidation at the rejection extreme, not the zone edge", () => {
    const setup = detectZoneReversal("TESTUSDT", "1h", bullishGapSeries({ reclaim: true }));
    // Below the wick low, since that is the price that proved the zone held.
    expect(setup.invalidation!).toBeLessThanOrEqual(setup.best!.extreme);
    expect(setup.invalidation!).toBeGreaterThan(setup.best!.extreme * 0.99);
    expect(setup.entry).toBeCloseTo(setup.best!.top, 6);
  });

  it("explains itself in prose, headline first", () => {
    const setup = detectZoneReversal("TESTUSDT", "1h", bullishGapSeries({ reclaim: true }));
    expect(setup.explanation[0]).toBe(setup.headline);
    expect(setup.explanation.length).toBeGreaterThan(2);
    expect(setup.explanation.join(" ")).toContain("Invalidation");
  });
});

describe("zone reversal — guards", () => {
  it("returns an empty setup when there is not enough history", () => {
    const setup = detectZoneReversal("TESTUSDT", "1h", syntheticCandles(20));
    expect(setup.qualified).toBe(false);
    expect(setup.best).toBeNull();
    expect(setup.headline).toContain("Not enough history");
  });

  it("returns an empty setup on no candles at all", () => {
    const setup = detectZoneReversal("TESTUSDT", "1h", []);
    expect(setup.price).toBe(0);
    expect(setup.reactions).toEqual([]);
  });

  it("does not invent a reaction on ordinary noise", () => {
    // Nothing in a random walk has been expelled from a zone, so the honest
    // answer is "nothing here" rather than the best-scoring near-miss.
    const setup = detectZoneReversal("TESTUSDT", "1h", syntheticCandles(300, 7));
    expect(setup.qualified === false || setup.best?.reclaimed === true).toBe(true);
  });
});
