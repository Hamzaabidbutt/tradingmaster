import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { buildPostMortem, PostMortemSignal } from "@/engines/postMortem";
import { OutcomeAnalysis } from "@/engines/types";
import { refreshOpenSignalsInBackground } from "@/services/signalLifecycle";

export const dynamic = "force-dynamic";

/**
 * Why the winners won and the losers lost.
 *
 * Reads the closed record and hands it to a pure engine. Deliberately not
 * filtered to a source or a timeframe by default: the comparisons *between*
 * those groups are the findings, and pre-filtering would remove the very
 * contrast the page exists to show.
 */

/** Rows read. Enough to make the slices meaningful without paging the world. */
const TAKE = 1000;

export async function GET(req: NextRequest) {
  const take = Math.min(TAKE, Math.max(50, Number(req.nextUrl.searchParams.get("take") ?? TAKE)));

  try {
    // Advance open positions first, so a page that has been idle does not
    // report stale statuses as if they were final.
    refreshOpenSignalsInBackground();

    const rows = await prisma.signal.findMany({
      orderBy: { createdAt: "desc" },
      take,
      select: {
        id: true,
        symbol: true,
        timeframe: true,
        side: true,
        status: true,
        source: true,
        confidence: true,
        entry: true,
        stopLoss: true,
        tp1: true,
        resultPnlPct: true,
        outcomeReason: true,
        outcomeAnalysis: true,
        regime: true,
        shadow: true,
        earlyExitReason: true,
        managementStage: true,
        createdAt: true,
        closedAt: true,
      },
    });

    const signals: PostMortemSignal[] = rows.map((r) => ({
      id: r.id,
      symbol: r.symbol,
      timeframe: r.timeframe,
      side: r.side as "BUY" | "SELL",
      status: r.status,
      source: r.source,
      confidence: r.confidence,
      entry: r.entry,
      stopLoss: r.stopLoss,
      tp1: r.tp1,
      resultPnlPct: r.resultPnlPct,
      outcomeReason: r.outcomeReason,
      outcomeAnalysis: (r.outcomeAnalysis as unknown as OutcomeAnalysis) ?? null,
      regime: r.regime,
      shadow: r.shadow === true,
      earlyExitReason: r.earlyExitReason,
      managementStage: r.managementStage,
      createdAt: Math.floor(r.createdAt.getTime() / 1000),
      closedAt: r.closedAt ? Math.floor(r.closedAt.getTime() / 1000) : null,
    }));

    return NextResponse.json(buildPostMortem(signals));
  } catch (err) {
    // Fail soft: this is one page, and an unreachable database must not make
    // it look like the record is empty rather than unavailable.
    return NextResponse.json(
      { ...buildPostMortem([]), error: `The signal record could not be read: ${String(err)}` },
      { status: 200 }
    );
  }
}
