import { buildVolumeProfile } from "./volumeProfile";
import { Candle } from "./types";

/**
 * Positioning: is the move adding commitment, or spending it?
 *
 * Price alone cannot tell you whether a rally is people arriving or people
 * leaving, and those are opposite facts about what happens next. Open interest
 * is the count of contracts still open, so pairing its direction with price's
 * separates the four cases that price on its own collapses into two:
 *
 *              OI rising                    OI falling
 *   Price up   new longs opening            shorts closing (covering)
 *   Price down new shorts opening           longs closing (liquidation)
 *
 * The left column is new money taking a side. The right column is old money
 * getting out — and that matters because a bid made of shorts covering is
 * *finite*: it ends when the shorts are out, with nobody left who has to buy.
 * A bid made of new longs opening has no such ceiling. Same green candles,
 * different thing entirely.
 *
 * ## What this does not say
 *
 * It does not say where price goes. "Short covering" is a statement about the
 * source of the buying, not a forecast that it fails — covering rallies run for
 * days, and plenty of them turn into real trends when new longs join. What the
 * quadrant gives you is *whether the fuel behind this move is being added or
 * spent*, which is a fact about now, not a claim about later.
 *
 * ## Why so much of this is guarded
 *
 * Binance publishes open interest on its own schedule — five minutes at the
 * finest — so the series rarely lines up with the candles, can be missing
 * entirely for a newly listed contract, and can hold a stale value across
 * several bars. Every one of those cases produces a confident-looking quadrant
 * if you let it, so each is checked and reported instead.
 */

/** Below this much price movement over the window, direction is noise. */
const MIN_PRICE_PCT = 0.15;
/** Same for open interest: exchanges round it, and small moves are rounding. */
const MIN_OI_PCT = 0.2;
/** Bars the read is measured over by default. */
const DEFAULT_LOOKBACK = 12;
/**
 * How far before a boundary an open-interest reading may sit and still be
 * taken as describing it.
 *
 * Scaled to the bar interval rather than fixed, because "recent" is not the
 * same length of time on every timeframe. A flat hour was right for a 15m
 * chart and quietly impossible on a 4h or daily one: there, the start of a
 * twelve-bar window is days back, no print is ever within an hour of it, and
 * the read refused every time with a message about staleness that was really
 * about the constant. One bar of tolerance, floored at an hour so fast
 * timeframes keep a usable window against a series that publishes every five
 * minutes at best.
 */
const MIN_STALENESS_SEC = 3600;
function stalenessLimit(barSec: number): number {
  return Math.max(MIN_STALENESS_SEC, barSec);
}

/** Median spacing of the candles, in seconds — the bar interval. */
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

export type PositioningQuadrant =
  | "new_longs"
  | "short_covering"
  | "new_shorts"
  | "long_liquidation";

export interface OpenInterestPointLike {
  time: number;
  openInterest: number;
}

export interface PositioningRead {
  /** null when either axis sits inside its dead zone — an honest "no read" */
  quadrant: PositioningQuadrant | null;
  label: string;
  /** price change across the window, percent */
  pricePct: number;
  /** open-interest change across the window, percent */
  oiPct: number;
  barsCovered: number;
  /** whether the window added commitment or unwound it */
  participation: "opening" | "closing" | null;
  /**
   * Does taker delta point the same way as price? Agreement means the move
   * was driven by aggression; disagreement means it went the other way
   * despite it, which is the absorption signature.
   */
  deltaAgrees: boolean | null;
  /** 0-100, from how far past both dead zones the window sits */
  strength: number;
  headline: string;
  mechanism: string;
  caveats: string[];
}

/** Human-facing name and the mechanism behind each quadrant. */
const QUADRANTS: Record<
  PositioningQuadrant,
  { label: string; participation: "opening" | "closing"; mechanism: string }
