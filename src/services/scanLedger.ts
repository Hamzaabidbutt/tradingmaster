import { Timeframe, TIMEFRAME_MINUTES } from "@/lib/config";
import { fetchKlines } from "@/lib/binance";
import { Candle } from "@/engines/types";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/db";
import {
  scanBosMomentum,
  scanCandleLadder,
  scanComposite,
  scanEngulfing,
  scanFlowAlignment,
  scanInstitutional,
  scanLiquidationReversals,
  scanRecovery,
  scanRetestThrust,
  scanZoneReversals,
} from "./scanService";

/**
 * The forward ledger: what each scanner claimed, and what price did next.
 *
 * Every scanner in this app renders a page and some of them send alerts, and
 * until this file existed none of them had a *record*. There was no way to ask
 * which scanners produce anything, on which timeframes, or whether the grade
 * on a row means what it says — so every threshold in the app was a judgement
 * nobody could check, including all of mine.
 *
 * ## Forward, not backtested
 *
 * The app already has a backtest. A backtest can be tuned until it agrees with
 * you; a row written before the outcome exists cannot be. This also measures
 * the scanners *as they actually run* — at the depth limit, on the sweep's
 * schedule, with whatever staleness that implies — rather than an idealised
 * replay that no live user ever experiences.
 *
 * ## What it will not claim
 *
 * A hit rate here is a measured frequency over whatever rows have accumulated.
 * It is not an edge, not a probability, and not a forecast, and for the first
 * weeks it will be far too thin to read at all. The scorecard refuses to print
 * a rate below a sample floor for that reason, and every rate it does print
 * carries its denominator.
 *
 * It also cannot see selection: it records what the scanner surfaced, which is
 * already filtered by the scanner's own gate and its depth limit. "Setups this
 * scanner shows do X" is the claim. "Setups like this do X" is not.
 */

/* ------------------------------------------------------------------ *
 * What a row looks like before it is written
 * ------------------------------------------------------------------ */

export type Side = "long" | "short";

export interface Observation {
  scanner: string;
  /** the scanner's own bucket, kept verbatim so rates can be split by it */
  state: string;
  symbol: string;
  timeframe: string;
  side: Side;
  price: number;
  /** the level the setup leans on, where it has one */
  level: number | null;
  /** open time of the last closed bar the scan read, unix seconds */
  barTime: number;
  meta: Record<string, string | number | boolean | null>;
}

/**
 * One row per *event*, not per sweep.
 *
 * Keyed on the bar the scan read rather than the time it ran, so a setup that
 * persists across six sweeps is one observation with one outcome rather than
 * six correlated copies. Six copies would not be six pieces of evidence — they
 * are one setup counted six times, and they would make every rate in the
 * scorecard a function of how often the cron happens to run.
 */
export function observationKey(o: Observation): string {
  return `${o.scanner}:${o.symbol}:${o.timeframe}:${o.state}:${o.barTime}`;
}

/* ------------------------------------------------------------------ *
 * Adapters
 * ------------------------------------------------------------------ */

/** Direction words each engine uses, mapped to one vocabulary. */
function sideOf(raw: string | null | undefined): Side | null {
  switch (raw) {
    case "long":
    case "bullish":
    case "BUY":
    case "up":
    case "accumulation":
      return "long";
    case "short":
    case "bearish":
    case "SELL":
    case "down":
    case "distribution":
      return "short";
    default:
      return null;
  }
}

interface ScannerSpec {
  name: string;
  /** false when the scan costs extra requests beyond the shared klines call */
  cheap: boolean;
  /**
   * Set when the engine reads one timeframe regardless of what it is asked.
   *
   * Such a scanner runs only on a pass at that timeframe. Running it on every
   * pass would re-record identical rows under whichever timeframe happened to
   * be sweeping, and file them where the scorer — which refetches candles at
   * the row's own timeframe — could never reproduce them.
   */
  fixedTimeframe?: Timeframe;
  run(opts: { timeframe: Timeframe; depth: number }): Promise<Observation[]>;
}

