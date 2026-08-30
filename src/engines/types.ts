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
  /**
   * How the forced volume was derived.
   *
   * `sub_candle` — detected on lower-timeframe candles and summed into these
   *   bars, so a cascade shows up at the same size whatever timeframe is on
   *   screen.
   * `estimated`  — detected on these bars directly. Fast events shorter than
   *   one bar are diluted by the ordinary trade around them and can fall under
   *   the threshold entirely, which is why the same spike can appear on 5m and
   *   be absent on 15m.
   */
  fidelity: "sub_candle" | "estimated";
  summary: string[];
}

/* ------------------------------------------------------------------ *
 * Market Pulse — recent-window conclusion
 * ------------------------------------------------------------------ */

export interface RecentWindowSummary {
  windowMinutes: number;
  /** span used to define "normal" volume/range — always wider than the window */
  baselineMinutes: number;
  /** true when the input series was too short for an honest baseline */
  baselineDegraded: boolean;
  from: number;
  to: number;
  priceStart: number;
  priceEnd: number;
  changePct: number;
  high: number;
  low: number;
  totalVolume: number;
  buyVolume: number;
  sellVolume: number;
  delta: number;
  buyPct: number;
  volumeMultiple: number;
  rangeMultiple: number;
  volumeTrendPct: number;
  /** where business actually got done in the window */
  mostTradedPrices: { price: number; volume: number; share: number; buyShare: number }[];
  poc: number;
  /** candles that closed against their own delta — absorbed aggression */
  absorptionCandles: {
    time: number;
    type: "bearish_positive_delta" | "bullish_negative_delta";
    open: number;
    close: number;
    delta: number;
    volume: number;
    volumeMultiple: number;
    note: string;
  }[];
  /** full count before the display cap — scoring used all of them */
  absorptionTotalCount: number;
  /** the price band that soaked up the bulk of the volume */
  institutionalZones: {
    priceLow: number;
    priceHigh: number;
    volume: number;
    share: number;
    side: "accumulation" | "distribution" | "neutral";
    note: string;
  }[];
  bigTrades: { time: number; price: number; side: "buy" | "sell"; volume: number; multiple: number }[];
  bigTradesTotalCount: number;
  sweeps: { time: number; price: number; direction: "above" | "below"; note: string }[];
  sweepsTotalCount: number;
  /** transparent breakdown of what produced the odds */
  factors: { label: string; points: number; detail: string }[];
  bullishOdds: number;
  bearishOdds: number;
  nextMove: {
    direction: Bias;
    target: number;
    invalidation: number;
    rationale: string[];
  };
  verdict: string;
  keyTakeaways: string[];
}

/* ------------------------------------------------------------------ *
 * Multi-window lookback insights
 * ------------------------------------------------------------------ */

export interface WindowInsight {
  /** number of candles this read covers */
  bars: number;
  from: number;
  to: number;
  priceStart: number;
  priceEnd: number;
  changePct: number;
  high: number;
  low: number;
  poc: number;
  totalVolume: number;
  buyVolume: number;
  sellVolume: number;
  delta: number;
  buyPct: number;
  volumeMultiple: number;
  rangeMultiple: number;
  volumeTrendPct: number;
  bullishCandles: number;
  bearishCandles: number;
  /** bars that closed against their own delta */
  absorptionCount: number;
  /** where the window closed inside its range, 0 = low, 1 = high */
  closePosition: number;
  bias: Bias;
  bullishOdds: number;
  headline: string;
  detail: string;
}

export interface MultiWindowResult {
  windows: WindowInsight[];
  consensus: {
    bias: Bias;
    /** % of windows agreeing with the majority */
    agreement: number;
    bullishCount: number;
    bearishCount: number;
    neutralCount: number;
    shortTermBias: Bias;
    longTermBias: Bias;
    /** short horizons disagreeing with long ones — an early-turn tell */
    diverging: boolean;
    summary: string[];
  };
}

/* ------------------------------------------------------------------ *
 * Chart Analyst — pattern & price action only
 *
 * Deliberately isolated from every other module: no indicators, no order
 * book, no liquidity/funding/liquidation data. It reads the chart the way a
 * human does — shapes, candles, and what happened last time the chart
 * looked like this.
 * ------------------------------------------------------------------ */

