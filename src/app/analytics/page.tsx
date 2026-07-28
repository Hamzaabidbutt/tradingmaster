"use client";

import { useEffect, useState } from "react";
import AppShell from "@/components/layout/AppShell";
import { GlassCard, StatChip } from "@/components/ui/primitives";

interface Bucket {
  total: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgProfit: number | null;
  avgLoss: number | null;
}

interface Analytics {
  today: Bucket | null;
  weekly: Bucket | null;
  monthly: Bucket | null;
  overall: Bucket | null;
  activeSignals: number;
  totalSignals: number;
  bestStrategy: { name: string; winRate: number; totalTrades: number } | null;
  worstStrategy: { name: string; winRate: number; totalTrades: number } | null;
  strategyAccuracy: { key: string; name: string; winRate: number; totalTrades: number; weight: number }[];
  warning?: string;
}

export default function AnalyticsPage() {
  const [data, setData] = useState<Analytics | null>(null);

  useEffect(() => {
    const load = () =>
      fetch("/api/analytics", { cache: "no-store" })
        .then((r) => r.json())
        .then(setData)
        .catch(() => undefined);
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  return (
    <AppShell>
      <div className="mx-auto max-w-5xl space-y-3 p-4">
        <div>
          <h1 className="text-lg font-bold">Performance Analytics</h1>
          <p className="text-xs text-slate-500">
            All figures are <em>measured from realized signal outcomes</em> stored in the database — the platform never
            claims fixed accuracy. Confidence in future signals derives from this live track record.
          </p>
        </div>
        {data?.warning && (
          <p className="rounded-lg border border-neon-amber/30 bg-neon-amber/5 p-2 text-xs text-neon-amber">{data.warning}</p>
        )}

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {(
            [
              ["Today", data?.today],
              ["7 days", data?.weekly],
              ["30 days", data?.monthly],
              ["All time", data?.overall],
            ] as const
          ).map(([label, b]) => (
            <GlassCard key={label} className="p-4">
              <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
              <div className={`mt-1 font-mono text-2xl font-bold ${b?.winRate == null ? "text-slate-600" : b.winRate >= 50 ? "text-bull" : "text-bear"}`}>
                {b?.winRate != null ? `${b.winRate}%` : "—"}
              </div>
              <div className="text-[10px] text-slate-500">
                {b ? `${b.wins}W / ${b.losses}L of ${b.total} closed` : "no closed signals yet"}
              </div>
              {b && b.avgProfit != null && (
                <div className="mt-2 flex gap-2 font-mono text-[10px]">
                  <span className="text-bull">avg +{b.avgProfit}%</span>
                  {b.avgLoss != null && <span className="text-bear">avg {b.avgLoss}%</span>}
                </div>
              )}
            </GlassCard>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatChip label="Active signals" value={data?.activeSignals ?? "—"} tone="cyan" />
          <StatChip label="Total signals" value={data?.totalSignals ?? "—"} />
          <StatChip label="Best strategy" value={data?.bestStrategy ? `${data.bestStrategy.name} (${data.bestStrategy.winRate}%)` : "—"} tone="bull" />
          <StatChip label="Worst strategy" value={data?.worstStrategy ? `${data.worstStrategy.name} (${data.worstStrategy.winRate}%)` : "—"} tone="bear" />
        </div>

        <GlassCard title="Strategy accuracy (measured, min 3 closed trades)" className="p-4">
          {!data || data.strategyAccuracy.length === 0 ? (
            <p className="text-xs text-slate-500">
              Not enough closed trades yet. As signals resolve, each strategy&apos;s real win rate appears here and the
              learning engine re-weights the ensemble accordingly.
            </p>
          ) : (
            <div className="space-y-2">
              {data.strategyAccuracy.map((s) => (
                <div key={s.key} className="flex items-center gap-3">
                  <span className="w-44 shrink-0 truncate text-xs text-slate-300">{s.name}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/5">
                    <div
                      className={`h-full rounded-full ${s.winRate >= 50 ? "bg-bull" : "bg-bear"}`}
                      style={{ width: `${s.winRate}%` }}
                    />
                  </div>
                  <span className={`w-12 text-right font-mono text-xs ${s.winRate >= 50 ? "text-bull" : "text-bear"}`}>{s.winRate}%</span>
                  <span className="w-16 text-right font-mono text-[10px] text-slate-500">{s.totalTrades} trades</span>
                  <span className="w-14 text-right font-mono text-[10px] text-neon-cyan">w {s.weight.toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}
        </GlassCard>
      </div>
    </AppShell>
  );
}