> = {
  new_longs: {
    label: "New longs opening",
    participation: "opening",
    mechanism:
      "Price rose while open interest grew: this is fresh money taking the long side, not old shorts leaving. The buying has no built-in ceiling — but every one of those longs is also a forced seller if price comes back through their stops.",
  },
  short_covering: {
    label: "Short covering",
    participation: "closing",
    mechanism:
      "Price rose while open interest fell: the buyers here are shorts closing, which means they are leaving the market rather than joining it. That bid is finite — it ends when the shorts are out — so this move needs new longs to arrive if it is to continue on anything but momentum.",
  },
  new_shorts: {
    label: "New shorts opening",
    participation: "opening",
    mechanism:
      "Price fell while open interest grew: fresh money taking the short side. Real selling pressure, and simultaneously the fuel for a squeeze — those shorts must buy back eventually, and they buy fastest when price goes against them.",
  },
  long_liquidation: {
    label: "Long liquidation",
    participation: "closing",
    mechanism:
      "Price fell while open interest fell: longs closing or being closed out. The selling is positions leaving rather than new shorts arriving, which is finite in the same way covering is — it runs out when the trapped longs are gone.",
  },
};

/** The most recent OI reading at or before `t`, if one is close enough. */
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
  // Open interest publishes on its own period, so an exact match is not
  // expected — but a reading from well before this boundary is describing a
  // different window and must not be presented as this one's.
  return t - best.time <= toleranceSec ? best : null;
}

/**
 * Read positioning over the last `lookback` bars.
 *
 * Pure and synchronous. `points` may be empty or short — every degenerate case
 * returns a read with `quadrant: null` and a caveat saying which one it was,
 * rather than a fabricated quadrant.
 */
