import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { fetchKlinesPaged } from "@/lib/binance";
import { runBacktest } from "@/engines/backtest";
import { isValidSymbol, isValidTimeframe, Timeframe } from "@/lib/config";
import { rateLimit } from "@/lib/rateLimit";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const limit = Math.min(50, Number(req.nextUrl.searchParams.get("limit") ?? 20));
  try {
    const backtests = await prisma.backtest.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true, symbol: true, timeframe: true, strategyKey: true, metrics: true, createdAt: true },
    });
    return NextResponse.json({ backtests });
  } catch {
    return NextResponse.json({ backtests: [], warning: "database unavailable" });
  }
}

const runSchema = z.object({
  symbol: z.string(),
  timeframe: z.string(),
  strategyKey: z.string().default("all"),
  bars: z.number().min(400).max(3000).default(1500),
  minConfidence: z.number().min(50).max(95).default(65),
});

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for") ?? "local";
  const rl = rateLimit(`backtest:${ip}`, 6, 60_000);
  if (!rl.allowed) return NextResponse.json({ error: "Rate limit exceeded — backtests are expensive" }, { status: 429 });

  const parsed = runSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  const { symbol, timeframe, strategyKey, bars, minConfidence } = parsed.data;
  if (!isValidSymbol(symbol)) return NextResponse.json({ error: "Unknown symbol" }, { status: 400 });
  if (!isValidTimeframe(timeframe)) return NextResponse.json({ error: "Unknown timeframe" }, { status: 400 });

  try {
    const candles = await fetchKlinesPaged(symbol, timeframe, bars);
    if (candles.length < 400) {
      return NextResponse.json({ error: `Insufficient history: ${candles.length} bars` }, { status: 422 });
    }
    const metrics = runBacktest(symbol, timeframe as Timeframe, candles, {
      strategyKey,
      minConfidence,
      step: 3,
    });

    let id: string | null = null;
    try {
      const saved = await prisma.backtest.create({
        data: {
          symbol,
          timeframe,
          strategyKey,
          params: { bars, minConfidence },
          metrics: metrics as unknown as object,
          trades: metrics.equityCurve as unknown as object[],
        },
      });
      id = saved.id;
    } catch (err) {
      logger.warn("backtest.persist.failed", { error: String(err) });
    }

    return NextResponse.json({ id, metrics });
  } catch (err) {
    logger.error("backtest.failed", { symbol, timeframe, error: String(err) });
    return NextResponse.json({ error: "Backtest failed", detail: String(err) }, { status: 500 });
  }
}