/** A geometric formation fitted over swing highs/lows. */
export interface ChartShape {
  name: string;
  kind:
    | "ascending_triangle"
    | "descending_triangle"
    | "symmetrical_triangle"
    | "rising_wedge"
    | "falling_wedge"
    | "ascending_channel"
    | "descending_channel"
    | "rectangle"
    | "bull_flag"
    | "bear_flag"
    | "head_and_shoulders"
    | "inverse_head_and_shoulders"
    | "double_top"
    | "double_bottom";
  /** the break direction the formation conventionally resolves toward */
  direction: Bias;
  /** how complete the formation is, 0-100 */
  maturity: number;
  strength: number;
  upperBoundary: number;
  lowerBoundary: number;
  /** measured-move projection if it resolves in its expected direction */
  measuredTarget: number;
  startTime: number;
  note: string;
}

/** A past stretch of chart whose normalized shape resembles the present. */
export interface HistoricalAnalogue {
  startIndex: number;
  startTime: number;
  endTime: number;
  /** 0-100, higher = closer shape match */
  similarity: number;
  /** what price did over the bars that followed the match, % */
  forwardReturnPct: number;
  forwardDirection: Bias;
  /** best and worst excursion after the match, % */
  maxUpPct: number;
  maxDownPct: number;
  note: string;
}

export interface ChartAnalystResult {
  /** bars used to define the current shape */
  windowBars: number;
  /** bars of history actually searched */
  historyBars: number;
  currentPattern: {
    headline: string;
    candlestick: CandlePattern[];
    shapes: ChartShape[];
    priceAction: string[];
  };
  historicalMatches: HistoricalAnalogue[];
  expectedNextMove: {
    direction: Bias;
    /** median forward move of the closest analogues, % */
    magnitudePct: number;
    /** null when the analogues are too split to project one */
    target: number | null;
    /** null when no direction is claimed */
    invalidation: number | null;
    horizonBars: number;
    rationale: string[];
  };
  bullishScenario: { trigger: string; target: number; probability: number; note: string };
  bearishScenario: { trigger: string; target: number; probability: number; note: string };
  confidence: number;
  confidenceLabel: "Low" | "Moderate" | "High" | "Very High";
  patternExplanation: string[];
}

/* ------------------------------------------------------------------ *
 * Candle Close Expansion — key levels + decisive closes
 * ------------------------------------------------------------------ */

export interface CandleCloseExpansionResult {
  keyLevel: {
    price: number;
    kind: "support" | "resistance";
    touches: number;
    /** touches that closed back away from the level */
    respects: number;
    /** share of prior breaks that failed and returned inside, 0-1 */
    historicalFalseBreakRate: number;
    note: string;
  } | null;
  candleClose: "above" | "below" | "inside";
  closePrice: number;
  closeTime: number;
  breakoutDirection: "bullish" | "bearish" | "none";
  /** why this close counts (or doesn't) — a crossing alone is never enough */
  decisiveness: {
    score: number;
    /** distance the close travelled beyond the level, in ATR units */
    penetrationAtr: number;
    bodyRatio: number;
    /** where the candle closed inside its own range, 0 = low, 1 = high */
    closeLocation: number;
    volumeMultiple: number;
    followThroughBars: number;
    verdict: "decisive" | "marginal" | "weak" | "none";
    checks: { label: string; passed: boolean; detail: string }[];
  };
  expansionProbability: "Low" | "Medium" | "High";
  expansionScore: number;
  expectedDirection: "up" | "down" | "uncertain";
  expansionTarget: number | null;
  invalidationLevel: number | null;
  reason: string[];
  /** previous closes through this same level and what followed */
  historicalPrecedents: {
    time: number;
    direction: "above" | "below";
    decisive: boolean;
    followThroughPct: number;
    failed: boolean;
    note: string;
  }[];
  summary: string;
}

/* ------------------------------------------------------------------ *
 * Range Trading Strategy
 * ------------------------------------------------------------------ */

