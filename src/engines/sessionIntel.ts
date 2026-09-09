import { Candle } from "./types";

/**
 * The trading day as three markets, not one.
 *
 * Crypto never closes, but the people trading it do. Asia, London and New York
 * hand the book to each other, and each hand-over changes who is setting
 * price: Asia is thin and ranges; London brings the first real size and
 * frequently takes out whatever Asia built; New York brings the most, and
 * often reverses what London did.
 *
 * That sequence is the reason to track sessions separately rather than as a
 * rolling window. A rolling 8-hour read blends three different populations
 * into one average and reports something none of them did.
 *
 * ## The two patterns, and why they are gated hard
 *
 * "London sweep → New York reversal" and "Asia range → London breakout" are
 * real and widely traded, which is exactly why they need evidence rather than
 * assertion. Both are detected only when the *specific* mechanical conditions
 * hold — a sweep means London actually traded through Asia's extreme and came
 * back, not merely that London was volatile — and both report which condition
 * failed when they do not fire.
 *
 * Neither is a forecast. The pattern describes what has already happened; the
 * note says what would confirm or refute the continuation, and nothing here
 * claims the next session obeys the last one.
 */

/** UTC hour boundaries. Approximate by construction — the sessions overlap in reality. */
const SESSIONS = [
  { key: "asia", label: "Asia", startHour: 0, endHour: 8 },
  { key: "london", label: "London", startHour: 7, endHour: 16 },
  { key: "newyork", label: "New York", startHour: 13, endHour: 22 },
] as const;

export type SessionKey = (typeof SESSIONS)[number]["key"];

/** Bars a session needs before its statistics mean anything. */
const MIN_BARS = 4;

export interface SessionStats {
  key: SessionKey;
  label: string;
  /** unix seconds of the first and last bar actually inside the session */
  from: number;
  to: number;
  bars: number;
  high: number;
  low: number;
  open: number;
  close: number;
  /** high − low as a percentage of the low */
  rangePct: number;
  volume: number;
  /** volume-weighted average price across the session's own bars */
  vwap: number;
  /** net taker delta across the session; null when takers are unavailable */
  delta: number | null;
  /** mean bar range as a percentage — the session's own volatility */
  volatilityPct: number;
  /** close against open */
  changePct: number;
  direction: "up" | "down" | "flat";
}

export type SessionPatternKind = "london_sweep_ny_reversal" | "asia_range_london_breakout";

export interface SessionPattern {
  kind: SessionPatternKind;
  label: string;
  found: boolean;
  /** which side was swept or broken */
  side: "up" | "down" | null;
  /** the level involved */
  level: number | null;
  /** each condition and whether it held — shown so a near-miss is legible */
  conditions: { label: string; met: boolean; detail: string }[];
  headline: string;
  note: string;
}

export interface SessionIntel {
  /** the most recent completed or in-progress instance of each session */
  sessions: SessionStats[];
  patterns: SessionPattern[];
  /** which session the last bar falls in, if any */
  current: SessionKey | null;
  note: string;
}

function sessionOfHour(hour: number, key: SessionKey): boolean {
  const s = SESSIONS.find((x) => x.key === key)!;
  return hour >= s.startHour && hour < s.endHour;
}

/** Bars belonging to the most recent instance of one session. */
function latestSessionBars(candles: Candle[], key: SessionKey): Candle[] {
  const inSession = (c: Candle) => sessionOfHour(new Date(c.time * 1000).getUTCHours(), key);
  // Walk back from the end to the start of the most recent run of in-session
  // bars, so a session still in progress is measured as far as it has got
  // rather than being skipped for being incomplete.
  let end = -1;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (inSession(candles[i])) {
      end = i;
      break;
    }
  }
  if (end < 0) return [];
  let start = end;
  while (start > 0 && inSession(candles[start - 1])) start--;
  return candles.slice(start, end + 1);
}

