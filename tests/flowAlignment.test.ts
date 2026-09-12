import { describe, expect, it } from "vitest";
import { readFlowAlignment } from "@/engines/flowAlignment";
import { Candle } from "@/engines/types";
import { OpenInterestPointLike } from "@/engines/positioning";

/**
 * The scanner built on this exists to find one configuration: price, CVD and
 * open interest all pushing the same way. So the tests that matter most are
 * the ones that keep the near misses OUT of it — a covering rally and a
 * markup are the same green candles, and the whole point is that they are not
 * the same answer.
 */

const T0 = 1_700_000_000;
const HOUR = 3600;

/**
 * A series where each bar's close and taker split are given explicitly.
 * `buyShare` above 0.5 means that bar added to the CVD.
 */
function bars(closes: number[], buyShare: number | number[] = 0.5): Candle[] {
  return closes.map((c, i) => {
    const share = Array.isArray(buyShare) ? buyShare[i] : buyShare;
    const volume = 1000;
    return {
      time: T0 + i * HOUR,
      open: i === 0 ? c : closes[i - 1],
      high: c * 1.004,
      low: c * 0.996,
      close: c,
      volume,
      takerBuyVolume: volume * share,
      trades: 200,
    };
  });
}

/** An OI series running from `from` to `to` across `n` prints. */
function oi(n: number, from: number, to: number): OpenInterestPointLike[] {
  return Array.from({ length: n }, (_, i) => ({
    time: T0 + i * HOUR,
    openInterest: from + ((to - from) * i) / Math.max(1, n - 1),
  }));
}

const N = 24;
/** Steadily rising / falling / flat price over the window. */
const rising = bars(Array.from({ length: N }, (_, i) => 100 + i * 0.5), 0.75);
const falling = bars(Array.from({ length: N }, (_, i) => 110 - i * 0.5), 0.25);
const flatPrice = bars(Array.from({ length: N }, () => 100), 0.75);

const oiUp = oi(N, 1_000_000, 1_060_000);
const oiDown = oi(N, 1_060_000, 1_000_000);
const oiFlat = oi(N, 1_000_000, 1_000_100);

describe("readFlowAlignment — what it refuses to answer", () => {
  it("returns no state without enough candles", () => {
    const r = readFlowAlignment(bars([1, 2, 3]), oiUp);
    expect(r.state).toBeNull();
    expect(r.caveats.join(" ")).toMatch(/fewer than/i);
  });

  it("returns no state without open-interest history", () => {
    const r = readFlowAlignment(rising, []);
    expect(r.state).toBeNull();
    expect(r.caveats.join(" ")).toMatch(/no open-interest history/i);
  });

  it("returns no state when the open-interest series is stale", () => {
    // Prints that all predate the window by days cannot speak for it.
    const stale = oi(N, 1_000_000, 1_060_000).map((p) => ({ ...p, time: p.time - 30 * 24 * HOUR }));
    const r = readFlowAlignment(rising, stale);
    expect(r.state).toBeNull();
    expect(r.caveats.join(" ")).toMatch(/do not cover this window/i);
  });

  it("returns no state when the window straddles a single open-interest print", () => {
    /* The fast-timeframe case the message describes: open interest publishes
       every five minutes at best, so a ten-minute window can sit entirely
       between two prints and resolve both of its boundaries to the same one.
       An hourly window instead fails the staleness check above — a different
       failure, with a different message. */
    const minuteBars = bars(Array.from({ length: 10 }, (_, i) => 100 + i * 0.5), 0.75).map(
      (c, i) => ({ ...c, time: T0 + i * 60 })
    );
    const r = readFlowAlignment(minuteBars, [{ time: T0, openInterest: 1_000_000 }]);
    expect(r.state).toBeNull();
    expect(r.caveats.join(" ")).toMatch(/straddle a single print/i);
  });

  it("returns no state without a taker breakdown — CVD is the point", () => {
    const noTaker = rising.map(({ takerBuyVolume: _t, ...rest }) => rest);
    const r = readFlowAlignment(noTaker, oiUp);
    expect(r.state).toBeNull();
    expect(r.caveats.join(" ")).toMatch(/cumulative delta cannot be built/i);
  });

  it("returns no state when price is flat", () => {
    const r = readFlowAlignment(flatPrice, oiUp);
    expect(r.state).toBeNull();
    expect(r.caveats.join(" ")).toMatch(/nothing for delta and open interest to agree/i);
  });

  it("returns no state when neither side pressed", () => {
    const balanced = bars(Array.from({ length: N }, (_, i) => 100 + i * 0.5), 0.5);
    const r = readFlowAlignment(balanced, oiUp);
    expect(r.state).toBeNull();
    expect(r.caveats.join(" ")).toMatch(/inside the noise band/i);
  });

  it("still reports the axes it did manage to read", () => {
    // A failed read that throws away the two working axes is less useful than
    // one that says which single thing was missing.
    const r = readFlowAlignment(rising, oiFlat);
    expect(r.state).toBeNull();
    expect(r.price.direction).toBe("up");
    expect(r.cvd.direction).toBe("up");
    expect(r.barsCovered).toBe(N);
  });

  it("refuses to call flat open interest a positioning change", () => {
    const r = readFlowAlignment(rising, oiFlat);
    expect(r.state).toBeNull();
    expect(r.caveats.join(" ")).toMatch(/between existing holders/i);
  });
});

