import { NextRequest, NextResponse } from "next/server";
import { fetchKlines } from "@/lib/binance";
import { readAlignment } from "@/engines/timeframeAlignment";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * The same symbol read on a ladder of clocks.
 *
 * Server-side so the browser makes one request instead of four, and so the
 * klines come from the cache the rest of the app already fills rather than
 * spending fresh rate budget on every terminal that happens to be open.
 *
 * The ladder is fixed rather than derived from the chart's current timeframe.
 * A ribbon whose columns move when you change timeframe is not a context
 * strip — it is a second chart control, and you cannot learn to read it at a
 * glance if it never shows the same thing twice.
 */
const LADDER = ["15m", "1h", "4h", "1d"] as const;

/** Enough for a 50-period average plus room for the swing detector. */
const BARS = 200;

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol")?.toUpperCase();
  if (!symbol || !/^[A-Z0-9]{4,20}$/.test(symbol)) {
    return NextResponse.json({ error: "A valid symbol is required." }, { status: 400 });
  }

  /* One timeframe failing must not blank the whole ribbon: three clocks read
     is strictly better than none, and the engine already drops series it
     cannot read rather than counting them as neutral. */
  const series = await Promise.all(
    LADDER.map(async (timeframe) => {
      try {
        return { timeframe, candles: await fetchKlines(symbol, timeframe, BARS) };
      } catch (err) {
        logger.warn("alignment.timeframe_unavailable", { symbol, timeframe, error: String(err) });
        return { timeframe, candles: [] };
      }
    })
  );

  try {
    return NextResponse.json(readAlignment(series));
  } catch (err) {
    logger.error("alignment.failed", { symbol, error: String(err) });
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
