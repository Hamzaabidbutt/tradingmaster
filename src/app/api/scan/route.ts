import { NextRequest, NextResponse } from "next/server";
import { isValidTimeframe, Timeframe } from "@/lib/config";
import {
  DEFAULT_SCAN_DEPTH,
  loadPersistedScan,
  mergeScans,
  scanUniverse,
  UniverseScan,
} from "@/services/scanService";
import {
  persistScanSignalsInBackground,
  refreshOpenSignalsInBackground,
} from "@/services/signalLifecycle";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Universe scan — the data behind 🔥 High Probability Setups.
 *
 * Coverage comes from two sources merged into one answer:
 *
 *  * a live scan of the top `depth` symbols by 24 h volume, computed now;
 *  * every symbol the background worker has scanned recently, read from the
 *    database.
 *
 * The live pass now covers the whole universe by default — a 400-bar klines
 * call costs 2 weight, so ~530 symbols is ~1060 against a ~2400/min budget.
 * The persisted merge is kept because it still earns its place: it fills in
 * symbols a sweep cut short by the function time limit never reached, and
 * survives a Binance hiccup mid-scan. The response reports exactly where its
 * coverage came from rather than implying it looked at everything itself.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const tfParam = q.get("timeframe") ?? "1h";
  const timeframe: Timeframe = isValidTimeframe(tfParam) ? tfParam : "1h";
  // 0 = the whole ranked universe, which is now the default.
  const depth = Math.max(0, Number(q.get("depth") ?? DEFAULT_SCAN_DEPTH));
  const minParam = q.get("min");
  const minConfidence = minParam && !Number.isNaN(Number(minParam)) ? Number(minParam) : undefined;
  const includePersisted = q.get("persisted") !== "false";

  try {
    const live = await scanUniverse({ timeframe, depth, minConfidence });

    // Turn qualifying setups into tracked signals, and refresh the ones
    // already open. On a long-lived host the worker does this; serverless has
    // no worker, so the scan itself drives the lifecycle. Both are
    // fire-and-forget — the dashboard must not wait on database writes.
    persistScanSignalsInBackground([...live.long, ...live.short]);
    refreshOpenSignalsInBackground();

    if (!includePersisted) return NextResponse.json(wire(live));

    const persisted = await loadPersistedScan(timeframe);
    return NextResponse.json(wire(mergeScans(live, persisted)));
  } catch (err) {
    // A scan failure must not blank the dashboard: return an explicit empty
    // scan with the reason, so the page renders its "no setups" state with an
    // honest explanation rather than an infinite spinner.
    return NextResponse.json(
      {
        timeframe,
        long: [],
        short: [],
        nearMisses: [],
        noTradeCount: 0,
        scanned: 0,
        failed: 0,
        partial: true,
        coverage: { onDemand: 0, persisted: 0, universe: 0 },
        minConfidence: minConfidence ?? 70,
        scannedAt: Math.floor(Date.now() / 1000),
        error: String(err),
      },
      { status: 200 }
    );
  }
}

/**
 * Drop `scannedSymbols` before serialising.
 *
 * It exists so `mergeScans` can tell "the live pass rejected this coin" from
 * "the live pass never saw it". The browser never reads it, and at full
 * coverage it is 500-odd strings on every 45 s poll.
 */
function wire(scan: UniverseScan): Omit<UniverseScan, "scannedSymbols"> {
  const { scannedSymbols: _drop, ...rest } = scan;
  return rest;
}
