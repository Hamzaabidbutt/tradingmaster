import { NextRequest, NextResponse } from "next/server";
import { isValidTimeframe, Timeframe } from "@/lib/config";
import { DEFAULT_SCAN_DEPTH, scanComposite } from "@/services/scanService";
import {
  persistCompositeSignalsInBackground,
  refreshOpenSignalsInBackground,
} from "@/services/signalLifecycle";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Composite sweep — the weighted 28-strategy ensemble, per coin.
 *
 * The dashboard board asks whether three *independent* analysts agree, which
 * is a narrow question that most coins answer with silence. This asks the
 * other one: what does the full ensemble conclude on its own? A coin can carry
 * a strong composite setup and no confluence at all, and that is information
 * rather than a contradiction.
 *
 * `depth=0` (the default) sweeps the entire ranked universe.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const tfParam = q.get("timeframe") ?? "1h";
  const timeframe: Timeframe = isValidTimeframe(tfParam) ? tfParam : "1h";
  const depth = Math.max(0, Number(q.get("depth") ?? DEFAULT_SCAN_DEPTH));
  const minParam = q.get("min");
  const minConfidence = minParam && !Number.isNaN(Number(minParam)) ? Number(minParam) : undefined;

  try {
    const scan = await scanComposite({ timeframe, depth, minConfidence });

    // Track what the sweep found, and advance whatever is already open. Both
    // fire-and-forget: a scan response must never wait on database writes.
    persistCompositeSignalsInBackground([...scan.long, ...scan.short]);
    refreshOpenSignalsInBackground();

    return NextResponse.json(scan);
  } catch (err) {
    return NextResponse.json(
      {
        timeframe,
        long: [],
        short: [],
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
