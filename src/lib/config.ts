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
