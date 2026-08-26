import { cacheGet, cacheSet } from "./cache";
import { MARKETS } from "./config";
import { logger } from "./logger";

/**
 * The live Binance USDT-M perpetual universe.
 *
 * The platform used to validate symbols against a 7-entry hardcoded list,
 * which meant the terminal could only ever look at 7 coins. This module
 * replaces that with the exchange's own answer, cached for an hour because
 * listings change on the order of days, not seconds.
 *
 * Failure is handled by degrading, never by locking the terminal: if
 * exchangeInfo is unreachable (Binance geo-blocks some regions with HTTP
 * 451), symbol validation falls back to a format check and lets Binance
 * itself reject anything genuinely invalid downstream.
 */

const FAPI = process.env.BINANCE_FAPI_BASE ?? "https://fapi.binance.com";
const CACHE_KEY = "futures:symbols";
const CACHE_TTL = 60 * 60 * 1000;
/** Shape of a symbol Binance would accept even if we can't confirm it. */
const SYMBOL_FORMAT = /^[A-Z0-9]{2,20}USDT$/;

export interface FuturesSymbol {
  symbol: string;
  base: string;
  quote: string;
  label: string;
  pricePrecision: number;
  /** true for the curated list the worker and ticker tape still use */
  featured: boolean;
}

interface RawExchangeSymbol {
  symbol?: string;
  baseAsset?: string;
  quoteAsset?: string;
  status?: string;
  contractType?: string;
  pricePrecision?: number;
  filters?: { filterType?: string; tickSize?: string }[];
}

/**
 * Display decimals implied by a PRICE_FILTER tickSize.
 *
 * `pricePrecision` is the width of the price *field*, not the granularity the
 * market actually trades in, and the two often disagree: SOLUSDT reports
 * precision 4 while ticking in 0.01, ARBUSDT reports 6 while ticking in
 * 0.00001. Rendering the field width shows digits that can never move.
 *
 * Parsed off the raw string rather than via Number, because a tickSize like
 * "0.0000001" stringifies to "1e-7" and would measure as zero decimals.
 * Anything unparseable returns null so the caller can fall back.
 */
function tickDecimals(tick: string | undefined): number | null {
  if (typeof tick !== "string") return null;
  const m = /^\d+(?:\.(\d+))?$/.exec(tick.trim());
  if (!m) return null;
  // Trailing zeros are padding, not precision: "0.0010" ticks in thousandths.
  return (m[1] ?? "").replace(/0+$/, "").length;
}

/**
 * Filter exchangeInfo down to tradable USDT perpetuals.
 *
 * Exported separately from the fetch so the filtering rules are testable
 * without touching the network.
 */
export function mapExchangeInfo(symbols: RawExchangeSymbol[]): FuturesSymbol[] {
  const featured = new Set(MARKETS.map((m) => m.symbol));
  return symbols
    .filter(
      (s) =>
        typeof s.symbol === "string" &&
        s.status === "TRADING" &&
        s.contractType === "PERPETUAL" &&
        s.quoteAsset === "USDT"
    )
    .map((s) => {
      const symbol = s.symbol as string;
      const base = s.baseAsset ?? symbol.replace(/USDT$/, "");
      const tick = tickDecimals(
        (s.filters ?? []).find((f) => f.filterType === "PRICE_FILTER")?.tickSize
      );
      return {
        symbol,
        base,
        quote: "USDT",
        label: `${base}/USDT`,
        // The tradable tick is the honest display precision; the field width
        // and a flat 4 are only there so a missing filter can't break the UI.
        pricePrecision: tick ?? (Number.isFinite(s.pricePrecision) ? (s.pricePrecision as number) : 4),
        featured: featured.has(symbol),
      };
    })
    .sort((a, b) => {
      // Curated pairs first, then alphabetical — the search box wants the
      // familiar names at the top before the user types anything.
      if (a.featured !== b.featured) return a.featured ? -1 : 1;
      return a.base.localeCompare(b.base);
    });
}

/** Every tradable USDT perpetual, cached ~1h. Empty array on failure. */
export async function fetchFuturesSymbols(): Promise<FuturesSymbol[]> {
  const cached = cacheGet<FuturesSymbol[]>(CACHE_KEY);
  if (cached) return cached;

  try {
    const res = await fetch(`${FAPI}/fapi/v1/exchangeInfo`, { cache: "no-store" });
    if (!res.ok) {
      logger.warn("binance.exchangeinfo.failed", { status: res.status });
      return [];
    }
    const data = (await res.json()) as { symbols?: RawExchangeSymbol[] };
    const mapped = mapExchangeInfo(data.symbols ?? []);
    if (mapped.length === 0) return [];
    cacheSet(CACHE_KEY, mapped, CACHE_TTL);
    return mapped;
  } catch (err) {
    logger.warn("binance.exchangeinfo.error", { error: String(err) });
    return [];
  }
}

/**
 * Is this a symbol we're willing to run analysis on?
 *
 * Consults the live universe when we have it. When we don't, a format check
 * is the honest fallback — refusing every symbol because Binance is
 * unreachable would break the terminal for the curated pairs too.
 */
export async function isTradableSymbol(symbol: string): Promise<boolean> {
  if (!symbol || !SYMBOL_FORMAT.test(symbol)) return false;
  const all = await fetchFuturesSymbols();
  if (all.length === 0) return true;
  return all.some((s) => s.symbol === symbol);
}

/**
 * Price decimals for a symbol: live precision, then the curated list, then a
 * conservative 4.
 */
export async function precisionFor(symbol: string): Promise<number> {
  const all = await fetchFuturesSymbols();
  const live = all.find((s) => s.symbol === symbol);
  if (live) return live.pricePrecision;
  return MARKETS.find((m) => m.symbol === symbol)?.pricePrecision ?? 4;
}