describe("readFlowAlignment — the configuration it looks for", () => {
  it("calls price up, CVD up and OI up longs building", () => {
    const r = readFlowAlignment(rising, oiUp);
    expect(r.state).toBe("longs_building");
    expect(r.unanimous).toBe(true);
    expect(r.price.direction).toBe("up");
    expect(r.cvd.direction).toBe("up");
    expect(r.openInterest.direction).toBe("up");
  });

  it("calls the mirror shorts building", () => {
    const r = readFlowAlignment(falling, oiUp);
    expect(r.state).toBe("shorts_building");
    expect(r.unanimous).toBe(true);
    expect(r.cvd.direction).toBe("down");
  });

  it("rules out both ways a rally fakes it", () => {
    const r = readFlowAlignment(rising, oiUp);
    expect(r.mechanism).toMatch(/not shorts being squeezed out/i);
    expect(r.mechanism).toMatch(/not a drift up on thin offers/i);
  });
});

describe("readFlowAlignment — the near misses stay out", () => {
  it("separates a covering rally from a markup", () => {
    // Same green candles, same real buying — but OI falling means the buyers
    // are leaving rather than joining, and that bid ends when they are out.
    const r = readFlowAlignment(rising, oiDown);
    expect(r.state).toBe("covering_rally");
    expect(r.unanimous).toBe(false);
    expect(r.mechanism).toMatch(/finite/i);
  });

  it("separates deleveraging from fresh shorts", () => {
    const r = readFlowAlignment(falling, oiDown);
    expect(r.state).toBe("deleveraging");
    expect(r.unanimous).toBe(false);
  });

  it("calls a rally on falling CVD absorbed, whatever open interest did", () => {
    const priceUpFlowDown = bars(Array.from({ length: N }, (_, i) => 100 + i * 0.5), 0.25);
    for (const points of [oiUp, oiDown]) {
      const r = readFlowAlignment(priceUpFlowDown, points);
      expect(r.state).toBe("absorbed_rally");
      expect(r.unanimous).toBe(false);
    }
  });

  it("calls a decline on rising CVD absorbed", () => {
    const priceDownFlowUp = bars(Array.from({ length: N }, (_, i) => 110 - i * 0.5), 0.75);
    const r = readFlowAlignment(priceDownFlowUp, oiUp);
    expect(r.state).toBe("absorbed_selloff");
    expect(r.mechanism).toMatch(/selling passively into every one of those lifts/i);
  });

  it("still reports open interest on the absorbed states", () => {
    // The state ignores OI by design, but dropping the field would lose the
    // difference between absorption with shorts arriving and without.
    const priceUpFlowDown = bars(Array.from({ length: N }, (_, i) => 100 + i * 0.5), 0.25);
    expect(readFlowAlignment(priceUpFlowDown, oiUp).openInterest.direction).toBe("up");
    expect(readFlowAlignment(priceUpFlowDown, oiDown).openInterest.direction).toBe("down");
  });
});

