import { Candle } from "./types";

/**
 * The week, not just the day: which weekday and which session actually carry
 * the volume, and whether any of the "Friday night pumps" people talk about
 * survive being checked.
 *
 * ## The trap this engine exists to avoid
 *
 * A weekday-by-hour grid has 168 cells. Test all of them for a directional
 * bias at the usual 5% threshold and roughly **eight** will look significant
 * on pure noise, every single time, on any asset, forever. Those eight cells
 * are where market folklore comes from: somebody notices that Thursday 03:00
 * closed green 68% of the time, tells people, and nobody ever checks whether
 * it kept doing that.
 *
 * So this engine does two things a naive scan does not:
 *
 *  1. **Corrects for how many cells it looked at.** The threshold a cell must
 *     clear rises with the number of candidates tested, and the output states
 *     how many survivors pure chance would have produced anyway.
 *  2. **Requires the pattern to repeat.** The window is split in half and a
 *     candidate only counts as recurring if it leans the same way in *both*
 *     halves. This is the closest thing to out-of-sample evidence available
 *     from one series, and it is what separates "a pattern" from "a shape the
 *     data happened to make".
 *
 * Finding nothing is the normal result, and the engine says so in as many
 * words rather than lowering the bar until something appears.
 *
 * ## Volume is a different question
 *
 * Where volume trades is not a coin flip and does not need any of this. The
 * same desks work the same hours, so the busy cells are stable and are
 * reported plainly, with no significance testing and no hedging.
 */

/** Bars in a bucket before any figure is quoted. */
const MIN_SAMPLES = 30;
/** Bars in *each half* before the repeat test is attempted. */
const MIN_HALF_SAMPLES = 12;
/**
 * Base two-sided significance level, before correction for the number of
 * candidates. Corrected per candidate, Bonferroni-style — crude, conservative,
 * and the right kind of wrong for this: it errs toward reporting nothing.
 */
const ALPHA = 0.05;
/** A half must lean at least this far past even money to count as agreeing. */
const HALF_MARGIN_PCT = 51;

export type SessionKey = "asia" | "europe" | "us" | "late";

interface SessionDef {
  key: SessionKey;
  label: string;
  /** UTC hours covered, [from, to) */
  from: number;
  to: number;
  desks: string;
}

/**
 * Sessions named by their UTC window first and the desks second.
 *
 * Named the other way round they would be wrong for most readers: "the London
 * session" is a different wall-clock time depending on where you are sitting,
 * while 08:00–13:00 UTC is the same everywhere. The desk name is kept because
 * it explains *why* the window is busy.
 */
export const SESSIONS: SessionDef[] = [
  { key: "asia", label: "00–08 UTC", from: 0, to: 8, desks: "Asia hours" },
  { key: "europe", label: "08–13 UTC", from: 8, to: 13, desks: "Europe hours" },
  { key: "us", label: "13–21 UTC", from: 13, to: 21, desks: "US hours" },
  { key: "late", label: "21–24 UTC", from: 21, to: 24, desks: "late / rollover" },
];

export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export function sessionOf(hour: number): SessionDef {
  return SESSIONS.find((s) => hour >= s.from && hour < s.to) ?? SESSIONS[0];
}

/** One cell of the 7×24 grid. */
export interface WeekCell {
  /** 0 = Sunday, UTC */
  weekday: number;
  /** UTC hour */
  hour: number;
  samples: number;
  /** mean volume here ÷ mean hourly volume overall */
  volumeMultiple: number;
  /** mean bar range ÷ mean bar range overall */
  rangeMultiple: number;
  /** share of bars closing above their open, percent. Null below the floor. */
  upSharePct: number | null;
  /** mean close-to-open return, percent. Null below the floor. */
  meanReturnPct: number | null;
}

/** A named group of bars — a weekday, a session, or a weekday's session. */
export interface WeekBucket {
  key: string;
  label: string;
  /** null on a session-only bucket */
  weekday: number | null;
  /** null on a weekday-only bucket */
  session: SessionKey | null;
  samples: number;
  volumeMultiple: number;
  rangeMultiple: number;
  upSharePct: number | null;
  meanReturnPct: number | null;
  /** up-share over the first and second half of the window */
  firstHalfUpPct: number | null;
  secondHalfUpPct: number | null;
  /**
   * How far the up-share sits from a coin flip, in standard errors.
   * Comparable across buckets of different sizes, which a raw percentage
   * is not — 60% of 20 bars and 60% of 600 are not the same claim.
   */
  z: number | null;
  /** cleared the corrected threshold *and* leaned the same way in both halves */
  recurring: boolean;
}

