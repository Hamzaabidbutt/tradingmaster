import { ENGINE_DEFAULTS, Timeframe } from "@/lib/config";
import { detectCandlePatterns } from "./candlestick";
import { detectDoublePatterns } from "./doublePatterns";
import { detectFVGs } from "./fvg";
import { generateInsights } from "./insights";
import { analyzeLiquidations } from "./liquidations";
import { analyzeLiquidity } from "./liquidity";
import { analyzeMarketStructure } from "./marketStructure";
import { detectOrderBlocks, detectSupplyDemand } from "./orderBlocks";
import { analyzeOrderFlow } from "./orderflow";
import { analyzePremiumDiscount } from "./premiumDiscount";
import { buildTradeSetup, computeConfidence } from "./signal";
import { evaluateStrategies } from "./strategies";
import { detectSupportResistance } from "./supportResistance";
import { Candle, FullAnalysis } from "./types";
import { analyzeVolume } from "./volume";

export interface AnalyzeOptions {
  weights?: Record<string, { weight: number; enabled: boolean }>;
  minConfidence?: number;
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
  const patterns = detectCandlePatterns(candles);
  const srLevels = detectSupportResistance(candles, timeframe);
  const volume = analyzeVolume(candles);
  const orderFlow = analyzeOrderFlow(candles);
  const liquidations = analyzeLiquidations(candles);
  const doublePatterns = detectDoublePatterns(candles, structure.swings);

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
