"use client";

import { FullAnalysis } from "@/engines/types";
import { BiasBadge, GlassCard } from "@/components/ui/primitives";

/** Market structure + liquidity map + premium/discount read. */
export default function StructurePanel({ analysis }: { analysis: FullAnalysis | null }) {
  const st = analysis?.structure;
  const pd = analysis?.premiumDiscount;

  return (
    <GlassCard title="Market Structure & Liquidity" className="h-full">
      {!st || !analysis || !pd ? (
        <div className="p-4 text-xs text-slate-500">Mapping structure…</div>
      ) : (
        <div className="space-y-3 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <BiasBadge bias={st.trend} label={`External ${st.trend}`} />
            <BiasBadge bias={st.internalTrend} label={`Internal ${st.internalTrend}`} />
            {st.isRange && <BiasBadge bias="neutral" label="Range" />}
            <BiasBadge bias={pd.currentZone === "premium" ? "bearish" : pd.currentZone === "discount" ? "bullish" : "neutral"} label={pd.currentZone} />
          </div>

          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <div className="rounded-lg bg-white/[0.03] p-2">
              <div className="text-slate-500">Continuation</div>
              <div className="font-mono font-semibold text-bull">{st.continuationProbability}%</div>
            </div>
            <div className="rounded-lg bg-white/[0.03] p-2">
              <div className="text-slate-500">Reversal</div>
              <div className="font-mono font-semibold text-bear">{st.reversalProbability}%</div>
            </div>
          </div>

          {/* Dealing range position */}
          <div>
            <div className="mb-1 flex justify-between font-mono text-[10px] text-slate-500">
              <span>{pd.rangeLow.toFixed(4)}</span>
              <span className="text-slate-400">EQ {pd.equilibrium.toFixed(4)}</span>
              <span>{pd.rangeHigh.toFixed(4)}</span>
            </div>
            <div className="relative h-2 w-full rounded-full bg-gradient-to-r from-bull/40 via-white/10 to-bear/40">
              <div
                className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-neon-cyan bg-base-900 shadow-[0_0_8px_rgba(34,211,238,0.8)]"
                style={{ left: `${pd.positionInRange * 100}%` }}
                title={`Position in range: ${(pd.positionInRange * 100).toFixed(0)}%`}
              />
            </div>
            <div className="mt-1 flex justify-between text-[9px] uppercase tracking-wider">
              <span className="text-bull">Discount</span>
              <span className="text-bear">Premium</span>
            </div>
          </div>

          {/* Recent structure events */}
          <div className="space-y-1">
            {st.events.slice(-4).reverse().map((ev, i) => (
              <div key={i} className="flex items-center justify-between rounded-md bg-white/[0.02] px-2 py-1 font-mono text-[10px]">
                <span className={ev.type === "CHOCH" ? "font-bold text-neon-violet" : ev.direction === "bullish" ? "text-bull" : "text-bear"}>
                  {ev.scope === "internal" ? "int " : "ext "}{ev.type} {ev.direction === "bullish" ? "▲" : "▼"}
                </span>
                <span className="text-slate-500">@{ev.price.toFixed(4)}</span>
              </div>
            ))}
          </div>

          {/* Double top/bottom patterns */}
          {analysis.doublePatterns.length > 0 && (
            <div className="space-y-1.5">
              {analysis.doublePatterns.map((p, i) => (
                <div key={i} className="rounded-lg border border-neon-violet/20 bg-neon-violet/5 p-2 text-[10px]">
                  <div className="flex justify-between">
                    <span className="font-semibold capitalize text-neon-violet">{p.type.replace(/_/g, " ")}</span>
                    <span className="font-mono text-slate-400">{p.confirmed ? "CONFIRMED" : "forming"}</span>
                  </div>
                  <div className="mt-1 grid grid-cols-3 gap-1 font-mono text-slate-400">
                    <span>Neck {p.neckline.toFixed(4)}</span>
                    <span>Target {p.measuredTarget.toFixed(4)}</span>
                    <span>Break {p.breakoutProbability}%</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          <ul className="space-y-1">
            {st.summary.slice(0, 2).map((s, i) => (
              <li key={i} className="text-[10px] leading-relaxed text-slate-400">• {s}</li>
            ))}
            {analysis.liquidity.summary.slice(0, 2).map((s, i) => (
              <li key={`l${i}`} className="text-[10px] leading-relaxed text-slate-400">• {s}</li>
            ))}
          </ul>
        </div>
      )}
    </GlassCard>
  );
}
