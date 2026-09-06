import { classifyBucket, OutcomeBucket } from "./outcomeBuckets";
import { Excursion, OutcomeAnalysis } from "./types";

/**
 * Why the winners won and the losers lost, from the record rather than from
 * opinion.
 *
 * Every other engine here reads a chart. This one reads the app's own closed
 * signals and asks the only question that can actually improve them: what
 * separates the ones that worked from the ones that did not, and is the
 * difference large enough and repeated enough to act on.
 *
 * ## The three things it looks for
 *
 * **Where the edge is concentrated.** Win rate and expectancy sliced by
 * confidence band, source, regime, timeframe and hold time. A source that
 * looks mediocre overall is often good in one regime and bad in another, and
 * the blended number hides exactly the thing worth knowing.
 *
 * **Whether the stops are in the right place.** Winners are examined for how
 * far they went *against* the position before working. If winners routinely
 * draw down 0.8R, a 1R stop is barely wide enough and half the losses are
 * fills, not reads. If they almost never exceed 0.35R, the stop is wider than
 * it needs to be and every loss costs more than it should.
 *
 * **Whether the targets are reachable.** Losers are examined for how close
 * they got. A book full of losses that reached 85% of TP1 is not a directional
 * problem; it is a target set slightly too far away, and it is fixed by moving
 * the target rather than by changing the read.
 *
 * ## What it refuses to do
 *
 * Rank a hundred slices and report the best one. That is the multiple-
 * comparisons trap the seasonality engine documents at length, and it applies
 * with equal force here: enough slices of a small record will always produce
 * one that looks decisive. So every comparison is sample-gated on **both**
 * sides, effect sizes are reported next to the counts that produced them, and
 * the report says plainly when there is not yet enough evidence — which, for a
 * young record, is the honest answer to most of these questions.
 *
 * Nothing here is a backtest. It describes trades this engine actually took,
 * which is a biased sample of all the trades it could have taken — the shadow
 * signals exist precisely to bound that bias, and they are included as their
 * own slice rather than pooled in.
 */

/** Decided trades a slice needs before any rate is quoted for it. */
const MIN_SLICE = 12;
/** Decided trades needed on BOTH sides before two slices are compared. */
const MIN_COMPARE = 10;
/** Win-rate gap, in points, below which a comparison is not worth reporting. */
const MIN_GAP_PTS = 12;

export interface PostMortemSignal {
  id: string;
  symbol: string;
  timeframe: string;
  side: "BUY" | "SELL";
  status: string;
  source: string | null;
  confidence: number;
  entry: number;
  stopLoss: number;
  tp1: number;
  resultPnlPct: number | null;
  outcomeReason: string | null;
  outcomeAnalysis: OutcomeAnalysis | null;
  regime: string | null;
  shadow: boolean;
  earlyExitReason: string | null;
  managementStage: string | null;
  createdAt: number;
  closedAt: number | null;
}

export interface Slice {
  key: string;
  label: string;
  /** decided = wins + losses; break-evens and running trades are excluded */
  decided: number;
  wins: number;
  losses: number;
  breakEvens: number;
  /** null below the sample floor */
  winRatePct: number | null;
  /** mean R per decided trade, the number that actually compounds */
  expectancyR: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
}

export interface Finding {
  /** what was compared */
  dimension: string;
  headline: string;
  detail: string;
  /** the two slices, better first */
  better: Slice;
  worse: Slice;
  gapPts: number;
  /** what to change, stated as an action rather than an observation */
  recommendation: string;
}

export interface StopStudy {
  /** winners examined */
  samples: number;
  /** how far the median winner went against the position, in R */
  medianAdverseR: number | null;
  /** the 90th percentile — the one that nearly got stopped */
  p90AdverseR: number | null;
  /** share of winners that drew down more than 0.75R before working */
  deepDrawdownPct: number | null;
  verdict: string;
}

export interface TargetStudy {
  /** losers examined */
  samples: number;
  /** median share of the way to TP1 the losers covered */
  medianProgressPct: number | null;
  /** share of losers that got at least 80% of the way */
  nearMissPct: number | null;
  verdict: string;
}

export interface PostMortemReport {
  totalClosed: number;
  decided: number;
  overall: Slice;
  byConfidence: Slice[];
  bySource: Slice[];
  byRegime: Slice[];
  byTimeframe: Slice[];
  byExitReason: Slice[];
  taken: Slice;
  shadow: Slice;
  stops: StopStudy;
  targets: TargetStudy;
  findings: Finding[];
  /** the most common failure classifications, with counts */
  failureReasons: { reason: string; count: number; sharePct: number }[];
  note: string;
  /** what cannot be answered yet, and how many more trades it would take */
  openQuestions: string[];
}

/* ------------------------------------------------------------------ */

