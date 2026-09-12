import { Candle } from "./types";
import { OpenInterestPointLike } from "./positioning";

/**
 * Three axes pointing the same way.
 *
 * Price says where the market went. It does not say who took it there, and on
 * its own a rally made of new buyers and a rally made of trapped shorts being
 * squeezed out look identical. Two other series answer that, and they answer
 * different halves of it:
 *
 *  - **Cumulative delta** — was the move *bought*, or did it drift up on thin
 *    offers while net aggression was flat or selling? CVD is the only one of
 *    the three that says which side crossed the spread.
 *  - **Open interest** — were positions *added*, or closed? OI rising means
 *    new money took a side; OI falling means old money left.
 *
 * When all three rise together you have the one configuration that is hard to
 * fake: price advancing, aggressive buyers paying up for it, and the resulting
 * longs staying open rather than being scalped out. That is a markup with
 * participation behind it, and it is the pattern this looks for.
 *
 * The mirror — price falling, CVD falling, OI rising — is the same structure
 * inverted: fresh shorts selling aggressively into a decline.
 *
 * ## The cases that are not that
 *
 * Kept as first-class states rather than dropped, because the contrast is most
 * of the value. A rally on rising CVD but *falling* OI is shorts covering: the
 * buying is real but finite, because it ends when the shorts are out. A rally
 * on *falling* CVD is worse — price rose without anybody lifting the offer for
 * it, which is the absorption signature.
 *
 * ## What it does not claim
 *
 * That the move continues. Three-way agreement describes the composition of
 * what has already happened; it is not a forecast, and the most crowded,
 * most-confirmed markup on the board is also the one with the most stops under
 * it. Alignment tells you the move is real, not that it is early.
 */

/** Below this much price movement over the window, direction is noise. */
const MIN_PRICE_PCT = 0.5;
/**
 * Net delta must reach this share of the window's total volume.
 *
 * A share rather than an absolute: delta is in contracts, so any fixed floor
 * would be enormous on one symbol and invisible on another. "Net aggressive
 * buying was 3% of everything that traded" means the same thing everywhere.
 */
const MIN_CVD_SHARE = 2;
/** Same idea for open interest — exchanges round it, and small moves are rounding. */
const MIN_OI_PCT = 0.5;
/** Bars the read is measured over by default. */
const DEFAULT_LOOKBACK = 24;
/** Bars needed before any of this means anything. */
const MIN_BARS = 8;
/**
 * How far before a boundary an open-interest print may sit and still describe
 * it. Scaled to the bar interval for the reason `positioning.ts` sets out: a
 * flat hour is right on a 15m chart and impossible on a daily one.
 */
const MIN_STALENESS_SEC = 3600;

export type FlowState =
  /** price up, CVD up, OI up — the three-way agreement */
  | "longs_building"
  /** price down, CVD down, OI up — the mirror */
  | "shorts_building"
  /** price up, CVD up, OI down — the buying is shorts leaving */
  | "covering_rally"
  /** price down, CVD down, OI down — longs leaving rather than shorts arriving */
  | "deleveraging"
  /** price up, CVD down — it rose without being bought */
  | "absorbed_rally"
  /** price down, CVD up — it fell without being sold */
  | "absorbed_selloff";

export type AxisDirection = "up" | "down" | "flat";

export interface AxisRead {
  direction: AxisDirection;
  /**
   * Price and open interest in percent; CVD as net delta over the window's
   * total volume, also in percent, so the three are readable side by side
   * without being pretended to be the same quantity.
   */
  changePct: number;
  /**
   * 0-1. Share of the steps inside the window that went the way the axis
   * ended up going.
   *
   * Two windows with the same endpoints are not the same evidence: a CVD that
   * climbed on nineteen bars out of twenty-four is a different fact from one
   * that ended in the same place after lurching both ways, and only this
   * separates them.
   */
  steadiness: number;
  /** steps the steadiness was measured over */
  steps: number;
}

export interface FlowAlignmentRead {
  state: FlowState | null;
  label: string;
  price: AxisRead;
  cvd: AxisRead;
  openInterest: AxisRead;
  /** all three axes moved, and they agree with the state's definition */
  unanimous: boolean;
  barsCovered: number;
  /** 0-100, from how decisively each axis moved and how steadily */
  score: number;
  headline: string;
  mechanism: string;
  caveats: string[];
}

const FLAT: AxisRead = { direction: "flat", changePct: 0, steadiness: 0, steps: 0 };

