"use client";

import { Candle } from "@/engines/types";
import { MARKETS } from "./config";

/**
 * Browser-side Binance fallback.
 *
 * Binance geo-blocks a number of datacentre regions (US IPs get HTTP 451),
 * so a server deployed there cannot fetch market data even though the
 * user's own browser can — which is exactly why the websocket connects
 * while the REST-backed panels stay empty.
 *
 * These helpers let the UI fall back to fetching public market data
 * directly from Binance using the visitor's own connection. Binance sends
 * `Access-Control-Allow-Origin: *` on its public market endpoints, so this
 * works from the browser without a proxy.
 *
 * Only raw market data can be recovered this way. The full analysis is
 * computed server-side, so if the server is geo-blocked the fix is to move
 * it to a permitted region (see vercel.json).
 */

const FAPI = "https://fapi.binance.com";

export async function fetchKlinesDirect(
  symbol: string,
  interval: string,
  limit = 400
): Promise<Candle[]> {
  const res = await fetch(
    `${FAPI}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    { cache: "no-store" }
  );
  if (!res.ok) throw new Error(`Binance klines ${res.status}`);
  const raw = (await res.json()) as (string | number)[][];
  return raw.map((k) => ({
    time: Math.floor(Number(k[0]) / 1000),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    trades: Number(k[8]),
    takerBuyVolume: Number(k[9]),
  }));
}

export interface DirectTicker {
  symbol: string;
  lastPrice: number;
  priceChangePercent: number;
  quoteVolume: number;
}

export async function fetchTickersDirect(): Promise<DirectTicker[]> {
  const res = await fetch(`${FAPI}/fapi/v1/ticker/24hr`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Binance ticker ${res.status}`);
  const all = (await res.json()) as Record<string, string>[];
  const wanted = new Set(MARKETS.map((m) => m.symbol));
  return all
    .filter((t) => wanted.has(t.symbol))
    .map((t) => ({
      symbol: t.symbol,
      lastPrice: Number(t.lastPrice),
      priceChangePercent: Number(t.priceChangePercent),
      quoteVolume: Number(t.quoteVolume),
    }));
}

export interface DirectDepth {
  bids: [number, number][];
  asks: [number, number][];
}

/**
 * Order book snapshot, fetched from the browser.
 *
 * The walls panel is the one place where a geo-blocked server is most
 * visible: everything else degrades to stale, but resting depth is
 * meaningless if it is not current. So the same fallback applies here.
 */
export async function fetchDepthDirect(symbol: string, limit = 500): Promise<DirectDepth> {
  const res = await fetch(`${FAPI}/fapi/v1/depth?symbol=${symbol}&limit=${limit}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Binance depth ${res.status}`);
  const d = (await res.json()) as { bids: string[][]; asks: string[][] };
  return {
    bids: d.bids.map((b) => [Number(b[0]), Number(b[1])] as [number, number]),
    asks: d.asks.map((a) => [Number(a[0]), Number(a[1])] as [number, number]),
  };
}
