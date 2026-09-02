"use client";

import { useCallback, useEffect, useState } from "react";
import { HourlyProfile } from "@/engines/hourlyProfile";

/**
 * The symbol's hour-of-day profile.
 *
 * Fetched once per symbol and never polled. The profile is built from roughly
 * two thousand bars and cached server-side for an hour; one more closing
 * candle cannot move it, so a refresh loop would spend rate budget to produce
 * an identical answer.
 */
export function useHourlyProfile(symbol: string, days = 90) {
  const [profile, setProfile] = useState<HourlyProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/analysis/hours?symbol=${encodeURIComponent(symbol)}&days=${days}`,
        { cache: "no-store" }
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
      setProfile(json as HourlyProfile);
      setError(null);
    } catch (err) {
      setProfile(null);
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [symbol, days]);

  useEffect(() => {
    setProfile(null);
    load();
  }, [load]);

  return { profile, loading, error, reload: load };
}
