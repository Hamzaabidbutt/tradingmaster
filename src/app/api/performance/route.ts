import { NextRequest, NextResponse } from "next/server";
import { getPerformance } from "@/services/performanceService";

export const dynamic = "force-dynamic";

/**
 * Per-analyst and overall signal performance.
 *
 * Derived from closed signals on every request rather than read from stored
 * counters — see performanceService for why. Cheap enough to do live: one
 * indexed query and a pass over at most `take` rows.
 */
export async function GET(req: NextRequest) {
  const take = Math.min(5000, Math.max(50, Number(req.nextUrl.searchParams.get("take") ?? 2000)));
  const report = await getPerformance(take);
  return NextResponse.json(report);
}