/**
 * The scanners the ledger records, and what counts as a row for each.
 *
 * Only buckets where the scanner is making a *directional claim* are recorded.
 * Watchlist and "forming" buckets are left out — not because they are
 * uninteresting, but because they are the scanner explicitly declining to
 * claim anything, and scoring a non-claim as a miss would drag every rate down
 * by the size of the watchlist.
 *
 * Accumulation is excluded because its setup carries no bar time, so there is
 * nothing stable to key a row on — falling back to the sweep's own clock would
 * write a fresh row every pass and turn one base into a dozen correlated
 * observations, which is the exact failure the key exists to prevent.
 *
 * Cascade risk is excluded entirely, and the reason is worth stating: it warns
 * which *side* is about to be liquidated, so a "long" cascade means longs get
 * flushed and price falls. Its `side` is the side at risk, not a trade
 * direction, and recording it with the others would enter every one of its
 * rows backwards.
 */
const SCANNERS: ScannerSpec[] = [
  {
    name: "thrust",
    cheap: true,
    async run({ timeframe, depth }) {
      const s = await scanRetestThrust({ timeframe, depth });
      const rows: Observation[] = [];
      for (const [state, list] of [
        ["armed", s.armed],
        ["held", s.held],
        ["thrusting", s.thrusting],
      ] as const) {
        for (const e of list) {
          rows.push({
            scanner: "thrust",
            state,
            symbol: e.symbol,
            timeframe: e.timeframe,
            side: e.setup.direction,
            price: e.price,
            level: e.setup.level,
            barTime: e.barTime,
            meta: {
              score: e.setup.score,
              legAtr: e.setup.legAtr,
              precedentCount: e.setup.precedent.count,
              precedentBoomRate: e.setup.precedent.boomRate,
            },
          });
        }
      }
      return rows;
    },
  },
  {
    name: "ladder",
    cheap: true,
    async run({ timeframe, depth }) {
      const s = await scanCandleLadder({ timeframe, depth });
      return [...s.climbing, ...s.falling].map((e) => ({
        scanner: "ladder",
        state: e.ladder.direction === "up" ? "climbing" : "falling",
        symbol: e.symbol,
        timeframe: e.timeframe,
        side: e.ladder.direction === "up" ? ("long" as const) : ("short" as const),
        price: e.price,
        level: e.ladder.lineNow,
        barTime: e.barTime,
        meta: {
          bars: e.ladder.bars,
          r2: e.ladder.r2,
          score: e.ladder.score,
          bodyShare: e.ladder.bodyShare,
        },
      }));
    },
  },
  {
    name: "bos",
    cheap: true,
    async run({ timeframe, depth }) {
      const s = await scanBosMomentum({ timeframe, depth });
      const rows: Observation[] = [];
      for (const [state, list] of [
        ["retest_held", s.held],
        ["retesting", s.retesting],
        ["retest_pending", s.pending],
        ["fresh_break", s.fresh],
      ] as const) {
        for (const e of list) {
          const side = sideOf(e.setup.direction);
          if (!side) continue;
          rows.push({
            scanner: "bos",
            state,
            symbol: e.symbol,
            timeframe: e.timeframe,
            side,
            price: e.setup.price,
            level: e.setup.level,
            barTime: e.barTime,
            meta: { momentum: e.setup.momentum, grade: e.setup.grade ?? "none" },
          });
        }
      }
      return rows;
    },
  },
  {
    name: "flow",
    // two calls per symbol: the open-interest series has no substitute
    cheap: false,
    async run({ timeframe, depth }) {
      const s = await scanFlowAlignment({ timeframe, depth });
      const rows: Observation[] = [];
      for (const [state, side, list] of [
        ["longs_building", "long", s.longsBuilding],
        ["shorts_building", "short", s.shortsBuilding],
      ] as const) {
        for (const e of list) {
          rows.push({
            scanner: "flow",
            state,
            symbol: e.symbol,
            timeframe: e.timeframe,
            side,
            price: 0, // filled from candles by the scorer; the entry carries no price
            level: null,
            barTime: e.barTime,
            meta: { score: e.read.score },
          });
        }
      }
      return rows;
    },
  },
  {
    name: "zone",
    cheap: true,
    async run({ timeframe, depth }) {
      const s = await scanZoneReversals({ timeframe, depth });
      const rows: Observation[] = [];
      for (const [side, list] of [
        ["long", s.bullish],
        ["short", s.bearish],
      ] as const) {
        for (const e of list) {
          rows.push({
            scanner: "zone",
            state: e.setup.grade ?? "qualified",
            symbol: e.symbol,
            timeframe: e.timeframe,
            side,
            price: e.setup.price,
            level: e.setup.entry ?? null,
            barTime: e.barTime,
            meta: { score: e.setup.score, grade: e.setup.grade ?? "none" },
          });
        }
      }
      return rows;
    },
  },
  {
    name: "liqspike",
    cheap: true,
    async run({ timeframe, depth }) {
      const s = await scanLiquidationReversals({ timeframe, depth });
      const rows: Observation[] = [];
      /* Bottoms are longs and tops are shorts — the bucket carries the
         direction, because the setup itself reports the side that was
         *liquidated* rather than the side to take. */
      for (const [state, side, list] of [
        ["bottom", "long", s.bottoms],
        ["top", "short", s.tops],
      ] as const) {
        for (const e of list) {
          rows.push({
            scanner: "liqspike",
            state,
            symbol: e.symbol,
            timeframe: e.timeframe,
            side,
            price: e.setup.price,
            level: e.setup.spike?.extreme ?? null,
            barTime: e.barTime,
            meta: { score: e.setup.score, grade: e.setup.grade ?? "none" },
          });
        }
      }
      return rows;
    },
  },
  {
    name: "engulfing",
    cheap: true,
    async run({ timeframe, depth }) {
      const s = await scanEngulfing({ timeframe, depth });
      // The engine detects *bullish* engulfing only, so every row is a long.
      return s.confirmed.map((e) => ({
        scanner: "engulfing",
        state: e.setup.grade ?? "qualified",
        symbol: e.symbol,
        timeframe: e.timeframe,
        side: "long" as const,
        price: e.setup.price,
        level: e.setup.entry ?? null,
        barTime: e.barTime,
        meta: { score: e.setup.score, grade: e.setup.grade ?? "none" },
      }));
    },
  },
  {
    name: "institutional",
    cheap: true,
    async run({ timeframe, depth }) {
      const s = await scanInstitutional({ timeframe, depth });
      return s.footprints.flatMap((e) => {
        const side = sideOf(e.setup.side);
        if (!side) return [];
        return [
          {
            scanner: "institutional",
            state: e.setup.grade ?? "qualified",
            symbol: e.symbol,
            timeframe: e.timeframe,
            side,
            price: e.setup.price,
            level: null,
            barTime: e.barTime,
            meta: { score: e.setup.score, grade: e.setup.grade ?? "none" },
          } satisfies Observation,
        ];
      });
    },
  },
  {
    name: "recovery",
    cheap: true,
    /* Always daily, whatever timeframe the pass is running — the engine reads
       1d candles by construction, so recording its rows under the pass's
       timeframe would file them where no scorer could reproduce them. */
    fixedTimeframe: "1d",
    async run({ depth }) {
      const s = await scanRecovery({ depth });
      return s.candidates.map((e) => ({
        scanner: "recovery",
        state: e.setup.grade ?? "qualified",
        symbol: e.symbol,
        timeframe: "1d",
        side: "long" as const,
        price: e.setup.price,
        level: null,
        barTime: e.barTime,
        meta: { score: e.setup.score, grade: e.setup.grade ?? "none" },
      }));
    },
  },
  {
    name: "composite",
    cheap: true,
    async run({ timeframe, depth }) {
      const s = await scanComposite({ timeframe, depth });
      const rows: Observation[] = [];
      for (const [side, list] of [
        ["long", s.long],
        ["short", s.short],
      ] as const) {
        for (const e of list) {
          if (!e.setup) continue;
          rows.push({
            scanner: "composite",
            state: "qualified",
            symbol: e.symbol,
            timeframe: e.timeframe,
            side,
            price: e.setup.entry,
            level: e.setup.stopLoss,
            barTime: e.barTime,
            meta: { confidence: e.setup.confidence, riskReward: e.setup.riskReward },
          });
        }
      }
      return rows;
    },
  },
];

