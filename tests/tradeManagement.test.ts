import { describe, expect, it } from "vitest";
import { isBreakEvenExit, manageTrade, ManagedPosition } from "@/engines/tradeManagement";
import { Candle } from "@/engines/types";

/**
 * Management decides most of the P/L, so the rules have to be exact in both
 * directions: never loosen a stop, never exit a trade that is working, and
 * never claim break-even at a price that would book a loss after fees.
 */

const HOUR = 3600;
const T0 = 1_700_000_000;

const LONG: ManagedPosition = {
  side: "BUY",
  entry: 100,
  stopLoss: 96, // 4 of risk
  tp1: 104, // 4 to the first target
  tp2: 110,
  tp3: 116,
  status: "ACTIVE",
  openedAt: T0,
  estHoldingMin: 600,
};

const SHORT: ManagedPosition = {
  ...LONG,
  side: "SELL",
  stopLoss: 104,
  tp1: 96,
  tp2: 90,
  tp3: 84,
};

/** Flat bars that neither flip structure nor breach anything. */
function flat(n = 10, price = 100, from = T0): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    time: from + i * HOUR,
    open: price,
    high: price + 0.2,
    low: price - 0.2,
    close: price,
    volume: 1000,
    takerBuyVolume: 500,
  }));
}

describe("manageTrade — protecting a working trade", () => {
  it("leaves the original stop alone early in the trade", () => {
    const d = manageTrade(LONG, 101, flat(), T0 + HOUR);
    expect(d.stop).toBe(LONG.stopLoss);
    expect(d.moved).toBe(false);
    expect(d.stage).toBe("initial");
    expect(d.exit).toBeNull();
  });

  it("moves to break-even once most of the way to TP1", () => {
    // 103 of a 100→104 leg is 75% covered.
    const d = manageTrade(LONG, 103, flat(10, 103), T0 + HOUR);
    expect(d.stage).toBe("breakeven");
    expect(d.moved).toBe(true);
    expect(d.stop).toBeGreaterThan(LONG.entry);
  });

  it("does not move to break-even at half way", () => {
    // The failure this guards: a stop pulled to entry so early that ordinary
    // noise inside the trade's own range keeps taking it out for nothing.
    const d = manageTrade(LONG, 102, flat(10, 102), T0 + HOUR);
    expect(d.stage).toBe("initial");
    expect(d.stop).toBe(LONG.stopLoss);
  });

  it("clears fees when it says break-even", () => {
    // A stop exactly at entry books a loss after round-trip fees, which is
    // the whole reason the buffer exists.
    const d = manageTrade(LONG, 103.5, flat(10, 103.5), T0 + HOUR);
    expect(d.stop).toBeGreaterThan(LONG.entry * 1.001);
  });

  it("trails to TP1 once TP2 is tagged", () => {
    const d = manageTrade({ ...LONG, status: "TP2_HIT" }, 111, flat(10, 111), T0 + HOUR);
    expect(d.stage).toBe("trail_tp2");
    expect(d.stop).toBe(LONG.tp1);
  });

  it("never loosens a stop that has already been tightened", () => {
    // The cardinal rule. A management pass on a retracing trade must not undo
    // the protection an earlier pass put in place.
    const protectedPos = { ...LONG, managedStop: 100.12, status: "TP1_HIT" };
    const d = manageTrade(protectedPos, 100.5, flat(10, 100.5), T0 + HOUR);
    expect(d.stop).toBeGreaterThanOrEqual(100.12);
  });

  it("mirrors every rule for a short", () => {
    const d = manageTrade(SHORT, 97, flat(10, 97), T0 + HOUR);
    expect(d.stage).toBe("breakeven");
    // A short's break-even stop sits *below* entry, again past fees.
    expect(d.stop).toBeLessThan(SHORT.entry * 0.999);

    const trailed = manageTrade({ ...SHORT, status: "TP2_HIT" }, 89, flat(10, 89), T0 + HOUR);
    expect(trailed.stop).toBe(SHORT.tp1);
  });
});

