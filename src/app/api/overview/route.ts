import { NextResponse } from "next/server";
import { fetchAllTickers } from "@/lib/binance";
import { fetchFuturesSymbols } from "@/lib/symbols";
import { cacheGet, cacheSet } from "@/lib/cache";

export const dynamic = "force-dynamic";

/**
 * Market Overview + Overall Market Direction.
 *
 * Breadth from one all-tickers call: how many perpetuals are up versus down,
 * what the median contract did, and where the two majors sit. Breadth is a
 * better read on "the market" than BTC alone — a session where BTC is flat and
 * 380 of 500 alts are red is a bearish tape, and a BTC-only view calls it
 * neutral.
 *
 * `direction` is deliberately allowed to be `mixed`. Forcing every session
 * into bullish or bearish would be the same error as forcing every chart into
 * a trade.
 */

const TTL_MS = 30_000;

export interface OverviewResponse {
  universe: number;
  advancing: number;
  declining: number;
  unchanged: number;
  advanceDeclineRatio: number;
  medianChangePct: number;
  meanChangePct: number;
  totalQuoteVolume: number;
  breadthPct: number;
  majors: { symbol: string; label: string; lastPrice: number; changePct: number }[];
  topGainers: { symbol: string; changePct: number; quoteVolume: number }[];
  topLosers: { symbol: string; changePct: number; quoteVolume: number }[];
  direction: "bullish" | "bearish" | "mixed";
  directionLabel: string;
  /** built from the numbers above, so it differs every session */
  rationale: string[];
  generatedAt: number;
}

const MAJORS = ["BTCUSDT", "ETHUSDT"];

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export async function GET() {
  const cached = cacheGet<OverviewResponse>("overview:market");
  if (cached) return NextResponse.json(cached);

  try {
    const [symbols, tickers] = await Promise.all([fetchFuturesSymbols(), fetchAllTickers()]);
    const labels = new Map(symbols.map((s) => [s.symbol, s.label]));

    // Restrict to the tradable registry: the ticker feed includes contracts
    // that are settling or no longer perpetual, and counting those as breadth
    // would measure a market nobody can trade.
    const rows = symbols
      .map((s) => tickers.get(s.symbol))
      .filter((t): t is NonNullable<typeof t> => !!t);

    const changes = rows.map((t) => t.priceChangePercent);
    const advancing = changes.filter((c) => c > 0.15).length;
    const declining = changes.filter((c) => c < -0.15).length;
    const unchanged = rows.length - advancing - declining;
    const med = median(changes);
    const meanChange = changes.length > 0 ? changes.reduce((a, b) => a + b, 0) / changes.length : 0;
    const breadthPct = rows.length > 0 ? (advancing / rows.length) * 100 : 0;

    const majors = MAJORS.map((sym) => {
      const t = tickers.get(sym);
      return t
        ? {
            symbol: sym,
            label: labels.get(sym) ?? sym,
            lastPrice: t.lastPrice,
            changePct: t.priceChangePercent,
          }
        : null;
    }).filter((m): m is NonNullable<typeof m> => !!m);

    const byChange = [...rows].sort((a, b) => b.priceChangePercent - a.priceChangePercent);
    const liquid = byChange.filter((t) => t.quoteVolume > 1_000_000);
    const trim = (t: (typeof rows)[number]) => ({
      symbol: t.symbol,
      changePct: t.priceChangePercent,
      quoteVolume: t.quoteVolume,
    });

    const majorAvg =
      majors.length > 0 ? majors.reduce((s, m) => s + m.changePct, 0) / majors.length : 0;

    // Breadth and the majors must agree before a direction is claimed. When
    // they diverge — majors up, alts down, or vice versa — that divergence is
    // the finding, and "mixed" states it.
    const breadthBull = breadthPct >= 60;
    const breadthBear = breadthPct <= 35;
    const majorsBull = majorAvg > 0.5;
    const majorsBear = majorAvg < -0.5;

    let direction: OverviewResponse["direction"] = "mixed";
    if ((breadthBull && !majorsBear) || (majorsBull && breadthPct >= 50)) direction = "bullish";
    else if ((breadthBear && !majorsBull) || (majorsBear && breadthPct <= 50)) direction = "bearish";

    const rationale: string[] = [
      `${advancing} of ${rows.length} perpetuals advancing (${breadthPct.toFixed(0)}% breadth), ${declining} declining, ${unchanged} flat.`,
      `Median contract ${med >= 0 ? "+" : ""}${med.toFixed(2)}% over 24h; mean ${meanChange >= 0 ? "+" : ""}${meanChange.toFixed(2)}%.`,
      ...majors.map((m) => `${m.label} ${m.changePct >= 0 ? "+" : ""}${m.changePct.toFixed(2)}%.`),
    ];
    if (direction === "mixed") {
      rationale.push(
        breadthBull !== majorsBull && (breadthBull || majorsBull)
          ? `Breadth and the majors disagree — ${majorsBull ? "majors are up while the tape is not following" : "the tape is broad while the majors lag"}. No single direction is claimed.`
          : `Neither side has the tape: breadth at ${breadthPct.toFixed(0)}% and majors averaging ${majorAvg >= 0 ? "+" : ""}${majorAvg.toFixed(2)}% are both inside the neutral band.`
      );
    } else {
      rationale.push(
        `Breadth (${breadthPct.toFixed(0)}%) and the majors (${majorAvg >= 0 ? "+" : ""}${majorAvg.toFixed(2)}%) point the same way, so the tape reads ${direction}.`
      );
    }

    const payload: OverviewResponse = {
      universe: rows.length,
      advancing,
      declining,
      unchanged,
      advanceDeclineRatio: declining > 0 ? Number((advancing / declining).toFixed(2)) : advancing,
      medianChangePct: Number(med.toFixed(2)),
      meanChangePct: Number(meanChange.toFixed(2)),
      totalQuoteVolume: rows.reduce((s, t) => s + t.quoteVolume, 0),
      breadthPct: Number(breadthPct.toFixed(1)),
      majors,
      topGainers: liquid.slice(0, 5).map(trim),
      topLosers: liquid.slice(-5).reverse().map(trim),
      direction,
      directionLabel:
        direction === "bullish"
          ? "Bullish tape"
          : direction === "bearish"
            ? "Bearish tape"
            : "Mixed / no clear direction",
      rationale,
      generatedAt: Math.floor(Date.now() / 1000),
    };

    cacheSet("overview:market", payload, TTL_MS);
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json({ error: String(err), warning: "market data unavailable" }, { status: 200 });
  }
}
