import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { AnalystKey, AnalystVerdict, EvidenceBasis, OutcomeAnalysis } from "@/engines/types";
import { bucketScore, classifyBucket } from "@/engines/outcomeBuckets";

/**
 * Per-analyst and overall performance, derived from closed signals.
 *
 * Deliberately **derived on read** rather than kept as counters. Stored
 * counters are a second source of truth that drifts from the signals they
 * claim to summarise the first time a row is edited, back-filled, or a signal
 * is re-evaluated — and there is no way to notice the drift. Deriving also
 * satisfies "statistics update automatically as signals reach their outcome"
 * for free: the outcome *is* the statistic.
 *
 * Attribution rule: an analyst's record covers the signals it **supported** —
 * where it cleared its quality gate and pointed the way the signal went.
 *
 *  * An analyst that **abstained** is not charged. Charging abstentions as
 *    losses would make the quality gates in confluence.ts look like a defect
 *    rather than the point, and would push the system toward always voting.
 *  * An analyst that **opposed** a losing signal is credited separately
 *    (`correctlyOpposed`), because being right against the crowd is real
 *    information about that analyst.
 *
 * These numbers exist to *evaluate* the analysts. Nothing here is readable by
 * `evaluateConfluence`, which takes no stats parameter — so history can never
 * push a signal the present chart does not support.
 */

/** Below this many attributed signals, a win rate is noise — report null. */
const MIN_SAMPLE = 5;
/** Ranking best/worst analyst needs a slightly larger sample to be fair. */
const MIN_RANK_SAMPLE = 8;

const ANALYSTS: { key: AnalystKey; name: string; basis: EvidenceBasis }[] = [
  { key: "chart", name: "Chart Analyst", basis: "pattern_history" },
  { key: "candleClose", name: "Candle Close Expansion", basis: "level_close" },
  { key: "range", name: "Range Trading", basis: "range_boundary" },
];

/**
 * Statuses that mean a signal is *resolved* and can be scored.
 *
 * TP1_HIT and TP2_HIT are deliberately absent. They are partial fills on a
 * position that is still running — `resultPnlPct` is not written until the
 * signal finishes, so scoring them would count every in-progress winner as a
 * zero-P/L loss. They belong in `active` until they stop out, reach TP3 or
 * expire.
 */
const CLOSED_STATUSES = ["TP3_HIT", "STOPPED", "EXPIRED"];
const ACTIVE_STATUSES = ["ACTIVE", "TP1_HIT", "TP2_HIT"];

/**
 * The shape this module reads. Declared locally, not imported from Prisma, so
 * `computePerformance` stays a pure function over plain objects and the tests
 * need no database.
 */
export interface PerfSignal {
  id: string;
  symbol: string;
  timeframe: string;
  side: "BUY" | "SELL";
  status: string;
  confidence: number;
  resultPnlPct: number | null;
  outcomeReason: string | null;
  outcomeAnalysis: OutcomeAnalysis | null;
  verdicts: AnalystVerdict[];
  createdAt: Date;
}

export interface ReasonCount {
  reason: string;
  label: string;
  count: number;
}

export interface LabelledMetric {
  label: string;
  value: string | number;
  tone?: "bull" | "bear" | "neutral";
}

export interface AnalystPerformance {
  analyst: AnalystKey;
  name: string;
  basis: EvidenceBasis;
  /** closed signals this analyst supported */
  totalSignals: number;
  wins: number;
  losses: number;
  /** closed red but reached TP1 first — right on direction, wrong on exit */
  partials: number;
  /** null until MIN_SAMPLE attributed signals exist */
  winRate: number | null;
  /** win rate with partials given half credit, 0-100 */
  weightedAccuracy: number;
  longWins: number;
  longLosses: number;
  longWinRate: number | null;
  shortWins: number;
  shortLosses: number;
  shortWinRate: number | null;
  avgReturnPct: number;
  avgWinPct: number;
  avgLossPct: number;
  bestTimeframe: { timeframe: string; winRate: number; sample: number } | null;
  successReasons: ReasonCount[];
  failureReasons: ReasonCount[];
  abstentions: number;
  /** abstained on a signal that then lost — the gate did its job */
  correctAbstentions: number;
  /** opposed a signal that then lost */
  correctlyOpposed: number;
  /** metrics unique to this analyst, per the spec for each module */
  specific: LabelledMetric[];
}

