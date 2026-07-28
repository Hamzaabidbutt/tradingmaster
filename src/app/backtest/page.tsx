"use client";

import { useEffect, useState } from "react";
import AppShell from "@/components/layout/AppShell";
import { GlassCard, StatChip } from "@/components/ui/primitives";
import { MARKETS, TIMEFRAMES } from "@/lib/config";
import { BacktestMetrics } from "@/engines/types";

const STRATEGY_OPTIONS = [
  ["all", "Composite (all strategies)"],
  ["smc", "Smart Money Concepts"],
  ["ict", "ICT Model"],
  ["liquidity_sweep", "Liquidity Sweep"],
  ["order_block", "Order Block"],
  ["fvg", "Fair Value Gap"],
  ["breakout", "Breakout"],
  ["volume_expansion", "Volume Expansion"],
  ["trend_continuation", "Trend Continuation"],
  ["reversal", "Reversal"],
  ["choch", "CHOCH"],
  ["bos", "BOS Momentum"],
  ["engulfing", "Engulfing"],
  ["support_resistance", "Support/Resistance"],
  ["delta", "Delta / Order Flow"],
  ["absorption", "Absorption"],
  ["liquidation_fade", "Liquidation Fade"],
] as const;

interface SavedBacktest {
  id: string;
  symbol: string;
  timeframe: string;
  strategyKey: string;
  metrics: BacktestMetrics;
  createdAt: string;
}

