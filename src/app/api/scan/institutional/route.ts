import { NextRequest, NextResponse } from "next/server";
import { isValidTimeframe, Timeframe } from "@/lib/config";
import { scanInstitutional } from "@/services/scanService";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Institutional-footprint sweep.
 *
 * Looks for price bands where several *different kinds* of evidence land on
 * the same area — demand imbalance, an order block, absorption, forced
 * selling, divergence, rejection wicks, discount location, open interest.
 * One mechanism repeating is not confluence; four distinct ones are.
 *
 * Depth defaults lower than the other sweeps because each symbol costs an
 * extra open-interest request on top of its klines.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const tfParam = q.get("timeframe") ?? "1h";
  const timeframe: Timeframe = isValidTimeframe(tfParam) ? tfParam : "1h";
  const depth = Math.min(100, Math.max(10, Number(q.get("depth") ?? 50)));

  try {
    return NextResponse.json(await scanInstitutional({ timeframe, depth }));
  } catch (err) {
    return NextResponse.json(
      {
        timeframe,
        footprints: [],
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