export interface WeekProfile {
  symbol: string;
  bars: number;
  days: number;
  from: number;
  to: number;
  /** every cell of the 7×24 grid, row-major from Sunday 00:00 UTC */
  cells: WeekCell[];
  /** one per weekday */
  weekdays: WeekBucket[];
  /** one per session */
  sessions: WeekBucket[];
  /** weekday × session — where "Friday night" lives */
  slots: WeekBucket[];
  /** the busiest weekday×session slots by volume, most active first */
  busiestSlots: string[];
  /** candidates that survived correction and the repeat test */
  recurring: WeekBucket[];
  /** how many candidates were tested for a directional bias */
  candidatesTested: number;
  /** how many survivors pure chance would be expected to produce */
  expectedByChance: number;
  summary: string[];
  patternNote: string;
  note: string;
}

const SHORT = "Not enough history to profile the week. This needs several months of hourly bars.";

function empty(symbol: string, bars: number): WeekProfile {
  return {
    symbol,
    bars,
    days: 0,
    from: 0,
    to: 0,
    cells: [],
    weekdays: [],
    sessions: [],
    slots: [],
    busiestSlots: [],
    recurring: [],
    candidatesTested: 0,
    expectedByChance: 0,
    summary: [SHORT],
    patternNote: SHORT,
    note: SHORT,
  };
}

/** Normal two-sided tail probability, via a standard erfc approximation. */
function twoSidedP(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  // Abramowitz & Stegun 7.1.26 — plenty for a threshold comparison.
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return 1 - y;
}

interface Ctx {
  meanVolume: number;
  meanRangePct: number;
  /** bar time at the midpoint of the window, for the repeat test */
  midTime: number;
}

const rangePctOf = (c: Candle) => (c.open > 0 ? ((c.high - c.low) / c.open) * 100 : 0);
const returnPctOf = (c: Candle) => (c.open > 0 ? ((c.close - c.open) / c.open) * 100 : 0);

function makeBucket(
  key: string,
  label: string,
  weekday: number | null,
  session: SessionKey | null,
  bars: Candle[],
  ctx: Ctx
): WeekBucket {
  const base: WeekBucket = {
    key,
    label,
    weekday,
    session,
    samples: bars.length,
    volumeMultiple: 0,
    rangeMultiple: 0,
    upSharePct: null,
    meanReturnPct: null,
    firstHalfUpPct: null,
    secondHalfUpPct: null,
    z: null,
    recurring: false,
  };
  if (bars.length === 0) return base;

  const meanBarVolume = bars.reduce((s, c) => s + c.volume, 0) / bars.length;
  const meanBarRangePct = bars.reduce((s, c) => s + rangePctOf(c), 0) / bars.length;
  base.volumeMultiple =
    ctx.meanVolume > 0 ? Number((meanBarVolume / ctx.meanVolume).toFixed(3)) : 0;
  base.rangeMultiple =
    ctx.meanRangePct > 0 ? Number((meanBarRangePct / ctx.meanRangePct).toFixed(3)) : 0;

  if (bars.length < MIN_SAMPLES) return base;

  const ups = bars.filter((c) => c.close > c.open).length;
  const p = ups / bars.length;
  base.upSharePct = Number((p * 100).toFixed(1));
  base.meanReturnPct = Number(
    (bars.reduce((s, c) => s + returnPctOf(c), 0) / bars.length).toFixed(4)
  );
  // Standard error of a proportion under the null that it is a coin flip.
  base.z = Number(((p - 0.5) / Math.sqrt(0.25 / bars.length)).toFixed(3));

  const first = bars.filter((c) => c.time < ctx.midTime);
  const second = bars.filter((c) => c.time >= ctx.midTime);
  if (first.length >= MIN_HALF_SAMPLES && second.length >= MIN_HALF_SAMPLES) {
    base.firstHalfUpPct = Number(
      ((first.filter((c) => c.close > c.open).length / first.length) * 100).toFixed(1)
    );
    base.secondHalfUpPct = Number(
      ((second.filter((c) => c.close > c.open).length / second.length) * 100).toFixed(1)
    );
  }
  return base;
}

/**
 * Did this bucket lean the same way in both halves of the window?
 *
 * The whole-window figure cannot distinguish a steady tendency from one
 * extraordinary month, and it is precisely that distinction that decides
 * whether a "pattern" is worth the name.
 */
