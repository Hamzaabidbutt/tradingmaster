import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { AuthError, requireRole } from "@/lib/auth";
import { sendWebhook } from "@/lib/alerts";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireRole("VIEWER");
    const channels = await prisma.alertChannel.findMany({ where: { userId: user.id } });
    return NextResponse.json({ channels });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ channels: [] });
  }
}

const createSchema = z.object({
  type: z.enum(["browser", "email", "telegram", "discord", "webhook"]),
  config: z.record(z.string(), z.unknown()).default({}),
});

export async function POST(req: NextRequest) {
  try {
    const user = await requireRole("VIEWER");
    const parsed = createSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

    const channel = await prisma.alertChannel.create({
      data: { userId: user.id, type: parsed.data.type, config: parsed.data.config as object },
    });

    // Fire a test event for webhook channels so users can verify wiring.
    if (parsed.data.type === "webhook" && typeof parsed.data.config.url === "string") {
      await sendWebhook(
        { title: "TradingMaster test alert", body: "Webhook channel connected successfully.", symbol: "TEST" },
        parsed.data.config.url
      );
    }
    return NextResponse.json({ channel });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: "Failed to create channel" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const user = await requireRole("VIEWER");
    const id = req.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    await prisma.alertChannel.deleteMany({ where: { id, userId: user.id } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: "Failed to delete channel" }, { status: 500 });
  }
}