/** Names the recorder knows, for the route's `?scanners=` filter. */
export const SCANNER_NAMES = SCANNERS.map((s) => s.name);

/* ------------------------------------------------------------------ *
 * Recording
 * ------------------------------------------------------------------ */

export interface RecordRun {
  timeframe: string;
  scanners: string[];
  observed: number;
  /** per-scanner counts, so a silent adapter is visible rather than averaged away */
  byScanner: Record<string, number>;
  written: number;
  duplicates: number;
  failures: { scanner: string; error: string }[];
  ranAt: number;
  error?: string;
}

/**
 * Run the scanners and write down what they surfaced.
 *
 * Cheaper than it looks: every scan asks for the same `SCAN_BARS` klines under
 * the same cache key, so the first scanner in a pass pays for the universe and
 * the rest are served from cache. The exception is flow, which needs a second
 * open-interest series per symbol and is marked accordingly.
 */
export async function recordScans(opts: {
  timeframe: Timeframe;
  depth?: number;
  scanners?: string[];
  /** skip the scanners that cost extra requests */
  cheapOnly?: boolean;
  /**
   * Run every scanner and report what it produced, writing nothing.
   *
   * The way to check an adapter is reading its scanner correctly without
   * needing a database to look at afterwards — an adapter pointed at the wrong
   * bucket returns zero rows and is otherwise completely silent.
   */
  dryRun?: boolean;
}): Promise<RecordRun> {
  const depth = opts.depth ?? Number(process.env.LEDGER_DEPTH ?? 60);
  const wanted = opts.scanners?.length
    ? SCANNERS.filter((s) => opts.scanners!.includes(s.name))
    : SCANNERS;
  const chosen = (opts.cheapOnly ? wanted.filter((s) => s.cheap) : wanted).filter(
    (s) => s.fixedTimeframe == null || s.fixedTimeframe === opts.timeframe
  );

  const run: RecordRun = {
    timeframe: opts.timeframe,
    scanners: chosen.map((s) => s.name),
    observed: 0,
    byScanner: {},
    written: 0,
    duplicates: 0,
    failures: [],
    ranAt: Math.floor(Date.now() / 1000),
  };

  const rows: Observation[] = [];
  for (const spec of chosen) {
    try {
      /* Sequential rather than parallel: the scans share a klines cache, and
         firing them together means every one of them misses it and refetches
         the universe simultaneously — the same requests at N times the weight,
         which is exactly the pattern that gets an IP rate-limited. */
      const produced = await spec.run({ timeframe: opts.timeframe, depth });
      run.byScanner[spec.name] = produced.length;
      rows.push(...produced);
    } catch (err) {
      run.failures.push({ scanner: spec.name, error: String(err) });
      logger.warn("ledger.scan_failed", { scanner: spec.name, error: String(err) });
    }
  }
  run.observed = rows.length;
  if (rows.length === 0 || opts.dryRun) return run;

  for (const o of rows) {
    const key = observationKey(o);
    try {
      /* findUnique before create, for the same reason the alert store does it:
         MongoDB creates collections implicitly but never creates indexes, so an
         install that skipped `db push` has no unique constraint and every
         insert succeeds. Read-then-write leaves a small race and turns "a
         duplicate every sweep" into "a rare duplicate". */
      if (await prisma.scanObservation.findUnique({ where: { key }, select: { id: true } })) {
        run.duplicates++;
        continue;
      }
      await prisma.scanObservation.create({
        data: {
          key,
          scanner: o.scanner,
          state: o.state,
          symbol: o.symbol,
          timeframe: o.timeframe,
          side: o.side,
          price: o.price,
          level: o.level,
          barTime: o.barTime,
          meta: o.meta,
        },
      });
      run.written++;
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "P2002") {
        run.duplicates++;
        continue;
      }
      if (!run.error) run.error = String(err);
      logger.warn("ledger.write_failed", { symbol: o.symbol, error: String(err) });
    }
  }

  logger.info("ledger.recorded", {
    timeframe: opts.timeframe,
    observed: run.observed,
    written: run.written,
  });
  return run;
}

