import { NextRequest, NextResponse } from "next/server";
import { isValidTimeframe, Timeframe } from "@/lib/config";
import { SCANNER_NAMES, recordScans, scoreObservations } from "@/services/scanLedger";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Scheduled endpoint: record what the scanners surfaced, then score what has
 * had time to play out.
 *
 * Both halves in one call, because they belong to the same clock. Recording
 * without scoring fills a table nobody can read; scoring without recording
 * runs out of rows. Splitting them across two schedules would be two things to
 * forget instead of one.
 *
 * Scoring runs even when recording fails — a Binance outage that stops the
 * sweep should not also stall the backlog of rows already waiting, which will
 * otherwise pile up until a later run does them all at once.
 *
 * ## Auth
 *
 * Guarded by `CRON_SECRET`, sent either as `Authorization: Bearer <secret>`
 * (what Vercel Cron does) or `?secret=`. If `CRON_SECRET` is unset the route
 * refuses to run rather than defaulting to open: an unauthenticated endpoint
 * that costs a universe sweep per call is a free denial-of-wallet for anyone
 * who finds the URL.
 *
 * `?dry=1` runs every scanner and reports what each produced without writing —
 * the way to check an adapter is reading its scanner's buckets correctly, since
 * one pointed at the wrong bucket returns nothing and is otherwise silent.
 *
 * `?only=score` skips the sweep, which is the cheap way to work through a
 * backlog. `?only=record` skips scoring. `?scanners=thrust,bos` narrows the
 * sweep. `?cheap=1` drops the scanners that cost extra requests per symbol.
 */
function authorised(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization");
  if (header === `Bearer ${secret}`) return true;
  return req.nextUrl.searchParams.get("secret") === secret;
}

async function handle(req: NextRequest) {
  if (!authorised(req)) {
    return NextResponse.json(
      {
        error: process.env.CRON_SECRET
          ? "Unauthorised"
          : "CRON_SECRET is not set — this endpoint is disabled until it is.",
      },
      { status: 401 }
    );
  }

  const q = req.nextUrl.searchParams;
  const tfParam = q.get("timeframe") ?? "1h";
  const timeframe: Timeframe = isValidTimeframe(tfParam) ? tfParam : "1h";
  const depthRaw = Number(q.get("depth"));
  const depth = Number.isFinite(depthRaw) && depthRaw > 0 ? Math.min(200, depthRaw) : undefined;
  const only = q.get("only");

  /* An unrecognised scanner name is dropped rather than failing the request,
     but a list naming *only* unrecognised ones falls back to all of them —
     a typo that silently records nothing looks exactly like a quiet market,
     which is the failure mode worth designing against. */
  const named = (q.get("scanners") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => SCANNER_NAMES.includes(s));

  const record =
    only === "score"
      ? null
      : await recordScans({
          timeframe,
          depth,
          scanners: named.length > 0 ? named : undefined,
          cheapOnly: q.get("cheap") === "1",
          dryRun: q.get("dry") === "1",
        });

  // Deliberately after recording and independent of its outcome.
  const score = only === "record" ? null : await scoreObservations();

  return NextResponse.json({ timeframe, record, score });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

/** POST for schedulers that will not issue a GET with a body-less job. */
export async function POST(req: NextRequest) {
  return handle(req);
}
