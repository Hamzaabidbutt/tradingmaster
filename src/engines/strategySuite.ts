import { Timeframe } from "@/lib/config";
import { analyzeMarket } from "./analyzer";
import { evaluateStrategies, STRATEGIES } from "./strategies";
import { Candle } from "./types";

/**
 * Every strategy, backtested against the same bars, ranked by what happened.
 *
 * The obvious way to build this is to run the existing backtester once per
 * strategy. That is thirty full walks of the same history, each re-running the
 * entire analysis stack on every step — thousands of redundant analyses, far
 * past any serverless time limit, to answer a question that only needs one
 * walk.
 *
 * So this walks the history **once**. At each step the full analysis runs a
 * single time and every strategy is scored from it, exactly as the live
 * composite does. A strategy "signals" when its own score clears the
 * threshold, and that signal is then simulated forward.
 *
 * ## Standardised geometry, deliberately
 *
 * Individual strategies produce a directional score, not entries and stops —
 * only the composite builds those. Borrowing the composite's levels for every
 * strategy would mean each was really being judged on the composite's trade
 * management, and the ranking would say nothing about the strategies.
 *
 * So every signal here gets identical geometry: entry at the close, stop at
 * `STOP_ATR` ATR, first target at `RR` times that risk. The absolute returns
 * are therefore not what any of these strategies would make in production —
 * they are a common yardstick, and the only claim made is a *relative* one
 * about which reads were more often right.
 *
 * ## No lookahead
 *
 * The analysis at bar `i` sees `candles[0..i]` and nothing after. Fills and
 * exits are simulated on bars strictly after `i`, and a bar containing both
 * the stop and the target is resolved as a stop — the pessimistic reading,
 * so the numbers under-promise rather than over.
 */

/** Score, absolute, a strategy must reach before it counts as a signal. */
const SIGNAL_THRESHOLD = 40;
/** Stop distance in ATR. Wide enough to survive noise on most timeframes. */
const STOP_ATR = 1.5;
/** Reward-to-risk of the single target every signal is measured against. */
const RR = 2;
/** Bars a trade may stay open before it is closed at the market. */
const MAX_HOLD = 60;
/** Trades a strategy needs before any rate is quoted for it. */
const MIN_TRADES = 10;

export interface StrategyResult {
  key: string;
  name: string;
  trades: number;
  wins: number;
  losses: number;
  /** null below the trade floor — a rate from four trades is not a rate */
  winRatePct: number | null;
  /** mean R per trade; the number that compounds */
  expectancyR: number | null;
  /** gross win R over gross loss R, null when there were no losses to divide by */
  profitFactor: number | null;
  /** worst peak-to-trough of the compounded curve, percent */
  maxDrawdownPct: number;
  /** net return of the compounded curve, percent */
  netReturnPct: number;
  /** how many bars the average trade was held */
  avgHoldBars: number;
  rank: number | null;
}

export interface StrategySuiteResult {
  symbol: string;
  timeframe: string;
  bars: number;
  /** unix seconds of the first and last bar walked */
  from: number;
  to: number;
  /** analyses actually run — the cost of the sweep, stated */
  steps: number;
  rows: StrategyResult[];
  note: string;
}

interface OpenTrade {
  key: string;
  side: 1 | -1;
  entry: number;
  stop: number;
  target: number;
  openedAt: number;
}

function atrOf(candles: Candle[], period = 14): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = Math.max(1, candles.length - period); i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1].close;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev)));
  }
  return trs.length > 0 ? trs.reduce((s, v) => s + v, 0) / trs.length : 0;
}

export interface SuiteOptions {
  /** analysis window handed to the engine at each step */
  window?: number;
  /** bars between steps; higher is faster and coarser */
  step?: number;
  threshold?: number;
}

