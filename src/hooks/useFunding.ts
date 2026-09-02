"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FundingReport } from "@/engines/fundingRates";

/**
 * Funding and the interest-rate anchor for the charted symbol.
 *
 * Polled every half minute: the settled rates change three times a day, but
 * the live accruing rate and the mark-to-index premium move continuously, and
 * those are the two numbers a reader watches while deciding whether the
 * crowded side is getting more crowded.
 *
 * Unlike the overlay hooks this one is not gated behind a toggle — the box is
 * always on screen, so there is nothing to gate it on. It is a single cached
 * request against two endpoints.
 */
export function useFunding(symbol: string, intervalMs = 30_000) {
  const [report, setReport] = useState<FundingReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/market/funding?symbol=${encodeURIComponent(symbol)}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as FundingReport;
      setReport(json);
      setError(json.error ?? null);
    } catch (err) {
      setError(String(err));
    }
  }, [symbol]);

  useEffect(() => {
    setReport(null);
    setError(null);
    load();
    timer.current = setInterval(load, intervalMs);
    return () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
    };
  }, [load, intervalMs]);

  return { report, error };
}