function summarise(key: SessionKey, label: string, bars: Candle[]): SessionStats | null {
  if (bars.length < MIN_BARS) return null;

  const high = Math.max(...bars.map((c) => c.high));
  const low = Math.min(...bars.map((c) => c.low));
  const open = bars[0].open;
  const close = bars[bars.length - 1].close;
  const volume = bars.reduce((s, c) => s + c.volume, 0);

  let pv = 0;
  for (const c of bars) pv += ((c.high + c.low + c.close) / 3) * c.volume;
  const vwap = volume > 0 ? pv / volume : close;

  let delta: number | null = null;
  for (const c of bars) {
    if (c.takerBuyVolume == null) continue;
    delta = (delta ?? 0) + (c.takerBuyVolume - (c.volume - c.takerBuyVolume));
  }

  const meanRangePct =
    bars.reduce((s, c) => s + (c.low > 0 ? ((c.high - c.low) / c.low) * 100 : 0), 0) / bars.length;
  const changePct = open !== 0 ? ((close - open) / open) * 100 : 0;

  return {
    key,
    label,
    from: bars[0].time,
    to: bars[bars.length - 1].time,
    bars: bars.length,
    high,
    low,
    open,
    close,
    rangePct: low > 0 ? Number((((high - low) / low) * 100).toFixed(2)) : 0,
    volume,
    vwap,
    delta: delta == null ? null : Number(delta.toFixed(2)),
    volatilityPct: Number(meanRangePct.toFixed(3)),
    changePct: Number(changePct.toFixed(2)),
    direction: changePct > 0.05 ? "up" : changePct < -0.05 ? "down" : "flat",
  };
}

/**
 * Read the three sessions and the two patterns between them.
 *
 * Pure and synchronous. A session with too few bars is omitted rather than
 * reported with unstable statistics, and both patterns report every condition
 * they checked so a near-miss can be told from a non-event.
 */
export function readSessionIntel(candles: Candle[]): SessionIntel {
  const sessions: SessionStats[] = [];
  for (const s of SESSIONS) {
    const stats = summarise(s.key, s.label, latestSessionBars(candles, s.key));
    if (stats) sessions.push(stats);
  }

  const last = candles[candles.length - 1];
  const currentHour = last ? new Date(last.time * 1000).getUTCHours() : null;
  const current =
    currentHour == null
      ? null
      : (SESSIONS.find((s) => sessionOfHour(currentHour, s.key))?.key ?? null);

  const asia = sessions.find((s) => s.key === "asia") ?? null;
  const london = sessions.find((s) => s.key === "london") ?? null;
  const ny = sessions.find((s) => s.key === "newyork") ?? null;

  return {
    sessions,
    current,
    patterns: [sweepReversal(asia, london, ny), asiaRangeBreakout(asia, london)],
    note:
      sessions.length === 0
        ? "Not enough history in any session to summarise. On a daily chart a bar spans all three, so this read needs an intraday timeframe."
        : "Sessions are UTC hour bands and overlap in reality — London and New York share three hours, and both readings include them. The overlap is where most of the day's volume trades, so excluding it would be worse than double-counting it.",
  };
}

