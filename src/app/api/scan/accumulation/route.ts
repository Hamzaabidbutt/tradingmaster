import { NextRequest, NextResponse } from "next/server";
import { isValidTimeframe, Timeframe } from "@/lib/config";
import { DEFAULT_SCAN_DEPTH, scanAccumulation } from "@/services/scanService";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Accumulation sweep — coins building a base that buyers are defending.
 *
 * Narrower than /api/scan on purpose. It asks a single question with a
 * fixed checklist (defended level, positive delta, stacked buy imbalance,
 * absorption, accumulation profile, discount pricing) rather than scoring
 * general confluence, so a coin can rank highly here and nowhere else.
 *
 * A failed sweep returns an empty result with the reason rather than a 500,
 * so the panel renders an honest "nothing found / here is why" state instead
 * of spinning forever.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const tfParam = q.get("timeframe") ?? "1h";
  const timeframe: Timeframe = isValidTimeframe(tfParam) ? tfParam : "1h";
  const depth = Math.max(0, Number(q.get("depth") ?? DEFAULT_SCAN_DEPTH));

  try {
    return NextResponse.json(await scanAccumulation({ timeframe, depth }));
  } catch (err) {
    return NextResponse.json(
      {
        timeframe,
        candidates: [],
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
