import { describe, expect, it } from "vitest";
import { checkFill, fillsImmediately, FillInputs } from "@/engines/fills";
import { Candle } from "@/engines/types";

/**
 * The bias this engine removes is directional, not random: setups whose entry
 * ran away are the ones that were about to move. So the cases pinned hardest
 * are the ones that decide *which* signals get dropped — a fill on the wick
 * rather than the close, and a runaway that never came back.
 */

const T0 = 1_700_000_000;
const HOUR = 3600;

function bar(i: number, o: number, h: number, l: number, c: number): Candle {
  return { time: T0 + i * HOUR, open: o, high: h, low: l, close: c, volume: 100, takerBuyVolume: 50 };
}

function inputs(over: Partial<FillInputs> = {}): FillInputs {
  return {
    side: "BUY",
    entry: 100,
    stopLoss: 98,
    openedAt: T0,
    bars: [],
    estHoldingMin: 600,
    ...over,
  };
}

describe("checkFill — the touch", () => {
  it("fills a buy on the low reaching the entry, not on the close", () => {
    // The bar dips to 99.5 and closes at 101: a resting buy at 100 was hit.
    const r = checkFill(inputs({ bars: [bar(0, 101, 102, 99.5, 101)] }));
    expect(r.state).toBe("filled");
    expect(r.filledAt).toBe(T0);
    expect(r.barsWaited).toBe(0);
  });

  it("fills a sell on the high, mirrored", () => {
    const r = checkFill(
      inputs({ side: "SELL", entry: 100, stopLoss: 102, bars: [bar(0, 99, 100.5, 98, 99)] })
    );
    expect(r.state).toBe("filled");
  });

  it("does not fill when price stayed clear of the entry", () => {
    const r = checkFill(inputs({ bars: [bar(0, 100.5, 101, 100.4, 100.9)] }));
    expect(r.state).toBe("waiting");
    expect(r.filledAt).toBeNull();
  });

  it("counts the bars waited before a later fill", () => {
    const r = checkFill(
      inputs({
        bars: [
          bar(0, 101, 101.5, 100.6, 101),
          bar(1, 101, 101.2, 100.5, 100.8),
          bar(2, 100.8, 101, 99.8, 100.2),
        ],
      })
    );
    expect(r.state).toBe("filled");
    expect(r.barsWaited).toBe(2);
    expect(r.filledAt).toBe(T0 + 2 * HOUR);
  });
});

describe("checkFill — never reads the past", () => {
  it("ignores bars printed before publication", () => {
    // A dip to 99 an hour *before* the signal existed must not fill it.
    const r = checkFill(
      inputs({
        openedAt: T0 + 2 * HOUR,
        bars: [bar(0, 101, 101, 99, 100.5), bar(1, 101, 101, 99, 100.5), bar(2, 101, 102, 100.6, 101)],
      })
    );
    expect(r.state).toBe("waiting");
  });

  it("reports waiting rather than filled when there are no bars yet", () => {
    const r = checkFill(inputs({ bars: [] }));
    expect(r.state).toBe("waiting");
    expect(r.barsWaited).toBe(0);
  });
});

describe("checkFill — the runaway", () => {
  it("gives up once price is a full R past the entry", () => {
    // Risk is 2 (100 → 98). A close at 102 is 1R away, untouched.
    const r = checkFill(inputs({ bars: [bar(0, 101, 102.5, 100.5, 102)] }));
    expect(r.state).toBe("unfilled");
    expect(r.reason).toMatch(/without us/i);
  });

  it("keeps waiting while the drift is inside 1R", () => {
    const r = checkFill(inputs({ bars: [bar(0, 101, 101.5, 100.5, 101.5)] }));
    expect(r.state).toBe("waiting");
  });

  it("scales the runaway to the trade's own risk, not a flat percentage", () => {
    // Same 2-point drift; a wide stop should still be waiting where a tight
    // one has given up.
    const drift = [bar(0, 101, 102.5, 100.5, 102)];
    expect(checkFill(inputs({ stopLoss: 99, bars: drift })).state).toBe("unfilled");
    expect(checkFill(inputs({ stopLoss: 90, bars: drift })).state).toBe("waiting");
  });

  it("prefers a fill over a runaway when the same bar does both", () => {
    // Low touches 100 and close runs to 102: it filled, then ran.
    const r = checkFill(inputs({ bars: [bar(0, 101, 102.5, 99.9, 102)] }));
    expect(r.state).toBe("filled");
  });
});

describe("checkFill — the timeout", () => {
  it("stops waiting past the setup's own expected holding time", () => {
    const bars = Array.from({ length: 12 }, (_, i) => bar(i, 100.6, 100.9, 100.5, 100.7));
    const r = checkFill(inputs({ bars, estHoldingMin: 600 }));
    // 12 hourly bars is 720 minutes, past the 600-minute expectation.
    expect(r.state).toBe("unfilled");
    expect(r.reason).toMatch(/expired/i);
  });

  it("is still waiting inside that time", () => {
    const bars = Array.from({ length: 4 }, (_, i) => bar(i, 100.6, 100.9, 100.5, 100.7));
    expect(checkFill(inputs({ bars, estHoldingMin: 600 })).state).toBe("waiting");
  });
});

describe("fillsImmediately", () => {
  it("treats a marketable buy limit as already filled", () => {
    // Buying at 100 while price is 99: the order crosses on arrival.
    expect(fillsImmediately("BUY", 100, 99)).toBe(true);
    expect(fillsImmediately("BUY", 100, 101)).toBe(false);
  });

  it("mirrors for sells", () => {
    expect(fillsImmediately("SELL", 100, 101)).toBe(true);
    expect(fillsImmediately("SELL", 100, 99)).toBe(false);
  });

  it("counts an entry exactly at the price as filled", () => {
    expect(fillsImmediately("BUY", 100, 100)).toBe(true);
    expect(fillsImmediately("SELL", 100, 100)).toBe(true);
  });
});

describe("checkFill — stated limits", () => {
  it("treats a single touch as a fill, and the doc says so", () => {
    // Exactly at the entry, one tick. Real queue position might not have
    // filled; the engine is deliberately optimistic here and documents it.
    const r = checkFill(inputs({ bars: [bar(0, 100.5, 100.6, 100, 100.5)] }));
    expect(r.state).toBe("filled");
  });

  it("survives a zero-risk setup without dividing by it", () => {
    const r = checkFill(inputs({ stopLoss: 100, bars: [bar(0, 105, 106, 104, 105)] }));
    expect(["waiting", "unfilled"]).toContain(r.state);
    expect(Number.isFinite(r.barsWaited)).toBe(true);
  });
});