export interface RangeTradingResult {
  marketCondition: "Ranging" | "Trending" | "Unclear";
  rangeHigh: number | null;
  rangeLow: number | null;
  rangeMidpoint: number | null;
  rangeWidthPct: number | null;
  /** bars the candidate range spans */
  rangeBars: number;
  highTouches: number;
  lowTouches: number;
  /** share of bars whose bodies stayed inside the boundaries, 0-1 */
  containment: number;
  currentPosition: "Near High" | "Mid Range" | "Near Low" | "Outside";
  rangeSetup: "Long" | "Short" | "No Trade" | "Breakout";
  bias: Bias;
  confidence: number;
  confidenceLabel: "Low" | "Moderate" | "High" | "Very High";
  potentialEntry: number | null;
  /** first target is always the midpoint, second the opposite boundary */
  target1: number | null;
  target2: number | null;
  invalidation: number | null;
  /** the evidence gates, shown so a rejected range explains itself */
  validation: { label: string; passed: boolean; detail: string }[];
  boundaryReactions: {
    boundary: "high" | "low";
    time: number;
    kind: "rejection" | "failed_breakout" | "decisive_close_outside";
    price: number;
    note: string;
  }[];
  breakout: {
    active: boolean;
    direction: "up" | "down" | null;
    stage: "none" | "attempt" | "confirmed" | "retest" | "false_breakout";
    note: string;
  };
  reason: string[];
}

/* ------------------------------------------------------------------ *
 * Confluence — where the three independent analysts agree
 *
 * The three analysts above each read the chart their own way. This layer
 * asks a different question: do any of them independently point the same
 * direction, and is that agreement worth acting on?
 *
 * Two deliberate properties, both enforced by the shapes below:
 *   * LONG and SHORT are evaluated as separate, symmetric cases, so the
 *     structure itself cannot be biased toward one side.
 *   * NO_TRADE is a first-class decision, not a fallback — an analyst that
 *     fails its quality gate abstains rather than casting a weak vote.
 * ------------------------------------------------------------------ */

/** Which analyst spoke, and what kind of evidence it is. */
export type AnalystKey = "chart" | "candleClose" | "range";

/**
 * The class of evidence an analyst reads.
 *
 * Confluence is scored on the number of *distinct* bases that agree, not the
 * number of analysts — two modules reading the same kind of evidence are
 * closer to one opinion counted twice than to genuine confirmation.
 */
export type EvidenceBasis = "pattern_history" | "level_close" | "range_boundary";

export type Direction = "long" | "short" | "none";

/** One analyst's position on the current chart, captured at signal time. */
export interface AnalystVerdict {
  analyst: AnalystKey;
  name: string;
  basis: EvidenceBasis;
  direction: Direction;
  /** the analyst's own confidence, 0-100 */
  confidence: number;
  /** true when the analyst cleared its quality gate and may contribute */
  qualified: boolean;
  /** why it did or didn't qualify — shown, never hidden */
  gate: string;
  entry: number | null;
  target: number | null;
  invalidation: number | null;
  /** one line built from this analyst's own numbers, never a template */
  evidence: string;
}

/** The case for one direction, built independently of the other. */
export interface DirectionalCase {
  direction: "long" | "short";
  /** 50-97; 50 means no evidence either way */
  confidence: number;
  /** pre-squash weighted sum of qualified supporters */
  rawStrength: number;
  /** distinct evidence bases supporting this direction */
  independentBases: number;
  /** multiplier applied for independent agreement */
  independenceMultiplier: number;
  supporters: AnalystVerdict[];
  /** confidence points removed because qualified analysts pointed the other way */
  disagreementPenalty: number;
}

export interface ConfluenceSetup {
  symbol: string;
  timeframe: string;
  price: number;
  generatedAt: number;
  /** every analyst's verdict, including the ones that abstained */
  verdicts: AnalystVerdict[];
  long: DirectionalCase;
  short: DirectionalCase;
  decision: "LONG" | "SHORT" | "NO_TRADE";
  /** the winning case's confidence, or the higher of the two on NO_TRADE */
  confidence: number;
  confidenceLabel: "Low" | "Moderate" | "High" | "Very High";
  /** populated only when decision is NO_TRADE — which gate failed */
  noTradeReason: string | null;
  /** null on NO_TRADE: refusing to quote levels for a trade we won't take */
  entry: number | null;
  stopLoss: number | null;
  target1: number | null;
  target2: number | null;
  riskReward: number | null;
  disagreement: {
    present: boolean;
    note: string;
    penaltyApplied: number;
  };
  /** how strong the agreement is, in words */
  confluenceVerdict: "None" | "Single" | "Partial" | "Strong";
  /** generated from the actual verdicts above — differs for every setup */
  explanation: string[];
  invalidation: string[];
}

/* ------------------------------------------------------------------ *
 * Accumulation / reversal detector
 * ------------------------------------------------------------------ */