describe("readFlowAlignment — steadiness", () => {
  it("separates a steady climb from one that ended in the same place", () => {
    /* Two windows with identical endpoints are not identical evidence, and
       only steadiness tells them apart. */
    const steady = bars(Array.from({ length: N }, (_, i) => 100 + i * 0.5), 0.75);
    const lurching = bars(
      Array.from({ length: N }, (_, i) => 100 + i * 0.5),
      Array.from({ length: N }, (_, i) => (i % 2 === 0 ? 0.95 : 0.45))
    );
    const a = readFlowAlignment(steady, oiUp);
    const b = readFlowAlignment(lurching, oiUp);
    expect(a.cvd.steadiness).toBeGreaterThan(b.cvd.steadiness);
    expect(a.score).toBeGreaterThan(b.score);
  });

  it("counts a bar with positive delta as a bar the CVD rose on", () => {
    const r = readFlowAlignment(rising, oiUp);
    expect(r.cvd.steadiness).toBe(1);
    expect(r.cvd.steps).toBe(N);
  });

  it("measures steadiness in the direction the axis actually went", () => {
    // On a falling axis, steadiness must count the DOWN steps, or every
    // bearish read reports as maximally unsteady.
    const r = readFlowAlignment(falling, oiUp);
    expect(r.cvd.direction).toBe("down");
    expect(r.cvd.steadiness).toBe(1);
    expect(r.price.steadiness).toBe(1);
  });
});

describe("readFlowAlignment — scale and honesty", () => {
  it("reports the same read when every size is multiplied", () => {
    // CVD is expressed as a share of volume precisely so this holds.
    const big = rising.map((c) => ({
      ...c,
      volume: c.volume * 50_000,
      takerBuyVolume: (c.takerBuyVolume ?? 0) * 50_000,
    }));
    const bigOi = oiUp.map((p) => ({ ...p, openInterest: p.openInterest * 50_000 }));
    const a = readFlowAlignment(rising, oiUp);
    const b = readFlowAlignment(big, bigOi);
    expect(b.state).toBe(a.state);
    expect(b.cvd.changePct).toBeCloseTo(a.cvd.changePct, 4);
    expect(b.score).toBe(a.score);
  });

  it("keeps the CVD share inside 100% when taker volume exceeds the bar", () => {
    // Real Binance fixtures carry these.
    const broken = rising.map((c, i) => (i % 5 === 0 ? { ...c, takerBuyVolume: c.volume * 4 } : c));
    const r = readFlowAlignment(broken, oiUp);
    expect(Math.abs(r.cvd.changePct)).toBeLessThanOrEqual(100);
  });

  it("never claims the move continues", () => {
    const r = readFlowAlignment(rising, oiUp);
    const text = (r.headline + r.mechanism + r.caveats.join(" ")).toLowerCase();
    for (const banned of ["will continue", "will rise", "guaranteed", "expect price"]) {
      expect(text).not.toContain(banned);
    }
  });

  it("says alignment is not the same as being early", () => {
    expect(readFlowAlignment(rising, oiUp).caveats.join(" ")).toMatch(/carrying the most stops/i);
  });

  it("emits finite numbers on a zero-volume series", () => {
    const dead = rising.map((c) => ({ ...c, volume: 0, takerBuyVolume: 0 }));
    const r = readFlowAlignment(dead, oiUp);
    expect(Number.isFinite(r.cvd.changePct)).toBe(true);
    expect(Number.isFinite(r.score)).toBe(true);
  });

  it("scores a decisive window above a marginal one", () => {
    const marginal = bars(Array.from({ length: N }, (_, i) => 100 + i * 0.03), 0.56);
    const decisive = readFlowAlignment(rising, oiUp);
    const weak = readFlowAlignment(marginal, oi(N, 1_000_000, 1_006_000));
    expect(decisive.score).toBeGreaterThan(weak.score);
  });

  it("keeps ranking two strong windows apart instead of saturating", () => {
    /* The bug this pins: the score used to divide by a fixed ceiling and clamp
       at 1, so every strong reading came back at exactly 100 and the ranking
       carried no information at the top — the only place a scanner's ranking
       is ever read. A saturating curve has no ceiling to hit. */
    const strong = bars(Array.from({ length: N }, (_, i) => 100 + i * 0.5), 0.75);
    const stronger = bars(Array.from({ length: N }, (_, i) => 100 + i * 2), 0.95);
    const a = readFlowAlignment(strong, oi(N, 1_000_000, 1_060_000));
    const b = readFlowAlignment(stronger, oi(N, 1_000_000, 1_400_000));
    expect(a.score).toBeLessThan(b.score);
    expect(b.score).toBeLessThan(100);
  });

  it("never reaches 100 however extreme the window", () => {
    const absurd = bars(Array.from({ length: N }, (_, i) => 100 * Math.pow(1.5, i)), 1);
    const r = readFlowAlignment(absurd, oi(N, 1_000, 100_000_000));
    expect(r.score).toBeLessThan(100);
    expect(r.score).toBeGreaterThan(80);
  });
});
