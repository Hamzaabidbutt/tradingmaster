import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { dispatchAlert } from "@/lib/alerts";
import { fetchKlines, fetchKlinesPaged, fetchTicker } from "@/lib/binance";
import { analyzeMarket } from "@/engines/analyzer";
import { STRATEGIES } from "@/engines/strategies";
import { buildTradeRetrospective, computeWeightAdjustments } from "@/engines/learning";
import { buildVerdicts } from "@/engines/confluence";
import { classifyOutcome, computeExcursion, OutcomeSignal } from "@/engines/outcome";
import { AnalystVerdict, ConfluenceSetup, FullAnalysis, StrategyScore } from "@/engines/types";
import { ENGINE_DEFAULTS, FOOTPRINT_SOURCE, TIMEFRAME_MINUTES, Timeframe } from "@/lib/config";

/**
 * Signal lifecycle service: generation → persistence → evaluation → learning.
 */

/**
 * Bars of same-timeframe history fetched for the Chart Analyst's analogue
 * search. Paged in 1500-bar chunks, so this is a handful of requests.
 */
const DEEP_HISTORY_BARS = 3000;

export async function getStrategyWeights(): Promise<Record<string, { weight: number; enabled: boolean }>> {
  try {
    const configs = await prisma.strategyConfig.findMany();
    if (configs.length === 0) return defaultWeights();
    const out: Record<string, { weight: number; enabled: boolean }> = {};
    for (const c of configs) out[c.key] = { weight: c.weight, enabled: c.enabled };
    // Fill any strategies added after the DB was seeded.
    for (const s of STRATEGIES) {
      if (!out[s.key]) out[s.key] = { weight: s.defaultWeight, enabled: true };
    }
    return out;
  } catch (err) {
    logger.warn("signals.weights.db_unavailable", { error: String(err) });
    return defaultWeights();
  }
}

function defaultWeights(): Record<string, { weight: number; enabled: boolean }> {
  return Object.fromEntries(STRATEGIES.map((s) => [s.key, { weight: s.defaultWeight, enabled: true }]));
}

export async function ensureStrategyConfigs(): Promise<void> {
  for (const s of STRATEGIES) {
    await prisma.strategyConfig.upsert({
      where: { key: s.key },
      update: {},
      create: { key: s.key, name: s.name, description: s.description, weight: s.defaultWeight },
    });
  }
}

/**
 * Run full analysis with DB-backed adaptive weights.
 *
 * Also pulls a lower-timeframe series so the footprint engine can rebuild
 * a genuine bid × ask ladder per candle instead of falling back to a
 * modelled distribution. The sub-candle fetch is best-effort: if it fails
 * the analysis still runs, just with `footprint.fidelity === "estimated"`.
 *
 * Two further best-effort series:
 *  - 1m candles for the Market Pulse window, sized to the requested window
 *    so its "normal volume" baseline is always strictly wider than the
 *    window itself (otherwise every multiple collapses to 1x).
 *  - deep same-timeframe history for the Chart Analyst's analogue search.
 *    More history means more precedents; without it the search falls back to
 *    the analysis window and simply finds fewer.
 */
export async function analyzeSymbol(
  symbol: string,
  timeframe: Timeframe,
  pulseWindowMinutes = 60
): Promise<FullAnalysis> {
  const subTf = FOOTPRINT_SOURCE[timeframe];
  // Window + a 4x baseline, with headroom. Binance caps a single call at 1500.
  const minuteBars = Math.min(1500, Math.max(360, pulseWindowMinutes * 5));
  const [candles, weights, subCandles, minuteCandles, deepCandles] = await Promise.all([
    fetchKlines(symbol, timeframe, ENGINE_DEFAULTS.analysisLookback),
    getStrategyWeights(),
    subTf
      ? fetchKlines(symbol, subTf, 1000).catch((err) => {
          logger.warn("signals.subcandles.unavailable", { symbol, subTf, error: String(err) });
          return null;
        })
      : Promise.resolve(null),
    // 1m series powers the Market Pulse window independently of the chart TF.
    fetchKlines(symbol, "1m", minuteBars).catch((err) => {
      logger.warn("signals.minutecandles.unavailable", { symbol, error: String(err) });
      return null;
    }),
    fetchKlinesPaged(symbol, timeframe, DEEP_HISTORY_BARS).catch((err) => {
      logger.warn("signals.deepcandles.unavailable", { symbol, error: String(err) });
      return null;
    }),
  ]);
  return analyzeMarket(symbol, timeframe, candles, {
    weights,
    subCandles,
    subTimeframe: subTf ?? undefined,
    minuteCandles,
    pulseWindowMinutes,
    deepCandles,
  });
}

