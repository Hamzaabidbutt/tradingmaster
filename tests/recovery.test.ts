import { describe, expect, it } from "vitest";
import { detectRecovery } from "@/engines/recovery";
import { Candle } from "@/engines/types";
import { syntheticCandles } from "./helpers";

/**
 * The premise of this scanner is seductive and the base rate behind it is
 * brutal, so the tests concentrate on the guards rather than the arithmetic:
 * that drawdown filters rather than scores, that a falling knife never
 * qualifies, and that nothing in the output turns a ratio into a forecast.
 */

const DAY = 86_400;
const t = (i: number) => 1_600_000_000 + i * DAY;

/** A peak, a long decline, then `baseDays` of flat trade near the low. */
function declineThenBase(opts: {
  peak: number;
  low: number;
  declineDays: number;
  baseDays: number;
  baseVolume?: number;
  buyShare?: number;
  /** per-day upward drift through the base, as a fraction of the low */
  baseDrift?: number;
}): Candle[] {
  const out: Candle[] = [];
  // Rise into the peak, so there is a high to measure the drawdown from.
  for (let i = 0; i < 60; i++) {
    const price = opts.peak * (0.5 + (0.5 * i) / 60);
    out.push({
      time: t(out.length),
      open: price,
      high: price * 1.02,
      low: price * 0.98,
      close: price,
      volume: 5000,
      takerBuyVolume: 2600,
    });
  }
  // The decline.
  for (let i = 0; i < opts.declineDays; i++) {
    const price = opts.peak * Math.pow(opts.low / opts.peak, (i + 1) / opts.declineDays);
    out.push({
      time: t(out.length),
      open: price * 1.01,
      high: price * 1.02,
      low: price * 0.97,
      close: price,
      volume: 6000,
      takerBuyVolume: 2200,
    });
  }
  // The base: quiet, buy-heavy, and optionally drifting up — a base that
  // grinds higher is what produces the higher lows the checklist looks for,
  // and a perfectly flat one never will.
  for (let i = 0; i < opts.baseDays; i++) {
    const drift = (opts.baseDrift ?? 0) * i;
    const price = opts.low * (1 + drift + 0.04 * Math.sin(i / 6));
    out.push({
      time: t(out.length),
      open: price,
      high: price * 1.03,
      low: price * 0.98,
      close: price,
      volume: opts.baseVolume ?? 1500,
      takerBuyVolume: (opts.baseVolume ?? 1500) * (opts.buyShare ?? 0.6),
    });
  }
  return out;
}

