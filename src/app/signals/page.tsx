"use client";

import { useEffect, useState } from "react";
import AppShell from "@/components/layout/AppShell";
import { GlassCard } from "@/components/ui/primitives";
import { MARKETS } from "@/lib/config";

interface SignalRow {
  id: string;
  symbol: string;
  timeframe: string;
  side: "BUY" | "SELL";
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp3: number;
  riskReward: number;
  confidence: number;
  confidenceLabel: string;
  status: string;
  resultPnlPct: number | null;
  reasoning: string[];
  invalidation: string[];
  createdAt: string;
  closedAt: string | null;
}

const STATUS_STYLE: Record<string, string> = {
  ACTIVE: "bg-neon-cyan/10 text-neon-cyan border-neon-cyan/30",
  TP1_HIT: "bg-bull/10 text-bull border-bull/30",
  TP2_HIT: "bg-bull/10 text-bull border-bull/30",
  TP3_HIT: "bg-bull/15 text-bull border-bull/40",
  STOPPED: "bg-bear/10 text-bear border-bear/30",
  EXPIRED: "bg-slate-500/10 text-slate-400 border-slate-500/30",
};

export default function SignalsPage() {
  const [signals, setSignals] = useState<SignalRow[]>([]);
  const [filter, setFilter] = useState<string>("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const q = filter ? `?symbol=${filter}&limit=50` : "?limit=50";
        const res = await fetch(`/api/signals${q}`, { cache: "no-store" });
        const data = await res.json();
        setSignals(data.signals ?? []);
      } finally {
        setLoading(false);
      }
    };
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [filter]);

  return (
    <AppShell>
      <div className="mx-auto max-w-5xl space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-lg font-bold">Signal History</h1>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="rounded-lg border border-white/10 bg-base-800 px-2.5 py-1.5 text-sm outline-none"
          >
            <option value="">All markets</option>
            {MARKETS.map((m) => (
              <option key={m.symbol} value={m.symbol}>{m.label}</option>
            ))}
          </select>
        </div>

        {loading && <p className="text-sm text-slate-500">Loading signals…</p>}
        {!loading && signals.length === 0 && (
          <GlassCard className="p-8 text-center">
            <p className="text-sm text-slate-400">
              No signals recorded yet. Signals persist automatically whenever the engine finds strong confluence —
              keep the terminal running or start the background worker.
            </p>
          </GlassCard>
        )}

        {signals.map((s) => (
          <GlassCard key={s.id} className="animate-fade-in">
            <button className="w-full p-4 text-left" onClick={() => setExpanded(expanded === s.id ? null : s.id)}>
              <div className="flex flex-wrap items-center gap-3">
                <span className={`rounded-md px-2 py-0.5 font-mono text-xs font-bold ${s.side === "BUY" ? "bg-bull/15 text-bull" : "bg-bear/15 text-bear"}`}>
                  {s.side === "BUY" ? "▲ LONG" : "▼ SHORT"}
                </span>
                <span className="font-mono text-sm font-semibold">{s.symbol}</span>
                <span className="font-mono text-xs text-slate-500">{s.timeframe}</span>
                <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${STATUS_STYLE[s.status] ?? STATUS_STYLE.EXPIRED}`}>
                  {s.status.replace("_", " ")}
                </span>
                <span className="ml-auto font-mono text-xs text-slate-400">{s.confidence}% {s.confidenceLabel}</span>
                {s.resultPnlPct != null && (
                  <span className={`font-mono text-sm font-bold ${s.resultPnlPct > 0 ? "text-bull" : "text-bear"}`}>
                    {s.resultPnlPct > 0 ? "+" : ""}{s.resultPnlPct.toFixed(2)}%
                  </span>
                )}
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-[11px] text-slate-400 sm:grid-cols-6">
                <span>E {s.entry}</span>
                <span className="text-bear">SL {s.stopLoss}</span>
                <span className="text-bull">T1 {s.tp1}</span>
                <span className="text-bull">T2 {s.tp2}</span>
                <span className="text-bull">T3 {s.tp3}</span>
                <span>RR 1:{s.riskReward}</span>
              </div>
            </button>
            {expanded === s.id && (
              <div className="border-t border-white/5 p-4 text-xs">
                <h4 className="mb-1 font-semibold uppercase tracking-wider text-slate-500">Reasoning</h4>
                <ul className="mb-3 space-y-1">
                  {(s.reasoning as string[]).map((r, i) => (
                    <li key={i} className="text-slate-300">› {r}</li>
                  ))}
                </ul>
                <h4 className="mb-1 font-semibold uppercase tracking-wider text-slate-500">Invalidation</h4>
                <ul className="space-y-1">
                  {(s.invalidation as string[]).map((r, i) => (
                    <li key={i} className="text-slate-400">⚠ {r}</li>
                  ))}
                </ul>
                <p className="mt-3 font-mono text-[10px] text-slate-600">
                  Created {new Date(s.createdAt).toLocaleString()}
                  {s.closedAt && ` · Closed ${new Date(s.closedAt).toLocaleString()}`}
                </p>
              </div>
            )}
          </GlassCard>
        ))}
      </div>
    </AppShell>
  );
}
