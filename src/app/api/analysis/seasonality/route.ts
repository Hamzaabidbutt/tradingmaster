import { NextRequest, NextResponse } from "next/server";
import { fetchKlinesPaged } from "@/lib/binance";
import { cacheGet, cacheSet } from "@/lib/cache";
import { rateLimit } from "@/lib/rateLimit";
import { isTradableSymbol } from "@/lib/symbols";
import { buildHourlyProfile, HourlyProfile } from "@/engines/hourlyProfile";
import { buildWeekProfile, WeekProfile } from "@/engines/weekProfile";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Everything the clock determines: hour of day, weekday, session, and whether
 * any directional pattern in them survives being checked.
 *
 * Always reads **1-hour** candles regardless of the chart's timeframe — the
 * question is about the clock, and 4h bars would put six hours of the day
 * under one label.
 *
 * A year by default, which is the shortest window that gives the weekday-hour
 * cells enough bars for the repeat test to say anything. It is still one
 * market cycle rather than a sample of many, and both engines say so.
 */

export interface SeasonalityReport {
  symbol: string;
  days: number;
  hourly: HourlyProfile;
  week: WeekProfile;
}

const DEFAULT_DAYS = 365;
const MIN_DAYS = 42;
const MAX_DAYS = 730;

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const symbol = (q.get("symbol") ?? "").toUpperCase();
  const days = Math.min(MAX_DAYS, Math.max(MIN_DAYS, Number(q.get("days") ?? DEFAULT_DAYS)));

  if (!(await isTradableSymbol(symbol))) {
    return NextResponse.json({ error: "Unknown symbol" }, { status: 400 });
  }

  const ip = req.headers.get("x-forwarded-for") ?? "local";
  if (!rateLimit(`seasonality:${ip}`, 20, 60_000).allowed) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const cacheKey = `seasonality:${symbol}:${days}`;
  const cached = cacheGet<SeasonalityReport>(cacheKey);
  if (cached) return NextResponse.json(cached);

  try {
    const candles = await fetchKlinesPaged(symbol, "1h", days * 24);
    const report: SeasonalityReport = {
      symbol,
      days,
      hourly: buildHourlyProfile(symbol, candles),
      week: buildWeekProfile(symbol, candles),
    };
    // An hour. The profile is built from thousands of bars and one more
    // closing candle cannot move it, so re-paging that history per page view
    // would spend real rate budget to produce an identical answer.
    cacheSet(cacheKey, report, 3_600_000);
    return NextResponse.json(report);
  } catch (err) {
    return NextResponse.json({ error: "Seasonality read failed", detail: String(err) }, { status: 500 });
  }
}
