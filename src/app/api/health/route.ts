import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  let db = "up";
  try {
    // MongoDB has no SQL to send, so the liveness check is a driver-level
    // ping. `$queryRaw` would throw on this connector regardless of the
    // database being healthy, reporting "down" for a working cluster.
    await prisma.$runCommandRaw({ ping: 1 });
  } catch {
    db = "down";
  }
  return NextResponse.json({
    status: "ok",
    db,
    uptime: process.uptime(),
    ts: new Date().toISOString(),
  });
}