describe("manageTrade — cutting a trade that is not working", () => {
  it("exits on a close through most of the risk, rather than waiting for the stop", () => {
    // 97.6 is 60% of the way from 100 to 96.
    const bars = flat(6, 97.4, T0);
    const d = manageTrade(LONG, 97.4, bars, T0 + 3 * HOUR);
    expect(d.exit?.reason).toBe("adverse_close");
    expect(d.exit?.detail).toMatch(/closed/i);
  });

  it("ignores a wick through the same level", () => {
    // A wick through a level is the level being tested; a close through it is
    // the level failing. Only the second is a reason to leave.
    const bars = flat(6, 99.5).map((c) => ({ ...c, low: 97.0 }));
    const d = manageTrade(LONG, 99.5, bars, T0 + 3 * HOUR);
    expect(d.exit).toBeNull();
  });

  it("exits when structure changes character against the position", () => {
    // A clean uptrend that rolls over into lower highs and lower lows after
    // entry: the thing the trade was reasoning about has changed.
    const bars: Candle[] = [];
    let p = 100;
    for (let i = 0; i < 60; i++) {
      // Up for 25 bars with real pivots, then decisively down.
      const step = i < 25 ? 0.5 : -0.75;
      const wobble = Math.sin(i / 3) * 0.4;
      const open = p;
      const close = p + step + wobble;
      bars.push({
        time: T0 - 20 * HOUR + i * HOUR,
        open,
        close,
        high: Math.max(open, close) + 0.5,
        low: Math.min(open, close) - 0.5,
        volume: 1000,
        takerBuyVolume: 500,
      });
      p = close;
    }
    const d = manageTrade(LONG, 96.5, bars, T0 + 40 * HOUR);
    expect(d.exit).not.toBeNull();
    // Either reason is legitimate here; what matters is that it left.
    expect(["structure_flip", "adverse_close"]).toContain(d.exit!.reason);
  });

  it("exits a trade that has gone nowhere for its whole expected hold", () => {
    const d = manageTrade(LONG, 99.9, flat(20, 99.9), T0 + 550 * 60);
    expect(d.exit?.reason).toBe("stall");
    expect(d.exit?.detail).toMatch(/overtaken/i);
  });

  it("does not call a profitable trade stalled", () => {
    // Slow but going the right way is not a stall, and closing it would be
    // the management rule losing money on its own.
    const d = manageTrade(LONG, 101.5, flat(20, 101.5), T0 + 550 * 60);
    expect(d.exit).toBeNull();
  });

  it("does not exit early on a trade that is merely wobbling", () => {
    const d = manageTrade(LONG, 99.2, flat(10, 99.2), T0 + 2 * HOUR);
    expect(d.exit).toBeNull();
  });

  it("abstains from the structure read on too few bars", () => {
    // Reading a change of character out of a handful of bars would exit
    // trades on noise.
    const d = manageTrade(LONG, 99.5, flat(8, 99.5), T0 + HOUR);
    expect(d.exit).toBeNull();
  });

  it("says what an early exit gives up", () => {
    // The rule is a trade-off, not a free win, and the note has to say so —
    // otherwise the log reads like the engine avoided a loss for nothing.
    const d = manageTrade(LONG, 97.4, flat(6, 97.4), T0 + 3 * HOUR);
    expect(d.exit!.detail).toMatch(/giving up the chance of a recovery|smaller loss/i);
  });
});

describe("manageTrade — reporting", () => {
  it("reports progress and risk used as fractions the caller can log", () => {
    const d = manageTrade(LONG, 102, flat(10, 102), T0 + HOUR);
    expect(d.progressToTp1).toBeCloseTo(0.5, 3);
    expect(d.riskUsed).toBe(0);

    const losing = manageTrade(LONG, 98, flat(10, 98), T0 + HOUR);
    expect(losing.riskUsed).toBeCloseTo(0.5, 3);
    expect(losing.progressToTp1).toBeCloseTo(-0.5, 3);
  });

  it("never emits a non-finite stop", () => {
    const degenerate: ManagedPosition = {
      ...LONG,
      entry: 100,
      stopLoss: 100,
      tp1: 100,
      tp2: 100,
      tp3: 100,
    };
    const d = manageTrade(degenerate, 100, flat(), T0 + HOUR);
    expect(Number.isFinite(d.stop)).toBe(true);
    expect(Number.isFinite(d.progressToTp1)).toBe(true);
    expect(Number.isFinite(d.riskUsed)).toBe(true);
  });

  it("always leaves a note explaining the pass", () => {
    for (const price of [98, 100, 102, 103.5]) {
      const d = manageTrade(LONG, price, flat(10, price), T0 + HOUR);
      expect(d.notes.length).toBeGreaterThan(0);
    }
  });
});

describe("isBreakEvenExit", () => {
  it("recognises a protected stop being taken at entry", () => {
    expect(isBreakEvenExit({ side: "BUY", entry: 100 }, 100.12, 100.12)).toBe(true);
  });

  it("does not call an unprotected stop a break-even", () => {
    // The stop never moved: this is a plain loss, and filing it as break-even
    // would quietly remove a real failure from the record.
    expect(isBreakEvenExit({ side: "BUY", entry: 100 }, 96, 96)).toBe(false);
    expect(isBreakEvenExit({ side: "BUY", entry: 100 }, null, 96)).toBe(false);
  });

  it("does not call a win a break-even", () => {
    expect(isBreakEvenExit({ side: "BUY", entry: 100 }, 100.12, 108)).toBe(false);
  });

  it("mirrors for shorts", () => {
    expect(isBreakEvenExit({ side: "SELL", entry: 100 }, 99.88, 99.88)).toBe(true);
    expect(isBreakEvenExit({ side: "SELL", entry: 100 }, 104, 104)).toBe(false);
  });
});
