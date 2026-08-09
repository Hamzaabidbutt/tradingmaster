import { Candle } from "@/engines/types";
import { cacheGet, cacheSet } from "./cache";
import { logger } from "./logger";

const FAPI = process.env.BINANCE_FAPI_BASE ?? "https://fapi.binance.com";

interface RawKline extends Array<string | number> {}

/**
 * Fetch USDT-M futures klines. Public endpoint, no API key required.
 * Cached briefly to protect against burst traffic / Binance rate limits.
 */
export async function fetchKlines(
  symbol: string,
  interval: string,
  limit = 500,
  endTime?: number
): Promise<Candle[]> {
  const cacheKey = `klines:${symbol}:${interval}:${limit}:${endTime ?? "latest"}`;
  const cached = cacheGet<Candle[]>(cacheKey);
  if (cached) return cached;

  const params = new URLSearchParams({
    symbol,
    interval,
    limit: String(Math.min(limit, 1500)),
  });
  if (endTime) params.set("endTime", String(endTime));

  const url = `${FAPI}/fapi/v1/klines?${params.toString()}`;
  const res = await fetch(url, { next: { revalidate: 0 }, cache: "no-store" });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    logger.error("binance.klines.failed", { symbol, interval, status: res.status, detail: detail.slice(0, 200) });
    throw new Error(
      res.status === 451 || res.status === 403
        ? `Binance blocked this server (HTTP ${res.status}). The deployment region is geo-restricted — move it to a permitted region (see vercel.json) or set BINANCE_FAPI_BASE to a reachable mirror.`
        : `Binance klines request failed: ${res.status}`
    );
  }
  const raw = (await res.json()) as RawKline[];

  const candles: Candle[] = raw.map((k) => ({
    time: Math.floor(Number(k[0]) / 1000),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    trades: Number(k[8]),
    takerBuyVolume: Number(k[9]),
  }));

  // Short TTL: candles change every tick but engines tolerate ~5s staleness.
  cacheSet(cacheKey, candles, 5_000);
  return candles;
}

/** Fetch extended history by paging backwards. Used by backtests. */
export async function fetchKlinesPaged(
  symbol: string,
  interval: string,
  totalBars: number
): Promise<Candle[]> {
  const out: Candle[] = [];
  let endTime: number | undefined = undefined;
  while (out.length < totalBars) {
    const batch = Math.min(1500, totalBars - out.length);
    const candles = await fetchKlines(symbol, interval, batch, endTime);
    if (candles.length === 0) break;
    out.unshift(...candles);
    endTime = candles[0].time * 1000 - 1;
    if (candles.length < batch) break;
  }
  return out;
}

export interface TickerSnapshot {
  symbol: string;
  lastPrice: number;
  priceChangePercent: number;
  highPrice: number;
  lowPrice: number;
  volume: number;
  quoteVolume: number;
}

export async function fetchTicker(symbol: string): Promise<TickerSnapshot> {
  const cacheKey = `ticker:${symbol}`;
  const cached = cacheGet<TickerSnapshot>(cacheKey);
  if (cached) return cached;

  const res = await fetch(`${FAPI}/fapi/v1/ticker/24hr?symbol=${symbol}`, {
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(
      res.status === 451 || res.status === 403
        ? `Binance blocked this server (HTTP ${res.status}) — the deployment region is geo-restricted.`
        : `Binance ticker request failed: ${res.status}`
    );
  }
  const t = await res.json();
  const snap: TickerSnapshot = {
    symbol,
    lastPrice: Number(t.lastPrice),
    priceChangePercent: Number(t.priceChangePercent),
    highPrice: Number(t.highPrice),
    lowPrice: Number(t.lowPrice),
    volume: Number(t.volume),
    quoteVolume: Number(t.quoteVolume),
  };
  cacheSet(cacheKey, snap, 3_000);
  return snap;
}

export interface DepthSnapshot {
  bids: [number, number][];
  asks: [number, number][];
  bidVolume: number;
  askVolume: number;
  imbalance: number; // -1..1, positive = bid heavy
}

export async function fetchDepth(symbol: string, limit = 100): Promise<DepthSnapshot> {
  const cacheKey = `depth:${symbol}:${limit}`;
  const cached = cacheGet<DepthSnapshot>(cacheKey);
  if (cached) return cached;

  const res = await fetch(`${FAPI}/fapi/v1/depth?symbol=${symbol}&limit=${limit}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Binance depth request failed: ${res.status}`);
  const d = await res.json();
  const bids: [number, number][] = d.bids.map((b: string[]) => [Number(b[0]), Number(b[1])]);
  const asks: [number, number][] = d.asks.map((a: string[]) => [Number(a[0]), Number(a[1])]);
  const bidVolume = bids.reduce((s, b) => s + b[1], 0);
  const askVolume = asks.reduce((s, a) => s + a[1], 0);
  const snap: DepthSnapshot = {
    bids,
    asks,
    bidVolume,
    askVolume,
    imbalance: bidVolume + askVolume > 0 ? (bidVolume - askVolume) / (bidVolume + askVolume) : 0,
  };
  cacheSet(cacheKey, snap, 2_000);
  return snap;
}

export interface OpenInterestPoint {
  time: number;
  openInterest: number;
}

export async function fetchOpenInterestHist(
  symbol: string,
  period: "5m" | "15m" | "30m" | "1h" | "4h" | "1d" = "5m",
  limit = 48
): Promise<OpenInterestPoint[]> {
  const cacheKey = `oi:${symbol}:${period}:${limit}`;
  const cached = cacheGet<OpenInterestPoint[]>(cacheKey);
  if (cached) return cached;
  try {
    const res = await fetch(
      `${FAPI}/futures/data/openInterestHist?symbol=${symbol}&period=${period}&limit=${limit}`,
      { cache: "no-store" }
    );
    if (!res.ok) return [];
    const raw = await res.json();
    const points: OpenInterestPoint[] = raw.map((p: any) => ({
      time: Math.floor(Number(p.timestamp) / 1000),
      openInterest: Number(p.sumOpenInterest),
    }));
    cacheSet(cacheKey, points, 30_000);
    return points;
  } catch {
    return [];
  }
}
