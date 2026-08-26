"use client";

import { GlassCard, timeAgo } from "@/components/ui/primitives";
import { EmptyNote, SideBadge, fmtPct, outcomeLabel, useOpenInTerminal } from "./shared";
import { useSignals } from "@/hooks/useDashboard";
import { OutcomeAnalysis } from "@/engines/types";

/**
 * Blocks 7 and 8 — Recent Successful / Recent Failed Signals.
 *
 * One component, both outcomes, same as Top LONG/SHORT: the failure list gets
 * exactly as much space and detail as the success list. Each row carries the
 * classified reason and who was right or wrong, which is the whole point of
 * recording outcomes rather than just P/L.
 */
export default function RecentOutcomes({ outcome }: { outcome: "successful" | "failed" }) {
  const { data, loading, error } = useSignals(`outcome=${outcome}&limit=8`, 30_000);
  const open = useOpenInTerminal();
  const signals = data?.signals ?? [];
  const won = outcome === "successful";

  return (
    <GlassCard
      title={
        <span className={won ? "text-bull" : "text-bear"}>
          {won ? "Recent Successful Signals" : "Recent Failed Signals"}
        </span>
      }
      action={<span className="font-mono text-[10px] text-slate-500">{signals.length} shown</span>}
    >
      {signals.length === 0 ? (
        <EmptyNote>
          {loading
            ? "Loading…"
            : error || data?.warning
              ? `Unavailable — ${error ?? data?.warning}.`
              : `No ${won ? "winning" : "losing"} signals have resolved yet.`}
        </EmptyNote>
      ) : (
        <ul className="divide-y divide-white/5">
          {signals.map((s) => {
            const side = s.side === "BUY" ? "LONG" : "SHORT";
            const analysis = s.outcomeAnalysis as OutcomeAnalysis | null;
            return (
              <li key={s.id}>
                <button
                  onClick={() => open(s.symbol, s.timeframe)}
                  className="w-full px-3 py-2 text-left transition-colors hover:bg-white/5"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold text-slate-200">
                      {s.symbol.replace(/USDT$/, "/USDT")}
                    </span>
                    <SideBadge side={side} />
                    <span className="font-mono text-[10px] text-slate-500">{s.timeframe}</span>
                    <span
                      className={`font-mono text-xs font-bold ${
                        (s.resultPnlPct ?? 0) >= 0 ? "text-bull" : "text-bear"
                      }`}
                    >
                      {fmtPct(s.resultPnlPct)}
                    </span>
                    <span className="ml-auto font-mono text-[10px] text-slate-600">
                      {timeAgo(
                        Math.floor(new Date(s.closedAt ?? s.createdAt).getTime() / 1000)
                      )}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                    {outcomeLabel(s.outcomeReason)}
                    {analysis?.detail?.[0] ? ` — ${analysis.detail[0]}` : ""}
                  </p>
                  {analysis && (
                    <div className="mt-1 flex flex-wrap gap-x-3 font-mono text-[10px] text-slate-600">
                      {analysis.topContributor && <span>top: {analysis.topContributor}</span>}
                      {analysis.analystsRight?.length > 0 && (
                        <span className="text-bull/70">right: {analysis.analystsRight.join(", ")}</span>
                      )}
                      {analysis.analystsWrong?.length > 0 && (
                        <span className="text-bear/70">wrong: {analysis.analystsWrong.join(", ")}</span>
                      )}
                      {analysis.excursion && (
                        <span>
                          MFE {analysis.excursion.maxFavourableR.toFixed(2)}R / MAE{" "}
                          {analysis.excursion.maxAdverseR.toFixed(2)}R
                        </span>
                      )}
                      {/* Only on the failure list: on a winner this figure is
                          ≥100% by construction and says nothing. */}
                      {!won && typeof analysis.excursion?.targetProgressPct === "number" && (
                        <span className="text-neon-amber/70">
                          approached {analysis.excursion.targetProgressPct.toFixed(0)}% of TP1
                        </span>
                      )}
                    </div>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </GlassCard>
  );
}
