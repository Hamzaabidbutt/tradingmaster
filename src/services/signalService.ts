import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { dispatchAlert } from "@/lib/alerts";
import { fetchKlines, fetchTicker } from "@/lib/binance";
import { analyzeMarket } from "@/engines/analyzer";
import { STRATEGIES } from "@/engines/strategies";
import { buildTradeRetrospective, computeWeightAdjustments } from "@/engines/learning";
import { FullAnalysis, StrategyScore } from "@/engines/types";
import { ENGINE_DEFAULTS, FOOTPRINT_SOURCE, Timeframe } from "@/lib/config";

/**
 * Signal lifecycle service: generation → persistence → evaluation → learning.
 */

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
 */
export async function analyzeSymbol(symbol: string, timeframe: Timeframe): Promise<FullAnalysis> {
  const subTf = FOOTPRINT_SOURCE[timeframe];
  const [candles, weights, subCandles] = await Promise.all([
    fetchKlines(symbol, timeframe, ENGINE_DEFAULTS.analysisLookback),
    getStrategyWeights(),
    subTf
      ? fetchKlines(symbol, subTf, 1000).catch((err) => {
          logger.warn("signals.subcandles.unavailable", { symbol, subTf, error: String(err) });
          return null;
        })
      : Promise.resolve(null),
  ]);
  return analyzeMarket(symbol, timeframe, candles, {
    weights,
    subCandles,
    subTimeframe: subTf ?? undefined,
  });
}

/**
 * Persist a signal if the analysis produced a qualifying setup and there is
 * no similar active signal already open for the pair/timeframe.
 */
export async function maybePersistSignal(analysis: FullAnalysis): Promise<string | null> {
  const setup = analysis.setup;
  if (!setup) return null;
  try {
    const existing = await prisma.signal.findFirst({
      where: { symbol: analysis.symbol, timeframe: analysis.timeframe, status: "ACTIVE" },
    });
    if (existing) return null;

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
      await prisma.signal.update({
        where: { id: sig.id },
        data: {
          status: newStatus,
          ...(finished
            ? { closedAt: new Date(), closedPrice: price, resultPnlPct: Number(pnlPct.toFixed(3)) }
            : {}),
        },
      });

      if (finished) {
        closed++;
        await recordLearning(sig.id, sig.side as "BUY" | "SELL", pnlPct, sig.strategyScores as unknown as StrategyScore[]);
        await dispatchAlert({
          title: `${sig.symbol} ${sig.side} ${newStatus === "STOPPED" ? "stopped out" : newStatus === "EXPIRED" ? "expired" : "hit final target"}`,
          body: `Result: ${pnlPct.toFixed(2)}% | Entry ${sig.entry} → ${price}`,
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
