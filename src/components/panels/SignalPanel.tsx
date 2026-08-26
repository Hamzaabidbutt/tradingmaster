"use client";

import { useState } from "react";
import { FullAnalysis } from "@/engines/types";
import { GlassCard } from "@/components/ui/primitives";
import { useMarketStore } from "@/stores/marketStore";
import MarketPulse from "./MarketPulse";

/**
 * Signal panel with two views:
 *  • Setup — the active trade setup with reasoning and invalidation
 *  • Pulse — a complete conclusion of the last window (an hour by default,
 *    switchable to 15m or 5m) with directional odds, most traded prices,
 *    absorbed aggression and the institutional footprint band
 */
export default function SignalPanel({ analysis, pricePrecision }: { analysis: FullAnalysis | null; pricePrecision: number }) {
  const [tab, setTab] = useState<"reasoning" | "invalidation" | "strategies">("reasoning");
  const [view, setView] = useState<"setup" | "pulse">("pulse");
  const { pulseWindowMinutes, setPulseWindow } = useMarketStore();
  const setup = analysis?.setup;

  const fmt = (v: number) => v.toFixed(pricePrecision);

  const pulseOdds = analysis?.pulse
    ? Math.max(analysis.pulse.bullishOdds, analysis.pulse.bearishOdds)
    : null;

  // The tab label tracks the window the user actually chose — a hardcoded
  // "5-Min Pulse" would lie the moment they switched.
  const pulseLabel = pulseWindowMinutes >= 60 ? "1-Hour Pulse" : `${pulseWindowMinutes}-Min Pulse`;

  return (
    <GlassCard
      title={
        <div className="flex w-full items-center gap-1">
          {(
            [
              ["pulse", pulseLabel],
              ["setup", "Setup"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setView(k)}
              aria-pressed={view === k}
              className={`rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors ${
                view === k ? "bg-neon-cyan/15 text-neon-cyan" : "text-slate-500 hover:text-slate-300"
              }`}
            >
              {label}
              {k === "pulse" && pulseOdds != null && (
                <span
                  className={`ml-1.5 font-mono ${
                    analysis!.pulse!.bullishOdds >= analysis!.pulse!.bearishOdds ? "text-bull" : "text-bear"
                  }`}
                >
                  {pulseOdds}%
                </span>
              )}
              {k === "setup" && setup && (
                <span className={`ml-1.5 font-mono ${setup.side === "BUY" ? "text-bull" : "text-bear"}`}>
                  {setup.side}
                </span>
              )}
            </button>
          ))}
        </div>
      }
      className="h-full"
    >
      {view === "pulse" ? (
        <MarketPulse
          pulse={analysis?.pulse ?? null}
          pricePrecision={pricePrecision}
          windowMinutes={pulseWindowMinutes}
          onWindowChange={setPulseWindow}
        />
      ) : (
        <SetupView />
      )}
    </GlassCard>
  );

  function SetupView() {
    return (
      <>
        {!setup ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
          <span className="text-2xl">🎯</span>
          <p className="text-xs text-slate-400">
            No high-probability setup right now.
            {analysis && (
              <>
                <br />
                Composite confidence {Math.max(analysis.bullishProbability, analysis.bearishProbability)}% is below the
                signal threshold — the engine only fires on strong confluence.
              </>
            )}
          </p>
        </div>
      ) : (
        <div className="flex h-full flex-col">
          <div className={`px-4 py-3 ${setup.side === "BUY" ? "bg-bull/5" : "bg-bear/5"}`}>
            <div className="flex items-center justify-between">
              <span
                className={`rounded-md px-2.5 py-1 font-mono text-sm font-bold tracking-wide ${
                  setup.side === "BUY" ? "bg-bull/15 text-bull text-glow-bull" : "bg-bear/15 text-bear text-glow-bear"
                }`}
              >
                {setup.side === "BUY" ? "▲ LONG" : "▼ SHORT"}
              </span>
              <div className="text-right">
                <div className={`font-mono text-lg font-bold ${setup.side === "BUY" ? "text-bull" : "text-bear"}`}>
                  {setup.confidence}%
                </div>
                <div className="text-[10px] uppercase tracking-wider text-slate-400">{setup.confidenceLabel}</div>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 font-mono text-[11px]">
              <div><div className="text-slate-500">Entry</div><div className="font-semibold text-neon-cyan">{fmt(setup.entry)}</div></div>
              <div><div className="text-slate-500">Stop</div><div className="font-semibold text-bear">{fmt(setup.stopLoss)}</div></div>
              <div><div className="text-slate-500">RR</div><div className="font-semibold text-slate-200">1:{setup.riskReward}</div></div>
              <div><div className="text-slate-500">TP1</div><div className="text-bull">{fmt(setup.tp1)}</div></div>
              <div><div className="text-slate-500">TP2</div><div className="text-bull">{fmt(setup.tp2)}</div></div>
              <div><div className="text-slate-500">TP3</div><div className="text-bull">{fmt(setup.tp3)}</div></div>
              <div><div className="text-slate-500">Exp. move</div><div className="text-slate-200">{setup.expectedMovePct}%</div></div>
              <div className="col-span-2"><div className="text-slate-500">Est. holding</div><div className="text-slate-200">{formatDuration(setup.estHoldingMin)}</div></div>
            </div>
          </div>

          <nav className="flex border-b border-white/5 text-[10px] font-semibold uppercase tracking-wider">
            {(["reasoning", "invalidation", "strategies"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex-1 px-2 py-2 transition-colors ${
                  tab === t ? "border-b-2 border-neon-cyan text-neon-cyan" : "text-slate-500 hover:text-slate-300"
                }`}
              >
                {t === "reasoning" ? "Why" : t}
              </button>
            ))}
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {tab === "reasoning" && (
              <ul className="space-y-1.5">
                {setup.reasoning.map((r, i) => (
                  <li key={i} className="flex gap-2 text-[11px] leading-relaxed text-slate-300">
                    <span className={setup.side === "BUY" ? "text-bull" : "text-bear"}>›</span>
                    {r}
                  </li>
                ))}
              </ul>
            )}
            {tab === "invalidation" && (
              <ul className="space-y-1.5">
                {setup.invalidation.map((r, i) => (
                  <li key={i} className="flex gap-2 text-[11px] leading-relaxed text-slate-300">
                    <span className="text-neon-amber">⚠</span>
                    {r}
                  </li>
                ))}
              </ul>
            )}
            {tab === "strategies" && (
              <ul className="space-y-1.5">
                {[...setup.strategyScores]
                  .filter((s) => s.weight > 0 && Math.abs(s.score) > 1)
                  .sort((a, b) => Math.abs(b.score * b.weight) - Math.abs(a.score * a.weight))
                  .map((s) => (
                    <li key={s.key} className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="text-slate-300">{s.name}</span>
                      <span className={`font-mono font-semibold ${s.score > 0 ? "text-bull" : "text-bear"}`}>
                        {s.score > 0 ? "+" : ""}{Math.round(s.score)} × {s.weight.toFixed(2)}
                      </span>
                    </li>
                  ))}
              </ul>
            )}
          </div>
        </div>
        )}
      </>
    );
  }
}

function formatDuration(min: number): string {
  if (min < 60) return `~${min}m`;
  if (min < 1440) return `~${Math.round(min / 60)}h`;
  return `~${(min / 1440).toFixed(1)}d`;
}
