import { NextRequest, NextResponse } from "next/server";
import { fetchOpenInterestHist, OpenInterestPeriod } from "@/lib/binance";
import { isValidTimeframe, Timeframe } from "@/lib/config";

export const dynamic = "force-dynamic";

/**
 * Open-interest history for the chart's own overlay.
 *
 * Binance serves open interest on its own fixed set of periods, which is not
 * the chart's timeframe list — there is no 1m, 3m or 1w series. `OI_PERIOD`
 * maps each chart interval onto the nearest one that exists, so the overlay
 * lines up with the candles instead of silently returning nothing on the
 * intervals Binance does not publish.
 *
 * The series is also capped at roughly 30 days by the exchange, so on a daily
 * chart the line covers only the right-hand end. That is a limit of the data,
 * not a bug, and the panel says so rather than drawing a line that stops for
 * no visible reason.
 */
const OI_PERIOD: Record<Timeframe, OpenInterestPeriod> = {
  "1m": "5m",
  "3m": "5m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1h",
  "2h": "2h",
  "4h": "4h",
  "6h": "6h",
  "8h": "12h",
  "12h": "12h",
  "1d": "1d",
  "1w": "1d",
  "1M": "1d",
};

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const symbol = (q.get("symbol") ?? "").toUpperCase();
  const tfParam = q.get("timeframe") ?? "1h";
  const timeframe: Timeframe = isValidTimeframe(tfParam) ? tfParam : "1h";
  const limit = Math.min(500, Math.max(30, Number(q.get("limit") ?? 500)));

  if (!/^[A-Z0-9]{4,20}$/.test(symbol)) {
    return NextResponse.json({ points: [], error: "Invalid symbol" }, { status: 200 });
  }

  try {
    const points = await fetchOpenInterestHist(symbol, OI_PERIOD[timeframe], limit);
    return NextResponse.json({
      symbol,
      timeframe,
      period: OI_PERIOD[timeframe],
      points,
    });
  } catch (err) {
    // Soft failure, like the wall and funding fetches: the overlay is one line
    // on a chart, and losing it must never take the chart with it.
    return NextResponse.json({ points: [], error: String(err) }, { status: 200 });
  }
}
