"use client";

import { FullAnalysis } from "@/engines/types";
import { GlassCard, Gauge } from "@/components/ui/primitives";

/** Order flow: pressure gauges, delta bars, CVD sparkline, absorption/exhaustion flags. */
export default function OrderFlowPanel({ analysis }: { analysis: FullAnalysis | null }) {
  const of = analysis?.orderFlow;
  const vol = analysis?.volume;

  return (
    <GlassCard title="Order Flow" className="h-full">
      {!of || !vol ? (
        <div className="p-4 text-xs text-slate-500">Loading order flow…</div>
      ) : (
        <div className="space-y-3 p-3">
          <div className="grid grid-cols-2 gap-2">
            <Gauge value={of.buyPressure} label="Buy pressure" tone="bull" />
            <Gauge value={of.sellPressure} label="Sell pressure" tone="bear" />
          </div>

          {/* Delta bars (last 30) */}
          <div>
            <div className="mb-1 flex justify-between text-[10px] text-slate-500">
              <span>Delta per bar</span>
              <span className={`font-mono ${of.cumulativeDelta >= 0 ? "text-bull" : "text-bear"}`}>
                CVD {of.cumulativeDelta >= 0 ? "+" : ""}{formatNum(of.cumulativeDelta)}
              </span>
            </div>
            <div className="flex h-10 items-center gap-[2px]" aria-label="Delta histogram">
              {of.deltaSeries.map((d, i) => {
                const max = Math.max(...of.deltaSeries.map((x) => Math.abs(x.value)), 1);
                const pct = (Math.abs(d.value) / max) * 100;
                return (
                  <div key={i} className="flex h-full flex-1 flex-col justify-center">
                    <div
                      className={`w-full rounded-sm ${d.value >= 0 ? "self-end bg-bull/70" : "self-start bg-bear/70"}`}
                      style={{ height: `${Math.max(4, pct * 0.45)}%` }}
                      title={`${d.value >= 0 ? "+" : ""}${d.value.toFixed(0)}`}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <div className="rounded-lg bg-white/[0.03] p-2">
              <div className="text-slate-500">Buying vol (bar)</div>
              <div className="font-mono font-semibold text-bull">{formatNum(vol.buyingVolume)}</div>
            </div>
            <div className="rounded-lg bg-white/[0.03] p-2">
              <div className="text-slate-500">Selling vol (bar)</div>
              <div className="font-mono font-semibold text-bear">{formatNum(vol.sellingVolume)}</div>
            </div>
            <div className="rounded-lg bg-white/[0.03] p-2">
              <div className="text-slate-500">Relative volume</div>
              <div className={`font-mono font-semibold ${vol.relative > 1.5 ? "text-neon-amber" : "text-slate-200"}`}>
                {vol.relative.toFixed(2)}×
              </div>
            </div>
            <div className="rounded-lg bg-white/[0.03] p-2">
              <div className="text-slate-500">Aggression</div>
              <div className={`font-mono font-semibold capitalize ${of.aggression === "buyers" ? "text-bull" : of.aggression === "sellers" ? "text-bear" : "text-slate-200"}`}>
                {of.aggression}
              </div>
            </div>
          </div>

          {(of.absorption.present || of.exhaustion.present || vol.climax || vol.divergence) && (
            <div className="space-y-1.5">
              {of.absorption.present && <Flag tone="cyan" label="Absorption" text={of.absorption.note} />}
              {of.exhaustion.present && <Flag tone="amber" label="Exhaustion" text={of.exhaustion.note} />}
              {vol.climax && <Flag tone="amber" label="Volume climax" text="Extreme volume on extreme range — potential turning point." />}
              {vol.divergence && (
                <Flag
                  tone={vol.divergence === "bullish" ? "bull" : "bear"}
                  label={`${vol.divergence} divergence`}
                  text="Price extending while volume fades — move losing sponsorship."
                />
              )}
            </div>
          )}
        </div>
      )}
    </GlassCard>
  );
}

function Flag({ tone, label, text }: { tone: "bull" | "bear" | "cyan" | "amber"; label: string; text: string }) {
  const color =
    tone === "bull" ? "border-bull/30 text-bull" : tone === "bear" ? "border-bear/30 text-bear"
      : tone === "amber" ? "border-neon-amber/30 text-neon-amber" : "border-neon-cyan/30 text-neon-cyan";
  return (
    <div className={`rounded-lg border bg-white/[0.02] p-2 ${color}`}>
      <span className="text-[10px] font-bold uppercase tracking-wider">{label}</span>
      <p className="mt-0.5 text-[10px] leading-relaxed text-slate-400">{text}</p>
    </div>
  );
}

function formatNum(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}
