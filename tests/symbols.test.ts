import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheDelete } from "@/lib/cache";
import { MARKETS } from "@/lib/config";
import { fetchFuturesSymbols, isTradableSymbol, mapExchangeInfo, precisionFor } from "@/lib/symbols";

/** One raw exchangeInfo entry, tradable unless overridden. */
function raw(symbol: string, over: Record<string, unknown> = {}) {
  return {
    symbol,
    baseAsset: symbol.replace(/USDT$|USDC$|BUSD$/, ""),
    quoteAsset: "USDT",
    status: "TRADING",
    contractType: "PERPETUAL",
    pricePrecision: 4,
    filters: [{ filterType: "PRICE_FILTER", tickSize: "0.0100" }],
    ...over,
  };
}

/** A PRICE_FILTER carrying a given tickSize, as Binance formats it. */
function tick(tickSize: string) {
  return { filters: [{ filterType: "LOT_SIZE" }, { filterType: "PRICE_FILTER", tickSize }] };
}

/** Point `fetch` at a canned exchangeInfo response and clear the 1h cache. */
function stubExchangeInfo(body: unknown, ok = true, status = 200) {
  cacheDelete("futures:symbols");
  const fn = vi.fn(async () => ({ ok, status, json: async () => body }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  cacheDelete("futures:symbols");
});

describe("symbol universe — exchangeInfo filtering", () => {
  it("keeps only TRADING, PERPETUAL, USDT-quoted contracts", () => {
    const mapped = mapExchangeInfo([
      raw("ARBUSDT"),
      raw("SETTLINGUSDT", { status: "SETTLING" }),
      raw("PENDINGUSDT", { status: "PENDING_TRADING" }),
      raw("DELIVERUSDT", { contractType: "CURRENT_QUARTER" }),
      raw("BTCUSDC", { quoteAsset: "USDC" }),
      raw("ETHBUSD", { quoteAsset: "BUSD" }),
    ]);

    expect(mapped.map((s) => s.symbol)).toEqual(["ARBUSDT"]);
    expect(mapped[0]).toMatchObject({ base: "ARB", quote: "USDT", label: "ARB/USDT" });
  });

  it("sorts the curated pairs to the top, then alphabetically by base", () => {
    const mapped = mapExchangeInfo([
      raw("ZRXUSDT"),
      raw("SOLUSDT"),
      raw("AAVEUSDT"),
      raw("BTCUSDT"),
      raw("ARBUSDT"),
    ]);

    const featured = mapped.filter((s) => s.featured).map((s) => s.symbol);
    const rest = mapped.filter((s) => !s.featured).map((s) => s.base);

    // Every curated symbol precedes every non-curated one.
    expect(mapped.slice(0, featured.length).every((s) => s.featured)).toBe(true);
    expect(featured.sort()).toEqual(["BTCUSDT", "SOLUSDT"]);
    expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b)));
  });

  it("takes display precision from the tradable tick, not the price field width", () => {
    // Binance's own values: pricePrecision is consistently looser than the
    // tick, so rendering it would show digits price cannot move in.
    const byBase = Object.fromEntries(
      mapExchangeInfo([
        raw("BTCUSDT", { pricePrecision: 2, ...tick("0.10") }),
        raw("SOLUSDT", { pricePrecision: 4, ...tick("0.0100") }),
        raw("ARBUSDT", { pricePrecision: 6, ...tick("0.000010") }),
        // 1e-7 as a string — measuring this via Number() would read 0 decimals.
        raw("PEPEUSDT", { pricePrecision: 7, ...tick("0.0000001") }),
        raw("WHOLEUSDT", { pricePrecision: 2, ...tick("1") }),
      ]).map((s) => [s.base, s.pricePrecision])
    );

    expect(byBase).toEqual({ BTC: 1, SOL: 2, ARB: 5, PEPE: 7, WHOLE: 0 });
  });

  it("falls back to a safe precision when the exchange omits one", () => {
    const byBase = Object.fromEntries(
      mapExchangeInfo([
        // No PRICE_FILTER: fall back to the field width...
        raw("ARBUSDT", { pricePrecision: 5, filters: [] }),
        // ...and with neither, to a conservative default.
        raw("XYZUSDT", { pricePrecision: undefined, filters: undefined }),
        // An unparseable tick must not win over the field width.
        raw("ODDUSDT", { pricePrecision: 3, ...tick("1e-7") }),
      ]).map((s) => [s.base, s.pricePrecision])
    );

    expect(byBase).toEqual({ ARB: 5, XYZ: 4, ODD: 3 });
  });

  it("tolerates junk rows without throwing", () => {
    expect(mapExchangeInfo([])).toEqual([]);
    expect(mapExchangeInfo([{}, { symbol: undefined }, raw("ARBUSDT")]).map((s) => s.symbol)).toEqual([
      "ARBUSDT",
    ]);
  });
});

