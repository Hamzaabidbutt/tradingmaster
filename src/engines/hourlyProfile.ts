import { Candle } from "./types";

/**
 * When this market is actually busy, and what price does when it is.
 *
 * Crypto trades continuously, which is often mistaken for trading *evenly*. It
 * does not. Volume concentrates around the hours desks in London and New York
 * are at their screens, around the 00:00 UTC daily roll, and around funding
 * settlements. Those are the hours where a level is genuinely tested, and the
 * quiet hours between them are where a break has the least behind it.
 *
 * This engine answers three questions per hour of the day, from the symbol's
 * own history rather than from folklore about sessions:
 *
 *  1. **How busy?** Volume in that hour against the symbol's own hourly mean.
 *  2. **How violently?** Bar range against the same mean.
 *  3. **What happens to the move?** Whether a decisive hour tends to be
 *     extended by the next hour or given back.
 *
 * ## What it deliberately refuses to say
 *
 * That any hour is a *good time to trade*. Volume and range are properties of
 * the clock and are genuinely stable — the same hours are busy month after
 * month, because the people trading them keep the same office hours.
 * Direction is not: with ninety days of history each hour holds ninety
 * samples, which is enough to say "this hour is twice as busy" and nowhere
 * near enough to say "this hour goes up". So the directional read is
 * suppressed below a sample floor and, above it, is reported with its own
 * sample size attached and never phrased as an expectation.
 *
 * A profile like this also describes the window it was measured over. Ninety
 * days spanning one trend will report that trend's shape as if it were a
 * property of the clock, and the note says so.
 */

/** Hours needed before any per-hour figure is quoted at all. */
const MIN_SAMPLES = 20;
/**
 * Samples before a *directional* read is quoted.
 *
 * Deliberately far above the floor for volume. Volume per hour is stable and
 * converges quickly; a mean return converges slowly and, at this sample size,
 * a handful of outlier bars moves it more than any real tendency does.
 */
const MIN_DIRECTIONAL_SAMPLES = 45;
/**
 * How far a bar must move, as a share of the symbol's mean hourly range, to
 * count as "decisive" for the follow-through measurement. A hair either side
 * of unchanged is not a move whose continuation means anything.
 */
const DECISIVE_RANGE_SHARE = 0.8;
/** Volume multiple above which an hour is called busy, and below which quiet. */
const BUSY_MULTIPLE = 1.25;
const QUIET_MULTIPLE = 0.75;

export interface HourStats {
  /** hour of day, 0-23, in UTC */
  hour: number;
  /** bars observed in this hour */
  samples: number;
  /** mean volume in this hour ÷ mean hourly volume overall */
  volumeMultiple: number;
  /** share of all volume that trades in this hour, percent (sums to 100) */
  volumeSharePct: number;
  /** mean bar range ÷ mean bar range overall */
  rangeMultiple: number;
  /** mean high-low range as a percentage of the bar's open */
  rangePct: number;
  /** mean signed close-to-open return, percent. Null below the sample floor. */
  meanReturnPct: number | null;
  /** share of bars closing above their open, percent. Null below the floor. */
  upSharePct: number | null;
  /** mean taker-buy share of volume, percent — who was aggressive */
  takerBuySharePct: number | null;
  /**
   * Of the decisive bars in this hour, the share whose *next* bar continued in
   * the same direction. Above 50 means moves born here tend to be extended;
   * below 50 means they tend to be given back. Null when too few decisive bars.
   */
  followThroughPct: number | null;
  /** decisive bars behind `followThroughPct` */
  decisiveSamples: number;
  /** busy / normal / quiet, from `volumeMultiple` */
  activity: "busy" | "normal" | "quiet";
}

export interface HourlyProfile {
  symbol: string;
  /** bars the profile was built from */
  bars: number;
  /** calendar days spanned */
  days: number;
  /** unix seconds of the first and last bar */
  from: number;
  to: number;
  hours: HourStats[];
  /** the busiest hours by volume, most active first */
  busiest: number[];
  /** the quietest hours by volume */
  quietest: number[];
  /** mean hourly volume across the whole window, in base units */
  meanVolume: number;
  /** mean bar range as a percentage of open, across the whole window */
  meanRangePct: number;
  /** plain-language read, one line per finding */
  summary: string[];
  note: string;
}

const EMPTY_NOTE =
  "Not enough hourly history to profile the clock. This needs at least a few weeks of bars.";

function empty(symbol: string, bars: number): HourlyProfile {
  return {
    symbol,
    bars,
    days: 0,
    from: 0,
    to: 0,
    hours: [],
    busiest: [],
    quietest: [],
    meanVolume: 0,
    meanRangePct: 0,
    summary: [EMPTY_NOTE],
    note: EMPTY_NOTE,
  };
}

/** Two-digit UTC hour label, e.g. 14 -> "14:00". */
export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

/**
 * Build the hour-of-day profile.
 *
 * Expects **1-hour candles**; anything else buckets several hours into one
 * label and produces a profile of the timeframe rather than of the clock.
 * Pure and synchronous like the other engines, so it is testable without a
 * network and reusable from a backtest.
 */
