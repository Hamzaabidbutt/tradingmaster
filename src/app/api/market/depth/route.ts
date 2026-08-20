import { NextRequest, NextResponse } from "next/server";
import { fetchDepth } from "@/lib/binance";
import { isTradableSymbol } from "@/lib/symbols";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol") ?? "";
  if (!(await isTradableSymbol(symbol)))
    return NextResponse.json({ error: "Unknown symbol" }, { status: 400 });
  try {
    return NextResponse.json(await fetchDepth(symbol));
  } catch {
    return NextResponse.json({ error: "Upstream market data unavailable" }, { status: 502 });
  }
}