/**
 * Persist a signal if the analysis produced a qualifying setup and there is
 * no similar active signal already open for the pair/timeframe.
 *
 * Records what all three independent analysts said at this moment, even though
 * they did not produce the signal (the composite ensemble did). That is what
 * makes per-analyst win rates measurable rather than assumed: the analysts are
 * scored on every signal they had an opinion about, and an analyst that
 * abstained is recorded as having abstained rather than as silent.
 */
export async function maybePersistSignal(analysis: FullAnalysis): Promise<string | null> {
  const setup = analysis.setup;
  if (!setup) return null;
  try {
    const existing = await prisma.signal.findFirst({
      where: { symbol: analysis.symbol, timeframe: analysis.timeframe, status: "ACTIVE" },
    });
    if (existing) return null;

    const verdicts = buildVerdicts(
      analysis.chartAnalyst,
      analysis.candleCloseExpansion,
      analysis.rangeTrading
    );

    const signal = await prisma.signal.create({
      data: {
        symbol: analysis.symbol,
        timeframe: analysis.timeframe,
        side: setup.side,
        entry: setup.entry,
        stopLoss: setup.stopLoss,
        tp1: setup.tp1,
        tp2: setup.tp2,
        tp3: setup.tp3,
        riskReward: setup.riskReward,
        confidence: setup.confidence,
        confidenceLabel: setup.confidenceLabel,
        expectedMovePct: setup.expectedMovePct,
        estHoldingMin: setup.estHoldingMin,
        reasoning: setup.reasoning,
        invalidation: setup.invalidation,
        strategyScores: setup.strategyScores as object[],
        source: "COMPOSITE",
        analystVerdicts: verdicts as unknown as object[],
        marketSnapshot: {
          price: analysis.price,
          bias: analysis.bias,
          bullishProbability: analysis.bullishProbability,
          trend: analysis.structure.trend,
          volumeRelative: analysis.volume.relative,
          delta: analysis.volume.delta,
          cumulativeDelta: analysis.orderFlow.cumulativeDelta,
          liquidationPressure: {
            long: analysis.liquidations.longLiquidationPressure,
            short: analysis.liquidations.shortLiquidationPressure,
          },
        },
      },
    });

    await dispatchAlert({
      title: `${setup.side} ${analysis.symbol} ${analysis.timeframe} — ${setup.confidence}% ${setup.confidenceLabel}`,
      body: [
        `Entry ${setup.entry} | SL ${setup.stopLoss} | TP1 ${setup.tp1} | TP2 ${setup.tp2} | TP3 ${setup.tp3} | RR ${setup.riskReward}`,
        ...setup.reasoning.slice(0, 4).map((r) => `• ${r}`),
      ].join("\n"),
      symbol: analysis.symbol,
      side: setup.side,
      confidence: setup.confidence,
    });

    logger.info("signals.created", { id: signal.id, symbol: analysis.symbol, side: setup.side, confidence: setup.confidence });
    return signal.id;
  } catch (err) {
    logger.error("signals.persist.failed", { error: String(err) });
    return null;
  }
}

/**
 * Persist a scanner-originated signal from a confluence setup.
 *
 * Same collection, same lifecycle, same guard against duplicating an open
 * position — only `source: CONFLUENCE` distinguishes it, so Signal History and
 * every performance number treat both origins alike.
 *
 * Returns null for NO_TRADE. That is the common case by design: the scanner
 * looks at hundreds of symbols and most of them have nothing worth trading.
 */
