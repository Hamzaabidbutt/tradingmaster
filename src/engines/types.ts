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

/* ------------------------------------------------------------------ *
 * Volume Profile / Auction Theory
 * ------------------------------------------------------------------ */

export interface ProfileRow {
  price: number;
  volume: number;
  buyVolume: number;
  sellVolume: number;
  delta: number;
}

/** High/Low Volume Nodes — prices the market accepted vs rejected. */
export interface VolumeNode {
  price: number;
  priceHigh: number;
  priceLow: number;
  volume: number;
  /** share of total profile volume, 0-1 */
  share: number;
  kind: "HVN" | "LVN";
  note: string;
}

/**
 * Auction-theory profile shape.
 *  D = balanced (fair value accepted, range behaviour)
 *  P = short covering / accumulation tail below (bearish if printed at a high)
 *  b = long liquidation / distribution tail above (bullish if printed at a low)
 *  B = double distribution (two separate value areas — trend transition)
 */
export type ProfileShape = "D" | "P" | "b" | "B";

export interface VolumeProfileResult {
  scope: "session" | "daily" | "weekly" | "visible";
  rows: ProfileRow[];
  poc: number;
  vah: number;
  val: number;
  totalVolume: number;
  /** value-area volume share actually captured (target 70%) */
  valueAreaShare: number;
  hvns: VolumeNode[];
  lvns: VolumeNode[];
  shape: ProfileShape;
  /** where price currently trades relative to value */
  acceptance: "above_value" | "inside_value" | "below_value";
  /** auction state: balanced (inside value) vs imbalanced (seeking new value) */
  auctionState: "balance" | "imbalance";
  summary: string[];
}

/* ------------------------------------------------------------------ *
 * Footprint (bid × ask per price level)
 * ------------------------------------------------------------------ */

export interface FootprintCell {
  price: number;
  bidVolume: number; // sells hitting the bid (left column)
  askVolume: number; // buys lifting the ask (right column)
  delta: number;
  /** diagonal imbalance vs the neighbouring price level */
  imbalance: "buy" | "sell" | null;
  imbalanceRatio: number;
}

export interface FootprintCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  cells: FootprintCell[];
  /** price level inside this candle with the most traded volume */
  poc: number;
  totalVolume: number;
  delta: number;
  /** 3+ consecutive imbalances in the same direction */
  stackedImbalances: { direction: "buy" | "sell"; fromPrice: number; toPrice: number; count: number }[];
  /** price levels where one side got no fills at all */
  zeroPrints: { price: number; side: "buy" | "sell" }[];
  /** delta sign disagrees with candle direction — the classic trap signature */
  deltaDivergence: boolean;
}

export interface FootprintResult {
  /** approximation quality: "real" when built from lower-timeframe candles */
  fidelity: "sub_candle" | "estimated";
  sourceTimeframe: string;
  candles: FootprintCandle[];
  imbalanceThreshold: number;
  summary: string[];
}

/* ------------------------------------------------------------------ *
 * Absorption / Exhaustion / Trapped traders
 * ------------------------------------------------------------------ */

export interface AbsorptionEvent {
  time: number;
  price: number;
  side: "buy" | "sell"; // side doing the absorbing (passive)
  strength: number; // 0-100
  volume: number;
  delta: number;
  /** absorption only matters at a key level — this names it */
  atKeyLevel: string | null;
  explanation: string;
}

export interface ExhaustionEvent {
  time: number;
  price: number;
  side: "buy" | "sell"; // side running out of steam
  stage: "momentum" | "weakening" | "danger";
  volumeTrendPct: number; // negative = declining participation
  strength: number;
  explanation: string;
}

export interface TrappedTraders {
  time: number;
  price: number;
  side: "buyers" | "sellers";
  volume: number;
  strength: number;
  /** where their stops most likely sit */
  stopZone: { low: number; high: number };
  explanation: string;
}

