"use client";

import { GlassCard, timeAgo } from "@/components/ui/primitives";
import {
  EmptyNote,
  SideBadge,
  fmtPct,
  fmtPrice,
  opponentsOf,
  supportersOf,
  useOpenInTerminal,
} from "./shared";
import { useSignals, verdictsOf } from "@/hooks/useDashboard";

/**
 * Block 5 — Active Signals.
 *
 * `outcome=active` covers ACTIVE, TP1_HIT and TP2_HIT: a signal that has tagged
 * a partial target is still running, and showing it as closed would book an
 * in-progress winner before it finished.
 */
export default function ActiveSignalsCard() {
  const { data, loading, error } = useSignals("outcome=active&limit=10", 20_000);
  const open = useOpenInTerminal();
  const signals = data?.signals ?? [];

  return (
    <GlassCard
      title="Active Signals"
      action={
        <span className="font-mono text-[10px] text-slate-500">
          {signals.length} open
          {data?.warning ? " · db unavailable" : ""}
        </span>
      }
    >
      {signals.length === 0 ? (
        <EmptyNote>
          {loading
            ? "Loading open signals…"
            : error || data?.warning
              ? `Signals unavailable — ${error ?? data?.warning}.`
              : "No signals are open. Nothing qualified, or the last ones have all resolved."}
        </EmptyNote>
      ) : (
        <ul className="divide-y divide-white/5">
          {signals.map((s) => {
            const side = s.side === "BUY" ? "LONG" : "SHORT";
            const supporters = supportersOf(verdictsOf(s.analystVerdicts), s.side);
            const opponents = opponentsOf(verdictsOf(s.analystVerdicts), s.side);
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
                    <span className="font-mono text-[11px] text-neon-cyan">
                      {s.confidence.toFixed(0)}%
                    </span>
                    <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-slate-400">
                      {s.status.replace(/_/g, " ")}
                    </span>
                    <span className="ml-auto font-mono text-[10px] text-slate-600">
                      {timeAgo(Math.floor(new Date(s.createdAt).getTime() / 1000))}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 font-mono text-[10px] text-slate-500">
                    <span>entry {fmtPrice(s.entry)}</span>
                    <span className="text-bear/80">sl {fmtPrice(s.stopLoss)}</span>
                    <span className="text-bull/80">tp {fmtPrice(s.tp1)}</span>
                    <span>rr {s.riskReward.toFixed(2)}</span>
                    {s.resultPnlPct !== null && (
                      <span className={s.resultPnlPct >= 0 ? "text-bull" : "text-bear"}>
                        {fmtPct(s.resultPnlPct)}
                      </span>
                    )}
                  </div>
                  {(supporters.length > 0 || opponents.length > 0) && (
                    <div className="mt-1 text-[10px] text-slate-600">
                      {supporters.length > 0 && `backed by ${supporters.map((v) => v.name).join(", ")}`}
                      {opponents.length > 0 && (
                        <span className="text-neon-amber/70">
                          {supporters.length > 0 ? " · " : ""}
                          opposed by {opponents.map((v) => v.name).join(", ")}
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