function repeats(b: WeekBucket): boolean {
  if (b.firstHalfUpPct == null || b.secondHalfUpPct == null || b.upSharePct == null) return false;
  const up = b.upSharePct > 50;
  return up
    ? b.firstHalfUpPct >= HALF_MARGIN_PCT && b.secondHalfUpPct >= HALF_MARGIN_PCT
    : b.firstHalfUpPct <= 100 - HALF_MARGIN_PCT && b.secondHalfUpPct <= 100 - HALF_MARGIN_PCT;
}

export function buildWeekProfile(symbol: string, candles: Candle[]): WeekProfile {
  // Six weeks is the floor: below it the weekday buckets hold too few bars for
  // the halves of the repeat test to mean anything.
  if (candles.length < 24 * 7 * 6) return empty(symbol, candles.length);

  const meanVolume = candles.reduce((s, c) => s + c.volume, 0) / candles.length;
  const meanRangePct = candles.reduce((s, c) => s + rangePctOf(c), 0) / candles.length;
  const midTime = candles[Math.floor(candles.length / 2)].time;
  const ctx: Ctx = { meanVolume, meanRangePct, midTime };

  const grid: Candle[][][] = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => [] as Candle[])
  );
  for (const c of candles) {
    const d = new Date(c.time * 1000);
    grid[d.getUTCDay()][d.getUTCHours()].push(c);
  }

  const cells: WeekCell[] = [];
  for (let wd = 0; wd < 7; wd++) {
    for (let h = 0; h < 24; h++) {
      const bars = grid[wd][h];
      const b = makeBucket(`c${wd}-${h}`, "", wd, null, bars, ctx);
      cells.push({
        weekday: wd,
        hour: h,
        samples: bars.length,
        volumeMultiple: b.volumeMultiple,
        rangeMultiple: b.rangeMultiple,
        upSharePct: b.upSharePct,
        meanReturnPct: b.meanReturnPct,
      });
    }
  }

  const weekdays = grid.map((hours, wd) =>
    makeBucket(`d${wd}`, WEEKDAYS[wd], wd, null, hours.flat(), ctx)
  );

  const sessions = SESSIONS.map((s) =>
    makeBucket(
      `s${s.key}`,
      `${s.label} (${s.desks})`,
      null,
      s.key,
      candles.filter((c) => {
        const h = new Date(c.time * 1000).getUTCHours();
        return h >= s.from && h < s.to;
      }),
      ctx
    )
  );

  const slots: WeekBucket[] = [];
  for (let wd = 0; wd < 7; wd++) {
    for (const s of SESSIONS) {
      const bars: Candle[] = [];
      for (let h = s.from; h < s.to; h++) bars.push(...grid[wd][h]);
      slots.push(
        makeBucket(`${wd}-${s.key}`, `${WEEKDAYS[wd]} ${s.label}`, wd, s.key, bars, ctx)
      );
    }
  }

  /* ---- The directional search, corrected and repeat-checked ----
     Cells are included so the "specific hour of a specific day" question is
     actually asked, not dodged — but including them raises the correction for
     everything, which is exactly the price that should be paid for asking a
     wider question. */
  const candidates = [...weekdays, ...sessions, ...slots, ...cellBuckets(grid, ctx)];
  const tested = candidates.filter((b) => b.z != null);
  const threshold = ALPHA / Math.max(1, tested.length);
  for (const b of tested) {
    b.recurring = twoSidedP(b.z!) <= threshold && repeats(b);
  }
  const recurring = tested
    .filter((b) => b.recurring)
    .sort((a, b) => Math.abs(b.z!) - Math.abs(a.z!));

  const rankedSlots = slots
    .filter((s) => s.samples >= MIN_SAMPLES)
    .sort((a, b) => b.volumeMultiple - a.volumeMultiple);

  const from = candles[0].time;
  const to = candles[candles.length - 1].time;
  const days = Math.round((to - from) / 86_400);

  return {
    symbol,
    bars: candles.length,
    days,
    from,
    to,
    cells,
    weekdays,
    sessions,
    slots,
    busiestSlots: rankedSlots.slice(0, 5).map((s) => s.key),
    recurring,
    candidatesTested: tested.length,
    expectedByChance: Number((tested.length * threshold).toFixed(2)),
    summary: describe(weekdays, sessions, rankedSlots, days),
    patternNote: patternNote(recurring, tested.length, days),
    note:
      `Built from ${candles.length} hourly bars over ${days} days — about ${Math.round(days / 7)} of each weekday. ` +
      `Volume and range by weekday and session are stable and are reported as measured. ` +
      `Directional claims are held to a much higher bar: every candidate is corrected for the ${tested.length} that were tested, and must additionally lean the same way in both halves of the window. ` +
      `Even then the result describes this window. Twelve months of crypto history is one market cycle, not a sample of many.`,
  };
}