const STATES: Record<FlowState, { label: string; mechanism: string }> = {
  longs_building: {
    label: "Longs building",
    mechanism:
      "Price rose, aggressive buyers paid up for it, and the positions stayed open. All three agree, which rules out both of the ways a rally fakes this: it is not shorts being squeezed out, because open interest grew rather than shrank, and it is not a drift up on thin offers, because cumulative delta rose with it. The buying has no built-in ceiling — and every one of those longs is a forced seller if price comes back through their stops.",
  },
  shorts_building: {
    label: "Shorts building",
    mechanism:
      "Price fell, aggressive sellers hit the bid for it, and the positions stayed open. Fresh shorts rather than longs being flushed. Real selling pressure, and simultaneously the fuel for a squeeze — those shorts have to buy back eventually, and they buy fastest when price goes against them.",
  },
  covering_rally: {
    label: "Covering rally",
    mechanism:
      "Price rose on genuine aggressive buying, but open interest fell: the buyers are shorts closing, so they are leaving the market rather than joining it. That bid is finite — it ends when the shorts are out, with nobody left who has to buy. Covering rallies run for days and many turn into real trends, but they need new longs to arrive first.",
  },
  deleveraging: {
    label: "Deleveraging",
    mechanism:
      "Price fell on aggressive selling while open interest fell too: longs closing or being closed out, rather than new shorts arriving. Finite in the same way covering is — it runs out when the trapped longs are gone.",
  },
  absorbed_rally: {
    label: "Absorbed rally",
    mechanism:
      "Price rose while cumulative delta fell: it went up without being bought. Net aggression was on the sell side for the window and price advanced anyway, which means the offers were thin or a passive bid was doing the work. The rally is real; the participation behind it is not there.",
  },
  absorbed_selloff: {
    label: "Absorbed selloff",
    mechanism:
      "Price fell while cumulative delta rose: it went down without being sold. Aggressive buyers were lifting the offer throughout and price declined anyway, so someone was selling passively into every one of those lifts with more size.",
  },
};

/**
 * Names and one-line readings, exported so the scanner page cannot drift from
 * the engine. A label defined twice is a label that eventually says two
 * different things about the same state.
 */
export const FLOW_STATE_LABEL: Record<FlowState, string> = {
  longs_building: "Longs building",
  shorts_building: "Shorts building",
  covering_rally: "Covering rally",
  deleveraging: "Deleveraging",
  absorbed_rally: "Absorbed rally",
  absorbed_selloff: "Absorbed selloff",
};

export const FLOW_STATE_NOTE: Record<FlowState, string> = {
  longs_building:
    "Price up, cumulative delta up, open interest up. Aggressive buyers paid for the move and the positions stayed open — not a squeeze, not a drift on thin offers.",
  shorts_building:
    "Price down, cumulative delta down, open interest up. Fresh shorts selling into the decline rather than longs being flushed out of it.",
  covering_rally:
    "Price up on genuine buying, but open interest fell — the buyers are shorts closing. That bid ends when they are out, so this needs new longs to arrive to continue.",
  deleveraging:
    "Price down on genuine selling, but open interest fell — longs leaving rather than shorts arriving. Finite in the same way covering is.",
  absorbed_rally:
    "Price rose while cumulative delta fell: it went up without being bought. Thin offers or a passive bid did the work, not aggression.",
  absorbed_selloff:
    "Price fell while cumulative delta rose: it went down without being sold. Someone sold passively into every lift, with more size than the buyers had.",
};