export function runStrategySuite(
  symbol: string,
  timeframe: Timeframe,
  candles: Candle[],
  opts: SuiteOptions = {}
): StrategySuiteResult {
  const window = opts.window ?? 300;
  const step = opts.step ?? 4;
  const threshold = opts.threshold ?? SIGNAL_THRESHOLD;

  const rBy = new Map<string, number[]>();
  const holdBy = new Map<string, number[]>();
  for (const s of STRATEGIES) {
    rBy.set(s.key, []);
    holdBy.set(s.key, []);
  }

  /** One open trade per strategy at a time — no pyramiding, no overlap. */
  const open = new Map<string, OpenTrade>();
  let steps = 0;

  for (let i = window; i < candles.length - 1; i++) {
    const bar = candles[i];

    /* ---- Resolve anything already open, on this bar ---- */
    for (const [key, t] of [...open.entries()]) {
      const hitStop = t.side === 1 ? bar.low <= t.stop : bar.high >= t.stop;
      const hitTarget = t.side === 1 ? bar.high >= t.target : bar.low <= t.target;
      const expired = i - t.openedAt >= MAX_HOLD;
      if (!hitStop && !hitTarget && !expired) continue;

      // Both inside one bar is unresolvable from daily data, so it is read as
      // a stop: the pessimistic choice, which keeps the numbers honest.
      const r = hitStop ? -1 : hitTarget ? RR : ((bar.close - t.entry) * t.side) / Math.abs(t.entry - t.stop);
      rBy.get(key)!.push(r);
      holdBy.get(key)!.push(i - t.openedAt);
      open.delete(key);
    }

    if ((i - window) % step !== 0) continue;

    /* ---- One analysis, every strategy scored from it ---- */
    let scores;
    try {
      // Strictly up to and including bar i. Nothing after it exists yet.
      const slice = candles.slice(i - window, i + 1);
      const analysis = analyzeMarket(symbol, timeframe, slice);
      scores = evaluateStrategies(analysis, {});
      steps++;
    } catch {
      continue;
    }

    const atr = atrOf(candles.slice(Math.max(0, i - 30), i + 1));
    if (atr <= 0) continue;

    for (const s of scores) {
      if (open.has(s.key)) continue;
      if (Math.abs(s.score) < threshold) continue;
      const side: 1 | -1 = s.score > 0 ? 1 : -1;
      const risk = atr * STOP_ATR;
      open.set(s.key, {
        key: s.key,
        side,
        entry: bar.close,
        stop: bar.close - risk * side,
        target: bar.close + risk * RR * side,
        openedAt: i,
      });
    }
  }

  const rows: StrategyResult[] = STRATEGIES.map((s) => {
    const rs = rBy.get(s.key)!;
    const holds = holdBy.get(s.key)!;
    const wins = rs.filter((r) => r > 0);
    const losses = rs.filter((r) => r <= 0);
    const grossWin = wins.reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));

    // Compounded curve at a fixed 1% of equity risked per trade, purely so
    // drawdown and net return are comparable between strategies.
    let equity = 100;
    let peak = 100;
    let maxDD = 0;
    for (const r of rs) {
      equity *= 1 + r * 0.01;
      peak = Math.max(peak, equity);
      maxDD = Math.max(maxDD, ((peak - equity) / peak) * 100);
    }

    return {
      key: s.key,
      name: s.name,
      trades: rs.length,
      wins: wins.length,
      losses: losses.length,
      winRatePct:
        rs.length >= MIN_TRADES ? Number(((wins.length / rs.length) * 100).toFixed(1)) : null,
      expectancyR:
        rs.length >= MIN_TRADES
          ? Number((rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(3))
          : null,
      profitFactor:
        rs.length >= MIN_TRADES && grossLoss > 0
          ? Number((grossWin / grossLoss).toFixed(2))
          : null,
      maxDrawdownPct: Number(maxDD.toFixed(2)),
      netReturnPct: Number((equity - 100).toFixed(2)),
      avgHoldBars:
        holds.length > 0 ? Number((holds.reduce((a, b) => a + b, 0) / holds.length).toFixed(1)) : 0,
      rank: null,
    };
  });

  /* Ranked by success rate, as asked — but only among strategies that cleared
     the trade floor. A strategy with four trades and a 100% rate is not the
     best strategy; it is four trades, and it is listed unranked below the
     ones that have actually been tested. */
  const ranked = rows
    .filter((r) => r.winRatePct != null)
    .sort((a, b) => b.winRatePct! - a.winRatePct! || (b.expectancyR ?? 0) - (a.expectancyR ?? 0));
  ranked.forEach((r, i) => {
    r.rank = i + 1;
  });
  const unranked = rows
    .filter((r) => r.winRatePct == null)
    .sort((a, b) => b.trades - a.trades);

  return {
    symbol,
    timeframe,
    bars: candles.length,
    from: candles[0]?.time ?? 0,
    to: candles[candles.length - 1]?.time ?? 0,
    steps,
    rows: [...ranked, ...unranked],
    note:
      `Every strategy walked over the same ${candles.length} bars of ${symbol} ${timeframe}, one analysis per step, ` +
      `each signal simulated on identical geometry — stop at ${STOP_ATR} ATR, target at ${RR}R, ${MAX_HOLD} bars maximum hold. ` +
      `That uniformity is what makes the ranking a statement about the reads rather than about trade management, and it also means the absolute returns are a yardstick rather than a forecast of what any strategy would earn in production. ` +
      `A bar containing both the stop and the target is resolved as a stop. Strategies with fewer than ${MIN_TRADES} trades are listed unranked, because a rate from a handful of trades is not a rate. ` +
      `One symbol over one window is one experiment: a strategy that ranks first here has ranked first on this coin, in this period, and nothing more.`,
  };
}
