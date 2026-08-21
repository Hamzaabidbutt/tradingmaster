"use client";

import { GlassCard } from "@/components/ui/primitives";
import { ANALYST_ICON, fmtMean, fmtRate, outcomeLabel } from "@/components/dashboard/shared";
import type { AnalystPerformance } from "@/services/performanceService";

/**
 * One card per analyst, each with its own metric set.
 *
 * The three analysts are not measured with the same yardstick because they are
 * not doing the same job: a breakout analyst lives and dies on false breakouts,
 * a range analyst on boundary respect, a pattern analyst on how often its
 * analogues actually repeated. `specific` carries whichever metrics that
 * analyst's own module defines.
 *
 * Abstentions and correct oppositions are shown next to the win rate on
 * purpose. Both are ways of being useful without taking a trade, and an
 * analyst judged only on the trades it took is judged on the wrong thing.
 */
export default function AnalystCards({ analysts }: { analysts: AnalystPerformance[] }) {
  return (
    <div className="grid gap-3 lg:grid-cols-3">
      {analysts.map((a) => (
        <GlassCard
          key={a.analyst}
          title={
            <span className="flex items-center gap-1.5">
              <span className="text-slate-500">{ANALYST_ICON[a.analyst]}</span>
              {a.name}
            </span>
          }
          action={
            <span
              className={`font-mono text-xs font-bold ${
                a.winRate === null ? "text-slate-500" : a.winRate >= 50 ? "text-bull" : "text-bear"
              }`}
            >
              {fmtRate(a.winRate, a.totalSignals)}
            </span>
          }
        >
          <div className="space-y-2.5 p-3">
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[11px]">
              <Row label="Signals supported" value={a.totalSignals} />
              <Row label="Wins / losses" value={`${a.wins} / ${a.losses}`} />
              <Row label="LONG" value={`${a.longWins}W ${a.longLosses}L · ${fmtRate(a.longWinRate)}`} tone="bull" />
              <Row label="SHORT" value={`${a.shortWins}W ${a.shortLosses}L · ${fmtRate(a.shortWinRate)}`} tone="bear" />
              <Row
                label="Avg return"
                value={fmtMean(a.avgReturnPct, a.totalSignals)}
                tone={a.totalSignals === 0 ? "neutral" : a.avgReturnPct >= 0 ? "bull" : "bear"}
              />
              <Row
                label="Avg win / loss"
                value={`${fmtMean(a.avgWinPct, a.wins)} / ${fmtMean(a.avgLossPct, a.losses)}`}
              />
              <Row
                label="Best timeframe"
                value={
                  a.bestTimeframe
                    ? `${a.bestTimeframe.timeframe} · ${a.bestTimeframe.winRate.toFixed(0)}% (${a.bestTimeframe.sample})`
                    : "too few per bucket"
                }
              />
              <Row
                label="Abstained"
                value={`${a.abstentions}${a.correctAbstentions ? ` · ${a.correctAbstentions} vindicated` : ""}`}
              />
              <Row label="Correctly opposed" value={a.correctlyOpposed} />
            </dl>

            {a.specific.length > 0 && (
              <div>
                <h5 className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-slate-500">
                  {a.name} specifics
                </h5>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[11px]">
                  {a.specific.map((m) => (
                    <Row key={m.label} label={m.label} value={m.value} tone={m.tone} />
                  ))}
                </dl>
              </div>
            )}

            <ReasonList title="Why it worked" rows={a.successReasons} tone="bull" />
            <ReasonList title="Why it failed" rows={a.failureReasons} tone="bear" />
          </div>
        </GlassCard>
      ))}
    </div>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: "bull" | "bear" | "neutral";
}) {
  const color = tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : "text-slate-200";
  return (
    <div className="flex flex-col">
      <dt className="text-[9px] uppercase tracking-wider text-slate-600">{label}</dt>
      <dd className={color}>{value}</dd>
    </div>
  );
}

function ReasonList({
  title,
  rows,
  tone,
}: {
  title: string;
  rows: { reason: string; label: string; count: number }[];
  tone: "bull" | "bear";
}) {
  if (rows.length === 0) return null;
  return (
    <div>
      <h5 className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-slate-500">{title}</h5>
      <ul className="space-y-0.5">
        {rows.slice(0, 4).map((r) => (
          <li key={r.reason} className="flex justify-between gap-2 text-[11px]">
            <span className="text-slate-400">{r.label || outcomeLabel(r.reason)}</span>
            <span className={`font-mono ${tone === "bull" ? "text-bull/80" : "text-bear/80"}`}>
              ×{r.count}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