export function buildHourlyProfile(symbol: string, candles: Candle[]): HourlyProfile {
  if (candles.length < 24 * 7) return empty(symbol, candles.length);

  const buckets: Candle[][] = Array.from({ length: 24 }, () => []);
  // The *next* bar for each bar, by index, so follow-through can be measured
  // without re-scanning. Bars are assumed ordered, which every caller here
  // guarantees; a gap simply makes one follow-through observation wrong rather
  // than corrupting the bucket.
  const nextOf = new Map<number, Candle>();
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const hour = new Date(c.time * 1000).getUTCHours();
    buckets[hour].push(c);
    if (i + 1 < candles.length) nextOf.set(c.time, candles[i + 1]);
  }

  const totalVolume = candles.reduce((s, c) => s + c.volume, 0);
  const meanVolume = totalVolume / candles.length;
  const rangePctOf = (c: Candle) => (c.open > 0 ? ((c.high - c.low) / c.open) * 100 : 0);
  const meanRangePct = candles.reduce((s, c) => s + rangePctOf(c), 0) / candles.length;
  // In price terms, for the decisiveness threshold.
  const meanRange = candles.reduce((s, c) => s + (c.high - c.low), 0) / candles.length;

  const hours: HourStats[] = buckets.map((bars, hour) => {
    if (bars.length === 0) {
      return {
        hour,
        samples: 0,
        volumeMultiple: 0,
        volumeSharePct: 0,
        rangeMultiple: 0,
        rangePct: 0,
        meanReturnPct: null,
        upSharePct: null,
        takerBuySharePct: null,
        followThroughPct: null,
        decisiveSamples: 0,
        activity: "quiet" as const,
      };
    }

    const vol = bars.reduce((s, c) => s + c.volume, 0);
    const meanBarVolume = vol / bars.length;
    const volumeMultiple = meanVolume > 0 ? meanBarVolume / meanVolume : 0;
    const barRangePct = bars.reduce((s, c) => s + rangePctOf(c), 0) / bars.length;

    const enough = bars.length >= MIN_SAMPLES;
    const enoughDirectional = bars.length >= MIN_DIRECTIONAL_SAMPLES;

    const returns = bars.map((c) => (c.open > 0 ? ((c.close - c.open) / c.open) * 100 : 0));
    const takerBars = bars.filter((c) => c.takerBuyVolume != null && c.volume > 0);

    /* Follow-through: of the bars that actually moved, how often the next bar
       carried on the same way. This is the closest thing here to "how price
       reacts" — an hour that reliably starts moves reads differently from one
       that reliably ends them. */
    let decisive = 0;
    let continued = 0;
    for (const c of bars) {
      const body = c.close - c.open;
      if (Math.abs(body) < meanRange * DECISIVE_RANGE_SHARE) continue;
      const next = nextOf.get(c.time);
      if (!next) continue;
      decisive++;
      const nextBody = next.close - next.open;
      if (Math.sign(nextBody) === Math.sign(body)) continued++;
    }

    return {
      hour,
      samples: bars.length,
      volumeMultiple: Number(volumeMultiple.toFixed(3)),
      volumeSharePct: totalVolume > 0 ? Number(((vol / totalVolume) * 100).toFixed(2)) : 0,
      rangeMultiple: meanRangePct > 0 ? Number((barRangePct / meanRangePct).toFixed(3)) : 0,
      rangePct: Number(barRangePct.toFixed(3)),
      meanReturnPct: enoughDirectional
        ? Number((returns.reduce((s, r) => s + r, 0) / returns.length).toFixed(4))
        : null,
      upSharePct: enoughDirectional
        ? Number(((bars.filter((c) => c.close > c.open).length / bars.length) * 100).toFixed(1))
        : null,
      takerBuySharePct:
        enough && takerBars.length > 0
          ? Number(
              (
                (takerBars.reduce((s, c) => s + (c.takerBuyVolume ?? 0) / c.volume, 0) /
                  takerBars.length) *
                100
              ).toFixed(1)
            )
          : null,
      followThroughPct:
        decisive >= MIN_SAMPLES ? Number(((continued / decisive) * 100).toFixed(1)) : null,
      decisiveSamples: decisive,
      activity:
        volumeMultiple >= BUSY_MULTIPLE
          ? "busy"
          : volumeMultiple <= QUIET_MULTIPLE
            ? "quiet"
            : "normal",
    };
  });

  const ranked = hours.filter((h) => h.samples > 0).sort((a, b) => b.volumeMultiple - a.volumeMultiple);
  const busiest = ranked.slice(0, 4).map((h) => h.hour);
  const quietest = ranked.slice(-4).map((h) => h.hour).reverse();

  const from = candles[0].time;
  const to = candles[candles.length - 1].time;
  const days = Math.round((to - from) / 86_400);

  return {
    symbol,
    bars: candles.length,
    days,
    from,
    to,
    hours,
    busiest,
    quietest,
    meanVolume,
    meanRangePct: Number(meanRangePct.toFixed(3)),
    summary: describe(hours, busiest, quietest, days),
    note:
      `Measured over ${candles.length} hourly bars spanning ${days} days, so roughly ${Math.round(candles.length / 24)} samples per hour. ` +
      `Volume and range by hour are stable properties of the clock — the same desks keep the same hours — and they hold up month to month. ` +
      `Direction does not: it is withheld below ${MIN_DIRECTIONAL_SAMPLES} samples and, above it, describes this window rather than the next one. ` +
      `A window spanning one large trend will report that trend's shape as if it belonged to the clock.`,
  };
}

