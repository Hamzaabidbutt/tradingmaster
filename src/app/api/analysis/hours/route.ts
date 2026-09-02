import { NextRequest, NextResponse } from "next/server";
import { fetchKlinesPaged } from "@/lib/binance";
import { cacheGet, cacheSet } from "@/lib/cache";
import { rateLimit } from "@/lib/rateLimit";
import { isTradableSymbol } from "@/lib/symbols";
import { buildHourlyProfile, HourlyProfile } from "@/engines/hourlyProfile";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * When this symbol is busy, and what price does then.
 *
 * Always reads **1-hour** candles regardless of the chart's timeframe — the
 * question is about the clock, and bucketing 4h bars would put six hours of
 * the day under one label.
 *
 * Ninety days by default. That is a deliberate compromise: shorter and each
 * hour holds too few samples to say anything, longer and the profile starts
 * describing a market structure that no longer exists. Even at ninety days it
 * is a description of one window, which the engine's own note says plainly.
 */

const DEFAULT_DAYS = 90;
const MIN_DAYS = 21;
const MAX_DAYS = 365;

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const symbol = (q.get("symbol") ?? "").toUpperCase();
  const days = Math.min(MAX_DAYS, Math.max(MIN_DAYS, Number(q.get("days") ?? DEFAULT_DAYS)));

  if (!(await isTradableSymbol(symbol))) {
    return NextResponse.json({ error: "Unknown symbol" }, { status: 400 });
  }

  const ip = req.headers.get("x-forwarded-for") ?? "local";
  if (!rateLimit(`hours:${ip}`, 20, 60_000).allowed) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const cacheKey = `hours:${symbol}:${days}`;
  const cached = cacheGet<HourlyProfile>(cacheKey);
  if (cached) return NextResponse.json(cached);

  try {
    const candles = await fetchKlinesPaged(symbol, "1h", days * 24);
    const profile = buildHourlyProfile(symbol, candles);
    // Cached for an hour: the profile is built from ~2000 bars and one more
    // closing bar cannot move it, so re-paging that history per page view
    // would spend rate budget to produce the same answer.
    cacheSet(cacheKey, profile, 3_600_000);
    return NextResponse.json(profile);
  } catch (err) {
    return NextResponse.json(
      { error: "Hourly profile failed", detail: String(err) },
      { status: 500 }
    );
  }
}
