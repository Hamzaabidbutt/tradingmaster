import { NextRequest, NextResponse } from "next/server";
import { isValidTimeframe, Timeframe } from "@/lib/config";
import { DEFAULT_SCAN_DEPTH, scanInstitutional } from "@/services/scanService";
import {
  persistInstitutionalSignalsInBackground,
  refreshOpenSignalsInBackground,
} from "@/services/signalLifecycle";

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
 * `depth=0` (the default) sweeps the entire ranked universe. Each symbol costs
 * an extra open-interest request on top of its klines, so this is the heaviest
 * of the sweeps — hence the longer duration budget rather than a smaller
 * universe, which would have quietly answered a narrower question.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const tfParam = q.get("timeframe") ?? "1h";
  const timeframe: Timeframe = isValidTimeframe(tfParam) ? tfParam : "1h";
  const depth = Math.max(0, Number(q.get("depth") ?? DEFAULT_SCAN_DEPTH));

  try {
    const scan = await scanInstitutional({ timeframe, depth });

    // Qualified footprints become tracked signals on the same lifecycle as
    // every other source, which is what makes the page's success/partial/
    // failed record a measurement rather than a claim.
    persistInstitutionalSignalsInBackground(scan.footprints);
    refreshOpenSignalsInBackground();

    return NextResponse.json(scan);
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
