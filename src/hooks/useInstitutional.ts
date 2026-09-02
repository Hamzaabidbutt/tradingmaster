"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { InstitutionalSetup } from "@/engines/types";

/**
 * The institutional footprint for the charted symbol.
 *
 * Gated on `enabled` — the read costs three Binance calls and a full engine
 * pass, so it runs only while the overlay that draws it is switched on. Turning
 * the overlay off clears the state rather than leaving a stale footprint in
 * memory for the next symbol to briefly render.
 *
 * The interval is slow on purpose. The checklist is built from closed bars; on
 * anything above a five-minute chart it cannot change more often than the bar
 * does, and polling faster only spends rate budget to redraw the same boxes.
 */
export function useInstitutional(
  symbol: string,
  timeframe: string,
  enabled: boolean,
  intervalMs = 60_000
) {
  const [setup, setSetup] = useState<InstitutionalSetup | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/analysis/institutional?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`,
        { cache: "no-store" }
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
      setSetup(json as InstitutionalSetup);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [symbol, timeframe]);

  useEffect(() => {
    if (!enabled) {
      setSetup(null);
      setError(null);
      setLoading(false);
      return;
    }
    // Clear first: showing the previous symbol's zones over a new chart is
    // worse than showing nothing, because both look equally authoritative.
    setSetup(null);
    setLoading(true);
    load();
    timer.current = setInterval(load, intervalMs);
    return () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
    };
  }, [enabled, load, intervalMs]);

  return { setup, loading, error };
}