export interface AccumulationCriterion {
  key: string;
  label: string;
  met: boolean;
  /** points contributed toward the 0-100 score */
  score: number;
  /** maximum this criterion can contribute */
  weight: number;
  detail: string;
}

export interface AccumulationSetup {
  symbol: string;
  timeframe: string;
  price: number;
  criteria: AccumulationCriterion[];
  /** 0-100 weighted total */
  score: number;
  /** required criteria all met AND score above threshold */
  qualified: boolean;
  grade: "prime" | "strong" | "forming" | "none";
  /** the level being defended, when one exists */
  support: number | null;
  target: number | null;
  invalidation: number | null;
  headline: string;
  explanation: string[];
}

/* ------------------------------------------------------------------ *
 * Pressure map — forced buyers and forced sellers
 * ------------------------------------------------------------------ */

export interface PressureZone {
  price: number;
  /** signed % from current price; positive = above */
  distancePct: number;
  /** which cohort gets forced out here */
  side: "long" | "short";
  /** 0-100 relative heat */
  intensity: number;
  /** how this zone was derived — never presented as measured when inferred */
  basis: "equal_levels" | "swing_liquidity" | "leverage_band";
  note: string;
}

export interface WhaleOrder {
  time: number;
  price: number;
  side: "buy" | "sell";
  volume: number;
  /** multiple of average bar volume */
  multiple: number;
  notional: number;
  distancePct: number;
  /** defending = positioned to hold this level; trapped = now offside */
  posture: "defending" | "trapped";
  note: string;
}

export interface PressureMap {
  price: number;
  /** stop pools above price — touching them forces buying */
  shortSqueeze: PressureZone[];
  /** stop pools below price — touching them forces selling */
  longSqueeze: PressureZone[];
  forcedLongLiquidation: PressureZone[];
  forcedShortLiquidation: PressureZone[];
  whales: WhaleOrder[];
  cvdDivergence: {
    present: boolean;
    kind: string | null;
    bias: Bias;
    strength: number;
    note: string;
  };
  /** which direction the forced flow pulls, weighted by size and proximity */
  lean: Bias;
  summary: string[];
}

export interface StrategyScore {
  key: string;
  name: string;
  /** -100 (max bearish) .. +100 (max bullish) */
  score: number;
  weight: number;
  reasons: string[];
}export interface TradeSetup {
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
  /** null when 1-minute candles were unavailable */
  pulse: RecentWindowSummary | null;
  multiWindow: MultiWindowResult;
  pressureMap: PressureMap;
  /** chart-only read: patterns, price action, historical analogues */
  chartAnalyst: ChartAnalystResult;
  /** key levels + decisive candle closes → expansion probability */
  candleCloseExpansion: CandleCloseExpansionResult;
  /** range detection and boundary-reaction setups */
  rangeTrading: RangeTradingResult;
  bias: Bias;
  bullishProbability: number;
  bearishProbability: number;
  setup: TradeSetup | null;
  insights: Insight[];
}

