"use client";

import { useState } from "react";
import { FullAnalysis, WindowInsight } from "@/engines/types";
import { GlassCard, ProbabilityBar } from "@/components/ui/primitives";

/**
 * The same tape read across several lookbacks (3 → 15 bars).
 *
 * A single lookback is easy to fool yourself with. Seeing every horizon
 * side by side shows whether the immediate impulse agrees with the broader
 * move — and when the short windows turn against the long ones, that is an
 * early reversal tell no single window can produce.
 */
export default function MultiWindowPanel({
  analysis,
  pricePrecision,
}: {
  analysis: FullAnalysis | null;
  pricePrecision: number;
}) {
  const mw = analysis?.multiWindow;
  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <GlassCard
      title={
        <span className="flex items-center gap-2">
          Multi-Window Read
          {mw && mw.windows.length > 0 && (
            <span
              className={`rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
                mw.consensus.bias === "bullish"
                  ? "border-bull/30 text-bull"
                  : mw.consensus.bias === "bearish"
                    ? "border-bear/30 text-bear"
                    : "border-slate-500/30 text-slate-400"
              }`}
            >
              {mw.consensus.agreement}% agree
            </span>
          )}
        </span>
      }
      className="h-full"
    >
      {!mw || mw.windows.length === 0 ? (
        <div className="p-4 text-xs text-slate-500">Building multi-window read…</div>
      ) : (
        <div className="flex h-full flex-col">
          {/* Consensus header */}
          <div
            className={`border-b border-white/5 px-3 py-2.5 ${
              mw.consensus.diverging
                ? "bg-neon-amber/5"
                : mw.consensus.bias === "bullish"
                  ? "bg-bull/5"
                  : mw.consensus.bias === "bearish"
                    ? "bg-bear/5"
                    : ""
            }`}
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex gap-1">
                <Count label="bull" value={mw.consensus.bullishCount} tone="bull" />
                <Count label="bear" value={mw.consensus.bearishCount} tone="bear" />
                <Count label="flat" value={mw.consensus.neutralCount} tone="slate" />
              </div>
              {mw.consensus.diverging && (
                <span className="rounded-full border border-neon-amber/40 bg-neon-amber/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-neon-amber">
                  ⚠ diverging
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 text-[10px]">
              <HorizonChip label="Short (3–5)" bias={mw.consensus.shortTermBias} />
              <span className="text-slate-600">vs</span>
              <HorizonChip label="Long (12–15)" bias={mw.consensus.longTermBias} />
            </div>
          </div>

          {/* Per-window rows */}
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {mw.windows.map((w) => (
              <WindowRow
                key={w.bars}
                w={w}
                pricePrecision={pricePrecision}
                open={expanded === w.bars}
                onToggle={() => setExpanded(expanded === w.bars ? null : w.bars)}
              />
            ))}

            <div className="mt-2 space-y-1 border-t border-white/5 pt-2">
              {mw.consensus.summary.map((s, i) => (
                <p key={i} className="text-[10px] leading-relaxed text-slate-400">
                  • {s}
                </p>
              ))}
            </div>
          </div>
        </div>
      )}
    </GlassCard>
  );
}

function WindowRow({
  w,
  pricePrecision,
  open,
  onToggle,
}: {
  w: WindowInsight;
  pricePrecision: number;
  open: boolean;
  onToggle: () => void;
}) {
  const color =
    w.bias === "bullish" ? "text-bull" : w.bias === "bearish" ? "text-bear" : "text-slate-400";
  const barColor =
    w.bias === "bullish" ? "bg-bull" : w.bias === "bearish" ? "bg-bear" : "bg-slate-500";

  return (
    <div className="mb-1 rounded-lg bg-white/[0.02] transition-colors hover:bg-white/[0.04]">
      <button onClick={onToggle} className="w-full px-2 py-1.5 text-left" aria-expanded={open}>
        <div className="flex items-center gap-2">
          <span className="w-7 shrink-0 rounded bg-white/5 py-0.5 text-center font-mono text-[10px] font-bold text-slate-300">
            {w.bars}
          </span>

          {/* Odds bar */}
          <div className="relative h-3 flex-1 overflow-hidden rounded-full bg-white/5">
            <div
              className={`absolute inset-y-0 ${barColor} opacity-70`}
              style={
                w.bullishOdds >= 50
                  ? { left: "50%", width: `${(w.bullishOdds - 50) * 2}%` }
                  : { right: "50%", width: `${(50 - w.bullishOdds) * 2}%` }
              }
            />
            <div className="absolute inset-y-0 left-1/2 w-px bg-white/25" />
          </div>

          <span className={`w-8 shrink-0 text-right font-mono text-[10px] font-bold ${color}`}>
            {Math.max(w.bullishOdds, 100 - w.bullishOdds)}%
          </span>
          <span
            className={`w-12 shrink-0 text-right font-mono text-[10px] ${
              w.changePct >= 0 ? "text-bull" : "text-bear"
            }`}
          >
            {w.changePct >= 0 ? "+" : ""}
            {w.changePct.toFixed(2)}%
          </span>
          <span className="w-3 shrink-0 text-center text-[9px] text-slate-600">{open ? "▲" : "▼"}</span>
        </div>
      </button>

      {open && (
        <div className="animate-slide-up border-t border-white/5 px-2 py-2">
          <p className={`text-[10px] font-semibold ${color}`}>{w.headline}</p>
          <p className="mt-0.5 text-[10px] leading-relaxed text-slate-400">{w.detail}</p>
          <div className="mt-1.5 grid grid-cols-3 gap-1 font-mono text-[9px]">
            <Mini label="Buy %" value={`${w.buyPct.toFixed(0)}%`} tone={w.buyPct >= 50 ? "bull" : "bear"} />
            <Mini label="Delta" value={fmt(w.delta)} tone={w.delta >= 0 ? "bull" : "bear"} />
            <Mini label="Vol" value={`${w.volumeMultiple}×`} tone={w.volumeMultiple > 1.3 ? "amber" : "slate"} />
            <Mini label="POC" value={w.poc.toFixed(pricePrecision)} tone="slate" />
            <Mini label="Range" value={`${w.rangeMultiple}×`} tone={w.rangeMultiple > 1.8 ? "amber" : "slate"} />
            <Mini
              label="Close pos"
              value={`${(w.closePosition * 100).toFixed(0)}%`}
              tone={w.closePosition >= 0.5 ? "bull" : "bear"}
            />
          </div>
          <div className="mt-1.5">
            <ProbabilityBar bullish={w.bullishOdds} />
          </div>
        </div>
      )}
    </div>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone: "bull" | "bear" | "slate" }) {
  const color =
    tone === "bull"
      ? "bg-bull/10 text-bull"
      : tone === "bear"
        ? "bg-bear/10 text-bear"
        : "bg-white/5 text-slate-400";
  return (
    <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${color}`}>
      {value} {label}
    </span>
  );
}

function HorizonChip({ label, bias }: { label: string; bias: string }) {
  const color =
    bias === "bullish" ? "text-bull" : bias === "bearish" ? "text-bear" : "text-slate-400";
  return (
    <span className="flex items-center gap-1">
      <span className="text-slate-500">{label}</span>
      <span className={`font-semibold uppercase ${color}`}>{bias}</span>
    </span>
  );
}

function Mini({ label, value, tone }: { label: string; value: string; tone: "bull" | "bear" | "amber" | "slate" }) {
  const color =
    tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : tone === "amber" ? "text-neon-amber" : "text-slate-300";
  return (
    <div className="rounded bg-white/[0.03] px-1.5 py-1">
      <div className="text-[8px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`font-semibold ${color}`}>{value}</div>
    </div>
  );
}

function fmt(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${abs.toFixed(0)}`;
}
