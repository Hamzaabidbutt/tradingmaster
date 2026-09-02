import { NextRequest, NextResponse } from "next/server";
import { fetchFundingRateHist, fetchKlines, fetchOpenInterestHist } from "@/lib/binance";
import { cacheGet, cacheSet } from "@/lib/cache";
import { isValidTimeframe, Timeframe } from "@/lib/config";
import { rateLimit } from "@/lib/rateLimit";
import { isTradableSymbol } from "@/lib/symbols";
import { detectInstitutional } from "@/engines/institutional";
import { InstitutionalSetup } from "@/engines/types";

export const dynamic = "force-dynamic";

/**
 * The institutional footprint for **one** symbol, so the chart can draw it.
 *
 * The sweep at `/api/scan/institutional` answers "which coins have a
 * footprint"; this answers "show me the one I am looking at". Same engine,
 * same checklist, same thresholds — deliberately, because a chart overlay that
 * disagreed with the scanner about whether an item was found would make both
 * untrustworthy.
 *
 * Nothing is persisted here. The scan path is what creates tracked signals;
 * opening a chart is not a signal, and writing one every time somebody hovers
 * a coin would fill the record with rows nobody acted on.
 */

/** Bars fed to the engine — matches the scan so the two cannot diverge. */
const BARS = 400;

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const symbol = (q.get("symbol") ?? "").toUpperCase();
  const tfParam = q.get("timeframe") ?? "1h";

  if (!isValidTimeframe(tfParam)) {
    return NextResponse.json({ error: "Unknown timeframe" }, { status: 400 });
  }
  const timeframe: Timeframe = tfParam;
  if (!(await isTradableSymbol(symbol))) {
    return NextResponse.json({ error: "Unknown symbol" }, { status: 400 });
  }

  const ip = req.headers.get("x-forwarded-for") ?? "local";
  if (!rateLimit(`institutional:${ip}`, 60, 60_000).allowed) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const cacheKey = `institutional:one:${symbol}:${timeframe}`;
  const cached = cacheGet<InstitutionalSetup>(cacheKey);
  if (cached) return NextResponse.json(cached);

  try {
    // Open interest and funding are best-effort: losing either costs one
    // checklist item, and the engine reports that item as unreadable rather
    // than absent. Losing the candles is fatal, so that one is not caught.
    const [candles, oi, funding] = await Promise.all([
      fetchKlines(symbol, timeframe, BARS),
      fetchOpenInterestHist(symbol, "1h", 48).catch(() => []),
      fetchFundingRateHist(symbol, 21).catch(() => []),
    ]);

    const setup = detectInstitutional(
      symbol,
      timeframe,
      candles,
      oi.length > 0 ? oi.map((p) => p.openInterest) : null,
      funding.length > 0 ? funding : null
    );
    // Longer than the 5s analysis cache: the footprint is built from closed
    // bars and barely moves between them, and this is the heaviest read on the
    // terminal page.
    cacheSet(cacheKey, setup, 30_000);
    return NextResponse.json(setup);
  } catch (err) {
    return NextResponse.json({ error: "Footprint read failed", detail: String(err) }, { status: 500 });
  }
}
