/**
 * Central platform configuration. Markets and timeframes are data-driven:
 * add an entry here and the whole platform (API, UI, worker, backtests)
 * picks it up automatically.
 */

export interface MarketDef {
  symbol: string; // Binance futures symbol
  base: string;
  quote: string;
  label: string;
  pricePrecision: number;
  color: string;
}

export const MARKETS: MarketDef[] = [
  { symbol: "UNIUSDT", base: "UNI", quote: "USDT", label: "UNI/USDT", pricePrecision: 3, color: "#ff007a" },
  { symbol: "ORDIUSDT", base: "ORDI", quote: "USDT", label: "ORDI/USDT", pricePrecision: 3, color: "#f7931a" },
  { symbol: "BTCUSDT", base: "BTC", quote: "USDT", label: "BTC/USDT", pricePrecision: 1, color: "#f7931a" },
  { symbol: "ETHUSDT", base: "ETH", quote: "USDT", label: "ETH/USDT", pricePrecision: 2, color: "#627eea" },
  { symbol: "SOLUSDT", base: "SOL", quote: "USDT", label: "SOL/USDT", pricePrecision: 3, color: "#9945ff" },
  { symbol: "BNBUSDT", base: "BNB", quote: "USDT", label: "BNB/USDT", pricePrecision: 2, color: "#f0b90b" },
  { symbol: "DEXEUSDT", base: "DEXE", quote: "USDT", label: "DEXE/USDT", pricePrecision: 3, color: "#22d3ee" },
];

export const TIMEFRAMES = [
  "1m", "3m", "5m", "15m", "30m",
  "1h", "2h", "4h", "6h", "8h", "12h",
  "1d", "1w", "1M",
] as const;

export type Timeframe = (typeof TIMEFRAMES)[number];

export const TIMEFRAME_MINUTES: Record<Timeframe, number> = {
  "1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30,
  "1h": 60, "2h": 120, "4h": 240, "6h": 360, "8h": 480, "12h": 720,
  "1d": 1440, "1w": 10080, "1M": 43200,
};

/**
 * Lower timeframe used to reconstruct a genuine footprint (bid × ask per
 * price level) for each candle of the selected timeframe. Roughly 1/10th
 * of the parent bar keeps the request cheap while giving the footprint
 * engine real intrabar structure to work with.
 */
export const FOOTPRINT_SOURCE: Record<Timeframe, Timeframe | null> = {
  "1m": null, "3m": "1m", "5m": "1m", "15m": "1m", "30m": "3m",
  "1h": "5m", "2h": "5m", "4h": "15m", "6h": "15m", "8h": "30m", "12h": "30m",
  "1d": "1h", "1w": "4h", "1M": "1d",
};

/**
 * How long a trade is meant to be held — the horizon a signal belongs to.
 *
 * This is derived, never stored. A signal already records `estHoldingMin`, and
 * a second stored copy of the same fact would be free to drift from it. The
 * vocabulary is deliberately the trader's own rather than the timeframe label:
 * "4h" says how the chart was sampled, "swing" says what the trade is.
 */
export type TradeHorizon = "intraday" | "swing" | "position";

/**
 * The canonical expected hold for a timeframe, in minutes.
 *
 * Twelve bars, matching the multiplier `maybePersistConfluenceSignal` already
 * applies. Defined here so the timeframe-based and holding-time-based horizon
 * functions below cannot disagree about where the boundaries fall.
 */
export function expectedHoldMinutes(tf: Timeframe): number {
  return (TIMEFRAME_MINUTES[tf] ?? 60) * 12;
}

/**
 * Classify a horizon from an expected holding time.
 *
 * One trading day and one month are the two boundaries. They are wide on
 * purpose: a 4h setup expected to run two days is a swing trade whether it
 * closes in one day or three, and pretending the cutoff is precise would imply
 * a confidence the holding estimate does not have.
 */
export function horizonForHoldingMinutes(minutes: number): TradeHorizon {
  if (minutes < TIMEFRAME_MINUTES["1d"]) return "intraday";
  if (minutes < TIMEFRAME_MINUTES["1d"] * 30) return "swing";
  return "position";
}

/** The horizon a timeframe's signals default to, before geometry is known. */
export function horizonForTimeframe(tf: Timeframe): TradeHorizon {
  return horizonForHoldingMinutes(expectedHoldMinutes(tf));
}

/** Display label for a horizon — "Swing trade", not "swing". */
export const HORIZON_LABEL: Record<TradeHorizon, string> = {
  intraday: "Intraday",
  swing: "Swing trade",
  position: "Position trade",
};

export function isValidSymbol(symbol: string): boolean {
  return MARKETS.some((m) => m.symbol === symbol);
}

export function isValidTimeframe(tf: string): tf is Timeframe {
  return (TIMEFRAMES as readonly string[]).includes(tf);
}

export function marketBySymbol(symbol: string): MarketDef | undefined {
  return MARKETS.find((m) => m.symbol === symbol);
}

export const ENGINE_DEFAULTS = {
  /** candles fetched for analysis */
  analysisLookback: 500,
  /** swing detection fractal width (major) */
  majorSwingLookback: 8,
  /** swing detection fractal width (minor / internal) */
  minorSwingLookback: 3,
  /** tolerance (as fraction of price) for equal highs/lows clustering */
  equalLevelTolerance: 0.0015,
  /** minimum confidence to persist a signal */
  minSignalConfidence: Number(process.env.SIGNAL_MIN_CONFIDENCE ?? 65),
};
