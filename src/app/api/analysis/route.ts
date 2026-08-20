import { NextRequest, NextResponse } from "next/server";
import { isValidTimeframe } from "@/lib/config";
import { isTradableSymbol } from "@/lib/symbols";
import { rateLimit } from "@/lib/rateLimit";
import { analyzeSymbol, maybePersistSignal } from "@/services/signalService";
import { cacheGet, cacheSet } from "@/lib/cache";
import { FullAnalysis } from "@/engines/types";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/** Market Pulse windows the client may ask for, in minutes. */
const PULSE_WINDOWS = [5, 15, 60] as const;
const DEFAULT_PULSE_WINDOW = 60;

/**
 * Full market analysis for a symbol/timeframe. This is the heart of the
 * platform: every engine runs and the composite picture is returned.
 * Results are cached ~5s; qualifying setups are persisted as signals.
 */
export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol") ?? "";
  const tf = req.nextUrl.searchParams.get("timeframe") ?? "";
  if (!isValidTimeframe(tf)) return NextResponse.json({ error: "Unknown timeframe" }, { status: 400 });
  if (!(await isTradableSymbol(symbol)))
    return NextResponse.json({ error: "Unknown symbol" }, { status: 400 });

  const requested = Number(req.nextUrl.searchParams.get("pulseWindow"));
  const pulseWindow = (PULSE_WINDOWS as readonly number[]).includes(requested)
    ? requested
    : DEFAULT_PULSE_WINDOW;

  const ip = req.headers.get("x-forwarded-for") ?? "local";
  const rl = rateLimit(`analysis:${ip}`, 60, 60_000);
  if (!rl.allowed) return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });

  // The pulse window is part of the identity of the result — leaving it out
  // of the key would serve a stale window every time the user toggles.
  const cacheKey = `analysis:${symbol}:${tf}:${pulseWindow}`;
  const cached = cacheGet<FullAnalysis>(cacheKey);
  if (cached) return NextResponse.json(cached);

  try {
    const analysis = await analyzeSymbol(symbol, tf, pulseWindow);
    cacheSet(cacheKey, analysis, 5_000);
    // Fire-and-forget persistence — the response shouldn't wait on MySQL.
    maybePersistSignal(analysis).catch((err) =>
      logger.warn("analysis.persist.async_failed", { error: String(err) })
    );
    return NextResponse.json(analysis);
  } catch (err) {
    logger.error("analysis.failed", { symbol, tf, error: String(err) });
    return NextResponse.json({ error: "Analysis failed", detail: String(err) }, { status: 500 });
  }
}
