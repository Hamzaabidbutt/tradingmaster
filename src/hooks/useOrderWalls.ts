"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { OrderWallResult } from "@/engines/types";
import { detectOrderWalls } from "@/engines/orderWalls";
import { fetchDepthDirect } from "@/lib/marketClient";

/**
 * Resting buy/sell walls for one symbol.
 *
 * Polled rather than streamed on purpose. The depth diff stream would give
 * tick-accurate walls, but maintaining a local order book from diffs means
 * sequence-number bookkeeping and a resync path for every dropped frame — a
 * lot of machinery for an overlay whose whole point is "roughly where is the
 * size". A snapshot every few seconds answers that with none of it.
 *
 * `enabled` short-circuits the poll entirely, so a user with both wall
 * overlays off costs nothing.
 */
export function useOrderWalls(symbol: string, enabled: boolean, intervalMs = 6000) {
  const [walls, setWalls] = useState<OrderWallResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/market/walls?symbol=${symbol}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setWalls((await res.json()) as OrderWallResult);
      setError(null);
    } catch (serverErr) {
      // The server may be geo-blocked by Binance while the browser is not.
      // Recompute from a direct snapshot rather than showing an empty overlay.
      try {
        const depth = await fetchDepthDirect(symbol, 500);
        const mid =
          depth.bids[0] && depth.asks[0] ? (depth.bids[0][0] + depth.asks[0][0]) / 2 : 0;
        setWalls(detectOrderWalls(mid, depth.bids, depth.asks));
        setError(null);
      } catch {
        setError(String(serverErr));
      }
    }
  }, [symbol]);

  useEffect(() => {
    if (!enabled) {
      setWalls(null);
      setError(null);
      return;
    }
    setWalls(null);
    load();
    timer.current = setInterval(load, intervalMs);
    return () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
    };
  }, [enabled, load, intervalMs]);

  return { walls, error, refresh: load };
}
