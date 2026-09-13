import { NextRequest, NextResponse } from "next/server";
import { isValidTimeframe, Timeframe } from "@/lib/config";
import { DEFAULT_SCAN_DEPTH, scanCandleLadder } from "@/services/scanService";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Staircase-run sweep, 1h by default.
 *
 * Every timeframe is accepted, including the fast ones the other sweeps steer
 * away from. The reason the BOS and flow scans default high does not apply
 * here: those measure things that need time to mean anything — a broken swing
 * has to represent real positioning, open interest publishes every five
 * minutes at best — whereas a run of consecutive higher lows is exactly as
 * true on 1m as on 1d. It is simply a smaller event, and `minBars` is the
 * control for that, so a 1m sweep asking for twelve bars is a perfectly
 * sensible thing to want.
 *
 * The hour default is only where most people start.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const tfParam = q.get("timeframe") ?? "1h";
  const timeframe: Timeframe = isValidTimeframe(tfParam) ? tfParam : "1h";
  const minBarsRaw = Number(q.get("minBars") ?? 4);
  const minBars = Number.isFinite(minBarsRaw) ? minBarsRaw : 4;
  const depthRaw = Number(q.get("depth") ?? DEFAULT_SCAN_DEPTH);
  const depth = Number.isFinite(depthRaw) ? Math.max(0, depthRaw) : DEFAULT_SCAN_DEPTH;

  try {
    return NextResponse.json(await scanCandleLadder({ timeframe, minBars, depth }));
  } catch (err) {
    /* 200 with an error field, like the other sweeps: a failed scan is a state
       the page renders, not an HTTP failure the client has to special case.
       The empty buckets keep the response shape stable. */
    return NextResponse.json(
      {
        timeframe,
        climbing: [],
        falling: [],
        stalled: [],
        broken: [],
        scanned: 0,
        noRun: 0,
        failed_count: 0,
        scannedAt: Math.floor(Date.now() / 1000),
        error: String(err),
      },
      { status: 200 }
    );
  }
}
