import { NextRequest, NextResponse } from "next/server";
import { fetchDepth } from "@/lib/binance";
import { isValidSymbol } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol") ?? "";
  if (!isValidSymbol(symbol)) return NextResponse.json({ error: "Unknown symbol" }, { status: 400 });
  try {
    return NextResponse.json(await fetchDepth(symbol));
  } catch {
    return NextResponse.json({ error: "Upstream market data unavailable" }, { status: 502 });
  }
}
