import { describe, expect, it } from "vitest";
import { aggregateScorecard, observationKey, scoreObservation } from "@/services/scanLedger";
import type { Observation, ScoredRowInput } from "@/services/scanLedger";
import { Candle } from "@/engines/types";

/**
 * This is the file where a subtle bug would be most expensive, because its
 * output is the number used to judge every other part of the app. A scorer
 * that flatters by a few percent would not look wrong — it would look like
 * evidence, and it would be used to decide which scanners to keep.
 *
 * So the tests that matter are the ones about ordering (did the stop come
 * first?) and about refusing to score what has not finished.
 */

let clock = 1_700_000_000;
function bar(open: number, high: number, low: number, close: number): Candle {
  clock += 3600;
  return { time: clock, open, high, low, close, volume: 1000 };
}

/** Flat 1-wide bars around `price`, giving a predictable ATR of about 1. */
function base(n: number, price = 100): Candle[] {
  return Array.from({ length: n }, () => bar(price, price + 0.5, price - 0.5, price));
}

function seriesWith(after: Candle[], price = 100): { candles: Candle[]; at: number } {
  const head = base(30, price);
  const at = head[head.length - 1].time;
  return { candles: [...head, ...after], at };
}

describe("scoreObservation — refusing to score", () => {
  it("reports no_data when the bar is not in the series", () => {
    const { candles } = seriesWith(base(5));
    expect(scoreObservation(candles, 1, "long").outcome).toBe("no_data");
  });

  it("reports no_data when the bar is the last one", () => {
    const head = base(30);
    const last = head[head.length - 1].time;
    expect(scoreObservation(head, last, "long").outcome).toBe("no_data");
  });

  it("reports no_data when there is no volatility to measure against", () => {
    // Every bar identical: ATR is zero and an excursion in ATR is undefined.
    const flat = Array.from({ length: 40 }, () => bar(100, 100, 100, 100));
    expect(scoreObservation(flat, flat[29].time, "long").outcome).toBe("no_data");
  });
});

describe("scoreObservation — ordering", () => {
  it("calls a clean run to target a target", () => {
    const { candles, at } = seriesWith([
      bar(100, 101, 99.8, 100.8),
      bar(100.8, 102.5, 100.5, 102.3),
    ]);
    const s = scoreObservation(candles, at, "long");
    expect(s.outcome).toBe("target");
    expect(s.favourableAtr).toBeGreaterThanOrEqual(2);
  });

  it("calls a clean run against it a stop", () => {
    const { candles, at } = seriesWith([bar(100, 100.2, 98.5, 98.7)]);
    const s = scoreObservation(candles, at, "long");
    expect(s.outcome).toBe("stopped");
  });

  it("does not count a winner that only ran after the stop was hit", () => {
    /* The bug that would matter most. Taking the maxima over the whole window
       independently would score this as a target — a trade nobody was still
       in — and would flatter every scanner by however often it happens, which
       on a volatile session is often. */
    const { candles, at } = seriesWith([
      bar(100, 100.2, 98.4, 98.6), // stop first
      bar(98.6, 105, 98.5, 104.8), // then a huge run
    ]);
    const s = scoreObservation(candles, at, "long");
    expect(s.outcome).toBe("stopped");
  });

  it("assumes the adverse side first when one bar contains both", () => {
    /* Unverifiable without tick data, so it resolves pessimistically on
       purpose. An unverifiable assumption that favours the product is the kind
       that never gets revisited. */
    const { candles, at } = seriesWith([bar(100, 103, 98.5, 102)]);
    expect(scoreObservation(candles, at, "long").outcome).toBe("stopped");
  });

  it("reports neither when nothing reaches either threshold", () => {
    const { candles, at } = seriesWith(base(10, 100.2));
    const s = scoreObservation(candles, at, "long");
    expect(s.outcome).toBe("neither");
    expect(s.favourableAtr).toBeLessThan(2);
    expect(s.adverseAtr).toBeLessThan(1);
  });

  it("stops counting bars once the outcome is settled", () => {
    const { candles, at } = seriesWith([bar(100, 100.2, 98.4, 98.6), ...base(15, 98)]);
    expect(scoreObservation(candles, at, "long").barsScored).toBe(1);
  });

  it("never looks past the window", () => {
    // Nothing happens for 25 bars, then a huge move outside the 20-bar window.
    const { candles, at } = seriesWith([...base(25, 100.1), bar(100, 120, 100, 119)]);
    const s = scoreObservation(candles, at, "long");
    expect(s.outcome).toBe("neither");
    expect(s.barsScored).toBeLessThanOrEqual(20);
  });
});