/* ------------------------------------------------------------------ *
 * Scoring
 * ------------------------------------------------------------------ */

/** Bars of follow-through each observation is judged over. */
const WINDOW_BARS = 20;
/** Favourable excursion, in ATR, that counts as the setup working. */
const TARGET_ATR = 2;
/** Adverse excursion, in ATR, that counts as it failing first. */
const STOP_ATR = 1;

function atrAt(candles: Candle[], end: number, period = 14): number {
  const from = Math.max(1, end - period + 1);
  if (end < 1) return 0;
  let sum = 0;
  let n = 0;
  for (let i = from; i <= end; i++) {
    const c = candles[i];
    const prev = candles[i - 1].close;
    sum += Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
    n++;
  }
  return n > 0 ? sum / n : 0;
}

export interface ScoredOutcome {
  atr: number;
  barsScored: number;
  favourableAtr: number;
  adverseAtr: number;
  outcome: "target" | "stopped" | "neither" | "no_data";
  /** the close the excursions were measured from */
  entry: number;
}

/**
 * Judge one observation against the bars that followed it.
 *
 * ## Measured from the close, for every scanner alike
 *
 * Not from whatever entry price the scanner proposed. Several of them suggest
 * a limit at a level, and scoring against that would require deciding whether
 * the limit ever filled — which is modelling, and getting it wrong is how this
 * app previously recorded phantom fills. The close of the bar the scan read is
 * a price that certainly existed and was certainly available at the moment the
 * scanner spoke, and it is the same rule for all of them, which is the only
 * way the numbers compare.
 *
 * ## Which came first decides it
 *
 * Walked bar by bar rather than by taking the maxima over the whole window. A
 * setup that runs 4 ATR in your favour *after* a 1 ATR move against you is not
 * a winner — nobody was still in it. Taking both maxima independently would
 * count that as a target hit and quietly flatter every scanner by however
 * often it happens, which on a volatile session is often.
 *
 * Within a single bar, when both thresholds fall inside the same candle's
 * range, the adverse one is assumed to come first. That is the pessimistic
 * reading and it is chosen deliberately: the optimistic one cannot be checked
 * without tick data, and an unverifiable assumption that favours the product
 * is the kind that never gets revisited.
 */
