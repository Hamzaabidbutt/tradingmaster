/**
 * Core domain types shared by every analysis engine.
 * All engines are pure functions over Candle[] so they can run
 * identically in API routes, background workers, backtests and tests.
 */

export interface Candle {
  /** Unix seconds (open time) */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Taker buy base asset volume (from Binance klines). Enables delta estimation. */
  takerBuyVolume?: number;
  /** Number of trades in the candle */
  trades?: number;
}

export type Bias = "bullish" | "bearish" | "neutral";

export interface SwingPoint {
  index: number;
  time: number;
  price: number;
  kind: "high" | "low";
  /** major = external structure, minor = internal structure */
  degree: "major" | "minor";
  label?: "HH" | "HL" | "LH" | "LL" | "EQH" | "EQL";
}

export interface StructureEvent {
  type: "BOS" | "CHOCH";
  scope: "internal" | "external";
  direction: "bullish" | "bearish";
  time: number;
  price: number;
  brokenSwingTime: number;
}

export interface MarketStructureResult {
  swings: SwingPoint[];
  events: StructureEvent[];
  trend: Bias;
  internalTrend: Bias;
  isRange: boolean;
  lastHigherHigh?: SwingPoint;
  lastHigherLow?: SwingPoint;
  lastLowerHigh?: SwingPoint;
  lastLowerLow?: SwingPoint;
  reversalProbability: number;
  continuationProbability: number;
  summary: string[];
}

export interface Zone {
  id: string;
  type:
    | "order_block"
    | "breaker_block"
    | "mitigation_block"
    | "fvg"
    | "supply"
    | "demand"
    | "premium"
    | "discount"
    | "equilibrium"
    | "entry"
    | "exit";
  direction: "bullish" | "bearish" | "neutral";
  top: number;
  bottom: number;
  startTime: number;
  endTime?: number;
  /** order blocks: mitigated / respected; fvg: filled */
  status: "fresh" | "respected" | "mitigated" | "filled" | "partial";
  strength: number; // 0-100
  note?: string;
}

export interface LiquidityLevel {
  id: string;
  kind:
    | "buy_side"
    | "sell_side"
    | "equal_highs"
    | "equal_lows"
    | "swing_high"
    | "swing_low"
    | "buy_stops"
    | "sell_stops";
  price: number;
  time: number;
  swept: boolean;
  sweptAt?: number;
  strength: number;
}

export interface LiquiditySweep {
  time: number;
  price: number;
  direction: "above" | "below";
  levelKind: LiquidityLevel["kind"];
  reversalProbability: number;
  continuationProbability: number;
  explanation: string[];
}

export interface LiquidityResult {
  levels: LiquidityLevel[];
  sweeps: LiquiditySweep[];
  summary: string[];
}

export interface CandlePattern {
  name: string;
  index: number;
  time: number;
  direction: Bias;
  topPrice: number;
  bottomPrice: number;
  strength: number; // 0-100
  probability: number; // contextual success probability 0-100
  context: string;
}

export interface SRLevel {
  id: string;
  price: number;
  kind: "support" | "resistance";
  timeframeOrigin: string;
  touches: number;
  rejections: number;
  strength: number; // 0-100
  breakProbability: number;
  bounceProbability: number;
  volumeConfirmed: boolean;
  firstTouch: number;
  lastTouch: number;
}

export interface VolumeAnalysis {
  current: number;
  average: number;
  relative: number; // current / average
  buyingVolume: number;
  sellingVolume: number;
  delta: number;
  cumulativeDelta: number;
  cvdSeries: { time: number; value: number }[];
  spike: boolean;
  dryUp: boolean;
  climax: boolean;
  divergence: "bullish" | "bearish" | null;
  notes: string[];
}