function excursionOf(s: PostMortemSignal): Excursion | null {
  return s.outcomeAnalysis?.excursion ?? null;
}

/** Realised R, from the P/L and the risk the signal was opened with. */
function realisedR(s: PostMortemSignal): number | null {
  const riskPct = Math.abs((s.entry - s.stopLoss) / s.entry) * 100;
  if (!Number.isFinite(riskPct) || riskPct <= 0) return null;
  if (s.resultPnlPct == null) return null;
  return s.resultPnlPct / riskPct;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[i];
}

function buildSlice(key: string, label: string, rows: PostMortemSignal[]): Slice {
  const buckets = rows.map((r) => ({ row: r, bucket: classifyBucket(r) as OutcomeBucket }));
  const wins = buckets.filter((b) => b.bucket === "successful");
  const losses = buckets.filter((b) => b.bucket === "failed");
  const breakEvens = buckets.filter((b) => b.bucket === "breakeven");
  const decided = wins.length + losses.length;

  const rOf = (xs: typeof wins) =>
    xs.map((x) => realisedR(x.row)).filter((v): v is number => v != null);
  const winR = rOf(wins);
  const lossR = rOf(losses);
  const allR = [...winR, ...lossR];

  const mean = (xs: number[]) =>
    xs.length > 0 ? Number((xs.reduce((s, v) => s + v, 0) / xs.length).toFixed(3)) : null;

  return {
    key,
    label,
    decided,
    wins: wins.length,
    losses: losses.length,
    breakEvens: breakEvens.length,
    winRatePct: decided >= MIN_SLICE ? Number(((wins.length / decided) * 100).toFixed(1)) : null,
    // Expectancy over decided trades: the number that compounds, and the one a
    // win rate on its own cannot substitute for. A 35% win rate at 3R beats a
    // 70% win rate at 0.4R, and only this column shows it.
    expectancyR: allR.length >= MIN_SLICE ? mean(allR) : null,
    avgWinR: mean(winR),
    avgLossR: mean(lossR),
  };
}

/** Group rows by a key function, dropping groups nothing landed in. */
function group(
  rows: PostMortemSignal[],
  keyOf: (s: PostMortemSignal) => string | null,
  labelOf: (key: string) => string
): Slice[] {
  const map = new Map<string, PostMortemSignal[]>();
  for (const r of rows) {
    const k = keyOf(r);
    if (k == null) continue;
    const cur = map.get(k);
    if (cur) cur.push(r);
    else map.set(k, [r]);
  }
  return [...map.entries()]
    .map(([k, xs]) => buildSlice(k, labelOf(k), xs))
    .sort((a, b) => b.decided - a.decided);
}

const CONFIDENCE_BANDS: { key: string; label: string; min: number; max: number }[] = [
  { key: "c60", label: "Confidence under 65", min: 0, max: 65 },
  { key: "c65", label: "Confidence 65–74", min: 65, max: 75 },
  { key: "c75", label: "Confidence 75–84", min: 75, max: 85 },
  { key: "c85", label: "Confidence 85+", min: 85, max: 1000 },
];

const REGIME_LABEL: Record<string, string> = {
  risk_on: "BTC risk-on",
  risk_off: "BTC risk-off",
  mixed: "BTC mixed",
  unknown: "BTC regime unknown",
};

const EXIT_LABEL: Record<string, string> = {
  structure_flip: "Cut early — structure flipped",
  adverse_close: "Cut early — closed through 60% of risk",
  stall: "Cut early — stalled",
  none: "Ran to its stop or target",
};

/**
 * Compare two slices and, if the gap survives the sample gates, turn it into
 * a finding with an action attached.
 *
 * Both sides must clear `MIN_COMPARE`. A 90% win rate from four trades against
 * a 40% from sixty is not a finding, it is four trades.
 */
function compare(
  dimension: string,
  slices: Slice[],
  recommend: (better: Slice, worse: Slice) => string
): Finding | null {
  const usable = slices.filter((s) => s.decided >= MIN_COMPARE && s.winRatePct != null);
  if (usable.length < 2) return null;
  const sorted = [...usable].sort((a, b) => b.winRatePct! - a.winRatePct!);
  const better = sorted[0];
  const worse = sorted[sorted.length - 1];
  const gap = Number((better.winRatePct! - worse.winRatePct!).toFixed(1));
  if (gap < MIN_GAP_PTS) return null;

  return {
    dimension,
    headline: `${better.label} wins ${better.winRatePct}% against ${worse.label} at ${worse.winRatePct}%`,
    detail:
      `${better.decided} decided trades in the first group and ${worse.decided} in the second, a ${gap}-point gap. ` +
      `Expectancy runs ${better.expectancyR ?? "—"}R against ${worse.expectancyR ?? "—"}R. ` +
      `Both groups clear the ${MIN_COMPARE}-trade floor, but this is one comparison among several and a young record will throw up gaps like this by chance — treat it as a lead to watch, not a rule to hard-code.`,
    better,
    worse,
    gapPts: gap,
    recommendation: recommend(better, worse),
  };
}

