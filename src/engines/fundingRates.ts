import { FundingPoint, PremiumIndexSnapshot } from "@/lib/binance";

/**
 * The cost of carry, reduced to the numbers a reader can act on.
 *
 * Funding on a perpetual is `premium + clamp(interestRate − premium)`. The two
 * components are kept apart here because they say different things: the
 * interest rate is a fixed anchor the rate returns to when nothing is crowded,
 * while the premium — mark against index — is the part that moves and the part
 * that is actually information.
 *
 * Everything below is measured or arithmetic. Nothing here forecasts: the
 * annualised figure is the current rate quoted per year, not a claim that it
 * lasts one, and the note says so.
 */

/** Fallback cadence when the history is too short to measure one. */
const DEFAULT_SETTLEMENTS_PER_DAY = 3;
/** Below this the rate is noise around the anchor, not anybody paying. */
const BALANCED_PCT = 0.001;

export interface FundingReport {
  symbol: string;
  /** the rate accruing now, percent per settlement */
  currentRatePct: number | null;
  /** Binance's fixed interest-rate component, percent per settlement */
  interestRatePct: number | null;
  /** mark against index, percent */
  basisPct: number | null;
  markPrice: number | null;
  indexPrice: number | null;
  /** unix seconds of the next settlement */
  nextFundingTime: number | null;
  /** settlements per day, derived from the actual spacing of the history */
  settlementsPerDay: number;
  /**
   * The current rate annualised at the observed cadence.
   *
   * A per-settlement number in the fourth decimal place reads as nothing; the
   * same rate expressed per year shows what holding the crowded side actually
   * costs. It assumes the rate persists, which it will not — a rate quoted per
   * year, not a forecast of a year.
   */
  annualisedPct: number | null;
  /** realised averages over the trailing window, percent per settlement */
  avg8hPct: number | null;
  avg24hPct: number | null;
  avg7dPct: number | null;
  /** total paid by the crowded side over the window, percent */
  cumulativePct: number | null;
  /** share of settlements matching the mean's sign, 0-1 */
  consistency: number | null;
  /** who has been paying: positive rates mean longs pay shorts */
  payer: "longs" | "shorts" | "balanced" | null;
  history: FundingPoint[];
  note: string;
  error?: string;
}

export function emptyFundingReport(symbol: string, note: string, error?: string): FundingReport {
  return {
    symbol,
    currentRatePct: null,
    interestRatePct: null,
    basisPct: null,
    markPrice: null,
    indexPrice: null,
    nextFundingTime: null,
    settlementsPerDay: DEFAULT_SETTLEMENTS_PER_DAY,
    annualisedPct: null,
    avg8hPct: null,
    avg24hPct: null,
    avg7dPct: null,
    cumulativePct: null,
    consistency: null,
    payer: null,
    history: [],
    note,
    ...(error ? { error } : {}),
  };
}

/**
 * Settlements per day, measured from the series rather than assumed.
 *
 * Binance settles most contracts every eight hours but not all of them — some
 * run on four — and quoting an annualised number off a hardcoded three per day
 * would understate those by half. The median gap is used rather than the mean
 * so one missed settlement in the series does not drag the cadence.
 */
export function settlementsPerDay(points: FundingPoint[]): number {
  if (points.length < 3) return DEFAULT_SETTLEMENTS_PER_DAY;
  const gaps: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const gap = points[i].time - points[i - 1].time;
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return DEFAULT_SETTLEMENTS_PER_DAY;
  const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
  if (median <= 0) return DEFAULT_SETTLEMENTS_PER_DAY;
  return Math.round((86_400 / median) * 100) / 100;
}

/** Mean of the last `n` settlements, as a percentage. */
function meanPct(points: FundingPoint[], n: number): number | null {
  const slice = points.slice(-Math.max(1, n));
  if (slice.length === 0) return null;
  return Number(((slice.reduce((s, p) => s + p.rate, 0) / slice.length) * 100).toFixed(5));
}

export function buildFundingReport(
  symbol: string,
  premium: PremiumIndexSnapshot | null,
  history: FundingPoint[]
): FundingReport {
  if (!premium && history.length === 0) {
    return emptyFundingReport(symbol, "Funding data is unavailable for this contract right now.");
  }

  const perDayExact = settlementsPerDay(history);
  const perDay = Math.max(1, Math.round(perDayExact));
  const rates = history.map((p) => p.rate);
  const mean = rates.length > 0 ? rates.reduce((s, r) => s + r, 0) / rates.length : null;
  const consistency =
    mean != null && rates.length > 0
      ? Number(
          (rates.filter((r) => (mean >= 0 ? r >= 0 : r < 0)).length / rates.length).toFixed(3)
        )
      : null;

  // The live accruing rate when it is available, otherwise the last settled
  // one. They answer slightly different questions and the fallback is the
  // weaker of the two, but it beats showing nothing.
  const currentRatePct =
    premium != null ? Number((premium.lastFundingRate * 100).toFixed(5)) : meanPct(history, 1);

  const payer: FundingReport["payer"] =
    currentRatePct == null
      ? null
      : Math.abs(currentRatePct) < BALANCED_PCT
        ? "balanced"
        : currentRatePct > 0
          ? "longs"
          : "shorts";

  return {
    symbol,
    currentRatePct,
    interestRatePct: premium != null ? Number((premium.interestRate * 100).toFixed(5)) : null,
    basisPct: premium?.basisPct ?? null,
    markPrice: premium?.markPrice ?? null,
    indexPrice: premium?.indexPrice ?? null,
    nextFundingTime: premium?.nextFundingTime ?? null,
    settlementsPerDay: perDayExact,
    annualisedPct:
      currentRatePct != null ? Number((currentRatePct * perDayExact * 365).toFixed(2)) : null,
    avg8hPct: meanPct(history, 1),
    avg24hPct: meanPct(history, perDay),
    avg7dPct: meanPct(history, perDay * 7),
    cumulativePct:
      rates.length > 0 ? Number((rates.reduce((s, r) => s + r, 0) * 100).toFixed(4)) : null,
    consistency,
    payer,
    history,
    note:
      history.length === 0
        ? "No settled funding history yet — this is usually a newly listed contract."
        : `${history.length} settled payments at roughly ${perDayExact}/day. Funding is a cost, not a forecast: the side paying it is the crowded one, and the annualised figure is that cost quoted per year, not a prediction that it lasts one.`,
  };
}
