import { Timeframe, TIMEFRAME_MINUTES } from "@/lib/config";
import { analyzeMarket } from "./analyzer";
import { STRATEGIES } from "./strategies";
import { BacktestMetrics, BacktestTrade, Candle } from "./types";

export interface BacktestOptions {
  /** Only trade signals whose dominant contribution comes from this strategy; "all" = composite engine */
  strategyKey: string;
  minConfidence?: number;
  /** analysis window size */
  window?: number;
  /** evaluate every N bars (1 = every bar; higher = faster) */
  step?: number;
  maxHoldBars?: number;
}

/**
 * Event-driven backtester. Walks history bar by bar, re-running the full
 * analysis on a sliding window (no lookahead: entry decisions only see data
 * up to the decision bar; fills/exits are simulated on subsequent bars).
 *
 * Intrabar ambiguity (both SL and TP inside one bar) is resolved
 * pessimistically as a stop-out, so reported results under-promise.
 */
export function runBacktest(
  symbol: string,
  timeframe: Timeframe,
  candles: Candle[],
  opts: BacktestOptions
): BacktestMetrics {
  const window = opts.window ?? 300;
  const step = opts.step ?? 3;
  const minConfidence = opts.minConfidence ?? 65;
  const maxHoldBars = opts.maxHoldBars ?? 100;
  const trades: BacktestTrade[] = [];

  const weights: Record<string, { weight: number; enabled: boolean }> | undefined =
    opts.strategyKey === "all"
      ? undefined
      : ({ [opts.strategyKey]: { weight: 2.0, enabled: true } } as Record<string, { weight: number; enabled: boolean }>);

  let openUntil = 0; // bar index until which we skip new entries

  for (let i = window; i < candles.length - 2; i += step) {
    if (i < openUntil) continue;
    const slice = candles.slice(i - window, i + 1);
    let analysis;
    try {
      analysis = analyzeMarket(symbol, timeframe, slice, {
        minConfidence,
        weights: weights
          ? Object.fromEntries(
              // Isolate one strategy: zero out all others.
              ALL_KEYS.map((k) => [k, k === opts.strategyKey ? { weight: 2.0, enabled: true } : { weight: 0, enabled: false }])
            )
          : undefined,
      });
    } catch {
      continue;
    }
    const setup = analysis.setup;
    if (!setup) continue;

    // Simulate the trade forward.
    const entryBar = i + 1;
    let exit: { time: number; price: number; win: boolean; reason: string } | null = null;
    for (let j = entryBar; j < Math.min(candles.length, entryBar + maxHoldBars); j++) {
      const c = candles[j];
      if (setup.side === "BUY") {
        const hitSL = c.low <= setup.stopLoss;
        const hitTP = c.high >= setup.tp2;
        if (hitSL) { exit = { time: c.time, price: setup.stopLoss, win: false, reason: "Stop loss hit" }; break; }
        if (hitTP) { exit = { time: c.time, price: setup.tp2, win: true, reason: "TP2 reached" }; break; }
      } else {
        const hitSL = c.high >= setup.stopLoss;
        const hitTP = c.low <= setup.tp2;
        if (hitSL) { exit = { time: c.time, price: setup.stopLoss, win: false, reason: "Stop loss hit" }; break; }
        if (hitTP) { exit = { time: c.time, price: setup.tp2, win: true, reason: "TP2 reached" }; break; }
      }
    }
    if (!exit) {
      const lastBar = candles[Math.min(candles.length - 1, entryBar + maxHoldBars)];
      const pnl = setup.side === "BUY" ? lastBar.close - setup.entry : setup.entry - lastBar.close;
      exit = { time: lastBar.time, price: lastBar.close, win: pnl > 0, reason: "Time exit (max hold)" };
    }

    const direction = setup.side === "BUY" ? 1 : -1;
    const pnlPct = ((exit.price - setup.entry) / setup.entry) * 100 * direction;
    const risk = Math.abs(setup.entry - setup.stopLoss);
    trades.push({
      entryTime: candles[entryBar].time,
      exitTime: exit.time,
      side: setup.side,
      entry: setup.entry,
      exit: exit.price,
      stopLoss: setup.stopLoss,
      takeProfit: setup.tp2,
      pnlPct: Number(pnlPct.toFixed(3)),
      rr: risk > 0 ? Number((Math.abs(exit.price - setup.entry) / risk * Math.sign(pnlPct)).toFixed(2)) : 0,
      win: exit.win,
      reason: exit.reason,
    });

    // Skip forward until the trade closed.
    const exitIdx = candles.findIndex((c) => c.time === exit!.time);
    openUntil = exitIdx > 0 ? exitIdx : i + step;
  }

  return computeMetrics(symbol, timeframe, opts.strategyKey, trades);
}

