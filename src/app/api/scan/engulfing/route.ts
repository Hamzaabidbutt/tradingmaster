import { NextRequest, NextResponse } from "next/server";
import { isValidTimeframe, Timeframe } from "@/lib/config";
import { DEFAULT_SCAN_DEPTH, scanEngulfing } from "@/services/scanService";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Bullish-engulfing sweep, 4h by default.
 *
 * The timeframe default is deliberate rather than inherited: an engulfing on
 * 1m is a rounding error, and the pattern only carries weight once a bar
 * represents enough traded volume that swallowing the previous one means
 * clearing real positioning.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const tfParam = q.get("timeframe") ?? "4h";
  const timeframe: Timeframe = isValidTimeframe(tfParam) ? tfParam : "4h";
  const depth = Math.max(0, Number(q.get("depth") ?? DEFAULT_SCAN_DEPTH));

  try {
    return NextResponse.json(await scanEngulfing({ timeframe, depth }));
  } catch (err) {
    return NextResponse.json(
      {
        timeframe,
        confirmed: [],
        unconfirmed: [],
        scanned: 0,
        failed: 0,
        scannedAt: Math.floor(Date.now() / 1000),
        error: String(err),
      },
      { status: 200 }
    );
  }
}
