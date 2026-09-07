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
/** Binance's published anchor when the API does not report one, percent per settlement. */
const DEFAULT_INTEREST_PCT = 0.01;
/**
 * Annualised distance from the anchor below which nothing is being paid for.
 *
 * The important word is *anchor*. Funding is `premium + clamp(interest −
 * premium)`, so when the premium is neutral the clamp does not bind and the
 * rate lands exactly on the interest rate — 0.01% per settlement, about 11%
 * a year. Reading that as "longs are paying" is a mistake: longs pay it
 * because the formula has a floor, not because anyone is crowded.
 *
 * Measuring crowding against zero rather than against the anchor makes almost
 * every quiet market look mildly long. Measuring against the anchor is what
 * makes the number mean something.
 */
const NEUTRAL_BAND_ANNUAL = 6;
/**
 * Annualised excess beyond which the crowd stops being a confirmation and
 * starts being the risk. Above this, funding reads contrarian.
 */
const CROWDED_ANNUAL = 50;
/** A premium smaller than this is not a meaningful disagreement with funding. */
const PREMIUM_NOISE_PCT = 0.005;

/**
 * What funding says about positioning, and which way that leans.
 *
 * Funding is a *cost*, not a forecast, and the bias below is a statement about
 * where the leverage sits rather than a prediction of price. The reason it is
 * still worth stating directionally is that the two readings invert:
 *
 *   **In the middle of the range it is confirmatory.** A modest cost paid by
 *   longs means the crowd is long and paying a manageable price for it, which
 *   is what participation in an uptrend looks like.
 *
 *   **At the extremes it is contrarian.** A crowd paying triple-digit
 *   annualised rates is not confirmation; it is fuel. Everyone is already
 *   positioned, and the exit is the move.
 *
 * `mode` says which of those two readings is being applied, so a bullish label
 * is never ambiguous about *why*.
 */
export interface FundingBias {
  label: "bullish" | "bearish" | "neutral";
  /** confirmatory = the crowd's lean; contrarian = the crowd is the fuel */
  mode: "confirmatory" | "contrarian" | "none";
  strength: "mild" | "moderate" | "strong";
  /**
   * Funding minus the interest-rate anchor, annualised.
   *
   * This, not the raw rate, is the part that carries information: it is the
   * premium-driven component, with the formula's floor removed.
   */
  excessAnnualisedPct: number | null;
  /** the rate is sitting within the neutral band of its anchor */
  onAnchor: boolean;
  /** mark-to-index and funding point opposite ways — worth saying out loud */
  premiumDisagrees: boolean;
  headline: string;
  detail: string;
}

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
  /** funding minus the anchor, annualised — the informative component */
  excessAnnualisedPct: number | null;
  /** what the positioning implies, and whether that reading is contrarian */
  bias: FundingBias;
  history: FundingPoint[];
  note: string;
  error?: string;
}

const NEUTRAL_BIAS: FundingBias = {
  label: "neutral",
  mode: "none",
  strength: "mild",
  excessAnnualisedPct: null,
  onAnchor: true,
  premiumDisagrees: false,
  headline: "No positioning read",
  detail: "No live funding rate is available for this contract, so there is nothing to read.",
};

/**
 * Turn the rate into a positioning read, measured against the anchor.
 *
 * Exported so it can be tested directly: the band edges are the whole
 * behaviour, and driving them through a network fetch would test the fetch.
 */
