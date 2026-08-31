"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { OpenInterestPoint } from "@/lib/binance";

/**
 * Open-interest history for the chart overlay.
 *
 * Polled rather than streamed: Binance publishes open interest on fixed
 * periods — five minutes at the finest — so a websocket would deliver the same
 * number over and over. The interval is deliberately slow for the same reason;
 * refreshing faster than the data changes only spends rate budget.
 *
 * Off by default at the call site, like the order-book overlays: a chart should
 * not quietly open a polling loop nobody asked for.
 */
export function useOpenInterest(
  symbol: string,
  timeframe: string,
  enabled: boolean,
  intervalMs = 60_000
) {
  const [points, setPoints] = useState<OpenInterestPoint[]>([]);
  const [period, setPeriod] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/market/openinterest?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`,
        { cache: "no-store" }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as {
        points?: OpenInterestPoint[];
        period?: string;
        error?: string;
      };
      setPoints(json.points ?? []);
      setPeriod(json.period ?? null);
      // An empty series with no error is a real answer — Binance publishes no
      // open interest for some newly listed contracts — so it is reported as
      // "nothing to draw", not as a failure.
      setError(json.error ?? null);
    } catch (err) {
      setError(String(err));
    }
  }, [symbol, timeframe]);

  useEffect(() => {
    if (!enabled) {
      setPoints([]);
      setError(null);
      return;
    }
    setPoints([]);
    load();
    timer.current = setInterval(load, intervalMs);
    return () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
    };
  }, [enabled, load, intervalMs]);

  return { openInterest: points, period, error };
}
