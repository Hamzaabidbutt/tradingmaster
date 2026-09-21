import { NextRequest, NextResponse } from "next/server";
import { isValidTimeframe, Timeframe } from "@/lib/config";
import { DEFAULT_SCAN_DEPTH, DivergenceSource, scanDivergences } from "@/services/scanService";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Price/indicator divergence sweep across RSI and cumulative delta, 1h default.
 *
 * Every timeframe is accepted. Divergence is scale-free in the sense that the
 * arithmetic is identical on 1m and 1d — but it is emphatically not
 * scale-neutral in meaning: fast timeframes diverge constantly, and a 1m sweep
 * will return a long list of readings that resolve themselves within the hour.
 * That is a property of the pattern rather than of this route, and the page
 * says so.
 *
 * `?source=rsi` or `?source=cvd` runs one indicator instead of both, which is
 * what the two scanner pages use. `?period=` overrides the RSI lookback; 14 is
 * Wilder's default and the one every charting package draws, so changing it
 * means the numbers here stop matching the reader's own chart.
 */
function sourcesFrom(raw: string | null): DivergenceSource[] | undefined {
  if (!raw) return undefined;
  const wanted = raw.split(",").map((s) => s.trim().toLowerCase());
  const picked = (["rsi", "cvd"] as const).filter((s) => wanted.includes(s));
  /* A list naming only unrecognised sources falls back to both rather than
     running nothing: a typo that silently returns an empty page looks exactly
     like a quiet market. */
  return picked.length > 0 ? [...picked] : undefined;
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const tfParam = q.get("timeframe") ?? "1h";
  const timeframe: Timeframe = isValidTimeframe(tfParam) ? tfParam : "1h";
  const depthRaw = Number(q.get("depth") ?? DEFAULT_SCAN_DEPTH);
  const depth = Number.isFinite(depthRaw) ? Math.max(0, depthRaw) : DEFAULT_SCAN_DEPTH;

  const periodRaw = Number(q.get("period"));
  const rsiPeriod = Number.isFinite(periodRaw) && periodRaw >= 2 ? periodRaw : undefined;

  try {
    return NextResponse.json(
      await scanDivergences({
        timeframe,
        depth,
        rsiPeriod,
        sources: sourcesFrom(q.get("source")),
      })
    );
  } catch (err) {
    /* 200 with an error field, like the other sweeps: a failed scan is a state
       the page renders, not an HTTP failure the client has to special case. */
    return NextResponse.json(
      {
        timeframe,
        rsiPeriod: rsiPeriod ?? 14,
        rows: [],
        scanned: 0,
        noDivergence: 0,
        failed_count: 0,
        scannedAt: Math.floor(Date.now() / 1000),
        error: String(err),
      },
      { status: 200 }
    );
  }
}