/** London runs Asia's extreme, then New York goes the other way. */
function sweepReversal(
  asia: SessionStats | null,
  london: SessionStats | null,
  ny: SessionStats | null
): SessionPattern {
  const base: SessionPattern = {
    kind: "london_sweep_ny_reversal",
    label: "London sweep → New York reversal",
    found: false,
    side: null,
    level: null,
    conditions: [],
    headline: "",
    note: "",
  };

  if (!asia || !london) {
    return {
      ...base,
      headline: "Not enough session data to check.",
      note: `Needs at least ${MIN_BARS} bars in both Asia and London.`,
    };
  }

  const sweptHigh = london.high > asia.high;
  const sweptLow = london.low < asia.low;
  // A sweep is a trade *through* the level that does not hold, not merely a
  // higher high. Requiring the close back inside is what separates the two.
  const reclaimedHigh = sweptHigh && london.close < asia.high;
  const reclaimedLow = sweptLow && london.close > asia.low;
  const side: "up" | "down" | null = reclaimedHigh ? "up" : reclaimedLow ? "down" : null;
  const level = side === "up" ? asia.high : side === "down" ? asia.low : null;

  const nyOpposes =
    ny != null && side != null && (side === "up" ? ny.direction === "down" : ny.direction === "up");

  const conditions = [
    {
      label: "London traded through an Asia extreme",
      met: sweptHigh || sweptLow,
      detail: sweptHigh
        ? `London high ${london.high} cleared Asia's ${asia.high}.`
        : sweptLow
          ? `London low ${london.low} cleared Asia's ${asia.low}.`
          : "London stayed inside Asia's range — no sweep to reverse.",
    },
    {
      label: "…and closed back inside the range",
      met: side != null,
      detail:
        side != null
          ? `Closed at ${london.close}, back inside. A trade through a level that does not hold is a sweep; one that holds is a breakout.`
          : "London closed beyond the level it cleared, which makes it a breakout rather than a sweep.",
    },
    {
      label: "New York moved the other way",
      met: nyOpposes,
      detail:
        ny == null
          ? "New York has not started, or has too few bars to read."
          : nyOpposes
            ? `New York is ${ny.direction} (${ny.changePct >= 0 ? "+" : ""}${ny.changePct}%), against the swept side.`
            : `New York is ${ny.direction}, not opposing the sweep.`,
    },
  ];

  const found = conditions.every((c) => c.met);
  return {
    ...base,
    found,
    side,
    level,
    conditions,
    headline: found
      ? `London swept Asia's ${side === "up" ? "high" : "low"} at ${level} and New York is going the other way.`
      : "Conditions not met.",
    note: found
      ? "The classic shape: liquidity taken in the thinner session, then the size that arrives later trades against it. What it describes has already happened — whether New York continues is a separate question, and the swept level is what invalidates it if reclaimed."
      : "Shown with each condition so a near-miss is legible. Two of three is not the pattern; it is two facts that happen to be true.",
  };
}

/** Asia coils, London picks a direction out of it. */
function asiaRangeBreakout(asia: SessionStats | null, london: SessionStats | null): SessionPattern {
  const base: SessionPattern = {
    kind: "asia_range_london_breakout",
    label: "Asia range → London breakout",
    found: false,
    side: null,
    level: null,
    conditions: [],
    headline: "",
    note: "",
  };

  if (!asia || !london) {
    return {
      ...base,
      headline: "Not enough session data to check.",
      note: `Needs at least ${MIN_BARS} bars in both Asia and London.`,
    };
  }

  // "Range" needs a number, or every Asia session qualifies.
  const tight = asia.rangePct <= 1.2;
  const brokeUp = london.close > asia.high;
  const brokeDown = london.close < asia.low;
  const side: "up" | "down" | null = brokeUp ? "up" : brokeDown ? "down" : null;
  const level = side === "up" ? asia.high : side === "down" ? asia.low : null;
  const expanded = london.volatilityPct > asia.volatilityPct * 1.2;

  const conditions = [
    {
      label: "Asia held a tight range",
      met: tight,
      detail: `Asia's range was ${asia.rangePct}%. A wide Asia is not a coil, and a breakout from one is just continuation.`,
    },
    {
      label: "London closed beyond it",
      met: side != null,
      detail:
        side != null
          ? `London closed ${london.close}, ${side === "up" ? "above" : "below"} Asia's ${level}. A close beyond, not a wick through.`
          : "London closed inside Asia's range — nothing broke.",
    },
    {
      label: "…with volatility expanding",
      met: expanded,
      detail: expanded
        ? `London's average bar range is ${(london.volatilityPct / Math.max(asia.volatilityPct, 1e-9)).toFixed(1)}× Asia's.`
        : "London is no more volatile than Asia, so price left the range without anyone hurrying — which is how breakouts fail.",
    },
  ];

  const found = conditions.every((c) => c.met);
  return {
    ...base,
    found,
    side,
    level,
    conditions,
    headline: found
      ? `Asia ranged ${asia.rangePct}% and London broke ${side} through ${level}.`
      : "Conditions not met.",
    note: found
      ? `The Asia extreme at ${level} is the reference: back inside it and the breakout failed, which is the most common outcome for a session breakout that loses its volatility.`
      : "Each condition is shown rather than a single verdict, because a breakout that failed the volatility check is a different thing from one that never happened.",
  };
}
