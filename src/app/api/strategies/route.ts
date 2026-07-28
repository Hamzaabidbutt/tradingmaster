import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { AuthError, requireRole } from "@/lib/auth";
import { STRATEGIES } from "@/engines/strategies";
import { ensureStrategyConfigs } from "@/services/signalService";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await ensureStrategyConfigs();
    const configs = await prisma.strategyConfig.findMany({ orderBy: { name: "asc" } });
    const strategies = configs.map((c) => ({
      key: c.key,
      name: c.name,
      description: c.description,
      enabled: c.enabled,
      weight: c.weight,
      totalTrades: c.totalTrades,
      wins: c.wins,
      losses: c.losses,
      winRate: c.totalTrades > 0 ? Number(((c.wins / c.totalTrades) * 100).toFixed(1)) : null,
      avgRR: c.totalTrades > 0 ? Number((c.sumRR / c.totalTrades).toFixed(2)) : null,
    }));
    return NextResponse.json({ strategies });
  } catch {
    // Serve code-defined defaults when the DB is unreachable.
    return NextResponse.json({
      strategies: STRATEGIES.map((s) => ({
        key: s.key,
        name: s.name,
        description: s.description,
        enabled: true,
        weight: s.defaultWeight,
        totalTrades: 0,
        wins: 0,
        losses: 0,
        winRate: null,
        avgRR: null,
      })),
      warning: "database unavailable — showing defaults",
    });
  }
}

const patchSchema = z.object({
  key: z.string().min(1).max(50),
  enabled: z.boolean().optional(),
  weight: z.number().min(0).max(2.5).optional(),
});

export async function PATCH(req: NextRequest) {
  try {
    const user = await requireRole("ANALYST");
    const parsed = patchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    const { key, enabled, weight } = parsed.data;

    const updated = await prisma.strategyConfig.update({
      where: { key },
      data: {
        ...(enabled !== undefined ? { enabled } : {}),
        ...(weight !== undefined ? { weight } : {}),
      },
    });
    await prisma.auditLog.create({
      data: { userId: user.id, action: "strategy.update", meta: { key, enabled, weight } },
    });
    return NextResponse.json({ ok: true, strategy: updated });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}
