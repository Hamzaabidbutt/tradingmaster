import { NextRequest, NextResponse } from "next/server";
import { fetchKlinesPaged } from "@/lib/binance";
import { cacheGet, cacheSet } from "@/lib/cache";
import { isValidTimeframe, Timeframe } from "@/lib/config";
import { rateLimit } from "@/lib/rateLimit";
import { isTradableSymbol } from "@/lib/symbols";
import { runStrategySuite, StrategySuiteResult } from "@/engines/strategySuite";
import { pickStrongSymbol, StrongSymbol } from "@/services/strongSymbol";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Backtest every strategy on the same bars and rank them.
 *
 * When no symbol is given, one is chosen for *readability* rather than
 * performance — see `pickStrongSymbol`. A strategy comparison run on a dead
 * contract measures nothing, because almost nothing signals and the ranking is
 * decided by a handful of accidents.
 *
 * Bars default low on purpose. The sweep runs a full analysis per step, and
 * the honest constraint is the 60-second function limit rather than how much
 * history would be nice to have; `bars` and `step` are exposed so a longer run
 * can be requested deliberately rather than discovered as a timeout.
 */

const DEFAULT_BARS = 1200;
const MIN_BARS = 500;
const MAX_BARS = 3000;

export interface SuiteResponse extends StrategySuiteResult {
  /** how the symbol was chosen, when it was chosen automatically */
  pick: StrongSymbol | null;
  error?: string;
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const tfParam = q.get("timeframe") ?? "1h";
  if (!isValidTimeframe(tfParam)) {
    return NextResponse.json({ error: "Unknown timeframe" }, { status: 400 });
  }
  const timeframe: Timeframe = tfParam;
  const bars = Math.min(MAX_BARS, Math.max(MIN_BARS, Number(q.get("bars") ?? DEFAULT_BARS)));
  const step = Math.min(20, Math.max(1, Number(q.get("step") ?? 4)));
  const requested = (q.get("symbol") ?? "").toUpperCase();

  const ip = req.headers.get("x-forwarded-for") ?? "local";
  if (!rateLimit(`suite:${ip}`, 6, 60_000).allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded — a full strategy sweep is expensive" },
      { status: 429 }
    );
  }

  try {
    let pick: StrongSymbol | null = null;
    let symbol = requested;

    if (symbol) {
      if (!(await isTradableSymbol(symbol))) {
        return NextResponse.json({ error: "Unknown symbol" }, { status: 400 });
      }
    } else {
      pick = await pickStrongSymbol(timeframe);
      if (!pick) {
        return NextResponse.json({ error: "No symbol could be selected" }, { status: 503 });
      }
      symbol = pick.symbol;
    }

    const cacheKey = `suite:${symbol}:${timeframe}:${bars}:${step}`;
    const cached = cacheGet<SuiteResponse>(cacheKey);
    if (cached) return NextResponse.json(cached);

    const candles = await fetchKlinesPaged(symbol, timeframe, bars);
    if (candles.length < MIN_BARS) {
      return NextResponse.json(
        { error: `Only ${candles.length} bars available; ${MIN_BARS} are needed for a sweep.` },
        { status: 422 }
      );
    }

    const result = runStrategySuite(symbol, timeframe, candles, { step });
    const payload: SuiteResponse = { ...result, pick };
    // Long cache: the sweep is the most expensive thing in the app, and its
    // answer cannot change until new bars close.
    cacheSet(cacheKey, payload, 1_800_000);
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json({ error: `Strategy sweep failed: ${String(err)}` }, { status: 500 });
  }
}
