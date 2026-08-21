import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheDelete } from "@/lib/cache";
import { AnalystKey, AnalystVerdict, ConfluenceSetup, DirectionalCase } from "@/engines/types";

/**
 * The scanner's job is coverage, and the two ways coverage lies are:
 *
 *  * **Order.** If the universe isn't ranked by traded value, "we scanned the
 *    top 100" means 100 coins nobody trades.
 *  * **Silence.** If one delisted contract aborts the sweep, the dashboard goes
 *    blank and says nothing about why.
 *
 * Both are pinned here, along with the rule that a NO_TRADE never leaks into a
 * tradable list.
 */

const tickers = vi.hoisted(() => ({ fn: vi.fn() }));
const symbols = vi.hoisted(() => ({ fn: vi.fn() }));
const klines = vi.hoisted(() => ({ fn: vi.fn() }));

vi.mock("@/lib/binance", () => ({
  fetchAllTickers: tickers.fn,
  fetchKlines: klines.fn,
}));

vi.mock("@/lib/symbols", () => ({
  fetchFuturesSymbols: symbols.fn,
}));

// Imported for its side effect of constructing a client; never queried here.
vi.mock("@/lib/db", () => ({ prisma: {} }));

import {
  assembleScan,
  DEFAULT_SCAN_DEPTH,
  mergeScans,
  rankUniverse,
  ScanEntry,
  scanUniverse,
} from "@/services/scanService";

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function ticker(symbol: string, quoteVolume: number, over: Record<string, number> = {}) {
  return {
    symbol,
    lastPrice: 100,
    priceChangePercent: 1.5,
    highPrice: 105,
    lowPrice: 95,
    volume: quoteVolume / 100,
    quoteVolume,
    ...over,
  };
}

function futuresSymbol(symbol: string) {
  return {
    symbol,
    base: symbol.replace(/USDT$/, ""),
    quote: "USDT",
    label: symbol.replace(/USDT$/, "/USDT"),
    pricePrecision: 2,
    featured: false,
  };
}

function verdict(analyst: AnalystKey, qualified = true): AnalystVerdict {
  return {
    analyst,
    name: analyst,
    basis: analyst === "chart" ? "pattern_history" : analyst === "range" ? "range_boundary" : "level_close",
    direction: qualified ? "long" : "none",
    confidence: 80,
    qualified,
    gate: qualified ? "qualified" : "abstains",
    entry: 100,
    target: 106,
    invalidation: 98,
    evidence: "evidence",
  };
}

function directionalCase(over: Partial<DirectionalCase> = {}): DirectionalCase {
  return {
    direction: "long",
    confidence: 50,
    rawStrength: 0,
    independentBases: 0,
    independenceMultiplier: 1,
    supporters: [],
    disagreementPenalty: 0,
    ...over,
  };
}

function setup(over: Partial<ConfluenceSetup> = {}): ConfluenceSetup {
  return {
    symbol: "BTCUSDT",
    timeframe: "1h",
    price: 100,
    generatedAt: 1_700_000_000,
    verdicts: [],
    long: directionalCase(),
    short: directionalCase({ direction: "short" }),
    decision: "NO_TRADE",
    confidence: 55,
    confidenceLabel: "Low",
    noTradeReason: "nothing qualified",
    entry: null,
    stopLoss: null,
    target1: null,
    target2: null,
    riskReward: null,
    disagreement: { present: false, note: "", penaltyApplied: 0 },
    confluenceVerdict: "None",
    explanation: [],
    invalidation: [],
    ...over,
  };
}

function entry(symbol: string, over: Partial<ConfluenceSetup> = {}, quoteVolume = 1_000_000): ScanEntry {
  return {
    symbol,
    label: symbol.replace(/USDT$/, "/USDT"),
    timeframe: "1h",
    quoteVolume,
    priceChangePercent: 1,
    setup: setup({ symbol, ...over }),
  };
}

const meta = {
  timeframe: "1h",
  minConfidence: 70,
  failed: 0,
  coverage: { onDemand: 0, persisted: 0, universe: 0 },
};

