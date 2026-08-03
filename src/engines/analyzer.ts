import { ENGINE_DEFAULTS, Timeframe } from "@/lib/config";
import { detectCandlePatterns } from "./candlestick";
import { analyzeDelta } from "./deltaAnalysis";
import { detectDoublePatterns } from "./doublePatterns";
import { buildFootprint } from "./footprint";
import { detectFVGs } from "./fvg";
import { computeFibonacci, computeMovingAverages, computeVwap, detectEqualLevels } from "./indicators";
import { generateInsights } from "./insights";
import { analyzeLiquidationDelta } from "./liquidationDelta";
import { analyzeLiquidations } from "./liquidations";
import { analyzeLiquidity } from "./liquidity";
import { analyzeMarketStructure } from "./marketStructure";
import { detectOrderBlocks, detectSupplyDemand } from "./orderBlocks";
import { detectOrderFlowEvents } from "./orderFlowEvents";
import { analyzeOrderFlow } from "./orderflow";
import { analyzePremiumDiscount } from "./premiumDiscount";
import { buildTradeSetup, computeConfidence } from "./signal";
import { evaluateStrategies } from "./strategies";
import { detectSupportResistance } from "./supportResistance";
import { Candle, FullAnalysis } from "./types";
import { analyzeVolume } from "./volume";
import { buildVolumeProfile } from "./volumeProfile";
import { buildPulse } from "./pulse";
import { buildMultiWindow } from "./multiWindow";

export interface AnalyzeOptions {
  weights?: Record<string, { weight: number; enabled: boolean }>;
  minConfidence?: number;
  /**
   * Lower-timeframe candles covering the same span, used to reconstruct a
   * genuine footprint (bid × ask per price level). Optional — without it
   * the footprint engine falls back to a modelled distribution and marks
   * itself as estimated.
   */
  subCandles?: Candle[] | null;
  subTimeframe?: string;
  /**
   * 1-minute candles used by the Market Pulse engine so the recent-window
   * conclusion stays granular regardless of the chart timeframe.
   */
  minuteCandles?: Candle[] | null;
  pulseWindowMinutes?: number;
}

/**
 * Orchestrates every engine over a candle window and produces the complete
 * market intelligence picture used by the API, UI, worker and backtester.
 * Pure and synchronous — same inputs always produce the same output.
 */
export function analyzeMarket(
  symbol: string,
  timeframe: Timeframe,
  candles: Candle[],
  opts: AnalyzeOptions = {}
): FullAnalysis {
  if (candles.length < 50) {
    throw new Error(`Not enough candles for analysis: ${candles.length}`);
  }
  const price = candles[candles.length - 1].close;

  // --- Structure & smart-money zones ---
  const structure = analyzeMarketStructure(candles, {
    majorLookback: ENGINE_DEFAULTS.majorSwingLookback,
    minorLookback: ENGINE_DEFAULTS.minorSwingLookback,
    equalTolerance: ENGINE_DEFAULTS.equalLevelTolerance,
  });
  const { orderBlocks, breakers } = detectOrderBlocks(candles, structure.events);
  const fvgs = detectFVGs(candles);
  const supplyDemand = [...detectSupplyDemand(candles), ...breakers];
  const premiumDiscount = analyzePremiumDiscount(candles, structure.swings);
  const liquidity = analyzeLiquidity(candles, structure.swings, ENGINE_DEFAULTS.equalLevelTolerance);
  const equalLevels = detectEqualLevels(candles, structure.swings);

  // --- Price action ---
  const patterns = detectCandlePatterns(candles);
  const srLevels = detectSupportResistance(candles, timeframe);
  const doublePatterns = detectDoublePatterns(candles, structure.swings);

  // --- Volume & order flow ---
  const volume = analyzeVolume(candles);
  const orderFlow = analyzeOrderFlow(candles);
  const volumeProfile = buildVolumeProfile(candles.slice(-Math.min(240, candles.length)), {
    bins: 60,
    scope: "visible",
  });
  const footprint = buildFootprint(candles, opts.subCandles ?? null, {
    imbalanceThreshold: 3,
    count: 30,
    sourceTimeframe: opts.subTimeframe,
  });
  const delta = analyzeDelta(candles);
  const orderFlowEvents = detectOrderFlowEvents(candles, footprint, volumeProfile, srLevels);

  // --- Liquidations ---
  const liquidations = analyzeLiquidations(candles);
  const liquidationDelta = analyzeLiquidationDelta(candles);

  // --- Classic indicators ---
  const movingAverages = computeMovingAverages(candles);
  const vwap = computeVwap(candles);
  const fibonacci = computeFibonacci(candles, structure.swings);

  // --- Recent-window conclusion (falls back to the chart series when no
  // 1m data is supplied, e.g. inside backtests) ---
  const pulse = buildPulse(opts.minuteCandles ?? candles, {
    windowMinutes: opts.pulseWindowMinutes ?? 5,
  });

  // --- Same tape read across several lookbacks (3/5/7/10/12/15 bars) ---
  const multiWindow = buildMultiWindow(candles);

  const core = {
    symbol,
    timeframe,
    price,
    generatedAt: Math.floor(Date.now() / 1000),
    structure,
    orderBlocks,
    fvgs,
    supplyDemand,
    premiumDiscount,
    liquidity,
    patterns,
    srLevels,
    volume,
    orderFlow,
    liquidations,
    doublePatterns,
    volumeProfile,
    footprint,
    orderFlowEvents,
    delta,
    movingAverages,
    vwap,
    fibonacci,
    equalLevels,
    liquidationDelta,
    pulse,
    multiWindow,
  };

  const strategyScores = evaluateStrategies(core, opts.weights);
  const { bullishProbability, bearishProbability } = computeConfidence(strategyScores);
  const setup = buildTradeSetup(
    core,
    strategyScores,
    timeframe,
    opts.minConfidence ?? ENGINE_DEFAULTS.minSignalConfidence
  );
  const insights = generateInsights(core, bullishProbability);

  const bias =
    bullishProbability >= 55 ? "bullish" : bullishProbability <= 45 ? "bearish" : "neutral";

  return {
    ...core,
    bias,
    bullishProbability,
    bearishProbability,
    setup,
    insights,
  };
}
