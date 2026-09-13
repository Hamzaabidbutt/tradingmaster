import { NextRequest, NextResponse } from "next/server";
import { isValidTimeframe, Timeframe } from "@/lib/config";
import {
  LADDER_KIND,
  SetupAlertKind,
  THRUST_KIND,
  alertChannelsConfigured,
  runSetupAlerts,
} from "@/services/setupAlerts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Scheduled endpoint: sweep for setups and alert on the ones that clear the
 * gate.
 *
 * Meant to be called by a scheduler — Vercel Cron, GitHub Actions,
 * cron-job.org, or the worker. Once per bar on whatever timeframe you are
 * watching is the useful setting; more often costs Binance request weight
 * without seeing anything new, since the engines read closed candles.
 *
 * ## Auth
 *
 * Guarded by `CRON_SECRET`, sent either as `Authorization: Bearer <secret>`
 * (what Vercel Cron does) or `?secret=`. If `CRON_SECRET` is unset the route
 * refuses to run rather than defaulting to open: an unauthenticated endpoint
 * that costs a universe sweep per call is a free denial-of-wallet for anyone
 * who finds the URL.
 *
 * `?dry=1` evaluates and reports without sending or recording anything, which
 * is how you check the gate is tuned before pointing it at a real channel.
 * `?kinds=thrust` or `?kinds=ladder` runs one scanner instead of both.
 */
function authorised(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization");
  if (header === `Bearer ${secret}`) return true;
  return req.nextUrl.searchParams.get("secret") === secret;
}

/**
 * Parse `?kinds=`, defaulting to both.
 *
 * An unrecognised name is ignored rather than failing the request, but a list
 * that names *only* unrecognised kinds falls back to both rather than running
 * nothing — a typo that silently disables the alerter is the failure mode
 * worth designing against, because it looks exactly like a quiet market.
 */
function kindsFrom(raw: string | null): SetupAlertKind[] {
  if (!raw) return [THRUST_KIND, LADDER_KIND];
  const wanted = raw.split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
  const picked: SetupAlertKind[] = [];
  if (wanted.some((k) => k === "thrust" || k === THRUST_KIND)) picked.push(THRUST_KIND);
  if (wanted.some((k) => k === "ladder" || k === LADDER_KIND)) picked.push(LADDER_KIND);
  return picked.length > 0 ? picked : [THRUST_KIND, LADDER_KIND];
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
  const tfParam = q.get("timeframe");
  const timeframe: Timeframe | undefined =
    tfParam && isValidTimeframe(tfParam) ? tfParam : undefined;
  const depthParam = Number(q.get("depth"));
  const dryRun = q.get("dry") === "1" || q.get("dry") === "true";

  const run = await runSetupAlerts({
    timeframe,
    depth: Number.isFinite(depthParam) && depthParam > 0 ? Math.min(200, depthParam) : undefined,
    kinds: kindsFrom(q.get("kinds")),
    dryRun,
  });

  return NextResponse.json({
    ...run,
    dryRun,
    // Said plainly in the response because a silent no-op with no channel
    // configured looks identical to a quiet market.
    note: alertChannelsConfigured()
      ? undefined
      : "No alert channel is configured — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID (or a Discord/webhook URL). The sweep ran, but nothing could be delivered.",
  });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

/** POST for schedulers that will not issue a GET with a body-less job. */
export async function POST(req: NextRequest) {
  return handle(req);
}