export function scoreObservation(
  candles: Candle[],
  barTime: number,
  side: Side
): ScoredOutcome {
  const start = candles.findIndex((c) => c.time === barTime);
  if (start < 1 || start >= candles.length - 1) {
    return { atr: 0, barsScored: 0, favourableAtr: 0, adverseAtr: 0, outcome: "no_data", entry: 0 };
  }
  const atr = atrAt(candles, start);
  const entry = candles[start].close;
  if (!(atr > 0)) {
    return { atr: 0, barsScored: 0, favourableAtr: 0, adverseAtr: 0, outcome: "no_data", entry };
  }

  const long = side === "long";
  let favourable = 0;
  let adverse = 0;
  let outcome: ScoredOutcome["outcome"] = "neither";
  let bars = 0;

  const last = Math.min(candles.length - 1, start + WINDOW_BARS);
  for (let i = start + 1; i <= last; i++) {
    const c = candles[i];
    bars++;
    const up = (long ? c.high - entry : entry - c.low) / atr;
    const down = (long ? entry - c.low : c.high - entry) / atr;
    favourable = Math.max(favourable, up);
    adverse = Math.max(adverse, down);

    // Pessimistic within the bar: the adverse threshold is checked first.
    if (down >= STOP_ATR) {
      outcome = "stopped";
      break;
    }
    if (up >= TARGET_ATR) {
      outcome = "target";
      break;
    }
  }

  return { atr, barsScored: bars, favourableAtr: favourable, adverseAtr: adverse, outcome, entry };
}

export interface ScoreRun {
  considered: number;
  scored: number;
  skipped: number;
  failures: number;
  ranAt: number;
  error?: string;
}

/**
 * Score every observation that has had time to play out.
 *
 * An observation is only eligible once `WINDOW_BARS` of its own timeframe have
 * closed since its bar. Scoring earlier would record a partial window as a
 * finished one, and since an unfinished trade is far more likely to be
 * "neither" than a finished one, it would bias every scanner's rate toward
 * nothing-happened by exactly the amount of missing time.
 */
