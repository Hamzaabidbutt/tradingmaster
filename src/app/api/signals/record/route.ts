import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { classifyBucket, OutcomeBucket } from "@/engines/outcomeBuckets";
import { OutcomeAnalysis } from "@/engines/types";
import { refreshOpenSignalsInBackground } from "@/services/signalLifecycle";

export const dynamic = "force-dynamic";

const SOURCES = ["COMPOSITE", "CONFLUENCE", "INSTITUTIONAL"] as const;
type Source = (typeof SOURCES)[number];

export interface RecordRow {
  id: string;
  symbol: string;
  timeframe: string;
  side: "BUY" | "SELL";
  status: string;
  confidence: number;
  entry: number;
  resultPnlPct: number | null;
  outcomeReason: string | null;
  bucket: OutcomeBucket;
  createdAt: string;
  closedAt: string | null;
}

export interface RecordReport {
  source: Source | null;
  counts: Record<OutcomeBucket, number>;
  /** resolved = successful + partial + failed; the denominator that matters */
  resolved: number;
  /**
   * Successful plus half of partial, over resolved. Null until enough have
   * closed — a rate from three trades is noise wearing a percentage sign.
   */
  accuracyPct: number | null;
  minSample: number;
  avgPnlPct: number | null;
  signals: RecordRow[];
  note: string;
}

/**
 * How many resolved signals before a rate is quoted.
 *
 * Ten is still a small sample and the note says so, but below it the number
 * swings by ten points on a single trade, which is worse than showing nothing.
 */
const MIN_SAMPLE = 10;

/**
 * Per-source signal record: how many succeeded, partially succeeded, failed.
 *
 * Reads the same `Signal` collection and the same `classifyBucket` as Signal
 * History and the analytics page. That is the point — a scanner page that
 * scored its own results would eventually disagree with the rest of the app
 * about what "successful" means.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const raw = (q.get("source") ?? "").toUpperCase();
  const source = (SOURCES as readonly string[]).includes(raw) ? (raw as Source) : null;
  const take = Math.min(500, Math.max(10, Number(q.get("take") ?? 200)));

  try {
    // Advance any open positions first, so a page that has been idle does not
    // report stale statuses as if they were current.
    refreshOpenSignalsInBackground();

    const rows = await prisma.signal.findMany({
      where: source ? { source } : undefined,
      orderBy: { createdAt: "desc" },
      take,
      select: {
        id: true,
        symbol: true,
        timeframe: true,
        side: true,
        status: true,
        confidence: true,
        entry: true,
        resultPnlPct: true,
        outcomeReason: true,
        outcomeAnalysis: true,
        createdAt: true,
        closedAt: true,
      },
    });

    const signals: RecordRow[] = rows.map((r) => ({
      id: r.id,
      symbol: r.symbol,
      timeframe: r.timeframe,
      side: r.side as "BUY" | "SELL",
      status: r.status,
      confidence: r.confidence,
      entry: r.entry,
      resultPnlPct: r.resultPnlPct,
      outcomeReason: r.outcomeReason,
      bucket: classifyBucket({
        status: r.status,
        resultPnlPct: r.resultPnlPct,
        outcomeAnalysis: (r.outcomeAnalysis as unknown as OutcomeAnalysis) ?? null,
      }),
      createdAt: r.createdAt.toISOString(),
      closedAt: r.closedAt ? r.closedAt.toISOString() : null,
    }));

    const counts: Record<OutcomeBucket, number> = {
      active: 0,
      successful: 0,
      partial: 0,
      failed: 0,
    };
    for (const s of signals) counts[s.bucket]++;

    const resolved = counts.successful + counts.partial + counts.failed;
    const closed = signals.filter((s) => s.bucket !== "active" && s.resultPnlPct != null);
    const enough = resolved >= MIN_SAMPLE;

    return NextResponse.json({
      source,
      counts,
      resolved,
      // A partial counts as half: the direction was right and the first target
      // paid, but the trade did not finish green. Same rule as everywhere else.
      accuracyPct: enough
        ? Number((((counts.successful + counts.partial * 0.5) / resolved) * 100).toFixed(1))
        : null,
      minSample: MIN_SAMPLE,
      avgPnlPct:
        closed.length > 0
          ? Number(
              (closed.reduce((s, x) => s + (x.resultPnlPct ?? 0), 0) / closed.length).toFixed(2)
            )
          : null,
      signals,
      note: enough
        ? `Measured over ${resolved} resolved signals. A partial — reached the first target, then reversed — counts as half a success, because it was a correct read managed badly rather than a wrong one. This is a record of what happened, not a projection of what will.`
        : `${resolved} resolved signal${resolved === 1 ? "" : "s"} so far, below the ${MIN_SAMPLE} needed to quote a rate. The individual results are listed; the percentage is withheld because at this sample size one trade moves it by ten points.`,
    } satisfies RecordReport);
  } catch (err) {
    return NextResponse.json(
      {
        source,
        counts: { active: 0, successful: 0, partial: 0, failed: 0 },
        resolved: 0,
        accuracyPct: null,
        minSample: MIN_SAMPLE,
        avgPnlPct: null,
        signals: [],
        note: "The signal record is unavailable — the database could not be reached.",
        error: String(err),
      },
      { status: 200 }
    );
  }
}