afterEach(() => {
  vi.clearAllMocks();
  for (const tf of ["15m", "1h", "4h"]) {
    for (const depth of [3, 4, 100, DEFAULT_SCAN_DEPTH]) {
      cacheDelete(`scan:${tf}:${depth}:default`);
      cacheDelete(`scan:${tf}:${depth}:70`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * Ranking
 * ------------------------------------------------------------------ */

describe("rankUniverse", () => {
  it("ranks by 24h quote volume, not by name", async () => {
    symbols.fn.mockResolvedValue([
      futuresSymbol("AAVEUSDT"),
      futuresSymbol("BTCUSDT"),
      futuresSymbol("ETHUSDT"),
    ]);
    tickers.fn.mockResolvedValue(
      new Map([
        ["AAVEUSDT", ticker("AAVEUSDT", 40_000_000)],
        ["BTCUSDT", ticker("BTCUSDT", 9_000_000_000)],
        ["ETHUSDT", ticker("ETHUSDT", 4_000_000_000)],
      ])
    );

    const ranked = await rankUniverse();
    // Alphabetical order would put AAVE ahead of BTC, which is exactly the
    // failure that makes a top-100 scan worthless.
    expect(ranked.map((r) => r.symbol)).toEqual(["BTCUSDT", "ETHUSDT", "AAVEUSDT"]);
    expect(ranked[0]).toMatchObject({ label: "BTC/USDT", lastPrice: 100 });
  });

  it("drops symbols the ticker feed does not cover", async () => {
    symbols.fn.mockResolvedValue([futuresSymbol("BTCUSDT"), futuresSymbol("GHOSTUSDT")]);
    tickers.fn.mockResolvedValue(new Map([["BTCUSDT", ticker("BTCUSDT", 1_000)]]));

    const ranked = await rankUniverse();
    // A contract with no ticker has no volume to rank on and no candles worth
    // reading — scanning it would spend weight to learn nothing.
    expect(ranked.map((r) => r.symbol)).toEqual(["BTCUSDT"]);
  });
});

/* ------------------------------------------------------------------ *
 * Sweep resilience
 * ------------------------------------------------------------------ */

describe("scanUniverse", () => {
  /** Three symbols; `bad` throws when its klines are fetched. */
  function universe(bad?: string) {
    symbols.fn.mockResolvedValue([
      futuresSymbol("BTCUSDT"),
      futuresSymbol("ETHUSDT"),
      futuresSymbol("SOLUSDT"),
    ]);
    tickers.fn.mockResolvedValue(
      new Map([
        ["BTCUSDT", ticker("BTCUSDT", 9_000_000_000)],
        ["ETHUSDT", ticker("ETHUSDT", 4_000_000_000)],
        ["SOLUSDT", ticker("SOLUSDT", 1_000_000_000)],
      ])
    );
    klines.fn.mockImplementation(async (symbol: string) => {
      if (symbol === bad) throw new Error("delisted mid-scan");
      return [];
    });
  }

  it("does not abort the sweep when one symbol fails", async () => {
    universe("ETHUSDT");
    const scan = await scanUniverse({ timeframe: "1h", depth: 3, fresh: true });

    expect(scan.failed).toBe(1);
    // The whole point: one dead contract must not blank the dashboard.
    expect(scan.partial).toBe(true);
    expect(scan.scanned).toBe(2);
    expect(scan.coverage).toMatchObject({ onDemand: 2, persisted: 0, universe: 3 });
  });

  it("reports complete coverage as not partial", async () => {
    universe();
    const scan = await scanUniverse({ timeframe: "1h", depth: 3, fresh: true });
    expect(scan.failed).toBe(0);
    expect(scan.partial).toBe(false);
    expect(scan.scanned).toBe(3);
  });

  it("scans the highest-volume symbols first when depth is smaller than the universe", async () => {
    universe();
    await scanUniverse({ timeframe: "1h", depth: 3, fresh: true });
    klines.fn.mockClear();

    await scanUniverse({ timeframe: "4h", depth: 2, fresh: true });
    const scanned = klines.fn.mock.calls.map((c) => c[0]);
    expect(scanned.sort()).toEqual(["BTCUSDT", "ETHUSDT"]);
  });

  it("serves a repeat request from cache instead of refetching", async () => {
    universe();
    await scanUniverse({ timeframe: "15m", depth: 3 });
    const firstCallCount = klines.fn.mock.calls.length;
    expect(firstCallCount).toBe(3);

    await scanUniverse({ timeframe: "15m", depth: 3 });
    // A setup does not change meaningfully inside the TTL, and a second sweep
    // would double the Binance weight for the same answer.
    expect(klines.fn.mock.calls.length).toBe(firstCallCount);
  });

  it("bypasses the cache when asked for a fresh sweep", async () => {
    universe();
    await scanUniverse({ timeframe: "15m", depth: 3 });
    await scanUniverse({ timeframe: "15m", depth: 3, fresh: true });
    expect(klines.fn.mock.calls.length).toBe(6);
  });
});

/* ------------------------------------------------------------------ *
 * Assembling a board
 * ------------------------------------------------------------------ */

describe("assembleScan", () => {
  it("splits by decision and never lists a NO_TRADE as tradable", () => {
    const scan = assembleScan(
      [
        entry("AUSDT", { decision: "LONG", confidence: 78 }),
        entry("BUSDT", { decision: "SHORT", confidence: 84 }),
        entry("CUSDT", { decision: "NO_TRADE", confidence: 91, verdicts: [verdict("chart")] }),
      ],
      meta
    );

    expect(scan.long.map((e) => e.symbol)).toEqual(["AUSDT"]);
    expect(scan.short.map((e) => e.symbol)).toEqual(["BUSDT"]);
    // 91 is the highest confidence on the board, and it still must not appear
    // in a tradable list — the decision is the gate, not the number.
    expect([...scan.long, ...scan.short].map((e) => e.symbol)).not.toContain("CUSDT");
    expect(scan.noTradeCount).toBe(1);
    expect(scan.scanned).toBe(3);
  });

  it("ranks each side strongest first", () => {
    const scan = assembleScan(
      [
        entry("AUSDT", { decision: "LONG", confidence: 72 }),
        entry("BUSDT", { decision: "LONG", confidence: 91 }),
        entry("CUSDT", { decision: "LONG", confidence: 80 }),
        entry("DUSDT", { decision: "SHORT", confidence: 75 }),
        entry("EUSDT", { decision: "SHORT", confidence: 88 }),
      ],
      meta
    );
    expect(scan.long.map((e) => e.setup.confidence)).toEqual([91, 80, 72]);
    expect(scan.short.map((e) => e.setup.confidence)).toEqual([88, 75]);
  });

  it("surfaces the three closest near misses, ignoring coins nobody had a read on", () => {
    const scan = assembleScan(
      [
        entry("AUSDT", { decision: "NO_TRADE", confidence: 69, verdicts: [verdict("chart")] }),
        entry("BUSDT", { decision: "NO_TRADE", confidence: 66, verdicts: [verdict("range")] }),
        entry("CUSDT", { decision: "NO_TRADE", confidence: 68, verdicts: [verdict("candleClose")] }),
        entry("DUSDT", { decision: "NO_TRADE", confidence: 64, verdicts: [verdict("chart")] }),
        // All three abstained: this is noise, not a near miss.
        entry("EUSDT", { decision: "NO_TRADE", confidence: 62, verdicts: [verdict("chart", false)] }),
      ],
      meta
    );

    expect(scan.nearMisses.map((e) => e.symbol)).toEqual(["AUSDT", "CUSDT", "BUSDT"]);
    expect(scan.nearMisses).toHaveLength(3);
    expect(scan.nearMisses.map((e) => e.symbol)).not.toContain("EUSDT");
    // An empty board still reports how much was looked at, so "no setup" reads
    // as a finding rather than a failure.
    expect(scan.noTradeCount).toBe(5);
    expect(scan.long).toEqual([]);
    expect(scan.short).toEqual([]);
  });

  it("carries the applied threshold and failure count through", () => {
    const scan = assembleScan([entry("AUSDT", { decision: "LONG", confidence: 75 })], {
      ...meta,
      minConfidence: 65,
      failed: 4,
    });
    expect(scan.minConfidence).toBe(65);
    expect(scan.failed).toBe(4);
    expect(scan.partial).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Merging worker coverage
 * ------------------------------------------------------------------ */

describe("mergeScans", () => {
  const live = assembleScan(
    [
      entry("BTCUSDT", { decision: "LONG", confidence: 88 }),
      entry("ETHUSDT", { decision: "NO_TRADE", confidence: 60, verdicts: [verdict("chart")] }),
    ],
    { ...meta, coverage: { onDemand: 2, persisted: 0, universe: 530 } }
  );

  it("adds symbols the live scan never reached", () => {
    const merged = mergeScans(live, [
      entry("PEPEUSDT", { decision: "SHORT", confidence: 81 }),
      entry("WIFUSDT", { decision: "LONG", confidence: 74 }),
    ]);

    expect(merged.long.map((e) => e.symbol)).toEqual(["BTCUSDT", "WIFUSDT"]);
    expect(merged.short.map((e) => e.symbol)).toEqual(["PEPEUSDT"]);
    expect(merged.coverage).toMatchObject({ onDemand: 2, persisted: 2, universe: 530 });
  });

  it("lets the live scan win on a symbol both cover", () => {
    const merged = mergeScans(live, [entry("BTCUSDT", { decision: "SHORT", confidence: 95 })]);
    // The persisted row may be half an hour old; the live one was computed from
    // candles fetched seconds ago.
    expect(merged.short).toEqual([]);
    expect(merged.long.map((e) => e.setup.confidence)).toEqual([88]);
    expect(merged.coverage.persisted).toBe(0);
  });

  it("keeps the coverage counts honest rather than recounting a filtered board", () => {
    // `live` dropped its non-near-miss NO_TRADEs before merging, so a naive
    // recount would under-report both figures.
    const withDrops = { ...live, noTradeCount: 98, scanned: 100 };
    const merged = mergeScans(withDrops, [
      entry("AUSDT", { decision: "NO_TRADE", confidence: 55, verdicts: [verdict("chart")] }),
      entry("BUSDT", { decision: "LONG", confidence: 71 }),
    ]);
    expect(merged.noTradeCount).toBe(99);
    expect(merged.scanned).toBe(102);
    expect(merged.scannedAt).toBe(live.scannedAt);
  });

  it("does not resurrect a coin the live pass scanned and rejected", () => {
    // The board keeps two entries but the pass evaluated a hundred symbols, so
    // `scannedSymbols` is the only record that ZECUSDT was looked at and turned
    // down. A persisted LONG from ten minutes ago must not override that.
    const wide = {
      ...live,
      scannedSymbols: [...live.scannedSymbols, "ZECUSDT"],
      noTradeCount: 98,
      scanned: 100,
      coverage: { onDemand: 100, persisted: 0, universe: 530 },
    };
    const merged = mergeScans(wide, [
      entry("ZECUSDT", { decision: "LONG", confidence: 91 }),
      entry("WIFUSDT", { decision: "LONG", confidence: 74 }),
    ]);

    expect(merged.long.map((e) => e.symbol)).toEqual(["BTCUSDT", "WIFUSDT"]);
    // Only the genuinely new symbol counts as worker coverage, so the total can
    // never claim more pairs than the universe holds.
    expect(merged.coverage.persisted).toBe(1);
    expect(merged.coverage.onDemand + merged.coverage.persisted).toBe(101);
    expect(merged.scanned).toBe(101);
  });

  it("preserves the partial flag from the live sweep", () => {
    const partialLive = assembleScan([entry("BTCUSDT", { decision: "LONG", confidence: 88 })], {
      ...meta,
      failed: 3,
      coverage: { onDemand: 1, persisted: 0, universe: 530 },
    });
    const merged = mergeScans(partialLive, [entry("AUSDT", { decision: "LONG", confidence: 72 })]);
    // Worker rows filling in the gaps do not make a failed live sweep complete.
    expect(merged.partial).toBe(true);
    expect(merged.failed).toBe(3);
  });
});