export interface Insight {
  /** when the system produced the line — how stale the *reading* is */
  time: number;
  /**
   * Open time of the candle the observation is drawn from.
   *
   * Distinct from `time` on purpose. "Buyers absorbed sellers" is a statement
   * about a specific bar; the scan that noticed it may have run minutes later,
   * and on a 4h chart that gap can be hours. Without the bar's own clock time
   * a reader cannot line the line up against the chart it describes.
   */
  barTime: number;
  /** closed bars between that candle and the forming one; 0 = the live bar */
  barsAgo: number;
  /** the interval `barTime` belongs to, so "14:30" is unambiguous */
  barTimeframe: string;
  /** 0-100 conviction in this single observation. Not a probability of profit. */
  confidence: number;
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

/* ------------------------------------------------------------------ *
 * Signal outcome analysis
 *
 * Answers, after the fact, *why* a signal worked or didn't — and which
 * analyst deserves the credit or the blame. The classification is
 * deliberately coarse and explicit rather than a free-text guess, so the
 * same reason can be counted across hundreds of signals.
 * ------------------------------------------------------------------ */

/** How far price actually travelled after entry, in risk multiples. */
export interface Excursion {
  /** best move in the signal's favour, as a multiple of initial risk */
  maxFavourableR: number;
  /** worst move against the signal, as a multiple of initial risk */
  maxAdverseR: number;
  maxFavourablePct: number;
  maxAdversePct: number;
  /**
   * How much of the entry→first-target distance the favourable move covered,
   * as a percent. 100 means the first target was tagged; 40 means the signal
   * got 40 % of the way there before failing.
   *
   * Measured against TP1 rather than TP3 because TP1 is the target a signal is
   * actually judged on — a stop-out that reached 90 % of TP1 is a near miss,
   * while 90 % of TP3 could be a comfortable win. Because both the numerator
   * and the denominator are distances *from entry*, the figure is identical in
   * construction for a LONG and a SHORT.
   *
   * Nullable, and null is the honest answer in three cases: a legacy row stored
   * before this field existed, a signal that quoted no first target, and a
   * target equal to the entry. Not clamped at 100 — a signal that ran past TP1
   * and then reversed genuinely covered the whole distance, and hiding that
   * would make a management failure look like a directional one.
   */
  targetProgressPct: number | null;
  /** bars observed between entry and close */
  bars: number;
}

export type OutcomeReason =
  | "target_reached"
  | "partial_target"
  /** finished in profit without a target being hit (e.g. expired while up) */
  | "closed_in_profit"
  | "false_breakout"
  | "failed_rejection"
  | "range_invalidation"
  | "weak_candle_close"
  | "unexpected_reversal"
  | "expired_no_move"
  | "other";

export interface OutcomeAnalysis {
  win: boolean;
  reason: OutcomeReason;
  /** human-readable label for the reason */
  reasonLabel: string;
  /** narrative built from the actual numbers of this trade */
  detail: string[];
  /** which confirmation actually played out (success) or held up (failure) */
  workingConfirmation: string | null;
  /** the qualified analyst with the largest weighted contribution */
  topContributor: AnalystKey | null;
  analystsRight: AnalystKey[];
  analystsWrong: AnalystKey[];
  /** analysts that abstained and were vindicated by a loss */
  analystsAbstained: AnalystKey[];
  excursion: Excursion;
}

/* ------------------------------------------------------------------ *
 * Zone reversal detector — reactions from order blocks and fair value gaps
 * ------------------------------------------------------------------ */

export interface ZoneReaction {
  zoneId: string;
  zoneType: Zone["type"];
  direction: "bullish" | "bearish";
  top: number;
  bottom: number;
  /** bar time price first re-entered the zone within the evaluated window */
  tapTime: number;
  barsSinceTap: number;
  /** the furthest price traded into/through the zone after the tap */
  extreme: number;
  /** % price has travelled back off `extreme`, in the zone's direction */
  reversalPct: number;
  /** share of the rejecting bar's range spent as wick, 0-1 */
  rejectionWick: number;
  /** net taker delta from the tap to now; the sign should match `direction` */
  deltaAtTap: number;
  deltaConfirms: boolean;
  /** price has closed back out of the zone the way it came */
  reclaimed: boolean;
  /** the zone has not been traded through */
  intact: boolean;
  /** ids of other zones overlapping this one */
  confluence: string[];
  /** 0-100 quality of this single reaction */
  score: number;
  note: string;
}

export interface ZoneReversalSetup {
  symbol: string;
  timeframe: string;
  price: number;
  /** direction of the best reaction, or "none" when nothing reacted */
  direction: Bias;
  best: ZoneReaction | null;
  reactions: ZoneReaction[];
  /** 0-100, the best reaction's score plus context */
  score: number;
  qualified: boolean;
  grade: "prime" | "strong" | "forming" | "none";
  entry: number | null;
  invalidation: number | null;
  target: number | null;
  headline: string;
  explanation: string[];
}

/* ------------------------------------------------------------------ *
 * Liquidation spike reversal detector
 * ------------------------------------------------------------------ */

export interface LiquidationSpike {
  time: number;
  /** which cohort was forced out */
  side: "long" | "short";
  /** estimated forced volume on that bar */
  volume: number;
  /** multiple of the window's mean absolute liquidation flow */
  multiple: number;
  price: number;
  /** the extreme the spike bar printed (low for a long flush, high for a short squeeze) */
  extreme: number;
  /** true when the spike printed at the extreme of the analysed window */
  atExtreme: boolean;
  /** distance from the window extreme, as a % of price */
  distanceFromExtremePct: number;
  barsAgo: number;
}

export interface LiquidationReversalSetup {
  symbol: string;
  timeframe: string;
  price: number;
  spike: LiquidationSpike | null;
  /** "bottom" = long flush at the low, "top" = short squeeze at the high */
  location: "bottom" | "top" | "mid" | "none";
  /** % price has reversed away from the spike extreme */
  reversalPct: number;
  /** the peak reversal reached since the spike, which may exceed `reversalPct` */
  peakReversalPct: number;
  /**
   * Whether the flow was genuinely forced.
   *
   * `confirmed` — live forced-order prints were observed on this bar.
   * `inferred`  — no forced-order feed, but the price/volume/aggression
   *               signature is unambiguous.
   * `unlikely`  — the move was orderly; this reads as voluntary flow.
   */
  forced: "confirmed" | "inferred" | "unlikely";
  forcedNote: string;
  /** 0-100 */
  score: number;
  qualified: boolean;
  grade: "prime" | "strong" | "forming" | "none";
  /** the flush/squeeze extreme, which is the level that must hold */
  invalidation: number | null;
  target: number | null;
  headline: string;
  explanation: string[];
}

/* ------------------------------------------------------------------ *
 * Resting order walls
 * ------------------------------------------------------------------ */

export interface OrderWall {
  side: "bid" | "ask";
  price: number;
  /** base-asset size resting at (or clustered around) the price */
  size: number;
  /** size × price */
  notional: number;
  /** multiple of the mean level size on that side of the book */
  multiple: number;
  /** signed % from the current price; positive = above */
  distancePct: number;
  /** how many book levels the cluster spans */
  levels: number;
  note: string;
}

export interface OrderWallResult {
  price: number;
  bids: OrderWall[];
  asks: OrderWall[];
  /** -1..1 across the sampled book; positive = bid heavy */
  imbalance: number;
  /** the largest wall on each side, when one qualifies */
  largestBid: OrderWall | null;
  largestAsk: OrderWall | null;
  /** unix seconds this snapshot was taken */
  sampledAt: number;
  summary: string[];
}

/* ------------------------------------------------------------------ *
 * Cascade risk — where forced flow would trigger, and how loaded it is
 * ------------------------------------------------------------------ */

export interface CascadeTrigger {
  /** the level that would start it */
  price: number;
  /** signed % from current price; negative = below */
  distancePct: number;
  /** distance in ATR units — 2% is imminent on one coin and remote on another */
  distanceAtr: number;
  /** which cohort gets forced out here */
  side: "long" | "short";
  /**
   * How this level was derived. Never presented as measured:
   * `leverage_band` is arithmetic on an assumed entry, not a book of real
   * positions, and is the weakest of the three.
   */
  basis: "leverage_band" | "stop_pool" | "equal_levels";
  note: string;
}

export interface CascadeFuel {
  /** % change in open interest over the observed window */
  openInterestChangePct: number | null;
  /** price change over the same window, for the divergence read */
  priceChangePct: number;
  /** which cohort has been building, inferred from OI against price */
  crowded: "long" | "short" | "balanced" | "unknown";
  /** open interest is falling — positions closing, fuel draining */
  unwinding: boolean;
  note: string;
}

export interface CascadeRiskSetup {
  symbol: string;
  timeframe: string;
  price: number;
  /** the side most at risk of being forced out, or "none" */
  side: "long" | "short" | "none";
  /** nearest trigger on the at-risk side */
  trigger: CascadeTrigger | null;
  /** every trigger found, nearest first */
  triggers: CascadeTrigger[];
  fuel: CascadeFuel;
  /** true when a large flush already fired recently — fuel largely spent */
  recentlyDischarged: boolean;
  /** 0-100 how loaded the conditions are. NOT a probability. */
  score: number;
  qualified: boolean;
  grade: "prime" | "strong" | "forming" | "none";
  headline: string;
  explanation: string[];
}

/* ------------------------------------------------------------------ *
 * Bullish engulfing scanner
 * ------------------------------------------------------------------ */

export interface EngulfingSetup {
  symbol: string;
  timeframe: string;
  price: number;
  /** did the last closed bar engulf the one before it */
  engulfed: boolean;
  /** open time of the engulfing bar */
  time: number;
  barsAgo: number;
  /** engulfing body as a multiple of the body it covered */
  bodyRatio: number;
  /** covered the previous bar's full range, wicks included */
  fullRange: boolean;
  deltaConfirms: boolean;
  delta: number;
  atSupport: boolean;
  trend: Bias;
  score: number;
  qualified: boolean;
  grade: "prime" | "strong" | "forming" | "none";
  entry: number | null;
  invalidation: number | null;
  target: number | null;
  headline: string;
  explanation: string[];
}

/* ------------------------------------------------------------------ *
 * Institutional footprint — where size was worked, and what it implies
 * ------------------------------------------------------------------ */

/** One piece of evidence that size was being worked at a level. */
export interface InstitutionalEvidence {
  key: string;
  label: string;
  /** did this evidence appear at all */
  found: boolean;
  /** contribution toward the 0-100 conviction score */
  score: number;
  weight: number;
  /** the price this evidence points at, when it has one */
  price: number | null;
  detail: string;
}

export interface InstitutionalZone {
  low: number;
  high: number;
  /** midpoint, quoted as "the area" */
  mid: number;
  /** signed % from current price; negative = below */
  distancePct: number;
  /** how many independent kinds of evidence land inside this band */
  confluence: number;
  sources: string[];
}

/**
 * The balance area the market is currently trading inside, when it is in one.
 *
 * Null in a trend, deliberately. A range gives the checklist objective
 * boundaries — the high and low are where the reactions actually happened — but
 * only where one exists; picking a lookback high and low out of a trending
 * market produces two arbitrary numbers that look like levels.
 */
export interface InstitutionalRange {
  high: number;
  low: number;
  mid: number;
  /** where price sits inside it: 0 at the low, 1 at the high */
  position: number;
  /** bars the range covers */
  bars: number;
  /** closes that came within a fifth of the range of each boundary */
  touchesLow: number;
  touchesHigh: number;
}

/**
 * A comparable area found earlier in the same series, with what price did
 * after price returned to it. Measured, not modelled.
 */
export interface InstitutionalAnalogue {
  /** bar time the area finished forming */
  time: number;
  low: number;
  high: number;
  confluence: number;
  sources: string[];
  /** bar time price first traded back into it, null if it never did */
  tapTime: number | null;
  outcome: "held" | "broke" | "unresolved";
  /** furthest move in the area's favour after the tap, % */
  favourablePct: number;
  /** furthest move against it, % */
  adversePct: number;
}

export interface InstitutionalHistory {
  /** comparable areas with a resolved outcome */
  samples: number;
  held: number;
  broke: number;
  /**
   * null below the minimum sample count. A hit rate computed from two cases
   * is not a hit rate, and rendering one invites it to be read as an edge.
   */
  holdRatePct: number | null;
  medianFavourablePct: number | null;
  medianAdversePct: number | null;
  /** the most recent few, for inspection */
  analogues: InstitutionalAnalogue[];
  note: string;
}

/** One side's complete read. Both sides are always evaluated. */
export interface InstitutionalSideRead {
  side: "accumulation" | "distribution";
  zone: InstitutionalZone | null;
  zones: InstitutionalZone[];
  evidence: InstitutionalEvidence[];
  /** how many distinct checklist items were found */
  kinds: number;
  score: number;
  qualified: boolean;
}

export interface InstitutionalSetup {
  symbol: string;
  timeframe: string;
  price: number;
  /** the side size appears to have been working */
  side: "accumulation" | "distribution" | "none";
  /** the strongest area, when one is found */
  zone: InstitutionalZone | null;
  /** every area with at least two kinds of evidence, nearest first */
  zones: InstitutionalZone[];
  evidence: InstitutionalEvidence[];
  /** 0-100 conviction that size was worked here. Not a probability of profit. */
  score: number;
  qualified: boolean;
  grade: "prime" | "strong" | "forming" | "none";
  /** both sides, always — a demand read means more when supply reads weak */
  demand: InstitutionalSideRead;
  supply: InstitutionalSideRead;
  /** the balance area the checklist was located against, when there is one */
  range: InstitutionalRange | null;
  /** how comparable areas behaved earlier in this series */
  history: InstitutionalHistory;
  /** open interest change over the window, when available */
  openInterestChangePct: number | null;
  /**
   * Where the read points, expressed as levels rather than a forecast.
   * Direction follows `side`: for accumulation the confirm level is above and
   * invalidation below; for distribution the reverse. Named without a
   * direction because a field called `confirmAbove` is simply wrong on a
   * distribution read.
   */
  confirmLevel: number | null;
  invalidateLevel: number | null;
  /** the next mapped level in the implied direction */
  objective: number | null;
  headline: string;
  explanation: string[];
}
