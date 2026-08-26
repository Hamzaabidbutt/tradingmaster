import { NextRequest, NextResponse } from "next/server";
import { isValidTimeframe, Timeframe } from "@/lib/config";
import { DEFAULT_SCAN_DEPTH, scanLiquidationReversals } from "@/services/scanService";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Liquidation spike sweep — coins where forced flow has just printed at an
 * extreme, and what reversal followed.
 *
 * `setup.forced` comes back as `inferred` here, never `confirmed`: a universe
 * sweep reads candles, not a per-symbol forced-order websocket. The field says
 * so rather than the caller having to know.
 *
 * A failed sweep returns an empty result with the reason rather than a 500.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const tfParam = q.get("timeframe") ?? "15m";
  const timeframe: Timeframe = isValidTimeframe(tfParam) ? tfParam : "15m";
  const depth = Math.min(200, Math.max(10, Number(q.get("depth") ?? DEFAULT_SCAN_DEPTH)));

  try {
    return NextResponse.json(await scanLiquidationReversals({ timeframe, depth }));
  } catch (err) {
    return NextResponse.json(
      {
        timeframe,
        bottoms: [],
        tops: [],
        watching: [],
        scanned: 0,
        failed: 0,
        scannedAt: Math.floor(Date.now() / 1000),
        error: String(err),
      },
      { status: 200 }
    );
  }
}
