import { NextRequest, NextResponse } from "next/server";
import { buildScorecard } from "@/services/scanLedger";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Read-only view of the ledger. No auth: it reads rows the app wrote about
 * itself and costs one database query, not a universe sweep.
 */
export async function GET(req: NextRequest) {
  const daysRaw = Number(req.nextUrl.searchParams.get("days") ?? 90);
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(365, daysRaw) : 90;
  try {
    return NextResponse.json(await buildScorecard({ days }));
  } catch (err) {
    /* 200 with an error field, like the sweeps: an unreachable database is a
       state the page renders, not an HTTP failure the client special-cases. */
    return NextResponse.json(
      {
        rows: [],
        totalObserved: 0,
        totalScored: 0,
        since: null,
        minSample: 20,
        windowBars: 20,
        targetAtr: 2,
        stopAtr: 1,
        error: String(err),
      },
      { status: 200 }
    );
  }
}