export async function maybePersistConfluenceSignal(
  setup: ConfluenceSetup,
  extra: { quoteVolume?: number; priceChangePercent?: number } = {}
): Promise<string | null> {
  if (setup.decision === "NO_TRADE") return null;
  if (setup.entry === null || setup.stopLoss === null || setup.target1 === null || setup.target2 === null) {
    return null;
  }

  const isLong = setup.decision === "LONG";
  const side = isLong ? "BUY" : "SELL";
  const entry = setup.entry;

  // tp1/tp2 are the analysts' own targets. tp3 is an extension of the same
  // geometry — the Signal lifecycle needs three levels, and inventing a third
  // *analyst* target would be dressing up arithmetic as analysis, so it is
  // labelled for what it is in the reasoning below.
  const tp1 = setup.target1;
  const tp2 = setup.target2 !== setup.target1 ? setup.target2 : entry + (setup.target1 - entry) * 1.5;
  const tp3 = entry + (tp2 - entry) * 1.5;

  const expectedMovePct = Number((((tp2 - entry) / entry) * 100).toFixed(2));
  const tfMin = TIMEFRAME_MINUTES[setup.timeframe as Timeframe] ?? 60;

  try {
    const existing = await prisma.signal.findFirst({
      where: { symbol: setup.symbol, timeframe: setup.timeframe, status: "ACTIVE" },
    });
    if (existing) return null;

    const signal = await prisma.signal.create({
      data: {
        symbol: setup.symbol,
        timeframe: setup.timeframe,
        side,
        entry,
        stopLoss: setup.stopLoss,
        tp1,
        tp2,
        tp3,
        riskReward: setup.riskReward ?? 0,
        confidence: setup.confidence,
        confidenceLabel: setup.confidenceLabel,
        expectedMovePct,
        // Confluence setups are structural rather than momentum reads, so they
        // get a wider window than the composite engine's ATR-scaled estimate.
        estHoldingMin: tfMin * 12,
        reasoning: [
          ...setup.explanation,
          `TP3 (${tp3.toFixed(6).replace(/0+$/, "")}) is a 1.5x extension of the analyst target, not an analyst projection.`,
        ],
        invalidation: setup.invalidation,
        // Empty by design: no composite strategy produced this, and writing
        // fabricated scores here would corrupt the learning engine's weights.
        strategyScores: [],
        source: "CONFLUENCE",
        analystVerdicts: setup.verdicts as unknown as object[],
        confluence: setup as unknown as object,
        marketSnapshot: {
          price: setup.price,
          decision: setup.decision,
          confluenceVerdict: setup.confluenceVerdict,
          independentBases: isLong ? setup.long.independentBases : setup.short.independentBases,
          longConfidence: setup.long.confidence,
          shortConfidence: setup.short.confidence,
          disagreement: setup.disagreement.present,
          quoteVolume: extra.quoteVolume ?? null,
          priceChangePercent: extra.priceChangePercent ?? null,
        },
      },
    });

    await dispatchAlert({
      title: `🔥 ${setup.decision} ${setup.symbol} ${setup.timeframe} — ${setup.confidence}% confluence (${setup.confluenceVerdict})`,
      body: [
        `Entry ${entry} | SL ${setup.stopLoss} | TP ${tp1} / ${tp2} | RR ${setup.riskReward}`,
        ...setup.explanation.slice(0, 4).map((r) => `• ${r}`),
      ].join("\n"),
      symbol: setup.symbol,
      side,
      confidence: setup.confidence,
    });

    logger.info("signals.confluence.created", {
      id: signal.id,
      symbol: setup.symbol,
      decision: setup.decision,
      confidence: setup.confidence,
      bases: isLong ? setup.long.independentBases : setup.short.independentBases,
    });
    return signal.id;
  } catch (err) {
    logger.error("signals.confluence.persist.failed", { symbol: setup.symbol, error: String(err) });
    return null;
  }
}

/**
 * Evaluate open signals against current prices: mark TP/SL hits, close
 * finished trades and feed the outcome into the learning engine.
 */
export async function evaluateOpenSignals(): Promise<{ evaluated: number; closed: number }> {
  const open = await prisma.signal.findMany({ where: { status: { in: ["ACTIVE", "TP1_HIT", "TP2_HIT"] } } });
  let closed = 0;

  for (const sig of open) {
    try {
      const ticker = await fetchTicker(sig.symbol);
      const price = ticker.lastPrice;
      const isBuy = sig.side === "BUY";

      const hitSL = isBuy ? price <= sig.stopLoss : price >= sig.stopLoss;
      const hitTP3 = isBuy ? price >= sig.tp3 : price <= sig.tp3;
      const hitTP2 = isBuy ? price >= sig.tp2 : price <= sig.tp2;
      const hitTP1 = isBuy ? price >= sig.tp1 : price <= sig.tp1;

      const ageMin = (Date.now() - sig.createdAt.getTime()) / 60000;
      const expired = ageMin > sig.estHoldingMin * 3;

      let newStatus = sig.status;
      let finished = false;
      if (hitSL) { newStatus = "STOPPED"; finished = true; }
      else if (hitTP3) { newStatus = "TP3_HIT"; finished = true; }
      else if (hitTP2) { newStatus = "TP2_HIT"; }
      else if (hitTP1) { newStatus = "TP1_HIT"; }
      else if (expired) { newStatus = "EXPIRED"; finished = true; }

      if (newStatus === sig.status && !finished) continue;

      const pnlPct = ((price - sig.entry) / sig.entry) * 100 * (isBuy ? 1 : -1);

      // Only closing signals get the outcome pass: it costs one extra klines
      // call, and a signal that is merely progressing has no outcome yet.
      const outcome = finished ? await analyseClosedSignal(sig, newStatus, pnlPct) : null;

      await prisma.signal.update({
        where: { id: sig.id },
        data: {
          status: newStatus,
          ...(finished
            ? { closedAt: new Date(), closedPrice: price, resultPnlPct: Number(pnlPct.toFixed(3)) }
            : {}),
          ...(outcome
            ? {
                outcomeReason: outcome.reason,
                outcomeAnalysis: outcome as unknown as object,
              }
            : {}),
        },
      });

      if (finished) {
        closed++;
        await recordLearning(sig.id, sig.side as "BUY" | "SELL", pnlPct, sig.strategyScores as unknown as StrategyScore[]);
        await dispatchAlert({
          title: `${sig.symbol} ${sig.side} ${newStatus === "STOPPED" ? "stopped out" : newStatus === "EXPIRED" ? "expired" : "hit final target"}`,
          body: [
            `Result: ${pnlPct.toFixed(2)}% | Entry ${sig.entry} → ${price}`,
            ...(outcome ? [`${outcome.reasonLabel}. ${outcome.detail[0] ?? ""}`] : []),
          ].join("\n"),
          symbol: sig.symbol,
          side: sig.side as "BUY" | "SELL",
        });
      }
    } catch (err) {
      logger.warn("signals.evaluate.failed", { id: sig.id, error: String(err) });
    }
  }
  return { evaluated: open.length, closed };
}