/** Median spacing of the candles, in seconds. */
function barIntervalSec(candles: Candle[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const g = candles[i].time - candles[i - 1].time;
    if (g > 0) gaps.push(g);
  }
  if (gaps.length === 0) return MIN_STALENESS_SEC;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/** The most recent OI print at or before `t`, if one is close enough to speak for it. */
function oiAt(
  points: OpenInterestPointLike[],
  t: number,
  toleranceSec: number
): OpenInterestPointLike | null {
  let best: OpenInterestPointLike | null = null;
  for (const p of points) {
    if (p.time > t) break;
    best = p;
  }
  if (!best) return null;
  return t - best.time <= toleranceSec ? best : null;
}

/**
 * Taker buy volume, clamped into the bar's own total.
 *
 * Real Binance fixtures carry bars whose taker-buy figure exceeds the volume
 * that produced it. Unclamped, one of those drives the delta past the total
 * traded and the CVD share past 100%.
 */
function buyOf(c: Candle): number {
  const raw = c.takerBuyVolume ?? c.volume / 2;
  return Math.min(Math.max(raw, 0), c.volume);
}

/**
 * How much one axis contributes, 0-1.
 *
 * A saturating curve rather than a clipped ratio. The first version divided by
 * a fixed ceiling and clamped at 1, which meant every strong reading scored
 * exactly the same: on a constructed sweep where the states were all correct,
 * all eight symbols came back at 100 and the ranking carried no information at
 * the top — which is the only place a scanner's ranking is read.
 *
 * `x / (x + midpoint)` has no ceiling to hit. A reading at the midpoint scores
 * 0.5, three times it scores 0.75, ten times 0.91, and two enormous readings
 * still rank apart. It also needs no calibration against a maximum nobody
 * knows: only a rough sense of what "strong" looks like, which the dead zones
 * already encode.
 */
function contribution(value: number, midpoint: number, steadiness: number): number {
  const x = Math.abs(value);
  if (x <= 0 || midpoint <= 0) return 0;
  return (x / (x + midpoint)) * steadiness;
}

/**
 * Combine the three axes.
 *
 * CVD carries the most weight: it is the only one of the three that says which
 * side crossed the spread, and the hardest to produce by accident. Each axis is
 * discounted by its own steadiness, so a window that ended up somewhere by
 * lurching scores below one that walked there.
 */
function scoreOf(price: AxisRead, cvd: AxisRead, openInterest: AxisRead): number {
  return Math.round(
    100 *
      (0.3 * contribution(price.changePct, MIN_PRICE_PCT * 3, price.steadiness) +
        0.4 * contribution(cvd.changePct, MIN_CVD_SHARE * 3, cvd.steadiness) +
        0.3 * contribution(openInterest.changePct, MIN_OI_PCT * 3, openInterest.steadiness))
  );
}

/** Turn a change and a step count into a direction, with a dead zone. */
function axis(changePct: number, upSteps: number, steps: number, deadZone: number): AxisRead {
  const direction: AxisDirection =
    Math.abs(changePct) < deadZone ? "flat" : changePct > 0 ? "up" : "down";
  const withDirection = direction === "down" ? steps - upSteps : upSteps;
  return {
    direction,
    changePct: Number(changePct.toFixed(2)),
    steadiness: steps > 0 ? Number((withDirection / steps).toFixed(3)) : 0,
    steps,
  };
}

/**
 * Read price, cumulative delta and open interest over the same window.
 *
 * Pure and synchronous. Every degenerate case — too few bars, no open-interest
 * history, a stale series, a flat axis — returns `state: null` with a caveat
 * naming which one it was, rather than a confident-looking state built on a
 * missing axis.
 */
export function readFlowAlignment(
  candles: Candle[],
  points: OpenInterestPointLike[],
  lookback = DEFAULT_LOOKBACK
): FlowAlignmentRead {
  const empty = (caveat: string, over: Partial<FlowAlignmentRead> = {}): FlowAlignmentRead => ({
    state: null,
    label: "No alignment read",
    price: FLAT,
    cvd: FLAT,
    openInterest: FLAT,
    unanimous: false,
    barsCovered: 0,
    score: 0,
    headline: "Not enough aligned data to say whether price, delta and open interest agree.",
    mechanism: "",
    caveats: [caveat],
    ...over,
  });

  if (candles.length < MIN_BARS) return empty(`Fewer than ${MIN_BARS} candles.`);
  if (points.length === 0) {
    return empty(
      "No open-interest history for this contract — Binance publishes none for some newly listed symbols."
    );
  }

  const window = candles.slice(-Math.max(MIN_BARS, lookback));
  const first = window[0];
  const last = window[window.length - 1];

  /* ---- price ---- */
  const pricePct = first.close !== 0 ? ((last.close - first.close) / first.close) * 100 : 0;
  let priceUpSteps = 0;
  for (let i = 1; i < window.length; i++) {
    if (window[i].close > window[i - 1].close) priceUpSteps++;
  }
  const price = axis(pricePct, priceUpSteps, window.length - 1, MIN_PRICE_PCT);

  /* ---- cumulative delta ---- */
  let netDelta = 0;
  let totalVolume = 0;
  let deltaUpSteps = 0;
  let haveTaker = false;
  for (const c of window) {
    if (c.takerBuyVolume != null) haveTaker = true;
    const buy = buyOf(c);
    const barDelta = buy - (c.volume - buy);
    netDelta += barDelta;
    totalVolume += c.volume;
    // A bar with positive delta is a bar on which the CVD line rose. That is
    // the step this counts, so steadiness here means literally "how many of
    // these bars did the CVD climb on".
    if (barDelta > 0) deltaUpSteps++;
  }
  if (!haveTaker) {
    return empty(
      "No taker breakdown on these candles, so cumulative delta cannot be built — and CVD is the axis this read exists for."
    );
  }
  const cvdShare = totalVolume > 0 ? (netDelta / totalVolume) * 100 : 0;
  const cvd = axis(cvdShare, deltaUpSteps, window.length, MIN_CVD_SHARE);

  /* ---- open interest ---- */
  const sorted = [...points].sort((a, b) => a.time - b.time);
  const tolerance = Math.max(MIN_STALENESS_SEC, barIntervalSec(candles));
  const oiStart = oiAt(sorted, first.time, tolerance);
  const oiEnd = oiAt(sorted, last.time, tolerance);
  if (!oiStart || !oiEnd) {
    return empty(
      "Open-interest readings do not cover this window — the series is stale or does not reach back far enough.",
      { price, cvd, barsCovered: window.length }
    );
  }
  if (oiStart.time === oiEnd.time) {
    return empty(
      "Only one open-interest print covers this window. Open interest publishes every five minutes at best, so a short window on a fast timeframe can straddle a single print.",
      { price, cvd, barsCovered: window.length }
    );
  }
  const inWindow = sorted.filter((p) => p.time >= oiStart.time && p.time <= oiEnd.time);
  let oiUpSteps = 0;
  for (let i = 1; i < inWindow.length; i++) {
    if (inWindow[i].openInterest > inWindow[i - 1].openInterest) oiUpSteps++;
  }
  const oiPct =
    oiStart.openInterest !== 0
      ? ((oiEnd.openInterest - oiStart.openInterest) / oiStart.openInterest) * 100
      : 0;
  const openInterest = axis(oiPct, oiUpSteps, Math.max(1, inWindow.length - 1), MIN_OI_PCT);

  /* ---- the gate chain ---- */
  if (price.direction === "flat") {
    return empty(
      `Price moved ${pricePct.toFixed(2)}% over ${window.length} bars, inside the noise band. With no price direction there is nothing for delta and open interest to agree or disagree with.`,
      { price, cvd, openInterest, barsCovered: window.length }
    );
  }
  if (cvd.direction === "flat") {
    return empty(
      `Net delta was ${cvdShare.toFixed(2)}% of the ${window.length}-bar volume, inside the noise band. Neither side pressed hard enough over this window to call the flow a direction.`,
      { price, cvd, openInterest, barsCovered: window.length }
    );
  }

  const up = price.direction === "up";
  const flowAgrees = cvd.direction === price.direction;

  let state: FlowState;
  if (!flowAgrees) {
    state = up ? "absorbed_rally" : "absorbed_selloff";
  } else if (openInterest.direction === "flat") {
    /* Delta and price agree but nobody committed either way. Calling that
       "longs building" would claim a positioning change the open-interest
       series does not show, so it reports as no state with both agreeing
       axes still attached. */
    return empty(
      `Price and delta agree, but open interest moved ${oiPct.toFixed(2)}% — inside the noise band. The move is happening between existing holders, so there is no positioning change to confirm it.`,
      { price, cvd, openInterest, barsCovered: window.length }
    );
  } else if (openInterest.direction === "up") {
    state = up ? "longs_building" : "shorts_building";
  } else {
    state = up ? "covering_rally" : "deleveraging";
  }

  const meta = STATES[state];
  const unanimous = state === "longs_building" || state === "shorts_building";

  const score = scoreOf(price, cvd, openInterest);

  const caveats: string[] = [];
  if (last.time - oiEnd.time > tolerance / 2) {
    caveats.push(
      `The latest open-interest print is ${Math.round((last.time - oiEnd.time) / 60)} minutes behind the last candle.`
    );
  }
  if (inWindow.length < 4) {
    caveats.push(
      `Only ${inWindow.length} open-interest prints fall inside this window, so its steadiness figure is measured over very few steps.`
    );
  }
  caveats.push(
    "Agreement describes what the move was made of, not what happens next. The most confirmed markup on the board is also the one carrying the most stops."
  );

  return {
    state,
    label: meta.label,
    price,
    cvd,
    openInterest,
    unanimous,
    barsCovered: window.length,
    score,
    headline:
      `${meta.label} — price ${pricePct >= 0 ? "+" : ""}${pricePct.toFixed(2)}%, ` +
      `net delta ${cvdShare >= 0 ? "+" : ""}${cvdShare.toFixed(1)}% of volume, ` +
      `open interest ${oiPct >= 0 ? "+" : ""}${oiPct.toFixed(2)}% over ${window.length} bars.`,
    mechanism: meta.mechanism,
    caveats,
  };
}
