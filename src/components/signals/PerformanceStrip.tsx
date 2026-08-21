"use client";

import { GlassCard, StatChip } from "@/components/ui/primitives";
import { fmtMean, fmtRate } from "@/components/dashboard/shared";
import type { PerformanceReport } from "@/services/performanceService";

/**
 * Signal Performance Dashboard.
 *
 * Every figure here is derived from the signal rows on each request, so it
 * cannot drift from the table below it. Where a sample is too small to mean
 * anything the value is withheld rather than rounded into a claim — a 100% win
 * rate from three trades is worse than no number at all.
 */
export default function PerformanceStrip({
  report,
  loading,
  error,
}: {
  report: PerformanceReport | null;
  loading: boolean;
  error: string | null;
}) {
  if (!report) {
    return (
      <GlassCard title="Signal Performance">
        <p className="px-4 py-6 text-center text-xs text-slate-500">
          {loading ? "Deriving performance from closed signals…" : `Unavailable${error ? ` — ${error}` : ""}.`}
        </p>
      </GlassCard>
    );
  }

  const o = report.overall;
  const rateTone = (r: number | null) => (r === null ? "neutral" : r >= 50 ? "bull" : "bear");

  return (
    <GlassCard
      title="Signal Performance"
      action={
        <span className="font-mono text-[10px] text-slate-500">
          {report.attributedSignals} with analyst attribution
          {report.legacySignals > 0 && ` · ${report.legacySignals} legacy`}
        </span>
      }
    >
      <div className="space-y-2 p-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          <StatChip label="Total signals" value={o.totalSignals} />
          <StatChip label="Successful" value={o.successful} tone="bull" />
          <StatChip label="Failed" value={o.failed} tone="bear" />
          <StatChip label="Active" value={o.active} tone="cyan" />
          <StatChip label="Win rate" value={fmtRate(o.winRate)} tone={rateTone(o.winRate)} />
          <StatChip label="LONG win rate" value={fmtRate(o.longWinRate)} tone={rateTone(o.longWinRate)} />
          <StatChip label="SHORT win rate" value={fmtRate(o.shortWinRate)} tone={rateTone(o.shortWinRate)} />
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatChip
            label="Avg profit"
            value={fmtMean(o.avgProfitPct, o.successful)}
            tone={o.successful > 0 ? "bull" : "neutral"}
          />
          <StatChip
            label="Avg loss"
            value={fmtMean(o.avgLossPct, o.failed)}
            tone={o.failed > 0 ? "bear" : "neutral"}
          />
          <StatChip
            label="Best strategy"
            value={
              o.bestStrategy
                ? `${o.bestStrategy.name} · ${o.bestStrategy.winRate.toFixed(0)}%`
                : "not yet ranked"
            }
            tone={o.bestStrategy ? "bull" : "neutral"}
          />
          <StatChip
            label="Worst strategy"
            value={
              o.worstStrategy
                ? `${o.worstStrategy.name} · ${o.worstStrategy.winRate.toFixed(0)}%`
                : "not yet ranked"
            }
            tone={o.worstStrategy ? "bear" : "neutral"}
          />
        </div>

        <p className="text-[10px] leading-relaxed text-slate-600">
          {o.longSignals} LONG and {o.shortSignals} SHORT signals have resolved, out of{" "}
          {o.totalSignals} recorded ({o.active} still running). Rates are withheld below{" "}
          {report.minSample} resolved signals, and no strategy is ranked best or worst until at least
          two of them clear the ranking sample. These figures evaluate the analysts — nothing here is
          readable by the engine that generates the next signal.
        </p>
      </div>
    </GlassCard>
  );
}
