import { describe, expect, it } from "vitest";
import { findCandleLadders, MIN_BARS, strongestLadder } from "@/engines/candleLadder";
import { Candle } from "@/engines/types";

/**
 * The claim this engine makes is narrow and checkable: these N consecutive
 * bars each stepped past the one before it. So the tests that matter are the
 * ones that would catch it counting a run that did not happen — a step that
 * did not hold, a run stretched past the bar that broke it, chop dressed up as
 * a trend.
 */

let clock = 1_700_000_000;
function bar(open: number, high: number, low: number, close: number): Candle {
  clock += 900;
  return { time: clock, open, high, low, close, volume: 1000 };
}

const STEP = 2;

/** Flat bars, so nothing steps anywhere — the background for every fixture. */
function flat(n: number, price = 100): Candle[] {
  return Array.from({ length: n }, () => bar(price, price + 0.5, price - 0.5, price));
}

/**
 * A bar wide enough that the next bar cannot step past it either way.
 *
 * Every run fixture opens with one. Without it the first stair steps past
 * whatever preceded it — a flat bar really is lower than the first step of a
 * staircase — and the run comes back one bar longer than the fixture meant to
 * build. That is the fixture being wrong, not the engine, and asserting around
 * it would have baked an off-by-one into the expectations.
 */
function wall(price: number): Candle {
  return bar(price, price + STEP * 3, price - STEP * 3, price);
}

/** A clean ascending staircase: every low and high above the last. */
function stairsUp(n: number, from = 100, step = STEP): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const base = from + i * step;
    out.push(bar(base, base + step * 0.9, base - step * 0.1, base + step * 0.8));
  }
  return out;
}

function stairsDown(n: number, from = 100, step = STEP): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const base = from - i * step;
    out.push(bar(base, base + step * 0.1, base - step * 0.9, base - step * 0.8));
  }
  return out;
}

/**
 * A wall plus stairs, arranged so the run the engine finds is exactly `n` bars.
 *
 * `n` stairs and not `n + 1`: a run is counted in bars, and `n` bars contain
 * `n - 1` steps. The first stair opens the run without having to step past
 * anything, which is what the wall in front of it is for.
 */
function runUp(n: number, from = 100): Candle[] {
  return [wall(from), ...stairsUp(n, from)];
}
function runDown(n: number, from = 100): Candle[] {
  return [wall(from), ...stairsDown(n, from)];
}
/** Where a `runUp` of `n` bars leaves price, for chaining blocks. */
function afterUp(n: number, from = 100): number {
  return from + n * STEP;
}

describe("findCandleLadders — what it refuses to call a run", () => {
  it("finds nothing in a flat series", () => {
    expect(findCandleLadders(flat(60))).toEqual([]);
  });

  it("finds nothing in a series too short to hold a run", () => {
    expect(findCandleLadders(stairsUp(MIN_BARS - 1))).toEqual([]);
  });

  it("refuses a run one bar short of the minimum", () => {
    const candles = [...flat(30), ...runUp(MIN_BARS - 1)];
    expect(findCandleLadders(candles).filter((l) => l.direction === "up")).toEqual([]);
  });

  it("will not count a bar that failed to take out the previous high", () => {
    /* Higher low but an inside high is not a step — the bar did not get past
       the one before it, and counting it would inflate every run in a range. */
    const candles = [...flat(30)];
    candles.push(bar(100, 104, 99, 103));
    candles.push(bar(103, 106, 102, 105));
    candles.push(bar(105, 105.5, 104, 105)); // inside high
    candles.push(bar(105, 108, 105, 107));
    candles.push(bar(107, 110, 106, 109));
    expect(findCandleLadders(candles).filter((l) => l.bars >= MIN_BARS && l.direction === "up"))
      .toEqual([]);
  });

  it("ends the run at the bar that broke a step, not after it", () => {
    const candles = [...flat(20), ...runUp(6)];
    // a bar that dips under the previous low ends it
    const top = afterUp(6);
    candles.push(bar(top, top + 2, top - 4, top));
    candles.push(...runUp(5, top));
    const runs = findCandleLadders(candles).filter((l) => l.direction === "up");
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.bars).sort()).toEqual([5, 6]);
  });

  it("drops a run that covers no ground", () => {
    /* Four technically-higher lows inside a fraction of an average bar is a
       staircase on paper and invisible on a chart. Big bars first so ATR is
       large relative to the crawl that follows. */
    const top = afterUp(20);
    const candles = [...runUp(20), wall(top), ...stairsUp(7, top, 0.01)];
    const crawl = findCandleLadders(candles).find((l) => l.startIndex > 21);
    expect(crawl).toBeUndefined();
  });
});

