import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { parseVerdicts } from "@/services/performanceService";

export const dynamic = "force-dynamic";

/**
 * Signal History query API.
 *
 * Every filter is optional and they compose. Two of them cannot be expressed
 * as a Mongo predicate and are applied in memory after the query:
 *
 *  * `analyst` — the verdicts live in a JSON array, and Prisma's MongoDB
 *    connector has no operator for "array contains an object with these two
 *    fields". Filtering in code is correct and, at these row counts, fast.
 *  * `outcome=successful|failed` — the split is the *sign of the realised P/L*,
 *    which is a relation between fields rather than a value.
 *
 * Both are applied after fetching an over-sized page, so `limit` is still
 * honoured. `overFetched` tells the caller when the page may be incomplete.
 *
 * The four outcome buckets are mutually exclusive: TP1_HIT and TP2_HIT are
 * *running* positions (no `resultPnlPct` yet), so they are `active`, never
 * successful or failed. Same definition as performanceService, so the History
 * filters and the dashboard counts always agree.
 */

const ACTIVE_STATUSES = ["ACTIVE", "TP1_HIT", "TP2_HIT"] as const;
/** Statuses that end a signal and carry a realised P/L. */
const RESOLVED_STATUSES = ["TP3_HIT", "STOPPED", "EXPIRED"] as const;

type Outcome = "active" | "successful" | "failed" | "expired";

function isOutcome(v: string | null): v is Outcome {
  return v === "active" || v === "successful" || v === "failed" || v === "expired";
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const symbol = q.get("symbol") ?? undefined;
  const status = q.get("status") ?? undefined;
  const source = q.get("source") ?? undefined;
  const side = q.get("side") ?? undefined;
  const timeframe = q.get("timeframe") ?? undefined;
  const analyst = q.get("analyst") ?? undefined;
  const outcomeParam = q.get("outcome");
  const outcome = isOutcome(outcomeParam) ? outcomeParam : undefined;
  const outcomeReason = q.get("outcomeReason") ?? undefined;
  const from = q.get("from");
  const to = q.get("to");
  const minConfidence = q.get("minConfidence");
  const maxConfidence = q.get("maxConfidence");
  const cursor = q.get("cursor") ?? undefined;
  const limit = Math.min(200, Math.max(1, Number(q.get("limit") ?? 30)));

  // Statuses the requested outcome allows. `successful`/`failed` narrow further
  // in memory below, because the P/L sign is part of the definition.
  const statusFilter: Prisma.SignalWhereInput = outcome
    ? outcome === "active"
      ? { status: { in: [...ACTIVE_STATUSES] } }
      : outcome === "successful" || outcome === "failed"
        ? { status: { in: [...RESOLVED_STATUSES] } }
        : { status: "EXPIRED" }
    : status
      ? { status: status as never }
      : {};

  const createdAt: Prisma.DateTimeFilter = {};
  if (from) {
    const d = new Date(from);
    if (!Number.isNaN(d.getTime())) createdAt.gte = d;
  }
  if (to) {
    const d = new Date(to);
    // A bare date means "through the end of that day", not "up to midnight".
    if (!Number.isNaN(d.getTime())) createdAt.lte = /T/.test(to) ? d : new Date(d.getTime() + 86_399_000);
  }

  const confidence: Prisma.FloatFilter = {};
  if (minConfidence && !Number.isNaN(Number(minConfidence))) confidence.gte = Number(minConfidence);
  if (maxConfidence && !Number.isNaN(Number(maxConfidence))) confidence.lte = Number(maxConfidence);

  const where: Prisma.SignalWhereInput = {
    ...(symbol ? { symbol } : {}),
    ...(timeframe ? { timeframe } : {}),
    ...(side ? { side: side.toUpperCase() as never } : {}),
    ...(source ? { source: source.toUpperCase() as never } : {}),
    ...(outcomeReason ? { outcomeReason } : {}),
    ...statusFilter,
    ...(Object.keys(createdAt).length > 0 ? { createdAt } : {}),
    ...(Object.keys(confidence).length > 0 ? { confidence } : {}),
  };

  // Post-query filters need headroom; without one, filtering a full page down
  // would silently return fewer rows than asked for.
  const needsPostFilter = Boolean(analyst) || outcome === "successful" || outcome === "failed";
  const take = needsPostFilter ? Math.min(600, limit * 6) : limit;

  try {
    const rows = await prisma.signal.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    let signals = rows;

    if (outcome === "successful") {
      signals = signals.filter((s) => (s.resultPnlPct ?? 0) > 0);
    } else if (outcome === "failed") {
      // A signal that tagged a target and then reversed into a net loss is a
      // failure, whatever its status says — the P/L is the ground truth.
      signals = signals.filter((s) => (s.resultPnlPct ?? 0) <= 0);
    }

    if (analyst) {
      signals = signals.filter((s) =>
        parseVerdicts(s.analystVerdicts).some((v) => v.analyst === analyst && v.qualified)
      );
    }

    const overFetched = needsPostFilter && rows.length === take && signals.length > limit;
    signals = signals.slice(0, limit);

    return NextResponse.json({
      signals,
      count: signals.length,
      nextCursor: signals.length === limit ? signals[signals.length - 1].id : null,
      overFetched,
      filters: {
        symbol: symbol ?? null,
        timeframe: timeframe ?? null,
        side: side ?? null,
        source: source ?? null,
        analyst: analyst ?? null,
        outcome: outcome ?? null,
        outcomeReason: outcomeReason ?? null,
        from: from ?? null,
        to: to ?? null,
        minConfidence: minConfidence ? Number(minConfidence) : null,
        maxConfidence: maxConfidence ? Number(maxConfidence) : null,
      },
    });
  } catch {
    // DB down shouldn't break the dashboard — signals are enrichment.
    return NextResponse.json({ signals: [], count: 0, warning: "database unavailable" });
  }
}