export async function scoreObservations(opts: { limit?: number } = {}): Promise<ScoreRun> {
  const limit = opts.limit ?? Number(process.env.LEDGER_SCORE_LIMIT ?? 200);
  const run: ScoreRun = { considered: 0, scored: 0, skipped: 0, failures: 0, ranAt: Math.floor(Date.now() / 1000) };

  let pending;
  try {
    pending = await prisma.scanObservation.findMany({
      where: { scoredAt: null },
      orderBy: { barTime: "asc" },
      take: limit,
    });
  } catch (err) {
    run.error = String(err);
    logger.warn("ledger.score.lookup_failed", { error: String(err) });
    return run;
  }
  run.considered = pending.length;
  if (pending.length === 0) return run;

  const nowSec = Math.floor(Date.now() / 1000);
  /* Grouped by symbol and timeframe so one klines call serves every row that
     shares them — on a busy pass that is the difference between one request
     and forty for the same candles. */
  const groups = new Map<string, typeof pending>();
  for (const row of pending) {
    const barMin = TIMEFRAME_MINUTES[row.timeframe as Timeframe];
    if (!barMin) {
      run.skipped++;
      continue;
    }
    // Not yet ripe: the window has not closed.
    if (nowSec - row.barTime < WINDOW_BARS * barMin * 60) {
      run.skipped++;
      continue;
    }
    const gk = `${row.symbol}:${row.timeframe}`;
    const list = groups.get(gk);
    if (list) list.push(row);
    else groups.set(gk, [row]);
  }

  for (const [gk, rows] of groups) {
    const [symbol, timeframe] = gk.split(":");
    let candles: Candle[];
    try {
      candles = await fetchKlines(symbol, timeframe as Timeframe, 400);
    } catch (err) {
      run.failures += rows.length;
      logger.warn("ledger.score.klines_failed", { symbol, error: String(err) });
      continue;
    }
    for (const row of rows) {
      const scored = scoreObservation(candles, row.barTime, row.side as Side);
      try {
        await prisma.scanObservation.update({
          where: { id: row.id },
          data: {
            scoredAt: new Date(),
            atr: scored.atr,
            barsScored: scored.barsScored,
            favourableAtr: scored.favourableAtr,
            adverseAtr: scored.adverseAtr,
            outcome: scored.outcome,
            /* Overwritten with the close the outcome was actually measured
               from, so the column means one thing on every scored row rather
               than "whatever that scanner happened to call a price". */
            ...(scored.entry > 0 ? { price: scored.entry } : {}),
          },
        });
        run.scored++;
      } catch (err) {
        run.failures++;
        logger.warn("ledger.score.write_failed", { id: row.id, error: String(err) });
      }
    }
  }

  logger.info("ledger.scored", { scored: run.scored, skipped: run.skipped });
  return run;
}

/* ------------------------------------------------------------------ *
 * The scorecard
 * ------------------------------------------------------------------ */

/**
 * Below this many scored rows, a rate is not printed as a rate.
 *
 * The same rule the thrust engine's precedent uses, for the same reason: a
 * frequency from four cases is a description of four cases, and rendering it
 * as a percentage invites it to be read as a property of the scanner. For the
 * first weeks of this ledger every row will be below the floor, and that is
 * the honest state of the evidence rather than a defect.
 */
export const MIN_SAMPLE = 20;

export interface ScorecardRow {
  scanner: string;
  timeframe: string;
  state: string;
  /** rows written, scored or not */
  observed: number;
  scored: number;
  target: number;
  stopped: number;
  neither: number;
  /** share of scored rows that reached the target first; null below the floor */
  hitRate: number | null;
  /** median favourable excursion in ATR */
  medianFavourableAtr: number;
  /** median adverse excursion in ATR */
  medianAdverseAtr: number;
  /** mean of (favourable − adverse), the crude expectancy in ATR */
  edgeAtr: number | null;
}

