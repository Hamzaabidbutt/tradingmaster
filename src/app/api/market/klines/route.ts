import { NextRequest, NextResponse } from "next/server";
import { fetchKlines } from "@/lib/binance";
import { isValidTimeframe } from "@/lib/config";
import { isTradableSymbol } from "@/lib/symbols";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol") ?? "";
  const tf = req.nextUrl.searchParams.get("timeframe") ?? "";
  const limit = Math.min(1500, Number(req.nextUrl.searchParams.get("limit") ?? 500));

  if (!isValidTimeframe(tf)) return NextResponse.json({ error: "Unknown timeframe" }, { status: 400 });
  if (!(await isTradableSymbol(symbol)))
    return NextResponse.json({ error: "Unknown symbol" }, { status: 400 });

  try {
    const candles = await fetchKlines(symbol, tf, limit);
    return NextResponse.json({ symbol, timeframe: tf, candles });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Upstream market data unavailable" },
      { status: 502 }
    );
  }
}