/** The 7×24 cells as testable buckets. Only those with enough bars qualify. */
function cellBuckets(grid: Candle[][][], ctx: Ctx): WeekBucket[] {
  const out: WeekBucket[] = [];
  for (let wd = 0; wd < 7; wd++) {
    for (let h = 0; h < 24; h++) {
      const bars = grid[wd][h];
      if (bars.length < MIN_SAMPLES) continue;
      out.push(
        makeBucket(
          `${wd}-h${h}`,
          `${WEEKDAYS[wd]} ${String(h).padStart(2, "0")}:00 UTC`,
          wd,
          null,
          bars,
          ctx
        )
      );
    }
  }
  return out;
}

function patternNote(recurring: WeekBucket[], tested: number, days: number): string {
  if (recurring.length === 0) {
    return (
      `No weekday, session or weekday-hour showed a directional bias that both cleared the corrected threshold and repeated across ` +
      `both halves of the ${days} days. That is the ordinary outcome and it is worth stating plainly: with ${tested} candidates examined, ` +
      `several will always look striking on noise alone, which is where most "this coin always pumps on Friday" claims come from. ` +
      `Volume and range patterns below are real and stable — the directional ones did not survive being checked.`
    );
  }
  return (
    `${recurring.length} candidate${recurring.length === 1 ? "" : "s"} out of ${tested} cleared a threshold corrected for the number tested ` +
    `and leaned the same way in both halves of the window. That is a stronger filter than a raw win rate, but it is still not proof: ` +
    `both halves come from the same ${days} days and the same market regime. Treat it as a lead to watch forward, not an edge to size.`
  );
}

function describe(
  weekdays: WeekBucket[],
  sessions: WeekBucket[],
  rankedSlots: WeekBucket[],
  days: number
): string[] {
  const out: string[] = [];

  const byVolume = [...weekdays].filter((d) => d.samples > 0).sort((a, b) => b.volumeMultiple - a.volumeMultiple);
  if (byVolume.length >= 2) {
    const top = byVolume[0];
    const bottom = byVolume[byVolume.length - 1];
    out.push(
      `Busiest weekday is ${top.label} at ${top.volumeMultiple.toFixed(2)}× the average hour; quietest is ${bottom.label} at ${bottom.volumeMultiple.toFixed(2)}×. ` +
        `The weekend gap is the most reliable pattern in any crypto market: the asset trades but the desks that move it do not.`
    );
  }

  const sessionRanked = [...sessions].sort((a, b) => b.volumeMultiple - a.volumeMultiple);
  if (sessionRanked.length > 0) {
    out.push(
      `By session: ${sessionRanked.map((s) => `${s.label} ${s.volumeMultiple.toFixed(2)}×`).join(", ")}. ` +
        `The busiest session is where levels get tested with participation behind them; the quietest is where a break has the least behind it.`
    );
  }

  if (rankedSlots.length >= 3) {
    out.push(
      `Busiest weekday-session slots: ${rankedSlots.slice(0, 3).map((s) => `${s.label} at ${s.volumeMultiple.toFixed(2)}×`).join(", ")}.`
    );
    const quiet = rankedSlots[rankedSlots.length - 1];
    out.push(
      `Deadest slot: ${quiet.label} at ${quiet.volumeMultiple.toFixed(2)}× on ${quiet.rangeMultiple.toFixed(2)}× the range. ` +
        `Thin books move further on the same size, which is why stop runs and false breaks cluster in slots like this one.`
    );
  }

  const widest = [...rankedSlots].sort((a, b) => b.rangeMultiple - a.rangeMultiple)[0];
  if (widest) {
    out.push(
      `Widest slot by range: ${widest.label} at ${widest.rangeMultiple.toFixed(2)}× the average bar on ${widest.volumeMultiple.toFixed(2)}× the volume` +
        (widest.volumeMultiple < 1
          ? " — range without participation, which is a thin book rather than conviction."
          : " — range with participation behind it.")
    );
  }

  out.push(
    `All of the above is volume and range over ${days} days, which is what a clock genuinely determines. Direction is handled separately, and much more sceptically, under Patterns.`
  );
  return out;
}
