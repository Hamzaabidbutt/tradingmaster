import { NextRequest, NextResponse } from "next/server";
import { isValidTimeframe, Timeframe } from "@/lib/config";
import { scanCascadeRisk } from "@/services/scanService";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Cascade-risk sweep — where forced flow would begin, and how crowded that
 * side is.
 *
 * The companion to /api/scan/liquidations, which reports cascades that have
 * already fired. This one reports the conditions for one: unswept stop pools
 * and inferred leverage bands within reach, with open interest saying which
 * cohort has been building.
 *
 * It does not forecast. Nothing in public market data can say whether price
 * will reach a level — see the header of `src/engines/cascadeRisk.ts`. Depth
 * defaults lower than the other sweeps because this one costs an extra open
 * interest request per symbol.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const tfParam = q.get("timeframe") ?? "15m";
  const timeframe: Timeframe = isValidTimeframe(tfParam) ? tfParam : "15m";
  const depth = Math.min(120, Math.max(10, Number(q.get("depth") ?? 60)));

  try {
    return NextResponse.json(await scanCascadeRisk({ timeframe, depth }));
  } catch (err) {
    return NextResponse.json(
      {
        timeframe,
        longFlush: [],
        shortSqueeze: [],
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