/* ------------------------------------------------------------------ */

export function buildPostMortem(signals: PostMortemSignal[]): PostMortemReport {
  const closed = signals.filter((s) => classifyBucket(s) !== "active");
  const taken = closed.filter((s) => !s.shadow);

  const overall = buildSlice("all", "All taken signals", taken);

  /* ---- Stop placement, from the winners' drawdown ---- */
  const winners = taken.filter((s) => classifyBucket(s) === "successful");
  const adverse = winners
    .map((s) => excursionOf(s)?.maxAdverseR)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    .map(Math.abs)
    .sort((a, b) => a - b);
  const medianAdverseR = percentile(adverse, 0.5);
  const p90AdverseR = percentile(adverse, 0.9);
  const deep = adverse.filter((v) => v > 0.75).length;
  const stops: StopStudy = {
    samples: adverse.length,
    medianAdverseR: medianAdverseR != null ? Number(medianAdverseR.toFixed(3)) : null,
    p90AdverseR: p90AdverseR != null ? Number(p90AdverseR.toFixed(3)) : null,
    deepDrawdownPct:
      adverse.length >= MIN_SLICE ? Number(((deep / adverse.length) * 100).toFixed(1)) : null,
    verdict:
      adverse.length < MIN_SLICE
        ? `Only ${adverse.length} winners carry excursion data — below the ${MIN_SLICE} needed to say anything about stop placement. This is the highest-value question here and it needs the most data, so it is worth waiting for.`
        : p90AdverseR != null && p90AdverseR > 0.9
          ? `Nine winners in ten went at least ${p90AdverseR.toFixed(2)}R against the position before working. Stops at 1R are being taken out by moves that were going to recover, which means a meaningful share of the losses are fills rather than wrong reads. Widening the stop and reducing size to match keeps the same risk while surviving the noise.`
          : p90AdverseR != null && p90AdverseR < 0.45
            ? `Even the worst winners rarely gave up more than ${p90AdverseR.toFixed(2)}R before working. The stop is wider than the trades need, so every loss costs more than it has to — tightening it would improve the reward-to-risk on the same reads.`
            : `Winners typically drew down ${medianAdverseR?.toFixed(2)}R before working, with the worst tenth at ${p90AdverseR?.toFixed(2)}R. The stop is sized about right for how these trades actually behave.`,
  };

  /* ---- Target reachability, from how close the losers got ---- */
  const losers = taken.filter((s) => classifyBucket(s) === "failed");
  const progress = losers
    .map((s) => excursionOf(s)?.targetProgressPct)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    .sort((a, b) => a - b);
  const nearMiss = progress.filter((v) => v >= 80).length;
  const medianProgress = percentile(progress, 0.5);
  const targets: TargetStudy = {
    samples: progress.length,
    medianProgressPct: medianProgress != null ? Number(medianProgress.toFixed(1)) : null,
    nearMissPct:
      progress.length >= MIN_SLICE ? Number(((nearMiss / progress.length) * 100).toFixed(1)) : null,
    verdict:
      progress.length < MIN_SLICE
        ? `Only ${progress.length} losers carry progress data, below the ${MIN_SLICE} needed to judge whether the targets are reachable.`
        : nearMiss / progress.length >= 0.3
          ? `${((nearMiss / progress.length) * 100).toFixed(0)}% of losing trades got at least 80% of the way to their first target before failing. That is not a directional problem — the reads were right and the target was set slightly too far away. Pulling TP1 in would convert a large share of these into wins at a lower reward per trade, which the expectancy column can settle.`
          : medianProgress != null && medianProgress < 30
            ? `The median loser covered only ${medianProgress.toFixed(0)}% of the distance to its first target. These are not near misses; the reads were wrong from close to the start, and moving targets will not help. The entry criteria are where to look.`
            : `Losers covered a median ${medianProgress?.toFixed(0)}% of the way to TP1 with ${((nearMiss / progress.length) * 100).toFixed(0)}% getting past 80%. No strong signal that targets are misplaced either way.`,
  };

  /* ---- Slices ---- */
  const byConfidence = CONFIDENCE_BANDS.map((b) =>
    buildSlice(b.key, b.label, taken.filter((s) => s.confidence >= b.min && s.confidence < b.max))
  ).filter((s) => s.decided > 0);

  const bySource = group(taken, (s) => s.source ?? "UNKNOWN", (k) => `Source ${k}`);
  const byRegime = group(
    taken,
    (s) => s.regime ?? "unknown",
    (k) => REGIME_LABEL[k] ?? k
  );
  const byTimeframe = group(taken, (s) => s.timeframe, (k) => `${k} timeframe`);
  const byExitReason = group(
    taken,
    (s) => s.earlyExitReason ?? "none",
    (k) => EXIT_LABEL[k] ?? k
  );

  /* ---- Failure classifications ---- */
  const reasonCounts = new Map<string, number>();
  for (const s of losers) {
    const r = s.outcomeReason ?? s.outcomeAnalysis?.reason ?? "unclassified";
    reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + 1);
  }
  const failureReasons = [...reasonCounts.entries()]
    .map(([reason, count]) => ({
      reason,
      count,
      sharePct: losers.length > 0 ? Number(((count / losers.length) * 100).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  /* ---- Findings ---- */
  const findings: Finding[] = [];
  const push = (f: Finding | null) => {
    if (f) findings.push(f);
  };

  push(
    compare("Confidence", byConfidence, (better, worse) =>
      better.key > worse.key
        ? `Confidence is doing real work: raise the minimum for a signal to be taken toward the ${better.label.toLowerCase()} band and the same engine produces fewer, better trades.`
        : `Higher confidence is not producing better outcomes here, which means the score is not measuring what it claims. Until that reverses, treat confidence as a sort order rather than a filter.`
    )
  );
  push(
    compare("Source", bySource, (better, worse) =>
      `Shift allocation toward ${better.label} and either tighten ${worse.label}'s entry criteria or stop taking it. The gap is in outcomes, not in how many signals each produces.`
    )
  );
  push(
    compare("BTC regime", byRegime, (better, worse) =>
      `The setups work materially better in ${better.label}. The regime tag is deliberately not a gate yet — this is the evidence that would justify making it one, and it needs to hold up over more trades first.`
    )
  );
  push(
    compare("Timeframe", byTimeframe, (better, worse) =>
      `Concentrate on ${better.label}. Faster timeframes carry the same fee load over smaller moves, so a lower win rate there costs more than the gap alone suggests.`
    )
  );
  push(
    compare("Exit path", byExitReason, (better, worse) =>
      worse.key === "none"
        ? `Trades cut early are outperforming trades left to their stops, which supports the early-exit rules as they stand.`
        : `Trades cut for "${worse.label}" are underperforming — that rule may be firing on noise. Check whether those trades recovered after the exit before keeping it.`
    )
  );
  findings.sort((a, b) => b.gapPts - a.gapPts);

  /* ---- What cannot be answered yet ---- */
  const openQuestions: string[] = [];
  if (overall.decided < MIN_SLICE) {
    openQuestions.push(
      `Only ${overall.decided} trades have decided. Nothing on this page is a conclusion yet — ${MIN_SLICE - overall.decided} more would let the headline rate be quoted at all.`
    );
  }
  if (stops.samples < MIN_SLICE) {
    openQuestions.push(
      `Stop placement needs ${MIN_SLICE - stops.samples} more resolved winners before the drawdown distribution says anything. This is the single highest-value question here: it decides how many losses are bad fills rather than bad reads.`
    );
  }
  if (targets.samples < MIN_SLICE) {
    openQuestions.push(
      `Target reachability needs ${MIN_SLICE - targets.samples} more resolved losers before near-miss rate can separate "wrong direction" from "target too far".`
    );
  }
  const shadowSlice = buildSlice("shadow", "Shadow (never taken)", closed.filter((s) => s.shadow));
  if (shadowSlice.decided < MIN_COMPARE) {
    openQuestions.push(
      `Shadow signals have only ${shadowSlice.decided} decided. Comparing them against taken signals is what shows whether the slot allocator — rather than the engine — is choosing what gets recorded.`
    );
  }
  if (findings.length === 0 && overall.decided >= MIN_SLICE) {
    openQuestions.push(
      `No slice differs from another by more than ${MIN_GAP_PTS} points with enough trades on both sides. That is a real answer, not a missing one: at this sample size the engine performs about the same across confidence, source, regime and timeframe, and there is no group worth reallocating toward yet.`
    );
  }

  return {
    totalClosed: closed.length,
    decided: overall.decided,
    overall,
    byConfidence,
    bySource,
    byRegime,
    byTimeframe,
    byExitReason,
    taken: overall,
    shadow: shadowSlice,
    stops,
    targets,
    findings,
    failureReasons,
    note:
      `Built from ${closed.length} closed signals, ${overall.decided} of which decided one way or the other. ` +
      `Break-evens are excluded from every rate here, as everywhere else. ` +
      `This is not a backtest: it describes trades the engine actually took, which is a biased sample of the trades it could have taken — the shadow slice exists to bound that bias and is kept separate rather than pooled in. ` +
      `Comparisons are gated on both sides and reported with their counts, because ranking enough slices of a small record will always surface one that looks decisive.`,
    openQuestions,
  };
}