export interface OrderFlowEvents {
  absorptions: AbsorptionEvent[];
  exhaustions: ExhaustionEvent[];
  trapped: TrappedTraders[];
  /** price levels that printed extreme delta — act as future S/R */
  deltaSpikeLevels: { price: number; time: number; side: "buy" | "sell"; delta: number }[];
  /** outsized single-bar prints (the "big trade bubbles") */
  bigTrades: { time: number; price: number; side: "buy" | "sell"; volume: number; multiple: number }[];
  summary: string[];
}

/* ------------------------------------------------------------------ *
 * Delta analytics
 * ------------------------------------------------------------------ */

export interface DeltaDivergence {
  time: number;
  kind: "regular_bearish" | "regular_bullish" | "hidden_bearish" | "hidden_bullish";
  pricePoint: number;
  priorPricePoint: number;
  cvdPoint: number;
  priorCvdPoint: number;
  strength: number;
  explanation: string;
}

export interface DeltaAnalysis {
  /** per-bar delta with running CVD */
  series: { time: number; delta: number; cvd: number; price: number }[];
  cvd: number;
  cvdTrend: Bias;
  divergences: DeltaDivergence[];
  /** bars whose delta sign contradicts the candle body */
  trapBars: { time: number; price: number; candleDirection: Bias; deltaDirection: Bias; delta: number }[];
  maxDelta: number;
  minDelta: number;
  summary: string[];
}

/* ------------------------------------------------------------------ *
 * Classic indicators (MAs, VWAP, Fibonacci)
 * ------------------------------------------------------------------ */

export interface MovingAverage {
  key: string;
  label: string;
  type: "EMA" | "SMA";
  period: number;
  color: string;
  values: { time: number; value: number }[];
  current: number;
  /** price above/below this MA */
  position: "above" | "below";
}

export interface MovingAverageResult {
  averages: MovingAverage[];
  /** fast/slow alignment across the stack */
  alignment: Bias;
  goldenCross: boolean;
  deathCross: boolean;
  summary: string[];
}

export interface VwapResult {
  values: { time: number; value: number }[];
  current: number;
  upperBand1: number;
  lowerBand1: number;
  upperBand2: number;
  lowerBand2: number;
  bands: { time: number; upper1: number; lower1: number; upper2: number; lower2: number }[];
  position: "above" | "below";
  distancePct: number;
  summary: string[];
}

export interface FibLevel {
  ratio: number;
  label: string;
  price: number;
  kind: "retracement" | "extension";
  /** golden pocket 0.618–0.65 */
  isGoldenPocket: boolean;
}

export interface FibonacciResult {
  direction: "up" | "down";
  swingHigh: number;
  swingLow: number;
  swingHighTime: number;
  swingLowTime: number;
  levels: FibLevel[];
  /** the retracement level price is currently reacting to, if any */
  activeLevel: FibLevel | null;
  summary: string[];
}

/* ------------------------------------------------------------------ *
 * Equal highs / lows drawn as connecting lines
 * ------------------------------------------------------------------ */

export interface EqualLevelLine {
  id: string;
  kind: "EQH" | "EQL";
  price: number;
  startTime: number;
  endTime: number;
  touches: number;
  swept: boolean;
  strength: number;
  note: string;
}

/* ------------------------------------------------------------------ *
 * Aggregate liquidation delta
 * ------------------------------------------------------------------ */

export interface LiquidationDeltaPoint {
  time: number;
  longLiquidated: number;
  shortLiquidated: number;
  /** shortLiquidated - longLiquidated (positive = shorts getting squeezed) */
  delta: number;
  cumulative: number;
}

export interface LiquidationDeltaResult {
  series: LiquidationDeltaPoint[];
  netDelta: number;
  cumulative: number;
  dominantSide: "long" | "short" | "balanced";
  summary: string[];
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
  volumeProfile: VolumeProfileResult;
  footprint: FootprintResult;
  orderFlowEvents: OrderFlowEvents;
  delta: DeltaAnalysis;
  movingAverages: MovingAverageResult;
  vwap: VwapResult;
  fibonacci: FibonacciResult;
  equalLevels: EqualLevelLine[];
  liquidationDelta: LiquidationDeltaResult;
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