export interface Scorecard {
  rows: ScorecardRow[];
  totalObserved: number;
  totalScored: number;
  /** oldest observation, unix seconds — how long the ledger has been running */
  since: number | null;
  minSample: number;
  windowBars: number;
  targetAtr: number;
  stopAtr: number;
  error?: string;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Aggregate the ledger into one row per scanner, timeframe and state.
 *
 * Split by state as well as by scanner, because a scanner's states are not
 * degrees of one thing — a held retest and a fresh break are different claims,
 * and averaging them produces a number that describes neither. The split is
 * also where the useful answer usually lives: it is common for one state of a
 * scanner to carry everything and the rest to be noise, which a single
 * per-scanner rate would hide completely.
 */
/** The shape the aggregation needs, so it can be tested without a database. */
export interface ScoredRowInput {
  scanner: string;
  timeframe: string;
  state: string;
  outcome: string | null;
  favourableAtr: number | null;
  adverseAtr: number | null;
  observedAt: Date;
}

/**
 * Aggregate rows into one line per scanner, timeframe and state.
 *
 * Pure, and separated from the query on purpose: this is the function that
 * decides which numbers a reader sees, and it is the one place where a small
 * mistake would not look like a bug — it would look like evidence, and it
 * would be used to decide which scanners to keep. It gets tested directly
 * rather than through a database that is not reachable everywhere.
 *
 * Split by state as well as by scanner, because a scanner's states are not
 * degrees of one thing — a held retest and a fresh break are different claims,
 * and averaging them produces a number describing neither. The split is also
 * where the useful answer usually lives: it is common for one state to carry
 * everything and the rest to be noise, which a single per-scanner rate hides.
 */
export function aggregateScorecard(all: ScoredRowInput[]): Scorecard {
  const card: Scorecard = {
    rows: [],
    totalObserved: all.length,
    totalScored: 0,
    since: null,
    minSample: MIN_SAMPLE,
    windowBars: WINDOW_BARS,
    targetAtr: TARGET_ATR,
    stopAtr: STOP_ATR,
  };
  if (all.length === 0) return card;
  card.since = Math.floor(Math.min(...all.map((r) => r.observedAt.getTime())) / 1000);

  const buckets = new Map<string, ScoredRowInput[]>();
  for (const r of all) {
    const k = `${r.scanner}|${r.timeframe}|${r.state}`;
    const list = buckets.get(k);
    if (list) list.push(r);
    else buckets.set(k, [r]);
  }

  for (const [k, rows] of buckets) {
    const [scanner, timeframe, state] = k.split("|");
    /* `no_data` is not an outcome, it is the scorer saying it could not
       measure — usually because history had scrolled past the bar. Counting it
       as a miss would penalise a scanner for the ledger's own gaps. */
    const scored = rows.filter((r) => r.outcome && r.outcome !== "no_data");
    const target = scored.filter((r) => r.outcome === "target").length;
    const stopped = scored.filter((r) => r.outcome === "stopped").length;
    const neither = scored.filter((r) => r.outcome === "neither").length;
    const fav = scored.map((r) => r.favourableAtr ?? 0);
    const adv = scored.map((r) => r.adverseAtr ?? 0);
    const enough = scored.length >= MIN_SAMPLE;

    card.totalScored += scored.length;
    card.rows.push({
      scanner,
      timeframe,
      state,
      observed: rows.length,
      scored: scored.length,
      target,
      stopped,
      neither,
      hitRate: enough ? target / scored.length : null,
      medianFavourableAtr: median(fav),
      medianAdverseAtr: median(adv),
      edgeAtr: enough ? fav.reduce((s, v, i) => s + (v - adv[i]), 0) / scored.length : null,
    });
  }

  /* Ordered by how much evidence there is, not by how good the number looks.
     Sorting by hit rate would put a 3-of-4 at the top of a page whose whole
     purpose is to stop small samples being read as findings. */
  card.rows.sort((a, b) => b.scored - a.scored || b.observed - a.observed);
  return card;
}

/** Read the ledger and aggregate it. */
export async function buildScorecard(opts: { days?: number } = {}): Promise<Scorecard> {
  const days = opts.days ?? 90;
  try {
    const all = await prisma.scanObservation.findMany({
      where: { observedAt: { gte: new Date(Date.now() - days * 86_400_000) } },
      select: {
        scanner: true,
        timeframe: true,
        state: true,
        outcome: true,
        favourableAtr: true,
        adverseAtr: true,
        observedAt: true,
      },
    });
    return aggregateScorecard(all);
  } catch (err) {
    /* Plain language, not the driver's own message.
    
       Prisma's initialisation error is a multi-line report quoting the schema
       file and a line number, and rendering it verbatim put a stack trace in
       front of a reader who can do nothing with it. Every other route in this
       app says "database unavailable" for the same condition, and a page that
       phrases its failures differently from its neighbours reads as broken
       rather than as unconfigured. */
    const raw = String(err);
    const unreachable =
      raw.includes("DATABASE_URL") ||
      raw.includes("PrismaClientInitializationError") ||
      raw.includes("ECONNREFUSED") ||
      raw.includes("Server selection timeout");
    logger.warn("ledger.scorecard.failed", { error: raw });
    return {
      ...aggregateScorecard([]),
      error: unreachable ? "database unavailable" : raw.slice(0, 300),
    };
  }
}