export interface OrderFlowResult {
  buyPressure: number; // 0-100
  sellPressure: number; // 0-100
  delta: number;
  deltaSeries: { time: number; value: number }[];
  cumulativeDelta: number;
  aggression: "buyers" | "sellers" | "balanced";
  absorption: { present: boolean; side: "buy" | "sell" | null; note: string };
  exhaustion: { present: boolean; side: "buy" | "sell" | null; note: string };
  largeOrders: { time: number; side: "buy" | "sell"; volume: number }[];
  notes: string[];
}

export interface LiquidationEstimate {
  time: number;
  side: "long" | "short";
  intensity: number; // 0-100
  priceMovePct: number;
  note: string;
}

export interface LiquidationAnalysis {
  recentEvents: LiquidationEstimate[];
  longLiquidationPressure: number;
  shortLiquidationPressure: number;
  cascadeRisk: number;
  clusters: { priceLow: number; priceHigh: number; side: "long" | "short"; heat: number }[];
  whaleDriven: boolean;
  likelyFakeMove: boolean;
  reversalProbability: number;
  summary: string[];
}

export interface DoublePattern {
  type: "double_top" | "double_bottom" | "triple_top" | "triple_bottom";
  points: { time: number; price: number }[];
  neckline: number;
  breakoutProbability: number;
  fakeBreakoutProbability: number;
  measuredTarget: number;
  confirmationLevel: number;
  confirmed: boolean;
}

export interface PremiumDiscount {
  rangeHigh: number;
  rangeLow: number;
  equilibrium: number;
  currentZone: "premium" | "discount" | "equilibrium";
  positionInRange: number; // 0-1 where 1 = at range high
}

export interface StrategyScore {
  key: string;
  name: string;
  /** -100 (max bearish) .. +100 (max bullish) */
  score: number;
  weight: number;
  reasons: string[];
}

export interface TradeSetup {
  side: "BUY" | "SELL";
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp3: number;
  riskReward: number;
  expectedMovePct: number;
  estHoldingMin: number;
  confidence: number;
  confidenceLabel: "Weak" | "Moderate" | "Strong" | "Very Strong";
  reasoning: string[];
  invalidation: string[];
  strategyScores: StrategyScore[];
}

export interface FullAnalysis {
  symbol: string;
  timeframe: string;
  price: number;
  generatedAt: number;
  structure: MarketStructureResult;
  orderBlocks: Zone[];
  fvgs: Zone[];
  supplyDemand: Zone[];
  premiumDiscount: PremiumDiscount;
  liquidity: LiquidityResult;
  patterns: CandlePattern[];
  srLevels: SRLevel[];
  volume: VolumeAnalysis;
  orderFlow: OrderFlowResult;
  liquidations: LiquidationAnalysis;
  doublePatterns: DoublePattern[];
  bias: Bias;
  bullishProbability: number;
  bearishProbability: number;
  setup: TradeSetup | null;
  insights: Insight[];
}

export interface Insight {
  time: number;
  severity: "info" | "warning" | "critical";
  category:
    | "order_flow"
    | "structure"
    | "liquidity"
    | "liquidation"
    | "volume"
    | "pattern"
    | "signal"
    | "phase";
  headline: string;
  detail: string;
  bias: Bias;
}

export interface BacktestTrade {
  entryTime: number;
  exitTime: number;
  side: "BUY" | "SELL";
  entry: number;
  exit: number;
  stopLoss: number;
  takeProfit: number;
  pnlPct: number;
  rr: number;
  win: boolean;
  reason: string;
}

export interface BacktestMetrics {
  strategyKey: string;
  symbol: string;
  timeframe: string;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  lossRate: number;
  netProfitPct: number;
  grossProfitPct: number;
  grossLossPct: number;
  profitFactor: number;
  maxDrawdownPct: number;
  avgRR: number;
  sharpe: number;
  longestWinStreak: number;
  longestLossStreak: number;
  avgTradeDurationMin: number;
  monthly: { month: string; pnlPct: number; trades: number }[];
  yearly: { year: string; pnlPct: number; trades: number }[];
  equityCurve: { time: number; equity: number }[];
}
