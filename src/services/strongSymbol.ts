import { fetchKlines } from "@/lib/binance";
import { Timeframe } from "@/lib/config";
import { analyzeMarketStructure } from "@/engines/marketStructure";
import { Candle } from "@/engines/types";
import { rankUniverse } from "./scanService";

/**
 * Pick a coin that is worth backtesting on.
 *
 * A strategy comparison run on a dead contract measures nothing: with no
 * structure to read, every strategy scores near zero, almost nothing signals,
 * and the ranking is decided by a handful of accidents. The point of choosing
 * a "technically strong" symbol is not to flatter the results — it is to make
 * sure the test has something to test *on*.
 *
 * ## What "technically strong" means here
 *
 * Deliberately not "went up". Strength here is about how *readable* the chart
 * is, which is what a technical strategy needs to have any chance:
 *
 *   - **Liquidity.** Thin books produce wicks that are noise rather than
 *     information, and the whole universe ranking is already ordered by it.
 *   - **Structure.** A clear trend or a clean range, not a directionless
 *     drift. Measured as the swing detector actually finding labelled swings
 *     and settling on a non-neutral trend.
 *   - **Movement worth trading.** Enough ATR relative to price that a
 *     1.5-ATR stop is not inside the spread, and not so much that every bar
 *     is a gap.
 *
 * A coin that scores well on these is one where a technical read is *possible*
 * — it says nothing about whether the coin is going up, and nothing about
 * whether the strategy that wins here wins anywhere else.
 */

/** Symbols examined from the top of the liquidity ranking. */
const CANDIDATES = 12;
/** Bars used to judge readability. */
const BARS = 300;
/** ATR as a share of price, below which the chart is too quiet to trade. */
const MIN_ATR_PCT = 0.4;
/** ...and above which it is gapping rather than trending. */
const MAX_ATR_PCT = 6;

export interface StrongSymbol {
  symbol: string;
  label: string;
  score: number;
  quoteVolume: number;
  atrPct: number;
  trend: string;
  swings: number;
  structureEvents: number;
  reason: string;
}

function atrPctOf(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1].close;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev)));
  }
  const atr = trs.reduce((s, v) => s + v, 0) / trs.length;
  const price = candles[candles.length - 1].close;
  return price > 0 ? (atr / price) * 100 : 0;
}

/** Score one symbol's readability. Higher is more worth testing on. */
export function scoreReadability(candles: Candle[]): {
  score: number;
  atrPct: number;
  trend: string;
  swings: number;
  events: number;
} {
  if (candles.length < 120) {
    return { score: 0, atrPct: 0, trend: "neutral", swings: 0, events: 0 };
  }
  const structure = analyzeMarketStructure(candles);
  const labelled = structure.swings.filter((s) => s.label).length;
  const atrPct = atrPctOf(candles);

  // Outside the volatility band the chart is either too quiet to move a stop
  // or too violent for one to survive; either way the test learns nothing.
  const volatilityOk = atrPct >= MIN_ATR_PCT && atrPct <= MAX_ATR_PCT;
  const trendClear = structure.trend !== "neutral" || structure.isRange;

  const score =
    (volatilityOk ? 40 : 0) +
    (trendClear ? 25 : 0) +
    Math.min(20, labelled * 2) +
    Math.min(15, structure.events.length * 1.5);

  return {
    score: Math.round(score),
    atrPct: Number(atrPct.toFixed(3)),
    trend: structure.trend,
    swings: labelled,
    events: structure.events.length,
  };
}

/**
 * The most readable of the most liquid symbols.
 *
 * Liquidity first because it is free — the universe ranking already carries it
 * — and readability second, over a small candidate set, because it costs one
 * klines request each.
 */
export async function pickStrongSymbol(timeframe: Timeframe): Promise<StrongSymbol | null> {
  const ranked = (await rankUniverse()).slice(0, CANDIDATES);
  if (ranked.length === 0) return null;

  const scored = await Promise.all(
    ranked.map(async (r) => {
      try {
        const candles = await fetchKlines(r.symbol, timeframe, BARS);
        const read = scoreReadability(candles);
        return { r, read };
      } catch {
        return null;
      }
    })
  );

  const best = scored
    .filter((x): x is NonNullable<typeof x> => x != null)
    .sort((a, b) => b.read.score - a.read.score)[0];
  if (!best) return null;

  return {
    symbol: best.r.symbol,
    label: best.r.label,
    score: best.read.score,
    quoteVolume: best.r.quoteVolume,
    atrPct: best.read.atrPct,
    trend: best.read.trend,
    swings: best.read.swings,
    structureEvents: best.read.events,
    reason:
      `Picked from the ${CANDIDATES} most liquid contracts for readability, not for performance: ` +
      `structure reads ${best.read.trend} with ${best.read.swings} labelled swings and ${best.read.events} structure breaks, ` +
      `and ATR sits at ${best.read.atrPct.toFixed(2)}% of price — inside the band where a 1.5-ATR stop is neither inside the spread nor a gap. ` +
      `This is a chart a technical strategy can be tested on. It is not a prediction about the coin, and a strategy that ranks first here has ranked first here only.`,
  };
}