describe("symbol universe — fetching and caching", () => {
  it("caches the universe so repeated calls hit the exchange once", async () => {
    const fn = stubExchangeInfo({ symbols: [raw("ARBUSDT"), raw("BTCUSDT")] });

    const first = await fetchFuturesSymbols();
    const second = await fetchFuturesSymbols();

    expect(first.map((s) => s.symbol)).toEqual(["BTCUSDT", "ARBUSDT"]);
    expect(second).toEqual(first);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("degrades to an empty universe rather than throwing when Binance blocks us", async () => {
    stubExchangeInfo({}, false, 451);
    expect(await fetchFuturesSymbols()).toEqual([]);

    cacheDelete("futures:symbols");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ENOTFOUND");
      })
    );
    expect(await fetchFuturesSymbols()).toEqual([]);
  });
});

describe("symbol universe — validation", () => {
  it("accepts a live symbol and rejects one the exchange does not list", async () => {
    stubExchangeInfo({ symbols: [raw("ARBUSDT"), raw("BTCUSDT")] });

    expect(await isTradableSymbol("ARBUSDT")).toBe(true);
    expect(await isTradableSymbol("NOTREALUSDT")).toBe(false);
  });

  it("rejects malformed input before it ever reaches the network", async () => {
    const fn = stubExchangeInfo({ symbols: [raw("ARBUSDT")] });

    expect(await isTradableSymbol("")).toBe(false);
    expect(await isTradableSymbol("arbusdt")).toBe(false); // lower case
    expect(await isTradableSymbol("BTC/USDT")).toBe(false);
    expect(await isTradableSymbol("BTCUSD")).toBe(false); // not USDT-quoted
    expect(await isTradableSymbol("../../etc/passwd")).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it("lets well-formed symbols through when the universe is unavailable", async () => {
    // Refusing everything because Binance is unreachable would break the
    // terminal for the curated pairs too — let Binance itself do the rejecting.
    stubExchangeInfo({}, false, 451);

    expect(await isTradableSymbol("BTCUSDT")).toBe(true);
    expect(await isTradableSymbol("ARBUSDT")).toBe(true);
    // The format gate still applies.
    expect(await isTradableSymbol("BTC-USDT")).toBe(false);
  });
});

describe("symbol universe — price precision", () => {
  it("prefers live precision over the hardcoded curated value", async () => {
    stubExchangeInfo({
      symbols: [
        raw("BTCUSDT", { pricePrecision: 2, ...tick("0.10") }),
        raw("ARBUSDT", { pricePrecision: 6, ...tick("0.000010") }),
      ],
    });

    expect(await precisionFor("BTCUSDT")).toBe(1);
    expect(await precisionFor("ARBUSDT")).toBe(5);
  });

  it("falls back through the curated list, then to a conservative default", async () => {
    stubExchangeInfo({}, false, 451); // no live data at all

    const uni = MARKETS.find((m) => m.symbol === "UNIUSDT")!;
    expect(await precisionFor("UNIUSDT")).toBe(uni.pricePrecision);
    expect(await precisionFor("SOMETHINGUSDT")).toBe(4);
  });
});