export function readPositioning(
  candles: Candle[],
  points: OpenInterestPointLike[],
  lookback = DEFAULT_LOOKBACK
): PositioningRead {
  const empty = (caveat: string): PositioningRead => ({
    quadrant: null,
    label: "No positioning read",
    pricePct: 0,
    oiPct: 0,
    barsCovered: 0,
    participation: null,
    deltaAgrees: null,
    strength: 0,
    headline: "Not enough aligned data to say whether this move is opening or closing positions.",
    mechanism: "",
    caveats: [caveat],
  });

  if (candles.length < 2) return empty("Fewer than two candles.");
  /* Only a genuinely empty series is "no history". A series with one print in
     it is a different failure — there is history, it just cannot describe a
     change — and it gets caught below with its own message. Rejecting both
     here reported a stalled feed as an unlisted contract. */
  if (points.length === 0) {
    return empty(
      "No open-interest history for this contract — Binance publishes none for some newly listed symbols."
    );
  }

  const window = candles.slice(-Math.max(2, lookback));
  const first = window[0];
  const last = window[window.length - 1];

  const sorted = [...points].sort((a, b) => a.time - b.time);
  const tolerance = stalenessLimit(barIntervalSec(candles));
  const oiStart = oiAt(sorted, first.time, tolerance);
  const oiEnd = oiAt(sorted, last.time, tolerance);
  if (!oiStart || !oiEnd) {
    return empty("Open-interest readings do not cover this window — the series is stale or too short.");
  }
  if (oiStart.time === oiEnd.time) {
    return empty(
      "Only one open-interest reading covers this window. Open interest publishes every five minutes at best, so a short window on a fast timeframe can straddle a single print."
    );
  }

  const caveats: string[] = [];
  const pricePct = first.close !== 0 ? ((last.close - first.close) / first.close) * 100 : 0;
  const oiPct =
    oiStart.openInterest !== 0
      ? ((oiEnd.openInterest - oiStart.openInterest) / oiStart.openInterest) * 100
      : 0;

  // Taker delta across the window, for the agreement check.
  let delta = 0;
  let haveTaker = false;
  for (const c of window) {
    if (c.takerBuyVolume == null) continue;
    haveTaker = true;
    delta += c.takerBuyVolume - (c.volume - c.takerBuyVolume);
  }
  const deltaAgrees = haveTaker ? (pricePct >= 0 ? delta > 0 : delta < 0) : null;

  const priceFlat = Math.abs(pricePct) < MIN_PRICE_PCT;
  const oiFlat = Math.abs(oiPct) < MIN_OI_PCT;

  if (priceFlat || oiFlat) {
    const read = empty(
      priceFlat && oiFlat
        ? `Both flat over ${window.length} bars — price ${pricePct.toFixed(2)}%, open interest ${oiPct.toFixed(2)}%. Nothing is being committed either way.`
        : priceFlat
          ? `Price moved ${pricePct.toFixed(2)}% over ${window.length} bars, inside the noise band. Open interest changed ${oiPct.toFixed(2)}%, but with no price direction to pair it with there is no quadrant.`
          : `Open interest changed ${oiPct.toFixed(2)}% over ${window.length} bars, inside the noise band. The move is happening between existing holders.`
    );
    return { ...read, pricePct, oiPct, barsCovered: window.length, deltaAgrees };
  }

  const quadrant: PositioningQuadrant =
    pricePct > 0
      ? oiPct > 0
        ? "new_longs"
        : "short_covering"
      : oiPct > 0
        ? "new_shorts"
        : "long_liquidation";

  const meta = QUADRANTS[quadrant];

  // Both axes contribute, because either alone is the weaker claim: price says
  // there was a move, open interest says whether anyone committed to it.
  const strength = Math.round(
    Math.min(
      100,
      Math.min(50, (Math.abs(pricePct) / MIN_PRICE_PCT) * 12) +
        Math.min(50, (Math.abs(oiPct) / MIN_OI_PCT) * 12)
    )
  );

  /* Deliberately no caveat for `deltaAgrees === false`. It is already a
     field, and a consumer that renders both the field and a sentence saying
     the same thing prints the absorption warning twice — which is exactly
     what happened. Structured facts go in fields; caveats are for the things
     that have no field. */
  if (!haveTaker) caveats.push("No taker breakdown on these candles, so the delta check was skipped.");
  if (last.time - oiEnd.time > 900) {
    caveats.push(
      `The latest open-interest print is ${Math.round((last.time - oiEnd.time) / 60)} minutes behind the last candle.`
    );
  }

  return {
    quadrant,
    label: meta.label,
    pricePct: Number(pricePct.toFixed(2)),
    oiPct: Number(oiPct.toFixed(2)),
    barsCovered: window.length,
    participation: meta.participation,
    deltaAgrees,
    strength,
    headline: `${meta.label} — price ${pricePct >= 0 ? "+" : ""}${pricePct.toFixed(2)}%, open interest ${oiPct >= 0 ? "+" : ""}${oiPct.toFixed(2)}% over ${window.length} bars.`,
    mechanism: meta.mechanism,
    caveats,
  };
}

/* ------------------------------------------------------------------ *
 * Value migration
 * ------------------------------------------------------------------ */

/**
 * Where the market is doing its business now, against where it was doing it
 * before.
 *
 * A value area is the band that held ~70% of the volume — the prices the
 * market accepted rather than merely visited. Whether that band has moved, and
 * whether the new one still overlaps the old, is the cleanest available
 * separation of trend from rotation: value migrating in one direction is an
 * auction that keeps finding business at new prices, while value overlapping
 * its predecessor is the same auction rotating inside a range no matter what
 * the candles look like.
 *
 * Deliberately measured on overlap rather than on the point of control alone.
 * A POC can jump within an unchanged value area — that is a shift in where the
 * heaviest trade happened, not a migration of value — and reading it as a
 * migration is how a rotation gets mistaken for a breakout.
 */
export type MigrationDirection = "higher" | "lower" | "overlapping" | "unchanged";

export interface ValueMigration {
  direction: MigrationDirection;
  current: { high: number; low: number; poc: number };
  prior: { high: number; low: number; poc: number };
  /** share of the current value area that overlaps the prior one, 0-1 */
  overlap: number;
  headline: string;
  detail: string;
  caveats: string[];
}

