import { NextRequest, NextResponse } from "next/server";
import { fetchTicker } from "@/lib/binance";
import { MARKETS } from "@/lib/config";
import { isTradableSymbol } from "@/lib/symbols";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol");
  try {
    if (symbol) {
      if (!(await isTradableSymbol(symbol)))
        return NextResponse.json({ error: "Unknown symbol" }, { status: 400 });
      return NextResponse.json(await fetchTicker(symbol));
    }
    // No symbol = the header tape, which stays a curated strip by design.
    const all = await Promise.all(MARKETS.map((m) => fetchTicker(m.symbol).catch(() => null)));
    return NextResponse.json({ tickers: all.filter(Boolean) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Upstream market data unavailable" },
      { status: 502 }
    );
  }
}
