import { NextRequest, NextResponse } from "next/server";
import { scanRecovery } from "@/services/scanService";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Deep-drawdown recovery sweep.
 *
 * Depth defaults lower than the other sweeps and that is not an oversight:
 * this one needs 1000 daily candles per symbol, which Binance charges at
 * weight 5 rather than 2, so a full-universe pass would genuinely exceed the
 * rate budget. Volume ranking means the default prefix is the part of the
 * market anyone would actually trade; `depth=0` runs everything for anyone who
 * wants to accept the cost.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const depth = Math.max(0, Number(q.get("depth") ?? 200));

  try {
    return NextResponse.json(await scanRecovery({ depth }));
  } catch (err) {
    return NextResponse.json(
      {
        candidates: [],
        watching: [],
        falling: [],
        scanned: 0,
        eligible: 0,
        failed: 0,
        scannedAt: Math.floor(Date.now() / 1000),
        error: String(err),
      },
      { status: 200 }
    );
  }
}