/**
 * The findings, in plain language.
 *
 * Ordered by how much the underlying number can be trusted: volume first
 * because it is the most stable, direction last and hedged, because it is the
 * least.
 */
function describe(
  hours: HourStats[],
  busiest: number[],
  quietest: number[],
  days: number
): string[] {
  const out: string[] = [];
  const byHour = new Map(hours.map((h) => [h.hour, h]));
  const top = busiest.map((h) => byHour.get(h)!).filter(Boolean);
  const bottom = quietest.map((h) => byHour.get(h)!).filter(Boolean);
  if (top.length === 0) return [EMPTY_NOTE];

  const topShare = top.reduce((s, h) => s + h.volumeSharePct, 0);
  out.push(
    `Busiest hours (UTC): ${top.map((h) => `${hourLabel(h.hour)} at ${h.volumeMultiple.toFixed(2)}× normal`).join(", ")}. ` +
      `Those four hours carry ${topShare.toFixed(1)}% of all volume, against the ${((4 / 24) * 100).toFixed(1)}% they would carry if trading were even.`
  );
  if (bottom.length > 0) {
    out.push(
      `Quietest hours (UTC): ${bottom.map((h) => `${hourLabel(h.hour)} at ${h.volumeMultiple.toFixed(2)}×`).join(", ")}. ` +
        `A level broken in these hours is being broken by fewer participants, which is worth knowing before treating the break as a decision.`
    );
  }

  /* Range is reported separately from volume because they can disagree, and
     when they do it is informative: high volume with contained range is size
     being absorbed, while high range on ordinary volume is a thin book. */
  const widest = [...hours].filter((h) => h.samples > 0).sort((a, b) => b.rangeMultiple - a.rangeMultiple)[0];
  if (widest) {
    const alsoBusy = busiest.includes(widest.hour);
    out.push(
      `Widest range: ${hourLabel(widest.hour)} at ${widest.rangeMultiple.toFixed(2)}× the average bar (${widest.rangePct.toFixed(2)}% of price). ` +
        (alsoBusy
          ? "It is also one of the busiest hours, so the movement comes with participation behind it."
          : "It is not one of the busiest hours — range without volume is a thinner book moving further on the same size, not more conviction.")
    );
  }

  const divergent = hours.find(
    (h) => h.samples > 0 && h.volumeMultiple >= BUSY_MULTIPLE && h.rangeMultiple <= 0.9
  );
  if (divergent) {
    out.push(
      `${hourLabel(divergent.hour)} trades ${divergent.volumeMultiple.toFixed(2)}× the volume on ${divergent.rangeMultiple.toFixed(2)}× the range — heavy trade that does not move price, which is what absorption looks like on a clock.`
    );
  }

  /* Follow-through, where the sample supports it. This is the "how does price
     react" half, and it is a description of what happened after those bars,
     not a claim about what will. */
  const graded = hours.filter((h) => h.followThroughPct != null);
  const extending = [...graded].sort((a, b) => b.followThroughPct! - a.followThroughPct!)[0];
  const fading = [...graded].sort((a, b) => a.followThroughPct! - b.followThroughPct!)[0];
  if (extending && fading && extending.hour !== fading.hour) {
    out.push(
      `Moves born at ${hourLabel(extending.hour)} were extended by the next hour ${extending.followThroughPct!.toFixed(0)}% of the time (${extending.decisiveSamples} decisive bars); ` +
        `moves born at ${hourLabel(fading.hour)} only ${fading.followThroughPct!.toFixed(0)}% (${fading.decisiveSamples} bars). ` +
        `Both are records of this window. Neither is a rate to trade off — a coin flip lands 60/40 over ${extending.decisiveSamples} tries often enough.`
    );
  }

  const directional = hours.filter((h) => h.meanReturnPct != null);
  if (directional.length > 0) {
    const best = [...directional].sort((a, b) => b.meanReturnPct! - a.meanReturnPct!)[0];
    const worst = [...directional].sort((a, b) => a.meanReturnPct! - b.meanReturnPct!)[0];
    out.push(
      `Directionally, ${hourLabel(best.hour)} averaged ${best.meanReturnPct! >= 0 ? "+" : ""}${best.meanReturnPct!.toFixed(3)}% and ${hourLabel(worst.hour)} ${worst.meanReturnPct!.toFixed(3)}% over ${days} days. ` +
        `Read these as trivia unless the gap is large: an average return per hour is the noisiest number here, and over a window this size it mostly reports which hours happened to catch the big days.`
    );
  }

  return out;
}
