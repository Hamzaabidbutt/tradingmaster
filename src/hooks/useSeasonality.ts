"use client";

import { useCallback, useEffect, useState } from "react";
import type { SeasonalityReport } from "@/app/api/analysis/seasonality/route";

/**
 * Everything the clock determines for this symbol.
 *
 * Fetched once per symbol and never polled. The report is built from a year of
 * hourly bars and cached server-side for an hour; a refresh loop would spend
 * rate budget to produce an identical answer.
 */
export function useSeasonality(symbol: string, days = 365) {
  const [report, setReport] = useState<SeasonalityReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/analysis/seasonality?symbol=${encodeURIComponent(symbol)}&days=${days}`,
        { cache: "no-store" }
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
      setReport(json as SeasonalityReport);
      setError(null);
    } catch (err) {
      setReport(null);
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [symbol, days]);

  useEffect(() => {
    setReport(null);
    load();
  }, [load]);

  return { report, loading, error, reload: load };
}
