import { NextRequest, NextResponse } from "next/server";
import { isValidTimeframe, Timeframe } from "@/lib/config";
import { DEFAULT_SCAN_DEPTH, scanZoneReversals } from "@/services/scanService";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Zone reversal sweep — coins reacting off an order block or fair value gap.
 *
 * Narrower than /api/scan: it asks whether price has returned to a zone that
 * still holds unfilled orders and been *expelled* from it, which is a different
 * question from general confluence and produces a different list.
 *
 * A failed sweep returns an empty result with the reason rather than a 500, so
 * the page renders an honest "nothing found / here is why" state.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const tfParam = q.get("timeframe") ?? "1h";
  const timeframe: Timeframe = isValidTimeframe(tfParam) ? tfParam : "1h";
  const depth = Math.max(0, Number(q.get("depth") ?? DEFAULT_SCAN_DEPTH));

  try {
    return NextResponse.json(await scanZoneReversals({ timeframe, depth }));
  } catch (err) {
    return NextResponse.json(
      {
        timeframe,
        bullish: [],
        bearish: [],
        forming: [],
        scanned: 0,
        failed: 0,
        scannedAt: Math.floor(Date.now() / 1000),
        error: String(err),
      },
      { status: 200 }
    );
  }
}
