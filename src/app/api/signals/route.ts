import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol") ?? undefined;
  const status = req.nextUrl.searchParams.get("status") ?? undefined;
  const limit = Math.min(100, Number(req.nextUrl.searchParams.get("limit") ?? 30));

  try {
    const signals = await prisma.signal.findMany({
      where: {
        ...(symbol ? { symbol } : {}),
        ...(status ? { status: status as never } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return NextResponse.json({ signals });
  } catch {
    // DB down shouldn't break the dashboard — signals are enrichment.
    return NextResponse.json({ signals: [], warning: "database unavailable" });
  }
}