describe("findCandleLadders — what it reports", () => {
  it("finds an ascending staircase and measures it", () => {
    const candles = [...flat(30), ...runUp(8)];
    const up = findCandleLadders(candles).find((l) => l.direction === "up");
    expect(up).toBeDefined();
    expect(up!.bars).toBe(8);
    expect(up!.endIndex).toBe(candles.length - 1);
    expect(up!.movePct).toBeGreaterThan(0);
    expect(up!.slopePctPerBar).toBeGreaterThan(0);
  });

  it("finds a descending staircase and signs it the other way", () => {
    const candles = [...flat(30), ...runDown(8)];
    const down = findCandleLadders(candles).find((l) => l.direction === "down");
    expect(down).toBeDefined();
    expect(down!.bars).toBe(8);
    expect(down!.movePct).toBeGreaterThan(0);
    expect(down!.slopePctPerBar).toBeLessThan(0);
  });

  it("reports a run once at its full length, not as its overlapping parts", () => {
    const candles = [...flat(30), ...runUp(9)];
    const ups = findCandleLadders(candles).filter((l) => l.direction === "up");
    expect(ups).toHaveLength(1);
    expect(ups[0].bars).toBe(9);
  });

  it("scores a perfectly even staircase as near-straight", () => {
    const candles = [...flat(30), ...runUp(8)];
    const up = findCandleLadders(candles).find((l) => l.direction === "up")!;
    expect(up.r2).toBeGreaterThan(0.99);
  });

  it("reports a curved run rather than dropping it, with a lower r2", () => {
    // steps that grow: still a staircase, but not a straight one
    const candles = [...flat(30), wall(100)];
    let base = 100;
    for (let i = 1; i <= 9; i++) {
      const step = i * 1.5;
      candles.push(bar(base, base + step, base - 0.2, base + step * 0.9));
      base += step;
    }
    const up = findCandleLadders(candles).find((l) => l.direction === "up")!;
    expect(up.r2).toBeLessThan(0.99);
  });

  it("counts a run that reaches the final bar", () => {
    /* The case a scanner is for. A run only closed when a later bar broke it
       would never report the live run, which is the only one anybody wants. */
    const candles = [...flat(30), ...runUp(7)];
    const up = findCandleLadders(candles).find((l) => l.direction === "up")!;
    expect(up.endIndex).toBe(candles.length - 1);
    expect(up.barsSinceEnd).toBe(0);
  });

  it("separates bodies from steps", () => {
    /* Higher highs and higher lows made of red candles is a grind, not a
       drive. Both are runs; bodyShare is what tells them apart. */
    const candles = [...flat(30), wall(100)];
    let base = 100;
    for (let i = 0; i < 8; i++) {
      // opens at the top, closes lower, yet still steps up
      candles.push(bar(base + 2.5, base + 3, base, base + 0.5));
      base += 2;
    }
    const up = findCandleLadders(candles).find((l) => l.direction === "up");
    expect(up).toBeDefined();
    expect(up!.bodyShare).toBe(0);
  });

  it("ranks a longer, straighter, bigger run above a shorter one", () => {
    const top = afterUp(10);
    const candles = [...flat(20), ...runUp(10), ...runUp(4, top)];
    const ups = findCandleLadders(candles).filter((l) => l.direction === "up");
    expect(ups).toHaveLength(2);
    expect(ups[0].bars).toBe(10);
    expect(ups[0].score).toBeGreaterThan(ups[1].score);
  });

  it("never scores outside 0-100", () => {
    for (const n of [4, 6, 10, 20, 40]) {
      for (const l of findCandleLadders([...flat(20), ...runUp(n)])) {
        expect(l.score).toBeGreaterThanOrEqual(0);
        expect(l.score).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe("the fitted line", () => {
  it("projects to roughly where the last low sits on a live run", () => {
    const candles = [...flat(30), ...runUp(8)];
    const up = findCandleLadders(candles).find((l) => l.direction === "up")!;
    const lastLow = candles[candles.length - 1].low;
    expect(Math.abs(up.lineNow - lastLow)).toBeLessThan(STEP);
  });

  it("marks a run broken once a later bar closes through the line", () => {
    const candles = [...flat(20), ...runUp(8)];
    const top = afterUp(8);
    // collapse well below where the line projects
    candles.push(bar(top, top + 1, 95, 96));
    candles.push(bar(96, 97, 94, 95));
    const up = findCandleLadders(candles).find((l) => l.direction === "up")!;
    expect(up.broken).toBe(true);
  });

  it("does not mark a run broken for a wick through the line", () => {
    const candles = [...flat(20), ...runUp(8)];
    const line = findCandleLadders(candles).find((l) => l.direction === "up")!.lineNow;
    // trades under the line intrabar, closes back above it
    candles.push(bar(line + 2, line + 3, line - 5, line + 4));
    const up = findCandleLadders(candles).find((l) => l.direction === "up")!;
    expect(up.broken).toBe(false);
  });
});

describe("strongestLadder", () => {
  it("returns null when there is nothing", () => {
    expect(strongestLadder(flat(60))).toBeNull();
  });

  it("prefers a live run over a higher-scoring dead one", () => {
    /* A scanner reports what is happening now. A fourteen-bar run that ended
       last week outranks everything on score and is worth nothing to a reader
       looking for something to trade today. */
    const top = afterUp(14);
    const candles = [...flat(10), ...runUp(14), wall(top), ...flat(20, top), ...runUp(5, top)];
    const pick = strongestLadder(candles)!;
    expect(pick.barsSinceEnd).toBe(0);
    expect(pick.bars).toBe(5);
  });

  it("falls back to the best dead run when nothing is live", () => {
    const top = afterUp(10);
    const candles = [...flat(10), ...runUp(10), wall(top), ...flat(20, top)];
    const pick = strongestLadder(candles)!;
    expect(pick.bars).toBe(10);
    expect(pick.barsSinceEnd).toBeGreaterThan(2);
  });
});
