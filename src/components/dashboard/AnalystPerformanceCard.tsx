"use client";

import { GlassCard } from "@/components/ui/primitives";
import { ANALYST_ICON, EmptyNote, fmtMean, fmtRate, outcomeLabel } from "./shared";
import { usePerformance } from "@/hooks/useDashboard";

/**
 * Block 6 — Analyst Performance.
 *
 * A compact version of the per-analyst cards on Signal History: enough to see
 * which analyst is currently carrying the system, with a link through to the
 * full breakdown.
 *
 * A withheld win rate reads "n/a (4)" rather than "0%". A 0% from four signals
 * is not a record, and printing one would slander an analyst that simply has
 * not traded much yet.
 */
export default function AnalystPerformanceCard() {
  const { data, loading, error } = usePerformance();

  return (
    <GlassCard
      title="Analyst Performance"
      action={
        data ? (
          <span className="font-mono text-[10px] text-slate-500">
            {data.attributedSignals} attributed
            {data.legacySignals > 0 && ` · ${data.legacySignals} legacy`}
          </span>
        ) : null
      }
    >
      {!data ? (
        <EmptyNote>
          {loading ? "Deriving performance from closed signals…" : `Performance unavailable${error ? ` — ${error}` : ""}.`}
        </EmptyNote>
      ) : (
        <div className="space-y-2 p-3">
          {data.analysts.map((a) => (
            <div key={a.analyst} className="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-slate-500">{ANALYST_ICON[a.analyst]}</span>
                <span className="text-xs font-semibold text-slate-200">{a.name}</span>
                <span
                  className={`ml-auto font-mono text-sm font-bold ${
                    a.winRate === null
                      ? "text-slate-500"
                      : a.winRate >= 50
                        ? "text-bull"
                        : "text-bear"
                  }`}
                >
                  {fmtRate(a.winRate, a.totalSignals)}
                </span>
              </div>
              <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[10px] text-slate-500 sm:grid-cols-4">
                <span>
                  {a.totalSignals} signal{a.totalSignals === 1 ? "" : "s"}
                </span>
                <span className="text-bull/80">
                  L {a.longWins}/{a.longWins + a.longLosses} · {fmtRate(a.longWinRate)}
                </span>
                <span className="text-bear/80">
                  S {a.shortWins}/{a.shortWins + a.shortLosses} · {fmtRate(a.shortWinRate)}
                </span>
                <span
                  className={
                    a.totalSignals === 0
                      ? "text-slate-600"
                      : a.avgReturnPct >= 0
                        ? "text-bull/80"
                        : "text-bear/80"
                  }
                >
                  avg {fmtMean(a.avgReturnPct, a.totalSignals)}
                </span>
                {a.partials > 0 && (
                  <span
                    className="text-neon-amber/80"
                    title="Reached the first target, then closed at or below breakeven. Counted at half credit in weighted accuracy."
                  >
                    {a.partials} partial · wtd {a.weightedAccuracy.toFixed(0)}%
                  </span>
                )}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 text-[10px] text-slate-600">
                {a.bestTimeframe && (
                  <span>
                    best TF {a.bestTimeframe.timeframe} ({a.bestTimeframe.winRate.toFixed(0)}% of{" "}
                    {a.bestTimeframe.sample})
                  </span>
                )}
                {a.abstentions > 0 && (
                  <span>
                    {a.abstentions} abstention{a.abstentions === 1 ? "" : "s"}
                    {a.correctAbstentions > 0 && `, ${a.correctAbstentions} vindicated`}
                  </span>
                )}
                {a.correctlyOpposed > 0 && <span>{a.correctlyOpposed} correctly opposed</span>}
                {a.failureReasons[0] && (
                  <span>
                    top failure: {outcomeLabel(a.failureReasons[0].reason)} ×
                    {a.failureReasons[0].count}
                  </span>
                )}
              </div>
            </div>
          ))}

          <p className="text-[10px] leading-relaxed text-slate-600">
            Win rates are withheld below {data.minSample} attributed signals. An analyst that
            abstained is never charged a loss — see Signal History for the full per-analyst
            breakdown.
          </p>
        </div>
      )}
    </GlassCard>
  );
}