export default function BacktestPage() {
  const [symbol, setSymbol] = useState("UNIUSDT");
  const [timeframe, setTimeframe] = useState("1h");
  const [strategyKey, setStrategyKey] = useState("all");
  const [bars, setBars] = useState(1500);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BacktestMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<SavedBacktest[]>([]);
  const [compare, setCompare] = useState<BacktestMetrics[]>([]);

  const loadHistory = () =>
    fetch("/api/backtest")
      .then((r) => r.json())
      .then((d) => setHistory(d.backtests ?? []))
      .catch(() => undefined);

  useEffect(() => {
    loadHistory();
  }, []);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/backtest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, timeframe, strategyKey, bars }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Backtest failed");
      setResult(data.metrics);
      loadHistory();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <AppShell>
      <div className="mx-auto max-w-6xl space-y-3 p-4">
        <h1 className="text-lg font-bold">Strategy Backtesting</h1>

        <GlassCard className="p-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs">
              <span className="mb-1 block text-slate-500">Market</span>
              <select value={symbol} onChange={(e) => setSymbol(e.target.value)} className="rounded-lg border border-white/10 bg-base-800 px-2.5 py-1.5 outline-none">
                {MARKETS.map((m) => <option key={m.symbol} value={m.symbol}>{m.label}</option>)}
              </select>
            </label>
            <label className="text-xs">
              <span className="mb-1 block text-slate-500">Timeframe</span>
              <select value={timeframe} onChange={(e) => setTimeframe(e.target.value)} className="rounded-lg border border-white/10 bg-base-800 px-2.5 py-1.5 outline-none">
                {TIMEFRAMES.map((tf) => <option key={tf} value={tf}>{tf}</option>)}
              </select>
            </label>
            <label className="text-xs">
              <span className="mb-1 block text-slate-500">Strategy</span>
              <select value={strategyKey} onChange={(e) => setStrategyKey(e.target.value)} className="rounded-lg border border-white/10 bg-base-800 px-2.5 py-1.5 outline-none">
                {STRATEGY_OPTIONS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
            </label>
            <label className="text-xs">
              <span className="mb-1 block text-slate-500">History (bars)</span>
              <input
                type="number" min={400} max={3000} step={100} value={bars}
                onChange={(e) => setBars(Number(e.target.value))}
                className="w-24 rounded-lg border border-white/10 bg-base-800 px-2.5 py-1.5 font-mono outline-none"
              />
            </label>
            <button
              onClick={run}
              disabled={running}
              className="rounded-lg bg-neon-cyan/15 px-4 py-1.5 text-sm font-semibold text-neon-cyan transition-colors hover:bg-neon-cyan/25 disabled:opacity-50"
            >
              {running ? "Running…" : "Run backtest"}
            </button>
          </div>
          {error && <p className="mt-2 text-xs text-bear">{error}</p>}
          <p className="mt-2 text-[10px] text-slate-600">
            Walk-forward simulation, no lookahead. Intrabar SL/TP conflicts resolve as losses (pessimistic), so
            results under-promise rather than over-promise.
          </p>
        </GlassCard>

        {result && <MetricsView m={result} />}

        {history.length > 0 && (
          <GlassCard title="Saved backtests — click to compare" className="p-0">
            <div className="max-h-72 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-base-850 text-left text-[10px] uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-4 py-2">Market</th><th>TF</th><th>Strategy</th>
                    <th className="text-right">Trades</th><th className="text-right">Win rate</th>
                    <th className="text-right">PF</th><th className="text-right">Net %</th><th className="text-right">Max DD</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {history.map((b) => (
                    <tr
                      key={b.id}
                      onClick={() => setCompare((c) => (c.some((x) => x === b.metrics) ? c.filter((x) => x !== b.metrics) : [...c, b.metrics].slice(-3)))}
                      className="cursor-pointer border-t border-white/5 hover:bg-white/[0.03]"
                    >
                      <td className="px-4 py-1.5">{b.symbol}</td>
                      <td>{b.timeframe}</td>
                      <td className="text-slate-400">{b.strategyKey}</td>
                      <td className="text-right">{b.metrics.totalTrades}</td>
                      <td className={`text-right ${b.metrics.winRate >= 50 ? "text-bull" : "text-bear"}`}>{b.metrics.winRate}%</td>
                      <td className="text-right">{b.metrics.profitFactor}</td>
                      <td className={`text-right ${b.metrics.netProfitPct >= 0 ? "text-bull" : "text-bear"}`}>{b.metrics.netProfitPct}%</td>
                      <td className="text-right text-bear">{b.metrics.maxDrawdownPct}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </GlassCard>
        )}

        {compare.length > 1 && (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {compare.map((m, i) => (
              <div key={i}><MetricsView m={m} compact /></div>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}

function MetricsView({ m, compact = false }: { m: BacktestMetrics; compact?: boolean }) {
  return (
    <GlassCard title={`${m.symbol} · ${m.timeframe} · ${m.strategyKey}`} className="p-4">
      <div className={`grid gap-2 ${compact ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-4 lg:grid-cols-6"}`}>
        <StatChip label="Trades" value={m.totalTrades} />
        <StatChip label="Win rate" value={`${m.winRate}%`} tone={m.winRate >= 50 ? "bull" : "bear"} />
        <StatChip label="Net profit" value={`${m.netProfitPct}%`} tone={m.netProfitPct >= 0 ? "bull" : "bear"} />
        <StatChip label="Profit factor" value={m.profitFactor} tone={m.profitFactor >= 1 ? "bull" : "bear"} />
        <StatChip label="Max drawdown" value={`${m.maxDrawdownPct}%`} tone="bear" />
        <StatChip label="Sharpe" value={m.sharpe} tone="cyan" />
        <StatChip label="Avg RR" value={m.avgRR} />
        <StatChip label="Gross profit" value={`${m.grossProfitPct}%`} tone="bull" />
        <StatChip label="Gross loss" value={`-${m.grossLossPct}%`} tone="bear" />
        <StatChip label="Win streak" value={m.longestWinStreak} tone="bull" />
        <StatChip label="Loss streak" value={m.longestLossStreak} tone="bear" />
        <StatChip label="Avg duration" value={`${m.avgTradeDurationMin}m`} />
      </div>

      {!compact && m.equityCurve.length > 1 && (
        <div className="mt-4">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">Equity curve (start = 100)</div>
          <EquitySparkline curve={m.equityCurve} />
        </div>
      )}

      {!compact && m.monthly.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {m.monthly.map((mo) => (
            <span
              key={mo.month}
              className={`rounded-md px-2 py-1 font-mono text-[10px] ${mo.pnlPct >= 0 ? "bg-bull/10 text-bull" : "bg-bear/10 text-bear"}`}
              title={`${mo.trades} trades`}
            >
              {mo.month}: {mo.pnlPct >= 0 ? "+" : ""}{mo.pnlPct}%
            </span>
          ))}
        </div>
      )}
    </GlassCard>
  );
}

function EquitySparkline({ curve }: { curve: { time: number; equity: number }[] }) {
  const w = 600, h = 60;
  const min = Math.min(...curve.map((p) => p.equity));
  const max = Math.max(...curve.map((p) => p.equity));
  const span = Math.max(max - min, 1e-9);
  const pts = curve.map((p, i) => `${(i / (curve.length - 1)) * w},${h - ((p.equity - min) / span) * h}`).join(" ");
  const up = curve[curve.length - 1].equity >= curve[0].equity;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-16 w-full" preserveAspectRatio="none" role="img" aria-label="Equity curve">
      <polyline points={pts} fill="none" stroke={up ? "#00e5a0" : "#ff4d6d"} strokeWidth="1.5" />
    </svg>
  );
}
