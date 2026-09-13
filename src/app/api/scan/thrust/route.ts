import { NextRequest, NextResponse } from "next/server";
import { isValidTimeframe, Timeframe } from "@/lib/config";
import { DEFAULT_SCAN_DEPTH, scanRetestThrust } from "@/services/scanService";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Change-of-character → retest → thrust sweep, 1h by default.
 *
 * Every timeframe is accepted. The sequence is scale-free — a leg, a base, a
 * close through the last opposing swing and a return to it are the same events
 * on 5m as on 1d — and the engine measures the leg in ATR rather than percent
 * precisely so the threshold travels between them.
 *
 * What does change with the timeframe is the precedent study, and not in the
 * direction people expect: a fast timeframe fits more instances into the same
 * loaded window, so its sample is *larger* and its rate is worth more, while a
 * daily sweep may find one or two previous cases and should be read as one or
 * two cases.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const tfParam = q.get("timeframe") ?? "1h";
  const timeframe: Timeframe = isValidTimeframe(tfParam) ? tfParam : "1h";
  const depthRaw = Number(q.get("depth") ?? DEFAULT_SCAN_DEPTH);
  const depth = Number.isFinite(depthRaw) ? Math.max(0, depthRaw) : DEFAULT_SCAN_DEPTH;

  try {
    return NextResponse.json(await scanRetestThrust({ timeframe, depth }));
  } catch (err) {
    /* 200 with an error field, like the other sweeps: a failed scan is a state
       the page renders, not an HTTP failure the client has to special case.
       The empty buckets keep the response shape stable. */
    return NextResponse.json(
      {
        timeframe,
        armed: [],
        held: [],
        thrusting: [],
        extended: [],
        failed: [],
        scanned: 0,
        noSetup: 0,
        failed_count: 0,
        scannedAt: Math.floor(Date.now() / 1000),
        error: String(err),
      },
      { status: 200 }
    );
  }
}
