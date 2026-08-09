"use client";

import { useEffect, useRef, useState } from "react";
import { Candle } from "@/engines/types";
import { fetchTickersDirect } from "@/lib/marketClient";

const WS_BASE = "wss://fstream.binance.com";

/**
 * Live market feed straight from Binance futures websockets (browser-side —
 * zero backend latency). Streams the in-progress kline, live mark price and
 * real forced-liquidation orders for the selected symbol.
 */

export interface LiveKline extends Candle {
  closed: boolean;
}

export interface LiveLiquidation {
  time: number;
  side: "long" | "short"; // side that got liquidated
  price: number;
  qty: number;
  notional: number;
}

export function useLiveMarket(symbol: string, timeframe: string) {
  const [kline, setKline] = useState<LiveKline | null>(null);
  const [price, setPrice] = useState<number | null>(null);
  const [liquidations, setLiquidations] = useState<LiveLiquidation[]>([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const streams = [
      `${symbol.toLowerCase()}@kline_${timeframe}`,
      `${symbol.toLowerCase()}@markPrice@1s`,
      `${symbol.toLowerCase()}@forceOrder`,
    ].join("/");
    let closedByUs = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      const ws = new WebSocket(`${WS_BASE}/stream?streams=${streams}`);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closedByUs) retry = setTimeout(connect, 2500);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          const data = msg.data;
          if (!data) return;
          if (data.e === "kline") {
            const k = data.k;
            setKline({
              time: Math.floor(k.t / 1000),
              open: Number(k.o),
              high: Number(k.h),
              low: Number(k.l),
              close: Number(k.c),
              volume: Number(k.v),
              takerBuyVolume: Number(k.V),
              closed: Boolean(k.x),
            });
            setPrice(Number(k.c));
          } else if (data.e === "markPriceUpdate") {
            setPrice((prev) => Number(data.p) || prev);
          } else if (data.e === "forceOrder") {
            const o = data.o;
            // SELL forced order = a long got liquidated.
            const liq: LiveLiquidation = {
              time: Math.floor(o.T / 1000),
              side: o.S === "SELL" ? "long" : "short",
              price: Number(o.ap ?? o.p),
              qty: Number(o.q),
              notional: Number(o.q) * Number(o.ap ?? o.p),
            };
            setLiquidations((prev) => [liq, ...prev].slice(0, 50));
          }
        } catch {
          /* malformed frame — ignore */
        }
      };
    };

    connect();
    return () => {
      closedByUs = true;
      if (retry) clearTimeout(retry);
      wsRef.current?.close();
      setLiquidations([]);
      setKline(null);
    };
  }, [symbol, timeframe]);

  return { kline, price, liquidations, connected };
}

export interface TickerRow {
  symbol: string;
  lastPrice: number;
  priceChangePercent: number;
  quoteVolume: number;
}

/**
 * All-market mini tickers for the live market feed strip.
 *
 * Falls back to fetching Binance directly from the browser when the server
 * route fails — a server deployed in a Binance-blocked region returns 451,
 * which would otherwise leave the strip stuck on "Connecting…" forever.
 */
export function useTickers(intervalMs = 10000) {
  const [tickers, setTickers] = useState<TickerRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const res = await fetch("/api/market/ticker", { cache: "no-store" });
        const data = await res.json();
        if (!res.ok || !data.tickers?.length) throw new Error(data.error ?? `HTTP ${res.status}`);
        if (!stop) {
          setTickers(data.tickers);
          setError(null);
        }
      } catch (serverErr) {
        try {
          const direct = await fetchTickersDirect();
          if (!stop && direct.length > 0) {
            setTickers(direct);
            setError(null);
          }
        } catch {
          if (!stop) setError(String(serverErr));
        }
      }
    };
    load();
    const t = setInterval(load, intervalMs);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [intervalMs]);

  return { tickers, error };
}
