"use client";

import { useEffect, useState } from "react";
import AppShell from "@/components/layout/AppShell";
import { GlassCard } from "@/components/ui/primitives";

interface StrategyRow {
  key: string;
  name: string;
  description: string;
  enabled: boolean;
  weight: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgRR: number | null;
}

export default function StrategiesPage() {
  const [strategies, setStrategies] = useState<StrategyRow[]>([]);
  const [warning, setWarning] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [authError, setAuthError] = useState(false);

  const load = async () => {
    const res = await fetch("/api/strategies", { cache: "no-store" });
    const data = await res.json();
    setStrategies(data.strategies ?? []);
    setWarning(data.warning ?? null);
  };
  useEffect(() => {
    load();
  }, []);

  const patch = async (key: string, body: { enabled?: boolean; weight?: number }) => {
    setSaving(key);
    const res = await fetch("/api/strategies", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, ...body }),
    });
    if (res.status === 401 || res.status === 403) setAuthError(true);
    await load();
    setSaving(null);
  };

  return (
    <AppShell>
      <div className="mx-auto max-w-5xl space-y-3 p-4">
        <div>
          <h1 className="text-lg font-bold">Strategy Engine</h1>
          <p className="text-xs text-slate-500">
            The AI learning engine adjusts these weights automatically after every closed trade. Win rates shown are
            <em> measured</em> from realized signals — never assumed. Manual tuning requires an ANALYST or ADMIN account.
          </p>
        </div>
        {warning && <p className="rounded-lg border border-neon-amber/30 bg-neon-amber/5 p-2 text-xs text-neon-amber">{warning}</p>}
        {authError && (
          <p className="rounded-lg border border-bear/30 bg-bear/5 p-2 text-xs text-bear">
            Sign in with an ANALYST or ADMIN account to change strategy settings.
          </p>
        )}

        <div className="grid gap-3 md:grid-cols-2">
          {strategies.map((s) => (
            <GlassCard key={s.key} className={`p-4 ${!s.enabled ? "opacity-50" : ""}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold">{s.name}</h3>
                  <p className="mt-0.5 text-[11px] text-slate-500">{s.description}</p>
                </div>
                <button
                  onClick={() => patch(s.key, { enabled: !s.enabled })}
                  disabled={saving === s.key}
                  role="switch"
                  aria-checked={s.enabled}
                  className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${s.enabled ? "bg-bull/60" : "bg-white/10"}`}
                >
                  <span
                    className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${s.enabled ? "left-4.5 left-[18px]" : "left-0.5"}`}
                  />
                </button>
              </div>

              <div className="mt-3">
                <div className="mb-1 flex justify-between font-mono text-[10px] text-slate-500">
                  <span>Weight</span>
                  <span className="text-neon-cyan">{s.weight.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={2.5}
                  step={0.05}
                  defaultValue={s.weight}
                  onMouseUp={(e) => patch(s.key, { weight: Number((e.target as HTMLInputElement).value) })}
                  onTouchEnd={(e) => patch(s.key, { weight: Number((e.target as HTMLInputElement).value) })}
                  className="w-full"
                  aria-label={`${s.name} weight`}
                />
              </div>

              <div className="mt-3 grid grid-cols-4 gap-2 text-center font-mono text-[11px]">
                <div><div className="text-slate-600">Trades</div><div className="text-slate-300">{s.totalTrades}</div></div>
                <div><div className="text-slate-600">Win rate</div><div className={s.winRate != null && s.winRate >= 50 ? "text-bull" : s.winRate != null ? "text-bear" : "text-slate-500"}>{s.winRate != null ? `${s.winRate}%` : "—"}</div></div>
                <div><div className="text-slate-600">W / L</div><div className="text-slate-300">{s.wins}/{s.losses}</div></div>
                <div><div className="text-slate-600">Avg P%</div><div className="text-slate-300">{s.avgRR ?? "—"}</div></div>
              </div>
            </GlassCard>
          ))}
        </div>
      </div>
    </AppShell>
  );
}