describe("detectRecovery", () => {
  it("refuses to read a contract with too little history", () => {
    const r = detectRecovery("TESTUSDT", syntheticCandles(50, 3, 100));
    expect(r.eligible).toBe(false);
    expect(r.qualified).toBe(false);
    expect(r.headline).toMatch(/history/i);
  });

  it("treats drawdown as a filter, not a score", () => {
    // A shallow decline is rejected outright, whatever else it is doing —
    // ranking by depth would produce a list of things still falling.
    const shallow = declineThenBase({ peak: 100, low: 70, declineDays: 120, baseDays: 90 });
    const r = detectRecovery("TESTUSDT", shallow);
    expect(r.eligible).toBe(false);
    expect(r.score).toBe(0);
    expect(r.headline).toMatch(/not deep enough/i);
  });

  it("accepts a deep drawdown as eligible without that alone qualifying it", () => {
    const deep = declineThenBase({ peak: 100, low: 5, declineDays: 200, baseDays: 5 });
    const r = detectRecovery("TESTUSDT", deep);
    expect(r.eligible).toBe(true);
    expect(r.drawdownPct).toBeGreaterThan(70);
    // Five days is not a base, so this is a decline in progress.
    expect(r.qualified).toBe(false);
  });

  it("never qualifies a falling knife, however deep", () => {
    // 97% down and still going: the single most dangerous thing this scanner
    // could rank highly, so it must be structurally impossible.
    const knife = declineThenBase({ peak: 100, low: 3, declineDays: 300, baseDays: 2 });
    const r = detectRecovery("TESTUSDT", knife);
    expect(r.baseDays).toBeLessThan(30);
    expect(r.qualified).toBe(false);
    expect(r.headline).toMatch(/no base|decline in progress/i);
  });

  it("counts a base only from consecutive recent days near the low", () => {
    const based = declineThenBase({ peak: 100, low: 6, declineDays: 200, baseDays: 120 });
    const r = detectRecovery("TESTUSDT", based);
    expect(r.baseDays).toBeGreaterThanOrEqual(100);
    const baseItem = r.evidence.find((e) => e.key === "base")!;
    expect(baseItem.found).toBe(true);
  });

  it("keeps the upside figures as ratios and labels them as arithmetic", () => {
    const based = declineThenBase({ peak: 100, low: 6, declineDays: 200, baseDays: 120 });
    const r = detectRecovery("TESTUSDT", based);
    // The ratio is a fact about two prices and must be exactly that.
    expect(r.upside.toWindowHigh).toBeCloseTo(r.windowHigh / r.price, 1);
    expect(r.upside.toWindowHigh).toBeGreaterThan(1);
    expect(r.upside.toHalfway).toBeLessThan(r.upside.toWindowHigh);

    const text = r.explanation.join(" ");
    expect(text).toMatch(/not a target|arithmetic/i);

    // Assert the denial is present rather than pattern-matching for the
    // claim. An earlier version searched for /will recover/ and failed on the
    // engine's own sentence "What it does not say is that price will recover"
    // — flagging the disclaimer as the thing it was meant to forbid. Testing
    // for the negation is both stronger and not fooled by its own wording.
    expect(text).toMatch(/What it does not say is that price will recover/);
    expect(text).toMatch(/Whether the market goes there is a different question/);

    // Promotional phrasing that could never appear inside a denial.
    expect(text).not.toMatch(/guaranteed|life[- ]changing|sure thing|cannot lose/i);
  });

  it("states that the high is the window's, not a true all-time high", () => {
    const based = declineThenBase({ peak: 100, low: 6, declineDays: 200, baseDays: 120 });
    const r = detectRecovery("TESTUSDT", based);
    expect(r.windowDays).toBe(based.length);
    expect(r.explanation.join(" ")).toMatch(/not necessarily this asset's all-time high/i);
  });

  it("warns about the base rate rather than selling the upside", () => {
    const based = declineThenBase({ peak: 100, low: 6, declineDays: 200, baseDays: 120 });
    const text = detectRecovery("TESTUSDT", based).explanation.join(" ");
    expect(text).toMatch(/most assets this far down go further down/i);
  });

  it("scores open interest building at the base, and its absence honestly", () => {
    const based = declineThenBase({ peak: 100, low: 6, declineDays: 200, baseDays: 120 });
    const building = detectRecovery("TESTUSDT", based, [100, 120, 140, 165]);
    const shrinking = detectRecovery("TESTUSDT", based, [165, 140, 120, 100]);
    const none = detectRecovery("TESTUSDT", based, null);

    const oi = (r: ReturnType<typeof detectRecovery>) =>
      r.evidence.find((e) => e.key === "open_interest")!;
    expect(oi(building).found).toBe(true);
    expect(oi(shrinking).found).toBe(false);
    expect(oi(none).found).toBe(false);
    expect(oi(none).detail).toMatch(/no open-interest history/i);
    expect(building.score).toBeGreaterThan(shrinking.score);
  });

  it("keeps every score inside its own weight", () => {
    for (const seed of [3, 11, 29]) {
      const noisy = syntheticCandles(400, seed, 100);
      const r = detectRecovery("TESTUSDT", noisy);
      for (const e of r.evidence) {
        expect(e.score).toBeLessThanOrEqual(e.weight);
        expect(e.score).toBeGreaterThanOrEqual(0);
        expect(e.detail.length).toBeGreaterThan(0);
      }
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
    }
  });

  it("reports both the peak and the drawdown that preceded it for each episode", () => {
    const based = declineThenBase({ peak: 100, low: 6, declineDays: 200, baseDays: 120 });
    const r = detectRecovery("TESTUSDT", based);
    for (const ep of r.episodes) {
      // Reporting a peak without the pain first would turn a violent round
      // trip into a clean multiple.
      expect(ep).toHaveProperty("peakGainPct");
      expect(ep).toHaveProperty("worstDrawdownPct");
      expect(ep.endTime).toBeGreaterThan(ep.startTime);
    }
  });

  it("does qualify a deep, based coin that is showing the signs", () => {
    // Without this the whole suite would pass against an engine that never
    // qualified anything — every "must not qualify" assertion above would
    // hold vacuously, and the scanner would silently return an empty list
    // forever.
    const rising = declineThenBase({
      peak: 100,
      low: 6,
      declineDays: 200,
      baseDays: 120,
      baseDrift: 0.0015,
    });
    const r = detectRecovery("TESTUSDT", rising, [100, 120, 140, 165]);
    expect(r.eligible).toBe(true);
    expect(r.qualified).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(60);
    expect(r.evidence.filter((e) => e.found).length).toBeGreaterThanOrEqual(4);
    expect(["strong", "prime"]).toContain(r.grade);
    // Even a qualified read still carries the warning.
    expect(r.explanation.join(" ")).toMatch(/most assets this far down go further down/i);
  });

  it("puts invalidation at the window low", () => {
    const based = declineThenBase({ peak: 100, low: 6, declineDays: 200, baseDays: 120 });
    const r = detectRecovery("TESTUSDT", based);
    expect(r.invalidation).toBe(r.windowLow);
  });
});
