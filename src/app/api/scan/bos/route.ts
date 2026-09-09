import { NextRequest, NextResponse } from "next/server";
import { isValidTimeframe, Timeframe } from "@/lib/config";
import { DEFAULT_SCAN_DEPTH, scanBosMomentum } from "@/services/scanService";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Break-of-structure momentum sweep, 1h by default.
 *
 * The default is deliberate rather than inherited. Below an hour the universe
 * breaks structure constantly — on 5m a large share of perpetuals takes out
 * some swing every hour — and the lists fill with events that are technically
 * breaks and mean nothing. An hour is roughly where a broken swing represents
 * enough traded volume that clearing it meant clearing real positioning.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const tfParam = q.get("timeframe") ?? "1h";
  const timeframe: Timeframe = isValidTimeframe(tfParam) ? tfParam : "1h";
  const depth = Math.max(0, Number(q.get("depth") ?? DEFAULT_SCAN_DEPTH));

  try {
    return NextResponse.json(await scanBosMomentum({ timeframe, depth }));
  } catch (err) {
    /* 200 with an error field, like the other sweeps: a failed scan is a
       state the page renders, not an HTTP failure the client has to special
       case. The empty buckets keep the response shape stable. */
    return NextResponse.json(
      {
        timeframe,
        held: [],
        retesting: [],
        pending: [],
        fresh: [],
        failed: [],
        extended: [],
        forming: [],
        scanned: 0,
        failed_count: 0,
        scannedAt: Math.floor(Date.now() / 1000),
        error: String(err),
      },
      { status: 200 }
    );
  }
}
