import { cacheGet, cacheSet } from "@/lib/cache";
import { fetchKlines } from "@/lib/binance";
import { logger } from "@/lib/logger";
import { readMarketRegime, REGIME_BARS } from "@/engines/regime";
import { MarketRegime } from "@/engines/types";

/**
 * The current BTC regime, cached and fail-soft.
 *
 * Every signal written gets tagged with this, so it sits on the hot path of
 * signal creation and has to obey two rules:
 *
 *  * **Never block.** A failed BTC fetch returns the `unknown` regime rather
 *    than throwing. A signal that cannot be tagged is still a signal, and
 *    losing it to a tagging failure would be a far worse outcome than an
 *    untagged row.
 *  * **Never repeat.** One BTC klines call serves every signal in a sweep.
 *    Without the cache a 100-symbol scan that persists eight signals would
 *    fetch BTC eight times for an answer that cannot change between them.
 *
 * The TTL is deliberately long relative to the scan cadence: this is a 4-hour
 * structural read, and refreshing it every thirty seconds would spend rate
 * budget to watch a number that moves four times a day.
 */
const CACHE_KEY = "regime:btc:4h";
const TTL_MS = 300_000;
const REFERENCE_SYMBOL = "BTCUSDT";
const REFERENCE_TIMEFRAME = "4h";

/** The regime returned when BTC cannot be read. Distinct from "mixed". */
export const UNKNOWN_REGIME: MarketRegime = {
  trend: "neutral",
  label: "unknown",
  timeframe: REFERENCE_TIMEFRAME,
  changePct: 0,
  aboveMa: false,
  volatility: "normal",
  atrPct: 0,
  atrPercentile: 50,
  bars: 0,
  summary:
    "BTC could not be read, so the regime this signal was born into is unknown. Recorded as unknown rather than folded into a neutral read — those are different facts.",
};

export async function getMarketRegime(): Promise<MarketRegime> {
  const cached = cacheGet<MarketRegime>(CACHE_KEY);
  if (cached) return cached;

  try {
    const candles = await fetchKlines(REFERENCE_SYMBOL, REFERENCE_TIMEFRAME, REGIME_BARS);
    const regime = readMarketRegime(candles, REFERENCE_TIMEFRAME);
    cacheSet(CACHE_KEY, regime, TTL_MS);
    return regime;
  } catch (err) {
    logger.warn("regime.unavailable", { error: String(err) });
    // Not cached: a transient BTC failure should not pin every signal for the
    // next five minutes to "unknown".
    return UNKNOWN_REGIME;
  }
}
