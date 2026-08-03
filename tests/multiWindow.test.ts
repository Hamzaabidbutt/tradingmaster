import { describe, expect, it } from "vitest";
import { DEFAULT_LOOKBACKS, buildMultiWindow } from "@/engines/multiWindow";
import { candle, syntheticCandles } from "./helpers";

describe("multi-window engine", () => {
  it("produces one insight per requested lookback", () => {
    const r = buildMultiWindow(syntheticCandles(120));
    expect(r.windows.map((w) => w.bars)).toEqual(DEFAULT_LOOKBACKS);
  });

  it("drops lookbacks that exceed the available history", () => {
    const r = buildMultiWindow(syntheticCandles(9));
    // Needs n + 2 bars, so with 9 candles only 3, 5 and 7 survive.
    expect(r.windows.map((w) => w.bars)).toEqual([3, 5, 7]);
  });

  it("returns an empty result rather than throwing on tiny input", () => {
    const r = buildMultiWindow(syntheticCandles(2));
    expect(r.windows).toHaveLength(0);
    expect(r.consensus.bias).toBe("neutral");
    expect(r.consensus.agreement).toBe(0);
  });

  it("computes each window over exactly its own candle count", () => {
    const candles = syntheticCandles(100);
    const r = buildMultiWindow(candles);
    for (const w of r.windows) {
      const slice = candles.slice(-w.bars);
      expect(w.priceStart).toBe(slice[0].open);
      expect(w.priceEnd).toBe(slice[slice.length - 1].close);
      expect(w.high).toBe(Math.max(...slice.map((c) => c.high)));
      expect(w.low).toBe(Math.min(...slice.map((c) => c.low)));
      expect(w.bullishCandles + w.bearishCandles).toBeLessThanOrEqual(w.bars);
    }
  });

  it("keeps odds bounded and bias consistent with them", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const r = buildMultiWindow(syntheticCandles(100, seed));
      for (const w of r.windows) {
        expect(w.bullishOdds).toBeGreaterThanOrEqual(10);
        expect(w.bullishOdds).toBeLessThanOrEqual(90);
        if (w.bias === "bullish") expect(w.bullishOdds).toBeGreaterThanOrEqual(56);
        if (w.bias === "bearish") expect(w.bullishOdds).toBeLessThanOrEqual(44);
        expect(w.closePosition).toBeGreaterThanOrEqual(0);
        expect(w.closePosition).toBeLessThanOrEqual(1);
      }
    }
  });

  it("counts consensus correctly and matches the window biases", () => {
    const r = buildMultiWindow(syntheticCandles(150));
    const bull = r.windows.filter((w) => w.bias === "bullish").length;
    const bear = r.windows.filter((w) => w.bias === "bearish").length;
    expect(r.consensus.bullishCount).toBe(bull);
    expect(r.consensus.bearishCount).toBe(bear);
    expect(r.consensus.bullishCount + r.consensus.bearishCount + r.consensus.neutralCount).toBe(
      r.windows.length
    );
    expect(r.consensus.agreement).toBeGreaterThanOrEqual(0);
    expect(r.consensus.agreement).toBeLessThanOrEqual(100);
  });

  it("reads a clean uptrend as bullish across horizons", () => {
    // Steadily rising closes with buy-dominant taker volume.
    const rising = Array.from({ length: 40 }, (_, i) =>
      candle(1000 + i * 60, 100 + i * 0.5, 100 + i * 0.5 + 0.6, 100 + i * 0.5 - 0.1, 100 + i * 0.5 + 0.45, 1000, 700)
    );
    const r = buildMultiWindow(rising);
    expect(r.consensus.bias).toBe("bullish");
    expect(r.consensus.bullishCount).toBeGreaterThan(r.consensus.bearishCount);
    expect(r.consensus.diverging).toBe(false);
  });

  it("flags divergence when the short horizon turns against the long one", () => {
    // A long rally, then a sharp sell-dominant reversal in the last few bars.
    const rally = Array.from({ length: 30 }, (_, i) =>
      candle(1000 + i * 60, 100 + i * 0.6, 100 + i * 0.6 + 0.7, 100 + i * 0.6 - 0.1, 100 + i * 0.6 + 0.55, 1000, 720)
    );
    // The pullback must stay small enough that the 12/15-bar windows are
    // still net-positive — otherwise every horizon is bearish and there is
    // genuinely nothing to diverge.
    const top = 100 + 29 * 0.6;
    const drop = Array.from({ length: 4 }, (_, i) =>
      candle(1000 + (30 + i) * 60, top - i * 0.5, top - i * 0.5 + 0.1, top - (i + 1) * 0.5 - 0.2, top - (i + 1) * 0.5, 2600, 500)
    );
    const r = buildMultiWindow([...rally, ...drop]);
    expect(r.consensus.shortTermBias).toBe("bearish");
    expect(r.consensus.diverging).toBe(true);
    expect(r.consensus.summary.join(" ").toLowerCase()).toContain("diverging horizons");
  });

  it("counts absorption bars that closed against their delta", () => {
    // Every bar closes red while taker-buy volume dominates.
    const absorbed = Array.from({ length: 20 }, (_, i) =>
      candle(1000 + i * 60, 100, 100.5, 99.0, 99.4, 2000, 1500)
    );
    const r = buildMultiWindow(absorbed);
    const w3 = r.windows.find((w) => w.bars === 3)!;
    expect(w3.absorptionCount).toBe(3);
    expect(w3.delta).toBeGreaterThan(0);
    expect(w3.detail).toContain("absorbed");
  });

  it("gives every window a headline and detail", () => {
    const r = buildMultiWindow(syntheticCandles(100));
    for (const w of r.windows) {
      expect(w.headline.length).toBeGreaterThan(10);
      expect(w.detail.length).toBeGreaterThan(20);
      expect(w.headline).toContain(String(w.bars));
    }
    expect(r.consensus.summary.length).toBeGreaterThan(0);
  });
});
