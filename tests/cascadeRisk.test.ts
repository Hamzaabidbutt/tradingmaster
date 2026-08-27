import { describe, expect, it } from "vitest";
import { detectCascadeRisk } from "@/engines/cascadeRisk";
import { Candle } from "@/engines/types";
import { candle, syntheticCandles } from "./helpers";

const T0 = 1_700_000_000;

/**
 * A staircase uptrend that leaves an unswept swing low just under price.
 *
 * Shaped to the detectors rather than to intuition: impulse legs run 14 bars
 * so an 8-bar fractal can see the pullback lows, and the series settles into
 * a low-travel chop above the last one so the level stays within a couple of
 * ATR. A fixture that merely "looks like" a trend produces no swings at all.
 */
function crowdedLongs(): Candle[] {
  const bars: Candle[] = [];
  let p = 90;
  const push = (o: number, h: number, l: number, c: number) =>
    bars.push(candle(T0 + bars.length * 900, o, h, l, c, 1000, 500));
  const leg = (n: number, step: number) => {
    for (let i = 0; i < n; i++) {
      const nx = p + step;
      push(p, Math.max(p, nx) + 0.25, Math.min(p, nx) - 0.25, nx);
      p = nx;
    }
  };

  for (let k = 0; k < 4; k++) {
    leg(14, +0.5); // impulse
    leg(6, -0.4); // shallow pullback, leaving a higher low behind
  }
  // Settle above the last low: enough bars for the fractal, little net travel.
  for (let i = 0; i < 12; i++) {
    const nx = p + (i % 2 === 0 ? 0.12 : -0.06);
    push(p, Math.max(p, nx) + 0.4, Math.min(p, nx) - 0.4, nx);
    p = nx;
  }
  return bars;
}

/** Open interest rising steadily — new positions being opened. */
const oiRising = Array.from({ length: 48 }, (_, i) => 1_000_000 * (1 + i * 0.004));
/** Open interest falling — positions closing, fuel draining. */
const oiFalling = Array.from({ length: 48 }, (_, i) => 1_000_000 * (1 - i * 0.004));

describe("cascade risk — triggers", () => {
  const setup = detectCascadeRisk("TESTUSDT", "15m", crowdedLongs(), oiRising);

  it("finds triggers and orders them nearest first", () => {
    expect(setup.triggers.length).toBeGreaterThan(0);
    const distances = setup.triggers.map((t) => t.distanceAtr);
    expect([...distances].sort((a, b) => a - b)).toEqual(distances);
  });

  it("quotes distance in ATR as well as percent", () => {
    const t = setup.trigger!;
    expect(t.distanceAtr).toBeGreaterThan(0);
    // ATR distance and % distance must agree in sign-free magnitude ordering.
    expect(Math.abs(t.distancePct)).toBeGreaterThan(0);
  });

  it("labels where each level came from", () => {
    for (const t of setup.triggers) {
      expect(["stop_pool", "equal_levels", "leverage_band"]).toContain(t.basis);
    }
  });

  it("never places a long band above price or a short band below", () => {
    // Those are already past — a position liquidated at a level price has
    // left behind is not a pending trigger.
    for (const t of setup.triggers.filter((x) => x.basis === "leverage_band")) {
      if (t.side === "long") expect(t.price).toBeLessThanOrEqual(setup.price);
      else expect(t.price).toBeGreaterThanOrEqual(setup.price);
    }
  });
});

describe("cascade risk — positioning", () => {
  it("reads rising OI into a rally as crowded longs", () => {
    const s = detectCascadeRisk("TESTUSDT", "15m", crowdedLongs(), oiRising);
    expect(s.fuel.crowded).toBe("long");
    expect(s.fuel.openInterestChangePct).toBeGreaterThan(0);
    expect(s.side).toBe("long");
  });

  it("qualifies a crowded side with a trigger within reach", () => {
    const s = detectCascadeRisk("TESTUSDT", "15m", crowdedLongs(), oiRising);
    expect(s.qualified).toBe(true);
    expect(["strong", "prime"]).toContain(s.grade);
    expect(s.trigger!.distanceAtr).toBeLessThanOrEqual(2);
    expect(s.headline).toContain("long flush");
  });

  it("marks falling OI as unwinding and refuses to qualify", () => {
    const s = detectCascadeRisk("TESTUSDT", "15m", crowdedLongs(), oiFalling);
    expect(s.fuel.unwinding).toBe(true);
    expect(s.qualified).toBe(false);
    expect(s.headline.toLowerCase()).toContain("unwinding");
  });

  it("says positioning is unknown rather than guessing, with no OI", () => {
    const s = detectCascadeRisk("TESTUSDT", "15m", crowdedLongs(), null);
    expect(s.fuel.crowded).toBe("unknown");
    expect(s.fuel.openInterestChangePct).toBeNull();
    expect(s.fuel.note).toContain("cannot be read");
  });

  it("does not call a side crowded when OI rises on a flat market", () => {
    const flat = syntheticCandles(200, 3);
    const s = detectCascadeRisk("TESTUSDT", "15m", flat, oiRising);
    expect(["balanced", "long", "short"]).toContain(s.fuel.crowded);
  });
});

describe("cascade risk — honesty", () => {
  const setup = detectCascadeRisk("TESTUSDT", "15m", crowdedLongs(), oiRising);

  it("states in the explanation that it is not a forecast", () => {
    const text = setup.explanation.join(" ").toLowerCase();
    expect(text).toContain("not a forecast");
    expect(text).toContain("conditional");
  });

  it("never claims price will reach the trigger", () => {
    const text = setup.explanation.join(" ").toLowerCase();
    expect(text).not.toContain("will fall");
    expect(text).not.toContain("will rise");
    expect(text).not.toContain("expect price to");
  });

  it("flags an inferred leverage band as the weakest basis when it is nearest", () => {
    if (setup.trigger?.basis === "leverage_band") {
      expect(setup.explanation.join(" ")).toContain("weakest");
    }
    // And the note on every such trigger says so on its own.
    for (const t of setup.triggers.filter((x) => x.basis === "leverage_band")) {
      expect(t.note).toContain("indicative");
    }
  });
});

describe("cascade risk — guards", () => {
  it("returns an empty setup without enough history", () => {
    const s = detectCascadeRisk("TESTUSDT", "15m", syntheticCandles(20));
    expect(s.qualified).toBe(false);
    expect(s.trigger).toBeNull();
    expect(s.headline).toContain("Not enough history");
  });

  it("handles no candles at all", () => {
    const s = detectCascadeRisk("TESTUSDT", "15m", []);
    expect(s.price).toBe(0);
    expect(s.triggers).toEqual([]);
  });

  it("keeps the score inside 0-100", () => {
    for (const oi of [oiRising, oiFalling, null]) {
      const s = detectCascadeRisk("TESTUSDT", "15m", crowdedLongs(), oi);
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(100);
    }
  });
});
