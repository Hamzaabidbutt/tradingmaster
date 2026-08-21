"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { useMarketStore } from "@/stores/marketStore";
import { isValidTimeframe } from "@/lib/config";
import { AnalystKey, AnalystVerdict, OutcomeReason } from "@/engines/types";

/**
 * Small pieces shared by the dashboard blocks.
 *
 * Kept here rather than in `ui/primitives` because these know about *this*
 * domain — setups, analysts, outcome classes — while primitives are generic.
 */

/** Scan timeframes offered on the dashboard. One klines call per coin each. */
export const SCAN_TIMEFRAMES = ["15m", "1h", "4h"] as const;
export type ScanTimeframe = (typeof SCAN_TIMEFRAMES)[number];

export const ANALYST_LABEL: Record<AnalystKey, string> = {
  chart: "Chart Analyst",
  candleClose: "Candle Close Expansion",
  range: "Range Trading",
};

export const ANALYST_ICON: Record<AnalystKey, string> = {
  chart: "▤",
  candleClose: "▮",
  range: "⇅",
};

export const OUTCOME_LABEL: Record<OutcomeReason, string> = {
  target_reached: "Target reached",
  partial_target: "Partial target",
  closed_in_profit: "Closed in profit",
  false_breakout: "False breakout",
  failed_rejection: "Failed rejection",
  range_invalidation: "Range invalidation",
  weak_candle_close: "Weak candle close",
  unexpected_reversal: "Unexpected reversal",
  expired_no_move: "Expired without moving",
  other: "Other",
};

export function outcomeLabel(reason: string | null | undefined): string {
  if (!reason) return "—";
  return OUTCOME_LABEL[reason as OutcomeReason] ?? reason.replace(/_/g, " ");
}

/**
 * Format a price without inventing precision.
 *
 * The universe spans BTC at ~$60,000 and 1000PEPE at ~$0.008, so a fixed
 * decimal count is wrong at one end or the other. Scale the decimals to the
 * magnitude instead.
 */
export function fmtPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const decimals = abs >= 1000 ? 2 : abs >= 1 ? 3 : abs >= 0.01 ? 5 : 7;
  return value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: decimals });
}

export function fmtPct(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

/** Compact volume: 1.2B / 340M / 5.6K. */
export function fmtVolume(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

/** A win rate that may be withheld for sample size — never print a fake 0%. */
export function fmtRate(rate: number | null, sample?: number): string {
  if (rate === null) return sample !== undefined ? `n/a (${sample})` : "n/a";
  return `${rate.toFixed(1)}%`;
}

/**
 * A mean over an empty set. `mean([])` is 0 in the service, but "+0.00% average
 * profit" reads as "this strategy breaks even" rather than "nothing has closed
 * yet", so the sample count decides whether the number is printed at all.
 */
export function fmtMean(value: number, sample: number, digits = 2): string {
  return sample > 0 ? fmtPct(value, digits) : "n/a";
}

/** Independence count in words. The plural of "basis" is "bases", not "basises". */
export function basesLabel(count: number): string {
  return `${count} independent ${count === 1 ? "basis" : "bases"}`;
}

/**
 * A gate reason with its "abstains — " prefix removed.
 *
 * `AnalystVerdict.gate` is written as a standalone sentence so the engine can
 * drop it straight into an explanation line. UI that has already labelled the
 * row "abstained" would otherwise say it twice.
 */
export function gateReason(gate: string): string {
  return gate.replace(/^abstains — /, "");
}

/**
 * The analysts that actually backed a stored signal's direction.
 *
 * `qualified` on its own is not agreement: an analyst can clear its quality gate
 * holding the *opposite* opinion, and a COMPOSITE signal is not gated on analyst
 * agreement at all — all three verdicts are recorded whatever they said. Listing
 * every qualified verdict as a supporter would credit a dissenting analyst with
 * the trade. This is the same test `performanceService.supported()` uses to
 * decide whose record a signal lands on, so the UI and the statistics agree.
 */
export function supportersOf(verdicts: AnalystVerdict[], side: "BUY" | "SELL"): AnalystVerdict[] {
  const want = side === "BUY" ? "long" : "short";
  return verdicts.filter((v) => v.qualified && v.direction === want);
}

/** Analysts that qualified *against* the signal's direction. Shown, not hidden. */
export function opponentsOf(verdicts: AnalystVerdict[], side: "BUY" | "SELL"): AnalystVerdict[] {
  const against = side === "BUY" ? "short" : "long";
  return verdicts.filter((v) => v.qualified && v.direction === against);
}

/**
 * Open a coin in the terminal.
 *
 * The store is persisted, so setting the symbol before routing means the
 * terminal mounts already pointed at it rather than loading the previous coin
 * and then switching — which would cost a wasted round of analysis fetches.
 */
export function useOpenInTerminal() {
  const router = useRouter();
  const setSymbol = useMarketStore((s) => s.setSymbol);
  const setTimeframe = useMarketStore((s) => s.setTimeframe);

  return useCallback(
    (symbol: string, timeframe?: string) => {
      setSymbol(symbol);
      if (timeframe && isValidTimeframe(timeframe)) setTimeframe(timeframe);
      router.push("/terminal");
    },
    [router, setSymbol, setTimeframe]
  );
}

export function SideBadge({ side }: { side: "LONG" | "SHORT" }) {
  const long = side === "LONG";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
        long ? "border-bull/30 bg-bull/10 text-bull" : "border-bear/30 bg-bear/10 text-bear"
      }`}
    >
      {long ? "▲" : "▼"} {side}
    </span>
  );
}

/** Confluence strength, in words — the same vocabulary the engine emits. */
export function ConfluenceBadge({ verdict }: { verdict: "None" | "Single" | "Partial" | "Strong" }) {
  const styles: Record<string, string> = {
    Strong: "border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan",
    Partial: "border-neon-amber/40 bg-neon-amber/10 text-neon-amber",
    Single: "border-slate-500/30 bg-slate-500/10 text-slate-400",
    None: "border-slate-600/30 bg-slate-600/10 text-slate-500",
  };
  return (
    <span
      className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${styles[verdict]}`}
    >
      {verdict} confluence
    </span>
  );
}

/** Empty / error state that says what was looked at, not just "no data". */
export function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-6 text-center text-xs leading-relaxed text-slate-500">{children}</p>;
}