/** Derived from the strategy registry so isolation can never drift out of sync. */
const ALL_KEYS = STRATEGIES.map((s) => s.key);

export function computeMetrics(
  symbol: string,
  timeframe: Timeframe,
  strategyKey: string,
  trades: BacktestTrade[]
): BacktestMetrics {
  const wins = trades.filter((t) => t.win);
  const losses = trades.filter((t) => !t.win);
  const grossProfitPct = wins.reduce((s, t) => s + Math.max(0, t.pnlPct), 0);
  const grossLossPct = Math.abs(losses.reduce((s, t) => s + Math.min(0, t.pnlPct), 0));
  const netProfitPct = grossProfitPct - grossLossPct;

  // Equity curve & max drawdown (compounded).
  let equity = 100;
  let peak = 100;
  let maxDD = 0;
  const equityCurve: { time: number; equity: number }[] = [];
  for (const t of trades) {
    equity *= 1 + t.pnlPct / 100;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, ((peak - equity) / peak) * 100);
    equityCurve.push({ time: t.exitTime, equity: Number(equity.toFixed(2)) });
  }

  // Streaks
  let winStreak = 0, lossStreak = 0, curWin = 0, curLoss = 0;
  for (const t of trades) {
    if (t.win) { curWin++; curLoss = 0; } else { curLoss++; curWin = 0; }
    winStreak = Math.max(winStreak, curWin);
    lossStreak = Math.max(lossStreak, curLoss);
  }

  // Sharpe (per-trade returns, annualization omitted deliberately — comparative metric)
  const returns = trades.map((t) => t.pnlPct);
  const mean = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const std = returns.length > 1
    ? Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1))
    : 0;
  const sharpe = std > 0 ? Number(((mean / std) * Math.sqrt(returns.length)).toFixed(2)) : 0;

  // Monthly / yearly buckets
  const monthly = new Map<string, { pnlPct: number; trades: number }>();
  const yearly = new Map<string, { pnlPct: number; trades: number }>();
  for (const t of trades) {
    const d = new Date(t.exitTime * 1000);
    const mKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const yKey = String(d.getUTCFullYear());
    const m = monthly.get(mKey) ?? { pnlPct: 0, trades: 0 };
    m.pnlPct += t.pnlPct; m.trades++;
    monthly.set(mKey, m);
    const y = yearly.get(yKey) ?? { pnlPct: 0, trades: 0 };
    y.pnlPct += t.pnlPct; y.trades++;
    yearly.set(yKey, y);
  }

  const tfMin = TIMEFRAME_MINUTES[timeframe] ?? 60;
  const avgDur = trades.length
    ? trades.reduce((s, t) => s + (t.exitTime - t.entryTime), 0) / trades.length / 60
    : 0;

  return {
    strategyKey,
    symbol,
    timeframe,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? Number(((wins.length / trades.length) * 100).toFixed(1)) : 0,
    lossRate: trades.length ? Number(((losses.length / trades.length) * 100).toFixed(1)) : 0,
    netProfitPct: Number(netProfitPct.toFixed(2)),
    grossProfitPct: Number(grossProfitPct.toFixed(2)),
    grossLossPct: Number(grossLossPct.toFixed(2)),
    profitFactor: grossLossPct > 0 ? Number((grossProfitPct / grossLossPct).toFixed(2)) : grossProfitPct > 0 ? 99 : 0,
    maxDrawdownPct: Number(maxDD.toFixed(2)),
    avgRR: trades.length ? Number((trades.reduce((s, t) => s + t.rr, 0) / trades.length).toFixed(2)) : 0,
    sharpe,
    longestWinStreak: winStreak,
    longestLossStreak: lossStreak,
    avgTradeDurationMin: Number(avgDur.toFixed(0)) || Math.round(tfMin * 2),
    monthly: [...monthly.entries()].map(([month, v]) => ({ month, pnlPct: Number(v.pnlPct.toFixed(2)), trades: v.trades })),
    yearly: [...yearly.entries()].map(([year, v]) => ({ year, pnlPct: Number(v.pnlPct.toFixed(2)), trades: v.trades })),
    equityCurve,
  };
}
