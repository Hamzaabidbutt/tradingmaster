import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Performance analytics: real measured win rates over multiple horizons —
 * never a hardcoded accuracy claim. All figures derive from closed signals
 * stored in MySQL.
 */
export async function GET() {
  try {
    const now = Date.now();
    const dayAgo = new Date(now - 24 * 3600 * 1000);
    const weekAgo = new Date(now - 7 * 24 * 3600 * 1000);
    const monthAgo = new Date(now - 30 * 24 * 3600 * 1000);

    const closed = await prisma.signal.findMany({
      where: { status: { in: ["TP1_HIT", "TP2_HIT", "TP3_HIT", "STOPPED", "EXPIRED"] }, closedAt: { not: null } },
      orderBy: { closedAt: "desc" },
      take: 1000,
    });

    const bucket = (since?: Date) => {
      const set = since ? closed.filter((s) => s.closedAt && s.closedAt >= since) : closed;
      const wins = set.filter((s) => (s.resultPnlPct ?? 0) > 0);
      const losses = set.filter((s) => (s.resultPnlPct ?? 0) <= 0);
      return {
        total: set.length,
        wins: wins.length,
        losses: losses.length,
        winRate: set.length ? Number(((wins.length / set.length) * 100).toFixed(1)) : null,
        avgProfit: wins.length ? Number((wins.reduce((a, s) => a + (s.resultPnlPct ?? 0), 0) / wins.length).toFixed(2)) : null,
        avgLoss: losses.length ? Number((losses.reduce((a, s) => a + (s.resultPnlPct ?? 0), 0) / losses.length).toFixed(2)) : null,
      };
    };

    const [active, totalSignals, strategies] = await Promise.all([
      prisma.signal.count({ where: { status: { in: ["ACTIVE", "TP1_HIT", "TP2_HIT"] } } }),
      prisma.signal.count(),
      prisma.strategyConfig.findMany(),
    ]);

    const ranked = strategies
      .filter((s) => s.totalTrades >= 3)
      .map((s) => ({
        key: s.key,
        name: s.name,
        winRate: Number(((s.wins / Math.max(1, s.totalTrades)) * 100).toFixed(1)),
        totalTrades: s.totalTrades,
        weight: s.weight,
      }))
      .sort((a, b) => b.winRate - a.winRate);

    return NextResponse.json({
      today: bucket(dayAgo),
      weekly: bucket(weekAgo),
      monthly: bucket(monthAgo),
      overall: bucket(),
      activeSignals: active,
      totalSignals,
      bestStrategy: ranked[0] ?? null,
      worstStrategy: ranked[ranked.length - 1] ?? null,
      strategyAccuracy: ranked,
    });
  } catch {
    return NextResponse.json({
      today: null, weekly: null, monthly: null, overall: null,
      activeSignals: 0, totalSignals: 0,
      bestStrategy: null, worstStrategy: null, strategyAccuracy: [],
      warning: "database unavailable",
    });
  }
}
