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
  confidenceLabel: string;
  /* The full geometry the signal was opened on. Without it the record can say
     a footprint failed but not what it actually proposed — which is the only
     way to tell a bad read from a bad stop. */
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp3: number;
  riskReward: number;
  expectedMovePct: number;
  /** the engine's own words at signal time */
  reasoning: string[];
  invalidation: string[];
  resultPnlPct: number | null;
  closedPrice: number | null;
  outcomeReason: string | null;
  bucket: OutcomeBucket;
  /** produced by the engine but not taken — the slot was occupied */
  shadow: boolean;
  /** BTC's regime when this signal was created */
  regime: string | null;
  createdAt: string;
  closedAt: string | null;
}

/** One slice of the record — the whole set, the taken half, or one regime. */
export interface RecordSlice {
  label: string;
  counts: Record<OutcomeBucket, number>;
  resolved: number;
  accuracyPct: number | null;
  avgPnlPct: number | null;
}

/** Prisma stores these as Json; they were written as string arrays. */
function asLines(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
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
  /**
   * The same record split three ways.
   *
   * `taken` versus `shadow` is the measurement that matters most: if the two
   * differ materially, the slot allocator — not the engine — is choosing what
   * gets recorded, and the headline number is a statement about timing rather
   * than about signal quality.
   */
  taken: RecordSlice;
  shadow: RecordSlice;
  /** per-BTC-regime slices, so a source that only works in one is visible */
  byRegime: RecordSlice[];
  signals: RecordRow[];
  note: string;
  regimeNote: string;
}

/**
 * How many resolved signals before a rate is quoted.
 *
 * Ten is still a small sample and the note says so, but below it the number
 * swings by ten points on a single trade, which is worse than showing nothing.
 */
const MIN_SAMPLE = 10;

/**
 * Reduce a set of signals to one comparable slice.
 *
 * Shared by the whole-record, taken/shadow and per-regime views so the three
 * can never drift into different definitions of "accuracy" — which is exactly
 * how a dashboard ends up quoting two win rates that disagree.
 */
function slice(label: string, rows: RecordRow[]): RecordSlice {
  const counts: Record<OutcomeBucket, number> = {
    active: 0,
    successful: 0,
    partial: 0,
    failed: 0,
  };
  for (const r of rows) counts[r.bucket]++;
  const resolved = counts.successful + counts.partial + counts.failed;
  const closed = rows.filter((r) => r.bucket !== "active" && r.resultPnlPct != null);
  return {
    label,
    counts,
    resolved,
    // A partial counts as half everywhere, including here.
    accuracyPct:
      resolved >= MIN_SAMPLE
        ? Number((((counts.successful + counts.partial * 0.5) / resolved) * 100).toFixed(1))
        : null,
    avgPnlPct:
      closed.length > 0
        ? Number((closed.reduce((s, x) => s + (x.resultPnlPct ?? 0), 0) / closed.length).toFixed(2))
        : null,
  };
}

const REGIME_LABEL: Record<string, string> = {
  risk_on: "BTC risk-on (uptrend, above its average)",
  risk_off: "BTC risk-off (downtrend, below its average)",
  mixed: "BTC mixed (trend and location disagree)",
  unknown: "BTC regime unreadable at signal time",
};

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
        confidenceLabel: true,
        entry: true,
        stopLoss: true,
        tp1: true,
        tp2: true,
        tp3: true,
        riskReward: true,
        expectedMovePct: true,
        reasoning: true,
        invalidation: true,
        resultPnlPct: true,
        closedPrice: true,
        outcomeReason: true,
        outcomeAnalysis: true,
        shadow: true,
        regime: true,
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
      confidenceLabel: r.confidenceLabel,
      entry: r.entry,
      stopLoss: r.stopLoss,
      tp1: r.tp1,
      tp2: r.tp2,
      tp3: r.tp3,
      riskReward: r.riskReward,
      expectedMovePct: r.expectedMovePct,
      reasoning: asLines(r.reasoning),
      invalidation: asLines(r.invalidation),
      resultPnlPct: r.resultPnlPct,
      closedPrice: r.closedPrice,
      outcomeReason: r.outcomeReason,
      shadow: r.shadow === true,
      regime: r.regime,
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

    const taken = slice("Taken", signals.filter((s) => !s.shadow));
    const shadow = slice("Shadow (suppressed by an occupied slot)", signals.filter((s) => s.shadow));

    const regimes = [...new Set(signals.map((s) => s.regime ?? "unknown"))];
    const byRegime = regimes
      .map((r) => slice(REGIME_LABEL[r] ?? r, signals.filter((s) => (s.regime ?? "unknown") === r)))
      .sort((a, b) => b.resolved - a.resolved);

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
      taken,
      shadow,
      byRegime,
      signals,
      regimeNote:
        byRegime.every((r) => r.resolved < MIN_SAMPLE)
          ? `No regime has ${MIN_SAMPLE} resolved signals yet, so no per-regime rate is quoted. This is the split worth waiting for: alt setups carry BTC beta, and a source that looks mediocre overall is often good in one regime and bad in the other — which a blended number can never show.`
          : `Rates are quoted only for regimes with at least ${MIN_SAMPLE} resolved signals. A large gap between them means the regime, not the setup, is doing much of the work.`,
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
        taken: slice("Taken", []),
        shadow: slice("Shadow (suppressed by an occupied slot)", []),
        byRegime: [],
        signals: [],
        regimeNote: "",
        note: "The signal record is unavailable — the database could not be reached.",
        error: String(err),
      },
      { status: 200 }
    );
  }
}
