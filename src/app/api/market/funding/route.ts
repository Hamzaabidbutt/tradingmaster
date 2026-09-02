import { NextRequest, NextResponse } from "next/server";
import { fetchFundingRateHist, fetchPremiumIndex } from "@/lib/binance";
import { buildFundingReport, emptyFundingReport } from "@/engines/fundingRates";

export const dynamic = "force-dynamic";

/**
 * The cost of carry for one symbol: interest rate, premium, funding history.
 *
 * Two Binance reads — the live premium index and the settled rates — handed
 * straight to a pure builder. The reduction lives in `engines/fundingRates`
 * so the cadence detection and the annualisation can be tested without a
 * network, which matters: a wrong cadence silently doubles or halves every
 * annualised figure on the page.
 *
 * Fails soft in every branch, like the wall and open-interest routes. This is
 * one box on a page and it must never take the page with it.
 */

/** Settlements returned. 21 is a week at the usual 8-hour cadence. */
const HISTORY = 21;

export type { FundingReport } from "@/engines/fundingRates";

export async function GET(req: NextRequest) {
  const symbol = (req.nextUrl.searchParams.get("symbol") ?? "").toUpperCase();
  if (!/^[A-Z0-9]{4,20}$/.test(symbol)) {
    return NextResponse.json(emptyFundingReport(symbol, "Invalid symbol."), { status: 200 });
  }

  try {
    const [premium, history] = await Promise.all([
      fetchPremiumIndex(symbol),
      fetchFundingRateHist(symbol, HISTORY),
    ]);
    return NextResponse.json(buildFundingReport(symbol, premium, history));
  } catch (err) {
    return NextResponse.json(
      emptyFundingReport(symbol, "Funding data could not be read.", String(err)),
      { status: 200 }
    );
  }
}