/**
 * Measure what price actually did between entry and close, then classify why
 * the signal worked or didn't.
 *
 * The extra klines call is what separates "stopped out" from "ran 2R in favour
 * and then reversed" — two results that a P/L figure alone records
 * identically, and which say opposite things about whether the entry was good.
 *
 * Best-effort: a failed fetch means the signal still closes, just without an
 * outcome analysis. Never let attribution block the lifecycle.
 */
async function analyseClosedSignal(
  sig: {
    id: string;
    symbol: string;
    timeframe: string;
    side: string;
    entry: number;
    stopLoss: number;
    tp1: number;
    tp2: number;
    tp3: number;
    createdAt: Date;
    analystVerdicts: unknown;
  },
  status: string,
  pnlPct: number
) {
  const input: OutcomeSignal = {
    side: sig.side as "BUY" | "SELL",
    entry: sig.entry,
    stopLoss: sig.stopLoss,
    tp1: sig.tp1,
    tp2: sig.tp2,
    tp3: sig.tp3,
    status,
    resultPnlPct: Number(pnlPct.toFixed(3)),
    timeframe: sig.timeframe,
    verdicts: Array.isArray(sig.analystVerdicts)
      ? (sig.analystVerdicts as unknown as AnalystVerdict[])
      : [],
  };

  const fromTime = Math.floor(sig.createdAt.getTime() / 1000);
  try {
    // 500 bars covers the longest holding window the expiry rule allows on
    // every timeframe the worker runs.
    const candles = await fetchKlines(sig.symbol, sig.timeframe, 500);
    return classifyOutcome(input, computeExcursion(candles, input, fromTime));
  } catch (err) {
    logger.warn("signals.excursion.unavailable", { id: sig.id, error: String(err) });
    return classifyOutcome(input, computeExcursion([], input, fromTime));
  }
}

async function recordLearning(
  signalId: string,
  side: "BUY" | "SELL",
  pnlPct: number,
  strategyScores: StrategyScore[]
): Promise<void> {
  const win = pnlPct > 0;
  const outcome = { side, win, pnlPct };
  const adjustments = computeWeightAdjustments(strategyScores, outcome);
  const retro = buildTradeRetrospective(strategyScores, outcome);

  await prisma.learningRecord.create({
    data: {
      signalId,
      features: strategyScores as unknown as object[],
      outcome: win ? "WIN" : "LOSS",
      pnlPct: Number(pnlPct.toFixed(3)),
      analysis: retro,
      adjustments: adjustments as unknown as object[],
    },
  });

  // Apply bounded weight updates + rolling per-strategy performance.
  for (const adj of adjustments) {
    const direction = side === "BUY" ? 1 : -1;
    const score = strategyScores.find((s) => s.key === adj.key);
    const agreed = score ? Math.sign(score.score) === direction : false;
    await prisma.strategyConfig
      .update({
        where: { key: adj.key },
        data: {
          weight: adj.after,
          totalTrades: { increment: agreed ? 1 : 0 },
          wins: { increment: agreed && win ? 1 : 0 },
          losses: { increment: agreed && !win ? 1 : 0 },
          sumRR: { increment: agreed ? pnlPct : 0 },
        },
      })
      .catch(() => undefined);
  }
  logger.info("learning.recorded", { signalId, outcome: win ? "WIN" : "LOSS", adjustments: adjustments.length });
}
