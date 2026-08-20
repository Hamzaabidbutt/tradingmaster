import { NextResponse } from "next/server";
import { fetchFuturesSymbols } from "@/lib/symbols";

export const dynamic = "force-dynamic";

/**
 * The searchable symbol universe: every tradable USDT-M perpetual on Binance.
 * `fetchFuturesSymbols` caches for an hour server-side; the browser caches
 * for five minutes so opening the search box is instant after the first load.
 */
export async function GET() {
  const symbols = await fetchFuturesSymbols();
  if (symbols.length === 0) {
    // Degraded, not broken — the client falls back to the curated list.
    return NextResponse.json(
      { symbols: [], warning: "Binance exchangeInfo unavailable" },
      { status: 200 }
    );
  }
  return NextResponse.json(
    { symbols },
    { headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=3600" } }
  );
}
