import { NextRequest, NextResponse } from "next/server";
import { fetchDepth } from "@/lib/binance";
import { isTradableSymbol } from "@/lib/symbols";
import { detectOrderWalls } from "@/engines/orderWalls";

export const dynamic = "force-dynamic";

/**
 * Buyer / seller order walls for one symbol.
 *
 * Depth is fetched at 500 levels rather than the default 100: a wall 2% away
 * on a liquid perp sits well outside the top 100 levels, and truncating the
 * book would silently report "no walls" for the levels that matter most.
 *
 * The snapshot is a moment in time — resting size can be pulled — so the
 * response carries `sampledAt` and the client is expected to re-poll rather
 * than treat a wall as durable.
 */
export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol") ?? "";
  if (!(await isTradableSymbol(symbol)))
    return NextResponse.json({ error: "Unknown symbol" }, { status: 400 });

  try {
    const depth = await fetchDepth(symbol, 500);
    const mid =
      depth.bids[0] && depth.asks[0] ? (depth.bids[0][0] + depth.asks[0][0]) / 2 : 0;
    return NextResponse.json(detectOrderWalls(mid, depth.bids, depth.asks));
  } catch {
    return NextResponse.json({ error: "Upstream market data unavailable" }, { status: 502 });
  }
}
