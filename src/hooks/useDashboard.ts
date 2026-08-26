"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnalystVerdict, ConfluenceSetup } from "@/engines/types";
import type { OverviewResponse } from "@/app/api/overview/route";
import type { PerformanceReport } from "@/services/performanceService";

/**
 * Polling hooks for the market-wide dashboard.
 *
 * One hook per endpoint, and the *page* owns them rather than the cards, so a
 * scan is fetched once and shared by every block that reads from it. Cards
 * fetching their own copy would triple the sweep cost for one screen.
 *
 * Every hook keeps the last good payload while a refresh is in flight. A
 * dashboard that blanks out on each poll is unreadable, and a transient 500
 * should not wipe the board — `error` surfaces the problem alongside stale
 * data rather than instead of it.
 */

export interface ScanEntryDto {
  symbol: string;
  label: string;
  timeframe: string;
  quoteVolume: number;
  /** null when the scan row predates the column — render "—", never +0.00%. */
  priceChangePercent: number | null;
  setup: ConfluenceSetup;
}

export interface UniverseScanDto {
  timeframe: string;
  long: ScanEntryDto[];
  short: ScanEntryDto[];
  nearMisses: ScanEntryDto[];
  noTradeCount: number;
  scanned: number;
  failed: number;
  partial: boolean;
  coverage: { onDemand: number; persisted: number; universe: number };
  minConfidence: number;
  scannedAt: number;
  error?: string;
}

export interface SignalRow {
  id: string;
  symbol: string;
  timeframe: string;
  side: "BUY" | "SELL";
  source: string | null;
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp3: number;
  riskReward: number;
  confidence: number;
  confidenceLabel: string;
  status: string;
  resultPnlPct: number | null;
  outcomeReason: string | null;
  outcomeAnalysis: unknown;
  analystVerdicts: unknown;
  confluence: unknown;
  /** market conditions at signal time — shape differs by source */
  marketSnapshot: unknown;
  reasoning: unknown;
  invalidation: unknown;
  createdAt: string;
  closedAt: string | null;
  /**
   * Live progress, attached by /api/signals to still-running positions only.
   * Absent on closed signals and on any symbol whose price lookup failed.
   */
  progress?: {
    currentPrice: number;
    pnlPct: number;
    rMultiple: number;
    progressToTp1Pct: number;
    drawdownToStopPct: number;
    targets: { label: string; price: number; progressPct: number; hit: boolean; remainingPct: number }[];
    nextTarget: { label: string; price: number; remainingPct: number } | null;
    state: "in_profit" | "in_loss" | "at_entry";
    summary: string;
  };
}

/** Generic JSON poller that never discards good data for a failed refresh. */
function usePolled<T>(url: string | null, intervalMs: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    if (!url) return;
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as T);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    if (!url) return;
    setLoading(true);
    load();
    timer.current = setInterval(load, intervalMs);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [load, intervalMs, url]);

  return { data, error, loading, refresh: load };
}

/**
 * The universe scan behind High Probability Setups and Top Opportunities.
 *
 * Polled slowly on purpose: the server caches a sweep for three minutes, so a
 * faster poll would return the identical payload while costing a request. 45 s
 * keeps the "updated Ns ago" line honest without churn.
 */
export function useScan(timeframe: string, depth = 100) {
  return usePolled<UniverseScanDto>(`/api/scan?timeframe=${timeframe}&depth=${depth}`, 45_000);
}

export function useOverview() {
  return usePolled<OverviewResponse>("/api/overview", 30_000);
}

export function usePerformance() {
  return usePolled<PerformanceReport>("/api/performance", 60_000);
}

export function useSignals(query: string, intervalMs = 20_000) {
  return usePolled<{
    signals: SignalRow[];
    count: number;
    nextCursor?: string | null;
    overFetched?: boolean;
    warning?: string;
  }>(`/api/signals?${query}`, intervalMs);
}

/** Verdicts as stored — a JSON column, so it needs narrowing before use. */
export function verdictsOf(value: unknown): AnalystVerdict[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is AnalystVerdict => !!v && typeof v === "object" && "analyst" in v && "qualified" in v
  );
}

/** `reasoning` / `invalidation` are Json columns; tolerate anything. */
export function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}
