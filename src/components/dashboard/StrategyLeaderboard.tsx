"use client";

import { useState } from "react";
import type { SuiteResponse } from "@/app/api/backtest/suite/route";
import { GlassCard, localStamp } from "@/components/ui/primitives";
import { TIMEFRAMES } from "@/lib/config";

/**
 * Every strategy, backtested on the same bars, numbered from best to worst.
 *
 * The ordering is by success rate because that is what was asked for, but the
 * expectancy column sits next to it deliberately: a 70% win rate at 0.4R loses
 * money and a 35% win rate at 3R does not, and a leaderboard sorted on rate
 * alone will confidently put the first above the second.
 *
 * Strategies with too few trades are listed below the ranked ones, greyed and
 * unnumbered. That is the single most important thing this component does —
 * a 100%-from-four-trades row at the top of a leaderboard is how these tables
 * usually mislead.
 */
export default function StrategyLeaderboard() {
  const [timeframe, setTimeframe] = useState("1h");
  const [symbol, setSymbol] = useState("");
  const [data, setData] = useState<(SuiteResponse & { error?: string }) | null>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    setRunning(true);
    setData(null);
    try {
      const q = new URLSearchParams({ timeframe });
      if (symbol.trim()) q.set("symbol", symbol.trim().toUpperCase());
      const res = await fetch(`/api/backtest/suite?${q}`, { cache: "no-store" });
      setData(await res.json());
    } catch (err) {
      setData({ error: String(err) } as never);
    } finally {
      setRunning(false);
    }
  };

  return (
    <GlassCard
      title="Strategy Leaderboard"
      action={
        <div className="flex items-center gap-1.5">
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            placeholder="auto-pick"
            className="w-24 rounded-md border border-white/10 bg-white/5 px-2 py-1 font-mono text-[10px] text-slate-200 placeholder:text-slate-600"
            aria-label="Symbol, or blank to choose one automatically"
          />
          <select
            value={timeframe}
            onChange={(e) => setTimeframe(e.target.value)}
            className="rounded-md border border-white/10 bg-white/5 px-2 py-1 font-mono text-[10px] text-slate-200"
            aria-label="Timeframe"
          >
            {TIMEFRAMES.map((tf) => (
              <option key={tf} value={tf}>
                {tf}
              </option>
            ))}
          </select>
          <button
            onClick={run}
            disabled={running}
            className="rounded-md border border-neon-cyan/40 bg-neon-cyan/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-neon-cyan disabled:opacity-50"
          >
            {running ? "Running…" : "Rank all"}
          </button>
        </div>
      }
      className="h-full"
    >
      <div className="h-full overflow-y-auto p-3">
        {running && (
          <p className="p-4 text-center text-xs text-slate-500">
            Walking the history once and scoring every strategy from it. This is the most expensive
            thing the app does — give it up to a minute.
          </p>
        )}

        {!running && !data && (
          <p className="p-4 text-center text-xs leading-relaxed text-slate-500">
            Ranks every strategy over the same bars. Leave the symbol blank and one is chosen for
            how <em>readable</em> its chart is — enough structure and enough volatility for a
            technical strategy to have something to work with — rather than for how well it has
            performed.
          </p>
        )}

        {data?.error && (
          <p className="rounded border border-bear/25 bg-bear/5 p-3 text-[11px] text-bear/80">
            {data.error}
          </p>
        )}

        {data && !data.error && data.rows && (
          <div className="space-y-3">
            <div className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
              <div className="font-mono text-[11px] text-slate-200">
                {data.symbol} · {data.timeframe} · {data.bars} bars · {data.steps} analyses
              </div>
              <div className="mt-0.5 font-mono text-[9px] text-slate-600">
                {localStamp(data.from)} → {localStamp(data.to)}
              </div>
              {data.pick && (
                <p className="mt-1 text-[10px] leading-relaxed text-slate-400">{data.pick.reason}</p>
              )}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left">
                <thead>
                  <tr className="text-[8px] uppercase tracking-[0.12em] text-slate-600">
                    <th className="w-8 py-1">#</th>
                    <th className="py-1">Strategy</th>
                    <th className="w-16 py-1 text-right" title="Share of trades that reached the target">
                      Win %
                    </th>
                    <th
                      className="w-16 py-1 text-right"
                      title="Mean R per trade. This, not the win rate, is what compounds."
                    >
                      Exp R
                    </th>
                    <th className="w-14 py-1 text-right" title="Gross win R over gross loss R">
                      PF
                    </th>
                    <th className="w-14 py-1 text-right">Trades</th>
                    <th className="w-16 py-1 text-right" title="Worst peak-to-trough of the compounded curve">
                      Max DD
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr
                      key={r.key}
                      className={`border-t border-white/5 font-mono text-[10px] ${
                        r.rank == null ? "text-slate-600" : "text-slate-300"
                      }`}
                      title={
                        r.rank == null
                          ? `${r.trades} trades — below the floor for a rate. Listed, not ranked: a percentage from a handful of trades is not a percentage.`
                          : `${r.wins} won, ${r.losses} lost, average hold ${r.avgHoldBars} bars`
                      }
                    >
                      <td className="py-1 text-neon-cyan">{r.rank ?? "—"}</td>
                      <td className="truncate py-1 font-sans">{r.name}</td>
                      <td className="py-1 text-right">
                        {r.winRatePct == null ? "—" : `${r.winRatePct}%`}
                      </td>
                      <td
                        className={`py-1 text-right ${
                          r.expectancyR == null
                            ? ""
                            : r.expectancyR >= 0
                              ? "text-bull"
                              : "text-bear"
                        }`}
                      >
                        {r.expectancyR == null
                          ? "—"
                          : `${r.expectancyR >= 0 ? "+" : ""}${r.expectancyR}`}
                      </td>
                      <td className="py-1 text-right">{r.profitFactor ?? "—"}</td>
                      <td className="py-1 text-right text-slate-500">{r.trades}</td>
                      <td className="py-1 text-right text-slate-500">{r.maxDrawdownPct}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="text-[9px] leading-relaxed text-slate-600">{data.note}</p>
          </div>
        )}
      </div>
    </GlassCard>
  );
}