/**
 * How close signals got to their first target before failing.
 *
 * `meanPct` is null rather than 0 when nothing qualifies: "0 % of the way" is a
 * claim about the market, "n/a" is a claim about the sample, and printing the
 * former for the latter is the exact mistake `fmtMean` exists to prevent.
 */
export interface TargetProgressStat {
  meanPct: number | null;
  /** losing signals that carried a usable figure */
  sample: number;
  /** the closest any single loser came, as a share of the first target */
  bestPct: number | null;
}

export interface OverallPerformance {
  totalSignals: number;
  successful: number;
  /**
   * Closed at or below breakeven having reached the first target.
   *
   * Counted apart from `failed`, and excluded from it, so the three buckets
   * add up to the closed total. A call that ran to TP1 and gave it back was
   * right about direction; filing it beside an outright miss hides the only
   * distinction that matters when reviewing losses.
   */
  partials: number;
  /** closed at or below breakeven without ever reaching the first target */
  failed: number;
  active: number;
  expired: number;
  winRate: number | null;
  /** win rate with partials given half credit, 0-100 */
  weightedAccuracy: number;
  longSignals: number;
  shortSignals: number;
  longWinRate: number | null;
  shortWinRate: number | null;
  avgProfitPct: number;
  avgLossPct: number;
  /**
   * How far losing signals travelled toward their first target, overall and
   * split by direction. Split because a system that gets 80 % of the way on
   * shorts and 20 % on longs is not the same system as one that averages 50 %
   * on both, and the average alone would hide it.
   */
  lossTargetProgress: { all: TargetProgressStat; long: TargetProgressStat; short: TargetProgressStat };
  bestStrategy: { key: string; name: string; winRate: number; sample: number } | null;
  worstStrategy: { key: string; name: string; winRate: number; sample: number } | null;
}

