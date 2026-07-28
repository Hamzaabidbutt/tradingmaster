import { NextResponse } from "next/server";
import { evaluateOpenSignals } from "@/services/signalService";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * Evaluates all open signals against live prices, closes finished trades
 * and triggers the learning engine. Called by the background worker and
 * safe to invoke from an external cron as well.
 */
export async function POST() {
  try {
    const result = await evaluateOpenSignals();
    return NextResponse.json(result);
  } catch (err) {
    logger.error("signals.evaluate.route_failed", { error: String(err) });
    return NextResponse.json({ error: "Evaluation failed" }, { status: 500 });
  }
}