/** Overlap above this and the two areas are the same auction. */
const OVERLAP_ROTATION = 0.6;
/** Bars needed on each side before a comparison means anything. */
const MIN_SIDE_BARS = 20;

/**
 * Compare the most recent `windowBars` against the `windowBars` before them.
 *
 * Both halves are profiled with the same builder and settings, so the only
 * difference between them is the candles.
 */
export function readValueMigration(candles: Candle[], windowBars = 60): ValueMigration | null {
  if (candles.length < MIN_SIDE_BARS * 2) return null;

  const size = Math.max(MIN_SIDE_BARS, Math.min(windowBars, Math.floor(candles.length / 2)));
  const currentBars = candles.slice(-size);
  const priorBars = candles.slice(-size * 2, -size);
  if (priorBars.length < MIN_SIDE_BARS) return null;

  const cur = buildVolumeProfile(currentBars, { scope: "visible" });
  const pri = buildVolumeProfile(priorBars, { scope: "visible" });

  const curSpan = Math.max(cur.vah - cur.val, 1e-9);
  const overlapSpan = Math.max(0, Math.min(cur.vah, pri.vah) - Math.max(cur.val, pri.val));
  const overlap = Math.min(1, overlapSpan / curSpan);

  let direction: MigrationDirection;
  if (overlap >= OVERLAP_ROTATION) {
    direction = "overlapping";
  } else if (cur.poc > pri.poc && cur.vah > pri.vah) {
    direction = "higher";
  } else if (cur.poc < pri.poc && cur.val < pri.val) {
    direction = "lower";
  } else {
    // Value moved but not cleanly in either direction — a widening or
    // narrowing area. Calling that a migration would be reading a direction
    // into a change of shape.
    direction = "unchanged";
  }

  const caveats: string[] = [];
  if (cur.valueAreaShare < 0.6 || pri.valueAreaShare < 0.6) {
    caveats.push(
      "One of the two profiles could not capture a clean 70% value area, so its edges are softer than the numbers suggest."
    );
  }
  caveats.push(
    `Both halves are ${size} bars of this timeframe, not calendar sessions — the comparison is "recently" against "before that", not today against yesterday.`
  );

  const headlines: Record<MigrationDirection, string> = {
    higher: "Value is migrating higher",
    lower: "Value is migrating lower",
    overlapping: "Value is overlapping — the same auction",
    unchanged: "Value changed shape without migrating",
  };

  const details: Record<MigrationDirection, string> = {
    higher: `Business has moved up: point of control ${pri.poc.toFixed(4)} → ${cur.poc.toFixed(4)}, with only ${(overlap * 100).toFixed(0)}% of the new value area inside the old one. The market keeps finding trade at higher prices, which is what an uptrend looks like in auction terms rather than in candles.`,
    lower: `Business has moved down: point of control ${pri.poc.toFixed(4)} → ${cur.poc.toFixed(4)}, with only ${(overlap * 100).toFixed(0)}% of the new value area inside the old one. Sellers keep finding acceptance at lower prices.`,
    overlapping: `${(overlap * 100).toFixed(0)}% of the current value area sits inside the previous one — the market is rotating in the same band it was already trading. Breakout setups are fighting this; the edges of value are where the trade is.`,
    unchanged: `The value area moved without a consistent direction — it widened or narrowed rather than migrating. Point of control ${pri.poc.toFixed(4)} → ${cur.poc.toFixed(4)}, ${(overlap * 100).toFixed(0)}% overlap. A change of shape is not a change of location.`,
  };

  return {
    direction,
    current: { high: cur.vah, low: cur.val, poc: cur.poc },
    prior: { high: pri.vah, low: pri.val, poc: pri.poc },
    overlap: Number(overlap.toFixed(3)),
    headline: headlines[direction],
    detail: details[direction],
    caveats,
  };
}
