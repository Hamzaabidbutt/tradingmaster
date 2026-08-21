"use client";

import { GlassCard, StatChip } from "@/components/ui/primitives";
import { fmtMean, fmtRate } from "@/components/dashboard/shared";
import type { PerformanceReport, TargetProgressStat } from "@/services/performanceService";

/**
 * "How far did the losers get?" as a printable string.
 *
 * `n/a (0)` rather than `0.0%` when nothing qualifies, for the same reason
 * `fmtRate` does it: 0 % is a statement about the market and n/a is a statement
 * about the sample, and the two must not look alike. The sample is always shown
 * because this mean is drawn from a narrower set than the loss count above it —
 * legacy rows and closes with no first target carry no figure.
 */
function fmtProgress(stat: TargetProgressStat): string {
  if (stat.meanPct === null) return `n/a (${stat.sample})`;
  return `${stat.meanPct.toFixed(1)}% (${stat.sample})`;
}

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
  const prog = o.lossTargetProgress;

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

        {/*
          How close the failures came. A system whose losers die at 15% of the
          first target is making bad directional calls; one whose losers die at
          85% is making good calls with stops that are too tight — the same win
          rate, two different problems, and only this row tells them apart.
          Split LONG/SHORT so a direction-specific weakness cannot hide inside
          the average.
        */}
        <div className="grid grid-cols-3 gap-2">
          <StatChip label="Losers approached TP1" value={fmtProgress(prog.all)} tone="amber" />
          <StatChip label="LONG losers" value={fmtProgress(prog.long)} tone="amber" />
          <StatChip label="SHORT losers" value={fmtProgress(prog.short)} tone="amber" />
        </div>

        <p className="text-[10px] leading-relaxed text-slate-600">
          {o.longSignals} LONG and {o.shortSignals} SHORT signals have resolved, out of{" "}
          {o.totalSignals} recorded ({o.active} still running). Rates are withheld below{" "}
          {report.minSample} resolved signals, and no strategy is ranked best or worst until at least
          two of them clear the ranking sample. These figures evaluate the analysts — nothing here is
          readable by the engine that generates the next signal.
        </p>

        <p className="text-[10px] leading-relaxed text-slate-600">
          &ldquo;Losers approached TP1&rdquo; is the mean share of the entry→first-target distance a{" "}
          <em>failed</em> signal covered before it failed, with the sample it rests on in brackets —
          measured from entry in both directions, so LONG and SHORT are computed identically. Winners
          are excluded because they are ≥100% by construction.
          {prog.all.bestPct !== null &&
            ` The closest any single loser came was ${prog.all.bestPct.toFixed(1)}%.`}
        </p>
      </div>
    </GlassCard>
  );
}