export interface PerformanceReport {
  overall: OverallPerformance;
  analysts: AnalystPerformance[];
  /** how many closed signals carried analyst attribution at all */
  attributedSignals: number;
  /** closed signals written before attribution existed */
  legacySignals: number;
  minSample: number;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function rate(wins: number, total: number, min = MIN_SAMPLE): number | null {
  if (total < min) return null;
  return Number(((wins / total) * 100).toFixed(1));
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return Number((values.reduce((s, v) => s + v, 0) / values.length).toFixed(2));
}

/**
 * How far a set of *losing* signals got toward their first target.
 *
 * Losers only, deliberately. On a winner the figure is ≥ 100 % by construction,
 * so pooling the two would produce an average that answers no question anybody
 * asked. Signals with no stored figure — legacy rows, or closes where the
 * excursion fetch failed — are excluded rather than counted as zero, and the
 * sample says how many the mean actually rests on.
 */
function lossTargetProgress(losses: PerfSignal[]): TargetProgressStat {
  const values = losses
    .map((s) => s.outcomeAnalysis?.excursion?.targetProgressPct)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return {
    meanPct: values.length > 0 ? mean(values) : null,
    sample: values.length,
    bestPct: values.length > 0 ? Number(Math.max(...values).toFixed(1)) : null,
  };
}

/**
 * Win/loss is decided by realised P/L, not by the status field.
 *
 * A trade that expired 1.2% up made money; a trade that tagged a target and
 * then reversed into the stop did not. Only applied to resolved signals, where
 * `resultPnlPct` is populated.
 */
function isWin(s: PerfSignal): boolean {
  return (s.resultPnlPct ?? 0) > 0;
}

/**
 * Reached TP1 but closed red — directionally right, managed badly.
 *
 * Kept out of `isWin` so P/L-based averages stay honest (these trades really
 * did lose money), but counted separately so accuracy is not understated by
 * lumping them in with calls that were simply wrong.
 */
function isPartialWin(s: PerfSignal): boolean {
  return !isWin(s) && classifyBucket(s) === "partial";
}

/**
 * Accuracy that gives partials half credit.
 *
 * A plain win rate treats "right, then gave it back" identically to "wrong
 * from the start". Weighting partials at 0.5 separates the two without
 * pretending a red trade was green.
 */
function weightedAccuracy(signals: PerfSignal[]): number {
  if (signals.length === 0) return 0;
  const score = signals.reduce((sum, s) => sum + bucketScore(classifyBucket(s)), 0);
  return Number(((score / signals.length) * 100).toFixed(1));
}

function isClosed(s: PerfSignal): boolean {
  return CLOSED_STATUSES.includes(s.status);
}

/** Sort reason counts descending and label them. */
function countReasons(signals: PerfSignal[]): ReasonCount[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (const s of signals) {
    const reason = s.outcomeReason ?? s.outcomeAnalysis?.reason ?? "unclassified";
    const label = s.outcomeAnalysis?.reasonLabel ?? humanise(reason);
    const cur = counts.get(reason);
    if (cur) cur.count++;
    else counts.set(reason, { label, count: 1 });
  }
  return [...counts.entries()]
    .map(([reason, v]) => ({ reason, label: v.label, count: v.count }))
    .sort((a, b) => b.count - a.count);
}

function humanise(reason: string): string {
  return reason.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** Best win rate among timeframes with enough attributed signals. */
function bestTimeframe(signals: PerfSignal[]): AnalystPerformance["bestTimeframe"] {
  const buckets = new Map<string, { wins: number; total: number }>();
  for (const s of signals) {
    const b = buckets.get(s.timeframe) ?? { wins: 0, total: 0 };
    b.total++;
    if (isWin(s)) b.wins++;
    buckets.set(s.timeframe, b);
  }
  let best: AnalystPerformance["bestTimeframe"] = null;
  for (const [timeframe, b] of buckets) {
    // A 100% rate off two signals is not a "best-performing timeframe".
    if (b.total < 3) continue;
    const wr = Number(((b.wins / b.total) * 100).toFixed(1));
    if (!best || wr > best.winRate || (wr === best.winRate && b.total > best.sample)) {
      best = { timeframe, winRate: wr, sample: b.total };
    }
  }
  return best;
}

/** The verdict this analyst gave on a signal, if any was recorded. */
function verdictOf(s: PerfSignal, analyst: AnalystKey): AnalystVerdict | undefined {
  return s.verdicts.find((v) => v.analyst === analyst);
}

function supported(s: PerfSignal, analyst: AnalystKey): boolean {
  const v = verdictOf(s, analyst);
  if (!v || !v.qualified) return false;
  return v.direction === (s.side === "BUY" ? "long" : "short");
}

function opposed(s: PerfSignal, analyst: AnalystKey): boolean {
  const v = verdictOf(s, analyst);
  if (!v || !v.qualified) return false;
  return v.direction === (s.side === "BUY" ? "short" : "long");
}

/**
 * Range Trading distinguishes two admissible setups, and the request asks for
 * them separately. The verdict's `gate` text is the only stored discriminator
 * — these patterns must stay in step with `rangeVerdict()` in confluence.ts.
 */
function isMeanReversion(v: AnalystVerdict | undefined): boolean {
  return !!v && /validated range/i.test(v.gate);
}
function isContinuation(v: AnalystVerdict | undefined): boolean {
  return !!v && /break under retest/i.test(v.gate);
}

/* ------------------------------------------------------------------ *
 * Per-analyst metrics
 * ------------------------------------------------------------------ */

function chartSpecific(supportedSignals: PerfSignal[]): LabelledMetric[] {
  const wins = supportedSignals.filter(isWin);
  const meanAnalogueMove = mean(
    wins.map((s) => s.outcomeAnalysis?.excursion?.maxFavourablePct ?? 0)
  );
  const asTop = supportedSignals.filter((s) => s.outcomeAnalysis?.topContributor === "chart");
  return [
    { label: "Was top contributor", value: asTop.length },
    { label: "Avg favourable excursion on wins", value: `${meanAnalogueMove.toFixed(2)}%`, tone: "bull" },
  ];
}

function candleCloseSpecific(supportedSignals: PerfSignal[]): LabelledMetric[] {
  // Every candle-close vote is by definition a confirmed break: the gate only
  // passes on a decisive close through a level.
  const breakouts = supportedSignals.length;
  const successfulBreakouts = supportedSignals.filter(isWin).length;
  const falseBreakouts = supportedSignals.filter(
    (s) => (s.outcomeReason ?? s.outcomeAnalysis?.reason) === "false_breakout"
  ).length;
  const avgMove = mean(
    supportedSignals.map((s) => s.outcomeAnalysis?.excursion?.maxFavourablePct ?? 0)
  );
  return [
    { label: "Confirmed breakouts traded", value: breakouts },
    { label: "Successful breakouts", value: successfulBreakouts, tone: "bull" },
    { label: "Failed breakouts", value: breakouts - successfulBreakouts, tone: "bear" },
    { label: "False breakouts", value: falseBreakouts, tone: "bear" },
    { label: "Avg move after confirmation", value: `${avgMove.toFixed(2)}%` },
  ];
}

function rangeSpecific(supportedSignals: PerfSignal[]): LabelledMetric[] {
  const mr = supportedSignals.filter((s) => isMeanReversion(verdictOf(s, "range")));
  const cont = supportedSignals.filter((s) => isContinuation(verdictOf(s, "range")));

  const rangeLowLongs = mr.filter((s) => s.side === "BUY");
  const rangeHighShorts = mr.filter((s) => s.side === "SELL");
  const falseBreakouts = supportedSignals.filter(
    (s) => (s.outcomeReason ?? s.outcomeAnalysis?.reason) === "false_breakout"
  ).length;
  const invalidations = supportedSignals.filter(
    (s) => (s.outcomeReason ?? s.outcomeAnalysis?.reason) === "range_invalidation"
  ).length;

  return [
    { label: "Successful range-low LONGs", value: rangeLowLongs.filter(isWin).length, tone: "bull" },
    { label: "Successful range-high SHORTs", value: rangeHighShorts.filter(isWin).length, tone: "bull" },
    { label: "Failed range setups", value: mr.filter((s) => !isWin(s)).length, tone: "bear" },
    { label: "Range invalidations", value: invalidations, tone: "bear" },
    { label: "False breakouts", value: falseBreakouts, tone: "bear" },
    { label: "Breakout continuations (up)", value: cont.filter((s) => s.side === "BUY").length },
    { label: "Breakdown continuations (down)", value: cont.filter((s) => s.side === "SELL").length },
  ];
}

function analystPerformance(
  spec: { key: AnalystKey; name: string; basis: EvidenceBasis },
  closed: PerfSignal[]
): AnalystPerformance {
  const mine = closed.filter((s) => supported(s, spec.key));
  const wins = mine.filter(isWin);
  const losses = mine.filter((s) => !isWin(s));
  const partials = mine.filter(isPartialWin);

  const longs = mine.filter((s) => s.side === "BUY");
  const shorts = mine.filter((s) => s.side === "SELL");
  const longWins = longs.filter(isWin);
  const shortWins = shorts.filter(isWin);

  const abstained = closed.filter((s) => {
    const v = verdictOf(s, spec.key);
    return !!v && !v.qualified;
  });

  const specific =
    spec.key === "chart"
      ? chartSpecific(mine)
      : spec.key === "candleClose"
        ? candleCloseSpecific(mine)
        : rangeSpecific(mine);

  return {
    analyst: spec.key,
    name: spec.name,
    basis: spec.basis,
    totalSignals: mine.length,
    wins: wins.length,
    losses: losses.length,
    partials: partials.length,
    winRate: rate(wins.length, mine.length),
    weightedAccuracy: weightedAccuracy(mine),
    longWins: longWins.length,
    longLosses: longs.length - longWins.length,
    longWinRate: rate(longWins.length, longs.length, 3),
    shortWins: shortWins.length,
    shortLosses: shorts.length - shortWins.length,
    shortWinRate: rate(shortWins.length, shorts.length, 3),
    avgReturnPct: mean(mine.map((s) => s.resultPnlPct ?? 0)),
    avgWinPct: mean(wins.map((s) => s.resultPnlPct ?? 0)),
    avgLossPct: mean(losses.map((s) => s.resultPnlPct ?? 0)),
    bestTimeframe: bestTimeframe(mine),
    successReasons: countReasons(wins),
    failureReasons: countReasons(losses),
    abstentions: abstained.length,
    correctAbstentions: abstained.filter((s) => !isWin(s)).length,
    correctlyOpposed: closed.filter((s) => opposed(s, spec.key) && !isWin(s)).length,
    specific,
  };
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

/** Pure: same rows in, same report out. No I/O, no clock beyond the rows. */
export function computePerformance(signals: PerfSignal[]): PerformanceReport {
  const closed = signals.filter(isClosed);
  const wins = closed.filter(isWin);
  const losses = closed.filter((s) => !isWin(s));
  const partials = closed.filter(isPartialWin);

  const longs = closed.filter((s) => s.side === "BUY");
  const shorts = closed.filter((s) => s.side === "SELL");

  const analysts = ANALYSTS.map((a) => analystPerformance(a, closed));

  // Best/worst are ranked over the three analysts, since those are the
  // strategies this dashboard is about. Anything under MIN_RANK_SAMPLE is
  // excluded outright rather than shown with a caveat — a 100%-from-2-trades
  // "best strategy" is worse than no answer.
  const rankable = analysts
    .filter((a) => a.totalSignals >= MIN_RANK_SAMPLE && a.winRate !== null)
    .map((a) => ({ key: a.analyst, name: a.name, winRate: a.winRate!, sample: a.totalSignals }))
    .sort((a, b) => b.winRate - a.winRate);

  return {
    overall: {
      totalSignals: signals.length,
      successful: wins.length,
      partials: partials.length,
      // Partials are removed from the failure count, not double-counted:
      // successful + partials + failed === closed.
      failed: losses.length - partials.length,
      active: signals.filter((s) => ACTIVE_STATUSES.includes(s.status)).length,
      expired: signals.filter((s) => s.status === "EXPIRED").length,
      winRate: rate(wins.length, closed.length),
      weightedAccuracy: weightedAccuracy(closed),
      longSignals: longs.length,
      shortSignals: shorts.length,
      longWinRate: rate(longs.filter(isWin).length, longs.length),
      shortWinRate: rate(shorts.filter(isWin).length, shorts.length),
      avgProfitPct: mean(wins.map((s) => s.resultPnlPct ?? 0)),
      avgLossPct: mean(losses.map((s) => s.resultPnlPct ?? 0)),
      lossTargetProgress: {
        all: lossTargetProgress(losses),
        long: lossTargetProgress(losses.filter((s) => s.side === "BUY")),
        short: lossTargetProgress(losses.filter((s) => s.side === "SELL")),
      },
      bestStrategy: rankable[0] ?? null,
      // null rather than a duplicate when only one analyst clears the bar:
      // "best and worst are the same thing" is not a finding.
      worstStrategy: rankable.length > 1 ? rankable[rankable.length - 1] : null,
    },
    analysts,
    attributedSignals: closed.filter((s) => s.verdicts.length > 0).length,
    legacySignals: closed.filter((s) => s.verdicts.length === 0).length,
    minSample: MIN_SAMPLE,
  };
}

/** Coerce a stored JSON value into verdicts, tolerating legacy rows. */
export function parseVerdicts(value: unknown): AnalystVerdict[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is AnalystVerdict =>
      !!v && typeof v === "object" && "analyst" in v && "qualified" in v
  );
}

/**
 * Load signals and compute the report.
 *
 * `take` is bounded: performance over the last 2000 signals is the useful
 * question, and an unbounded scan would grow slower every week.
 */
export async function getPerformance(
  take = 2000,
  opts: { source?: "COMPOSITE" | "CONFLUENCE" | "INSTITUTIONAL" } = {}
): Promise<PerformanceReport> {
  try {
    const rows = await prisma.signal.findMany({
      // A source filter answers "how good is *this* engine", which the blended
      // number cannot: one source producing ten signals a day drowns out
      // another producing five a week, and the average is then a statement
      // about volume rather than quality.
      where: opts.source ? { source: opts.source } : undefined,
      orderBy: { createdAt: "desc" },
      take,
      select: {
        id: true,
        symbol: true,
        timeframe: true,
        side: true,
        status: true,
        confidence: true,
        resultPnlPct: true,
        outcomeReason: true,
        outcomeAnalysis: true,
        analystVerdicts: true,
        createdAt: true,
      },
    });
    return computePerformance(
      rows.map((r) => ({
        id: r.id,
        symbol: r.symbol,
        timeframe: r.timeframe,
        side: r.side as "BUY" | "SELL",
        status: r.status,
        confidence: r.confidence,
        resultPnlPct: r.resultPnlPct,
        outcomeReason: r.outcomeReason,
        outcomeAnalysis: (r.outcomeAnalysis as unknown as OutcomeAnalysis) ?? null,
        verdicts: parseVerdicts(r.analystVerdicts),
        createdAt: r.createdAt,
      }))
    );
  } catch (err) {
    logger.warn("performance.db_unavailable", { error: String(err) });
    return computePerformance([]);
  }
}
