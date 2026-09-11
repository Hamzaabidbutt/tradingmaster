import { NextRequest, NextResponse } from "next/server";
import { isValidTimeframe, Timeframe } from "@/lib/config";
import { scanFlowAlignment } from "@/services/scanService";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Price, cumulative delta and open interest agreement sweep, 1h by default.
 *
 * The default is deliberate. Below an hour the three axes flip against each
 * other constantly — open interest publishes every five minutes at best, so on
 * a 5m window a single print's rounding decides the whole read — and the lists
 * fill with agreement that lasts one bar. An hour is roughly where a window
 * covers enough open-interest prints for their direction to mean something.
 *
 * `depth` defaults lower than the single-call sweeps because this one costs
 * two requests per symbol: the open-interest series has no substitute.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const tfParam = q.get("timeframe") ?? "1h";
  const timeframe: Timeframe = isValidTimeframe(tfParam) ? tfParam : "1h";
  const lookbackParam = Number(q.get("lookback") ?? 24);
  const lookback = Number.isFinite(lookbackParam) ? lookbackParam : 24;
  const depthRaw = Number(q.get("depth") ?? 75);
  const depth = Number.isFinite(depthRaw) ? Math.max(0, depthRaw) : 75;

  try {
    return NextResponse.json(await scanFlowAlignment({ timeframe, lookback, depth }));
  } catch (err) {
    /* 200 with an error field, like the other sweeps: a failed scan is a state
       the page renders, not an HTTP failure the client has to special case.
       The empty buckets keep the response shape stable. */
    return NextResponse.json(
      {
        timeframe,
        lookback,
        longsBuilding: [],
        shortsBuilding: [],
        covering: [],
        deleveraging: [],
        absorbedRallies: [],
        absorbedSelloffs: [],
        scanned: 0,
        noRead: 0,
        failed_count: 0,
        scannedAt: Math.floor(Date.now() / 1000),
        error: String(err),
      },
      { status: 200 }
    );
  }
}
