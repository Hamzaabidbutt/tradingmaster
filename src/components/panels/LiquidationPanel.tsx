"use client";

import { FullAnalysis } from "@/engines/types";
import { LiveLiquidation } from "@/hooks/useLiveMarket";
import { GlassCard, timeAgo } from "@/components/ui/primitives";

/** Aggregate liquidation intelligence + real-time forced-order tape. */
export default function LiquidationPanel({
  analysis,
  liveLiquidations,
}: {
  analysis: FullAnalysis | null;
  liveLiquidations: LiveLiquidation[];
}) {
  const liq = analysis?.liquidations;

  return (
    <GlassCard title="Liquidation Engine" className="h-full">
      {!liq ? (
        <div className="p-4 text-xs text-slate-500">Loading liquidation analysis…</div>
      ) : (
        <div className="flex h-full flex-col">
          <div className="space-y-3 p-3">
            <div className="grid grid-cols-3 gap-2 text-center">
              <Meter label="Long pressure" value={liq.longLiquidationPressure} tone="bear" />
              <Meter label="Short pressure" value={liq.shortLiquidationPressure} tone="bull" />
              <Meter label="Cascade risk" value={liq.cascadeRisk} tone="amber" />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {liq.whaleDriven && <Tag text="Whale-driven" tone="violet" />}
              {liq.likelyFakeMove && <Tag text="Likely fake move" tone="amber" />}
              <Tag text={`Reversal odds ${liq.reversalProbability}%`} tone="cyan" />
            </div>
            <ul className="space-y-1">
              {liq.summary.slice(0, 3).map((s, i) => (
                <li key={i} className="text-[10px] leading-relaxed text-slate-400">• {s}</li>
              ))}
            </ul>
          </div>

          <div className="border-t border-white/5 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            Live forced orders
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
            {liveLiquidations.length === 0 ? (
              <p className="py-3 text-center text-[10px] text-slate-600">
                Listening for liquidations on the websocket…
              </p>
            ) : (
              <table className="w-full font-mono text-[10px]">
                <tbody>
                  {liveLiquidations.slice(0, 12).map((l, i) => (
                    <tr key={`${l.time}-${i}`} className="animate-fade-in">
                      <td className={`py-0.5 font-semibold ${l.side === "long" ? "text-bear" : "text-bull"}`}>
                        {l.side === "long" ? "LONG REKT" : "SHORT REKT"}
                      </td>
                      <td className="py-0.5 text-right text-slate-300">${formatNotional(l.notional)}</td>
                      <td className="py-0.5 text-right text-slate-500">@{l.price}</td>
                      <td className="py-0.5 pl-2 text-right text-slate-600">{timeAgo(l.time)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </GlassCard>
  );
}

function Meter({ label, value, tone }: { label: string; value: number; tone: "bull" | "bear" | "amber" }) {
  const color = tone === "bull" ? "bg-bull" : tone === "bear" ? "bg-bear" : "bg-neon-amber";
  return (
    <div className="rounded-lg bg-white/[0.03] p-2">
      <div className="mb-1 font-mono text-sm font-bold text-slate-200">{value}</div>
      <div className="mb-1 h-1 w-full overflow-hidden rounded-full bg-white/5">
        <div className={`h-full rounded-full ${color} transition-all duration-700`} style={{ width: `${value}%` }} />
      </div>
      <div className="text-[9px] uppercase tracking-wider text-slate-500">{label}</div>
    </div>
  );
}

function Tag({ text, tone }: { text: string; tone: "violet" | "amber" | "cyan" }) {
  const color =
    tone === "violet" ? "border-neon-violet/30 text-neon-violet"
      : tone === "amber" ? "border-neon-amber/30 text-neon-amber"
      : "border-neon-cyan/30 text-neon-cyan";
  return <span className={`rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${color}`}>{text}</span>;
}

function formatNotional(v: number): string {
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}