export function readFundingBias(input: {
  currentRatePct: number | null;
  interestRatePct: number | null;
  basisPct: number | null;
  settlementsPerDay: number;
  consistency: number | null;
  samples: number;
}): FundingBias {
  const { currentRatePct, basisPct, settlementsPerDay } = input;
  if (currentRatePct == null || !Number.isFinite(currentRatePct)) return NEUTRAL_BIAS;

  const anchor = input.interestRatePct ?? DEFAULT_INTEREST_PCT;
  const excess = currentRatePct - anchor;
  const excessAnnual = Number((excess * settlementsPerDay * 365).toFixed(2));
  const magnitude = Math.abs(excessAnnual);
  const onAnchor = magnitude < NEUTRAL_BAND_ANNUAL;

  // A premium pointing the other way from funding is genuinely informative:
  // it means the perp is trading on the far side of spot from where the
  // settled rate says the crowd is, and the rate is being held up (or down)
  // by the formula's floor rather than by positioning.
  const premiumDisagrees =
    basisPct != null &&
    Math.abs(basisPct) > PREMIUM_NOISE_PCT &&
    Math.sign(basisPct) !== Math.sign(currentRatePct) &&
    currentRatePct !== 0;

  if (onAnchor) {
    return {
      label: "neutral",
      mode: "none",
      strength: "mild",
      excessAnnualisedPct: excessAnnual,
      onAnchor: true,
      premiumDisagrees,
      headline: "Neutral — funding is sitting on its anchor",
      detail:
        `At ${currentRatePct.toFixed(4)}% the rate is within ${NEUTRAL_BAND_ANNUAL}% annualised of the ${anchor.toFixed(4)}% interest-rate anchor, so the premium component is doing almost nothing. ` +
        `Nobody is paying meaningfully to hold either side, which means funding has no positioning signal here — whatever the sign happens to be. ` +
        (premiumDisagrees
          ? `The mark is ${basisPct! > 0 ? "above" : "below"} the index by ${Math.abs(basisPct!).toFixed(3)}% while the rate reads ${currentRatePct > 0 ? "positive" : "negative"}, which is the formula's floor showing through rather than a crowd.`
          : ""),
    };
  }

  const crowded = magnitude >= CROWDED_ANNUAL;
  const longsPaying = excess > 0;

  /* Mid-range confirms the crowd; the extremes fade it. */
  const label: FundingBias["label"] = crowded
    ? longsPaying
      ? "bearish"
      : "bullish"
    : longsPaying
      ? "bullish"
      : "bearish";

  // A standing cost means far more than one spike, so an inconsistent series
  // is downgraded rather than reported at face value.
  const persistent = (input.consistency ?? 0) >= 0.7 && input.samples >= 6;
  const rawStrength: FundingBias["strength"] =
    magnitude >= CROWDED_ANNUAL * 2 ? "strong" : magnitude >= CROWDED_ANNUAL ? "moderate" : "mild";
  const strength: FundingBias["strength"] = persistent
    ? rawStrength
    : rawStrength === "strong"
      ? "moderate"
      : "mild";

  const who = longsPaying ? "Longs" : "Shorts";
  const headline = crowded
    ? `${label === "bullish" ? "Bullish" : "Bearish"} — ${who.toLowerCase()} are crowded, and crowded is fuel`
    : `${label === "bullish" ? "Bullish" : "Bearish"} lean — ${who.toLowerCase()} are paying a manageable cost`;

  const detail = crowded
    ? `${who} are paying ${magnitude.toFixed(0)}% annualised above the anchor. At this level funding stops being a confirmation and becomes a risk: everyone who wants to be ${longsPaying ? "long" : "short"} already is, they are being charged heavily to stay, and their exit is the move. ` +
      `This is the contrarian reading, and it is about positioning — it says where the fuel is, not when it lights.` +
      (persistent ? "" : ` The series is inconsistent, so this looks more like a spike than a standing cost and the strength is downgraded accordingly.`)
    : `${who} are paying ${magnitude.toFixed(0)}% annualised above the anchor — a real but manageable cost. That is what ordinary participation on the ${longsPaying ? "long" : "short"} side looks like, so funding here confirms the crowd's lean rather than contradicting it. ` +
      `It would take roughly ${CROWDED_ANNUAL}% before the crowding itself became the risk.` +
      (persistent ? "" : ` The signs are mixed across settlements, so treat this as a lean rather than a standing cost.`) +
      (premiumDisagrees
        ? ` Note the mark is ${basisPct! > 0 ? "above" : "below"} the index by ${Math.abs(basisPct!).toFixed(3)}%, which points the other way from the rate.`
        : "");

  return {
    label,
    mode: crowded ? "contrarian" : "confirmatory",
    strength,
    excessAnnualisedPct: excessAnnual,
    onAnchor: false,
    premiumDisagrees,
    headline,
    detail,
  };
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
    excessAnnualisedPct: null,
    bias: NEUTRAL_BIAS,
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

  const interestRatePct =
    premium != null ? Number((premium.interestRate * 100).toFixed(5)) : null;
  const bias = readFundingBias({
    currentRatePct,
    interestRatePct,
    basisPct: premium?.basisPct ?? null,
    settlementsPerDay: perDayExact,
    consistency,
    samples: rates.length,
  });

  return {
    symbol,
    currentRatePct,
    interestRatePct,
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
    excessAnnualisedPct: bias.excessAnnualisedPct,
    bias,
    history,
    note:
      history.length === 0
        ? "No settled funding history yet — this is usually a newly listed contract."
        : `${history.length} settled payments at roughly ${perDayExact}/day. Funding is a cost, not a forecast: the side paying it is the crowded one, and the annualised figure is that cost quoted per year, not a prediction that it lasts one.`,
  };
}
