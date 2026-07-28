"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FullAnalysis } from "@/engines/types";

/**
 * Polls the full-analysis endpoint. The server caches results (~5s), so
 * many clients share one computation. Insights arrive with each refresh,
 * giving the AI panel its continuously updating feed.
 */
export function useAnalysis(symbol: string, timeframe: string, intervalMs = 8000) {
  const [analysis, setAnalysis] = useState<FullAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/analysis?symbol=${symbol}&timeframe=${timeframe}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as FullAnalysis;
      setAnalysis(data);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [symbol, timeframe]);

  useEffect(() => {
    setLoading(true);
    setAnalysis(null);
    load();
    timer.current = setInterval(load, intervalMs);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [load, intervalMs]);

  return { analysis, error, loading, refresh: load };
}