describe("scoreObservation — direction", () => {
  it("reads the same path from the other side", () => {
    const { candles, at } = seriesWith([
      bar(100, 100.2, 99, 99.2),
      bar(99.2, 99.5, 97.5, 97.7),
    ]);
    const long = scoreObservation(candles, at, "long");
    const short = scoreObservation(candles, at, "short");
    expect(long.outcome).toBe("stopped");
    expect(short.outcome).toBe("target");
  });

  it("mirrors the excursions exactly while neither side has settled", () => {
    /* Only while neither has settled. Once a side is decided the walk stops,
       so the two directions legitimately see different amounts of the path and
       their numbers stop being comparable — which is correct, and was worth
       finding out by writing the naive assertion first. */
    const { candles, at } = seriesWith([
      bar(100, 100.6, 99.7, 100.4),
      bar(100.4, 100.8, 99.9, 100.1),
    ]);
    const long = scoreObservation(candles, at, "long");
    const short = scoreObservation(candles, at, "short");
    expect(long.outcome).toBe("neither");
    expect(short.outcome).toBe("neither");
    expect(short.favourableAtr).toBeCloseTo(long.adverseAtr, 9);
    expect(short.adverseAtr).toBeCloseTo(long.favourableAtr, 9);
  });

  it("measures from the close of the observation bar", () => {
    /* Not from whatever entry a scanner proposed. Several suggest a limit at a
       level, and scoring against that needs a fill model — which is how this
       app previously recorded phantom fills. */
    const { candles, at } = seriesWith(base(5, 100));
    expect(scoreObservation(candles, at, "long").entry).toBe(100);
  });

  it("never returns a negative excursion", () => {
    for (const side of ["long", "short"] as const) {
      const { candles, at } = seriesWith(base(10, 100));
      const s = scoreObservation(candles, at, side);
      expect(s.favourableAtr).toBeGreaterThanOrEqual(0);
      expect(s.adverseAtr).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("observationKey", () => {
  const o: Observation = {
    scanner: "thrust",
    state: "armed",
    symbol: "BTCUSDT",
    timeframe: "1h",
    side: "long",
    price: 100,
    level: 99,
    barTime: 1_700_000_000,
    meta: {},
  };

  it("is stable across sweeps of the same bar", () => {
    /* A setup that persists over six sweeps must be one row. Six copies are
       not six pieces of evidence — they are one setup counted six times, and
       they would make every rate a function of how often the cron runs. */
    expect(observationKey({ ...o, price: 105, level: 98 })).toBe(observationKey(o));
  });

  it("separates bars, scanners, states, symbols and timeframes", () => {
    expect(observationKey({ ...o, barTime: o.barTime + 3600 })).not.toBe(observationKey(o));
    expect(observationKey({ ...o, scanner: "bos" })).not.toBe(observationKey(o));
    expect(observationKey({ ...o, state: "held" })).not.toBe(observationKey(o));
    expect(observationKey({ ...o, symbol: "ETHUSDT" })).not.toBe(observationKey(o));
    expect(observationKey({ ...o, timeframe: "4h" })).not.toBe(observationKey(o));
  });
});

describe("aggregateScorecard", () => {
  const row = (over: Partial<ScoredRowInput> = {}): ScoredRowInput => ({
    scanner: "thrust",
    timeframe: "1h",
    state: "armed",
    outcome: "target",
    favourableAtr: 2.5,
    adverseAtr: 0.4,
    observedAt: new Date(1_700_000_000_000),
    ...over,
  });

  it("returns an empty card for no rows", () => {
    const c = aggregateScorecard([]);
    expect(c.rows).toEqual([]);
    expect(c.totalObserved).toBe(0);
    expect(c.since).toBeNull();
  });

  it("withholds a rate below the sample floor", () => {
    /* The single most important behaviour on the page. A rate from four cases
       is a description of four cases, and rendering it as a percentage invites
       it to be read as a property of the scanner. */
    const c = aggregateScorecard(Array.from({ length: 4 }, () => row()));
    expect(c.rows[0].scored).toBe(4);
    expect(c.rows[0].hitRate).toBeNull();
    expect(c.rows[0].edgeAtr).toBeNull();
  });

  it("reports a rate once there is enough to report", () => {
    const rows = [
      ...Array.from({ length: 15 }, () => row({ outcome: "target" })),
      ...Array.from({ length: 10 }, () => row({ outcome: "stopped" })),
    ];
    const c = aggregateScorecard(rows);
    expect(c.rows[0].scored).toBe(25);
    expect(c.rows[0].hitRate).toBeCloseTo(15 / 25, 9);
  });

  it("counts unscored rows as observed but not as misses", () => {
    /* A row waiting for its window is not a failure. Counting it as one would
       drag every rate down by however much of the ledger is still ripening,
       which early on is all of it. */
    const rows = [
      ...Array.from({ length: 20 }, () => row({ outcome: "target" })),
      ...Array.from({ length: 30 }, () => row({ outcome: null })),
    ];
    const c = aggregateScorecard(rows);
    expect(c.rows[0].observed).toBe(50);
    expect(c.rows[0].scored).toBe(20);
    expect(c.rows[0].hitRate).toBe(1);
  });

  it("does not count no_data as a miss", () => {
    // The scorer could not measure; that is the ledger's gap, not the scanner's.
    const rows = [
      ...Array.from({ length: 20 }, () => row({ outcome: "target" })),
      ...Array.from({ length: 5 }, () => row({ outcome: "no_data" })),
    ];
    expect(aggregateScorecard(rows).rows[0].scored).toBe(20);
  });

  it("splits by scanner, timeframe and state rather than averaging them", () => {
    /* A held retest and a fresh break are different claims. Averaging them
       produces a number that describes neither, and hides the common case
       where one state carries everything. */
    const c = aggregateScorecard([
      ...Array.from({ length: 20 }, () => row({ state: "armed", outcome: "target" })),
      ...Array.from({ length: 20 }, () => row({ state: "held", outcome: "stopped" })),
      ...Array.from({ length: 20 }, () => row({ timeframe: "4h", outcome: "target" })),
      ...Array.from({ length: 20 }, () => row({ scanner: "bos", outcome: "stopped" })),
    ]);
    expect(c.rows).toHaveLength(4);
    const armed = c.rows.find((r) => r.scanner === "thrust" && r.state === "armed" && r.timeframe === "1h");
    const held = c.rows.find((r) => r.state === "held");
    expect(armed!.hitRate).toBe(1);
    expect(held!.hitRate).toBe(0);
  });

  it("orders by evidence, never by how good the number looks", () => {
    const c = aggregateScorecard([
      ...Array.from({ length: 25 }, () => row({ scanner: "many", outcome: "stopped" })),
      ...Array.from({ length: 3 }, () => row({ scanner: "few", outcome: "target" })),
    ]);
    expect(c.rows[0].scanner).toBe("many");
  });

  it("computes edge as favourable minus adverse", () => {
    const rows = Array.from({ length: 20 }, () =>
      row({ favourableAtr: 3, adverseAtr: 1, outcome: "target" })
    );
    expect(aggregateScorecard(rows).rows[0].edgeAtr).toBeCloseTo(2, 9);
  });

  it("reports the ledger's start from the oldest row", () => {
    const c = aggregateScorecard([
      row({ observedAt: new Date(1_700_000_000_000) }),
      row({ observedAt: new Date(1_600_000_000_000) }),
    ]);
    expect(c.since).toBe(1_600_000_000);
  });
});
