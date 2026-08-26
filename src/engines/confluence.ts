import {
  AnalystKey,
  AnalystVerdict,
  Bias,
  CandleCloseExpansionResult,
  ChartAnalystResult,
  ConfluenceSetup,
  Direction,
  DirectionalCase,
  EvidenceBasis,
  RangeTradingResult,
} from "./types";

/**
 * Confluence engine — where the three independent analysts agree.
 *
 * The three analysts each read the chart on their own terms and never feed
 * the composite 28-strategy signal. This module asks the one question they
 * cannot answer alone: does more than one of them, reading a *different kind
 * of evidence*, point the same way right now?
 *
 * Three properties are structural rather than promised:
 *
 *  1. **No directional bias.** `buildCase()` is called twice with the
 *     direction flipped and nothing else changed, so there is no code path a
 *     long can take that a short cannot. tests/confluence.test.ts proves this
 *     by mirroring a candle series and asserting the decision inverts with
 *     equal confidence.
 *
 *  2. **NO_TRADE is a real answer.** An analyst that fails its quality gate
 *     abstains; it does not cast a weak vote. When nothing qualifies, or only
 *     one method sees the trade, or the two sides are too close, or the
 *     resulting geometry is worse than 1R, the answer is NO_TRADE with a
 *     stated reason.
 *
 *  3. **Past performance cannot leak in.** The signature takes the three
 *     analyst results and nothing else — no database handle, no win-rate
 *     table, no options bag. Historical results are for *evaluating* these
 *     analysts (see performanceService), never for pushing a signal that the
 *     present chart does not support. That separation is enforced by this
 *     function's inability to see anything else.
 */

/** Minimum confluence confidence before a setup is tradable. */
const MIN_CONFLUENCE = Number(process.env.CONFLUENCE_MIN_CONFIDENCE ?? 70);

/**
 * How far the winning side must lead the losing side.
 *
 * Without this, a 71-vs-70 split would emit a signal while effectively being
 * a coin toss between two analysts that disagree.
 */
const MIN_EDGE = 8;

/**
 * Per-analyst quality weight.
 *
 * The candle-close read is weighted highest because it is the only one that
 * requires a *confirmed close* through a level that price had previously
 * respected — the strongest single piece of evidence available here. The
 * chart analyst is weighted lowest because an analogue distribution is
 * suggestive rather than confirming.
 */
const QUALITY_WEIGHT: Record<AnalystKey, number> = {
  candleClose: 1.0,
  range: 0.85,
  chart: 0.7,
};

/** Independence multiplier by count of distinct agreeing evidence bases. */
const INDEPENDENCE: Record<number, number> = { 0: 0, 1: 1.0, 2: 1.35, 3: 1.6 };

/**
 * Distinct evidence bases required before a setup may be traded.
 *
 * This is the definition of the feature, not a tuning knob: a "high
 * probability setup" is one where *independent methods agree*. A single
 * analyst — however decisive its close, however clean its range — is one
 * opinion, and one opinion is a near miss, not a signal.
 *
 * It is enforced as its own gate rather than left to fall out of the
 * calibration below, so that lowering CONFLUENCE_MIN_CONFIDENCE can widen the
 * net without silently turning single-analyst reads into signals.
 */
const MIN_BASES = 2;

/**
 * tanh divisor for the confidence squash.
 *
 * Calibrated so that the strongest possible *single* analyst (weight 1.0 at
 * 100% conviction, no independence bonus) lands at ~69 — under the default 70
 * threshold — while two independent bases reach the mid-80s and three reach
 * the low-90s. Confluence is what buys confidence here; conviction alone
 * cannot.
 */
const SQUASH = 2.3;

/** Chart analyst needs at least this many analogues to be worth hearing. */
const MIN_ANALOGUES = 4;
/** ...and this share of them must point the same way. */
const MIN_ANALOGUE_AGREEMENT = 0.6;

const ANALYST_NAMES: Record<AnalystKey, string> = {
  chart: "Chart Analyst",
  candleClose: "Candle Close Expansion",
  range: "Range Trading",
};

const BASIS_OF: Record<AnalystKey, EvidenceBasis> = {
  chart: "pattern_history",
  candleClose: "level_close",
  range: "range_boundary",
};

const BASIS_LABEL: Record<EvidenceBasis, string> = {
  pattern_history: "historical pattern analogues",
  level_close: "a confirmed close through a key level",
  range_boundary: "range boundary behaviour",
};

function biasToDirection(b: Bias): Direction {
  return b === "bullish" ? "long" : b === "bearish" ? "short" : "none";
}

function fmt(v: number): string {
  const m = Math.abs(v);
  return v.toFixed(m >= 1000 ? 1 : m >= 100 ? 2 : m >= 1 ? 4 : 6);
}

/* ------------------------------------------------------------------ *
 * Step 1 — one verdict per analyst, behind a quality gate
 *
 * Each mapper below reads only its own analyst's output. A gate failure
 * produces `qualified: false` with the reason recorded, so the UI can show
 * *why* an analyst is silent instead of leaving a mysterious blank.
 * ------------------------------------------------------------------ */

function chartVerdict(chart: ChartAnalystResult): AnalystVerdict {
  const direction = biasToDirection(chart.expectedNextMove.direction);
  const matches = chart.historicalMatches;
  const agreeing = matches.filter(
    (m) => biasToDirection(m.forwardDirection) === direction && direction !== "none"
  ).length;
  const agreement = matches.length > 0 ? agreeing / matches.length : 0;

  const reasons: string[] = [];
  if (direction === "none") reasons.push("no directional read");
  if (chart.expectedNextMove.target === null) reasons.push("no projected target");
  if (matches.length < MIN_ANALOGUES)
    reasons.push(`only ${matches.length} analogue${matches.length === 1 ? "" : "s"} (needs ${MIN_ANALOGUES})`);
  if (matches.length > 0 && agreement < MIN_ANALOGUE_AGREEMENT)
    reasons.push(`analogues only ${Math.round(agreement * 100)}% aligned (needs ${Math.round(MIN_ANALOGUE_AGREEMENT * 100)}%)`);

  const qualified = reasons.length === 0;
  const meanSimilarity =
    matches.length > 0 ? matches.reduce((s, m) => s + m.similarity, 0) / matches.length : 0;

  // Evidence is composed from this analyst's own measurements — the analogue
  // count, how closely they matched, how they resolved, and the shape on the
  // chart right now. Nothing here is boilerplate.
  const shape = chart.currentPattern.shapes[0];
  const parts: string[] = [];
  if (shape) parts.push(`${shape.name} (${Math.round(shape.maturity)}% formed)`);
  if (matches.length > 0) {
    parts.push(
      `${agreeing}/${matches.length} closest analogues resolved ${direction === "long" ? "up" : direction === "short" ? "down" : "flat"} at ${Math.round(meanSimilarity)}% mean similarity`
    );
    parts.push(`median forward move ${chart.expectedNextMove.magnitudePct >= 0 ? "+" : ""}${chart.expectedNextMove.magnitudePct.toFixed(2)}% over ${chart.expectedNextMove.horizonBars} bars`);
  }
  const evidence = parts.length > 0 ? parts.join("; ") : chart.currentPattern.headline;

  return {
    analyst: "chart",
    name: ANALYST_NAMES.chart,
    basis: BASIS_OF.chart,
    direction: qualified ? direction : "none",
    confidence: chart.confidence,
    qualified,
    gate: qualified
      ? `${matches.length} analogues, ${Math.round(agreement * 100)}% aligned, target projected`
      : `abstains — ${reasons.join(", ")}`,
    entry: null, // the analogue search projects a move, not an entry price
    target: chart.expectedNextMove.target,
    invalidation: chart.expectedNextMove.invalidation,
    evidence,
  };
}

function candleCloseVerdict(cc: CandleCloseExpansionResult): AnalystVerdict {
  const direction: Direction =
    cc.expectedDirection === "up" ? "long" : cc.expectedDirection === "down" ? "short" : "none";

  const reasons: string[] = [];
  if (!cc.keyLevel) reasons.push("no key level in play");
  // This gate is the whole point of the module: a candle merely crossing a
  // level is not a breakout. Only a decisive close may contribute, so a wick
  // through a level can never carry a confluence signal.
  if (cc.decisiveness.verdict !== "decisive")
    reasons.push(`close is ${cc.decisiveness.verdict}, not decisive`);
  if (cc.expansionProbability === "Low") reasons.push("expansion probability Low");
  if (direction === "none") reasons.push("no expected direction");

  const qualified = reasons.length === 0;
  const lvl = cc.keyLevel;

  const parts: string[] = [];
  if (lvl) {
    parts.push(
      `${cc.candleClose === "inside" ? "holding inside" : `closed ${cc.candleClose}`} ${lvl.kind} at ${fmt(lvl.price)} (${lvl.touches} touches, ${lvl.respects} respected)`
    );
    if (lvl.historicalFalseBreakRate > 0)
      parts.push(`${Math.round(lvl.historicalFalseBreakRate * 100)}% of past breaks here failed`);
  }
  parts.push(
    `${cc.decisiveness.verdict} close: ${cc.decisiveness.penetrationAtr.toFixed(2)} ATR beyond, ${Math.round(cc.decisiveness.bodyRatio * 100)}% body, ${cc.decisiveness.volumeMultiple.toFixed(1)}× volume`
  );
  if (cc.decisiveness.followThroughBars > 0)
    parts.push(`${cc.decisiveness.followThroughBars} bar(s) of follow-through`);

  return {
    analyst: "candleClose",
    name: ANALYST_NAMES.candleClose,
    basis: BASIS_OF.candleClose,
    direction: qualified ? direction : "none",
    confidence: cc.expansionScore,
    qualified,
    gate: qualified
      ? `decisive close, ${cc.expansionProbability} expansion probability`
      : `abstains — ${reasons.join(", ")}`,
    entry: cc.closePrice,
    target: cc.expansionTarget,
    invalidation: cc.invalidationLevel,
    evidence: parts.join("; "),
  };
}

function rangeVerdict(range: RangeTradingResult): AnalystVerdict {
  const direction: Direction =
    range.rangeSetup === "Long" ? "long" : range.rangeSetup === "Short" ? "short" : "none";

  const failedGates = range.validation.filter((v) => !v.passed);
  const reasons: string[] = [];

  // Two admissible states, and nothing else. A mean-reversion vote requires a
  // *validated* range; a continuation vote requires a break that has already
  // been retested. Everything in between abstains — which is what keeps the
  // module from buying the low of a range that has already broken.
  const meanReversionOk =
    range.marketCondition === "Ranging" && failedGates.length === 0 && direction !== "none";
  const continuationOk = range.breakout.active && range.breakout.stage === "retest";

  if (!meanReversionOk && !continuationOk) {
    if (range.marketCondition !== "Ranging") reasons.push(`market is ${range.marketCondition.toLowerCase()}, not ranging`);
    if (failedGates.length > 0)
      reasons.push(`range validation failed: ${failedGates.map((g) => g.label).join(", ")}`);
    if (direction === "none") reasons.push(`setup is ${range.rangeSetup}`);
    if (range.breakout.active && range.breakout.stage !== "retest")
      reasons.push(`breakout at ${range.breakout.stage} stage, awaiting retest`);
  }

  const qualified = reasons.length === 0;
  const continuationDirection: Direction = continuationOk
    ? range.breakout.direction === "up"
      ? "long"
      : range.breakout.direction === "down"
        ? "short"
        : "none"
    : "none";

  const parts: string[] = [];
  if (range.rangeHigh !== null && range.rangeLow !== null) {
    parts.push(
      `range ${fmt(range.rangeLow)}–${fmt(range.rangeHigh)} over ${range.rangeBars} bars (${range.highTouches} high / ${range.lowTouches} low touches, ${Math.round(range.containment * 100)}% contained)`
    );
    parts.push(`price ${range.currentPosition.toLowerCase()}`);
  }
  if (continuationOk) parts.push(`${range.breakout.direction === "up" ? "upside" : "downside"} break now retesting`);
  if (parts.length === 0) parts.push(range.reason[0] ?? `market condition ${range.marketCondition}`);

  return {
    analyst: "range",
    name: ANALYST_NAMES.range,
    basis: BASIS_OF.range,
    direction: qualified ? (meanReversionOk ? direction : continuationDirection) : "none",
    confidence: range.confidence,
    qualified,
    gate: qualified
      ? meanReversionOk
        ? `validated range, ${range.currentPosition.toLowerCase()}`
        : "confirmed break under retest"
      : `abstains — ${reasons.join(", ")}`,
    entry: range.potentialEntry,
    target: range.target1 ?? range.target2,
    invalidation: range.invalidation,
    evidence: parts.join("; "),
  };
}

/**
 * Build every analyst's verdict for the current chart.
 *
 * Exported on its own because signals need the verdicts recorded even when
 * they came from the composite engine rather than from confluence — that is
 * what makes per-analyst performance measurable across *all* signals.
 */
export function buildVerdicts(
  chart: ChartAnalystResult,
  candleClose: CandleCloseExpansionResult,
  range: RangeTradingResult
): AnalystVerdict[] {
  return [chartVerdict(chart), candleCloseVerdict(candleClose), rangeVerdict(range)];
}

/* ------------------------------------------------------------------ *
 * Step 2/3 — build each directional case and score it
 * ------------------------------------------------------------------ */

/**
 * Score one direction from the verdicts pointing that way.
 *
 * Deliberately **not** an average of the analysts' percentages. Averaging
 * treats three weak agreements as identical to one strong call and, worse,
 * makes a lone confident analyst *lose* confidence as soon as a second one
 * agrees less strongly. Instead: sum weighted contributions, then multiply by
 * how many genuinely *different* kinds of evidence agree, then squash.
 */
function buildCase(direction: "long" | "short", verdicts: AnalystVerdict[]): DirectionalCase {
  const supporters = verdicts.filter((v) => v.qualified && v.direction === direction);

  const rawStrength = supporters.reduce(
    (sum, v) => sum + (v.confidence / 100) * QUALITY_WEIGHT[v.analyst],
    0
  );
  const independentBases = new Set(supporters.map((v) => v.basis)).size;
  const independenceMultiplier = INDEPENDENCE[independentBases] ?? 1.6;

  // tanh squash: one basis at full conviction -> ~69, two -> ~82, three -> ~91,
  // never 100. Same house convention as computeConfidence in signal.ts —
  // stacked evidence buys progressively less, and certainty is unreachable.
  const effective = rawStrength * independenceMultiplier;
  const confidence = supporters.length === 0 ? 50 : 50 + Math.tanh(effective / SQUASH) * 47;

  return {
    direction,
    confidence: Number(confidence.toFixed(1)),
    rawStrength: Number(rawStrength.toFixed(3)),
    independentBases,
    independenceMultiplier,
    supporters,
    disagreementPenalty: 0,
  };
}

/**
 * Charge each side for the qualified evidence pointing the other way.
 *
 * Applied after both cases exist so it is symmetric by construction: the
 * penalty each side pays is a function of the *opposing* side's raw strength,
 * computed by the same expression.
 */
function applyDisagreement(a: DirectionalCase, b: DirectionalCase): void {
  // Both penalties are computed from the pre-penalty strengths, which the
  // helper never mutates — so the order of the two calls cannot matter.
  const penalty = (self: DirectionalCase, other: DirectionalCase): number => {
    if (self.supporters.length === 0 || other.supporters.length === 0) return 0;
    // Up to 18 points, scaled by how strong the opposition is relative to us.
    const ratio = other.rawStrength / Math.max(self.rawStrength, 1e-9);
    return Math.min(18, 18 * Math.tanh(ratio));
  };
  const pa = penalty(a, b);
  const pb = penalty(b, a);
  const charge = (self: DirectionalCase, p: number) => {
    self.disagreementPenalty = Number(p.toFixed(1));
    self.confidence = Number(Math.max(50, self.confidence - p).toFixed(1));
  };
  charge(a, pa);
  charge(b, pb);
}

/* ------------------------------------------------------------------ *
 * Step 4 — decision, levels, explanation
 * ------------------------------------------------------------------ */

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function label(confidence: number): ConfluenceSetup["confidenceLabel"] {
  return confidence >= 85 ? "Very High" : confidence >= 75 ? "High" : confidence >= 65 ? "Moderate" : "Low";
}

function verdictWord(bases: number): ConfluenceSetup["confluenceVerdict"] {
  return bases >= 3 ? "Strong" : bases === 2 ? "Partial" : bases === 1 ? "Single" : "None";
}

export function evaluateConfluence(
  symbol: string,
  timeframe: string,
  price: number,
  chart: ChartAnalystResult,
  candleClose: CandleCloseExpansionResult,
  range: RangeTradingResult,
  minConfidence: number = MIN_CONFLUENCE
): ConfluenceSetup {
  const verdicts = buildVerdicts(chart, candleClose, range);

  const long = buildCase("long", verdicts);
  const short = buildCase("short", verdicts);
  applyDisagreement(long, short);

  const leader = long.confidence >= short.confidence ? long : short;
  const trailer = leader === long ? short : long;
  const edge = leader.confidence - trailer.confidence;

  let decision: ConfluenceSetup["decision"] = "NO_TRADE";
  let noTradeReason: string | null = null;

  if (leader.supporters.length === 0) {
    noTradeReason =
      "No analyst cleared its quality gate. " +
      verdicts.map((v) => `${v.name}: ${v.gate.replace(/^abstains — /, "")}`).join(". ") +
      ".";
  } else if (leader.confidence < minConfidence) {
    noTradeReason = `Best case (${leader.direction === "long" ? "LONG" : "SHORT"} at ${leader.confidence.toFixed(0)}%) is below the ${minConfidence}% confluence threshold — ${leader.independentBases} independent ${leader.independentBases === 1 ? "basis" : "bases"} agreeing${leader.disagreementPenalty > 0 ? `, less a ${leader.disagreementPenalty.toFixed(0)}pt disagreement penalty` : ""}.`;
  } else if (leader.independentBases < MIN_BASES) {
    const lone = leader.supporters[0];
    noTradeReason = `Only ${lone.name} supports a ${leader.direction === "long" ? "LONG" : "SHORT"} here, reading ${BASIS_LABEL[lone.basis]}. Confluence needs ${MIN_BASES} independent methods agreeing; one opinion is a near miss, not a setup.`;
  } else if (edge < MIN_EDGE) {
    noTradeReason = `LONG ${long.confidence.toFixed(0)}% vs SHORT ${short.confidence.toFixed(0)}% — only ${edge.toFixed(0)}pt apart, under the ${MIN_EDGE}pt edge required. The analysts are genuinely split.`;
  } else {
    decision = leader.direction === "long" ? "LONG" : "SHORT";
  }

  // --- Levels, from the supporting analysts' own numbers ---
  let entry: number | null = null;
  let stopLoss: number | null = null;
  let target1: number | null = null;
  let target2: number | null = null;
  let riskReward: number | null = null;

  if (decision !== "NO_TRADE") {
    const isLong = decision === "LONG";
    const entries = leader.supporters.map((v) => v.entry).filter((v): v is number => v !== null);
    entry = median(entries) ?? price;

    const stops = leader.supporters
      .map((v) => v.invalidation)
      .filter((v): v is number => v !== null)
      // Only invalidations on the correct side of entry are stops; an analyst
      // quoting a level above a long's entry is describing something else.
      .filter((v) => (isLong ? v < entry! : v > entry!));
    // Widest (safest) stop among the supporters, so no single analyst's tight
    // invalidation can put the trade at 20:1 on paper and stop it out in a wick.
    const chosenStop = stops.length > 0 ? (isLong ? Math.min(...stops) : Math.max(...stops)) : null;

    const targets = leader.supporters
      .map((v) => v.target)
      .filter((v): v is number => v !== null)
      .filter((v) => (isLong ? v > entry! : v < entry!))
      .sort((a, b) => (isLong ? a - b : b - a));

    if (chosenStop !== null && targets.length > 0) {
      stopLoss = chosenStop;
      target1 = targets[0];
      target2 = targets[targets.length - 1];
      const risk = Math.abs(entry - stopLoss);
      const reward = Math.abs(target2 - entry);
      riskReward = risk > 0 ? Number((reward / risk).toFixed(2)) : null;

      // Same rule as buildTradeSetup: never emit negative-expectancy geometry,
      // however convincing the narrative is.
      if (riskReward === null || riskReward < 1) {
        decision = "NO_TRADE";
        noTradeReason = `${isLong ? "LONG" : "SHORT"} evidence is there (${leader.confidence.toFixed(0)}%) but the geometry is not: ${fmt(entry)} entry with a stop at ${fmt(stopLoss)} and target ${fmt(target2)} is only ${riskReward?.toFixed(2) ?? "0"}:1.`;
        entry = stopLoss = target1 = target2 = riskReward = null;
      }
    } else {
      decision = "NO_TRADE";
      noTradeReason = `${isLong ? "LONG" : "SHORT"} evidence reached ${leader.confidence.toFixed(0)}% but no supporting analyst quoted ${chosenStop === null ? "a usable invalidation level" : "a target beyond entry"}, so there is no tradable structure to act on.`;
      entry = null;
    }
  }

  // --- Disagreement, shown rather than quietly discounted ---
  const opposition = trailer.supporters;
  const disagreement = {
    present: opposition.length > 0 && leader.supporters.length > 0,
    note:
      opposition.length > 0 && leader.supporters.length > 0
        ? `${opposition.map((v) => v.name).join(" and ")} read this as ${trailer.direction === "long" ? "LONG" : "SHORT"} from ${opposition.map((v) => BASIS_LABEL[v.basis]).join(" and ")}, against the ${leader.direction === "long" ? "LONG" : "SHORT"} case. Confidence reduced by ${leader.disagreementPenalty.toFixed(0)} points.`
        : "",
    penaltyApplied: leader.disagreementPenalty,
  };

  // --- Explanation, generated from what actually happened ---
  const explanation: string[] = [];
  if (decision === "NO_TRADE") {
    explanation.push(`NO TRADE / NO HIGH-PROBABILITY SETUP on ${symbol} ${timeframe}.`);
    if (noTradeReason) explanation.push(noTradeReason);
    for (const v of verdicts.filter((x) => x.qualified)) {
      explanation.push(`${v.name} does see a ${v.direction.toUpperCase()}: ${v.evidence}.`);
    }
  } else {
    const dirWord = decision === "LONG" ? "LONG" : "SHORT";
    explanation.push(
      `${dirWord} on ${symbol} ${timeframe} at ${leader.confidence.toFixed(0)}% confidence, from ${leader.independentBases} independent method${leader.independentBases === 1 ? "" : "s"} agreeing.`
    );
    for (const v of leader.supporters) {
      explanation.push(`${v.name} (${BASIS_LABEL[v.basis]}, ${v.confidence.toFixed(0)}%): ${v.evidence}.`);
    }
    if (leader.independentBases > 1) {
      explanation.push(
        `These read different evidence — ${leader.supporters.map((v) => BASIS_LABEL[v.basis]).join(", ")} — so the agreement is corroboration rather than the same observation counted ${leader.supporters.length} times. Confluence multiplier ×${leader.independenceMultiplier.toFixed(2)}.`
      );
    } else {
      explanation.push(
        `Only one method supports this, so no confluence bonus is applied — the case rests entirely on ${BASIS_LABEL[leader.supporters[0].basis]}.`
      );
    }
    for (const v of verdicts.filter((x) => !x.qualified)) {
      explanation.push(`${v.name} ${v.gate}.`);
    }
    if (disagreement.present) explanation.push(disagreement.note);
    if (riskReward !== null) {
      explanation.push(
        `Geometry: entry ${fmt(entry!)}, stop ${fmt(stopLoss!)}, targets ${fmt(target1!)} and ${fmt(target2!)} — ${riskReward.toFixed(2)}:1.`
      );
    }
  }

  const invalidation: string[] = [];
  if (decision !== "NO_TRADE" && stopLoss !== null) {
    invalidation.push(
      `A candle close ${decision === "LONG" ? "below" : "above"} ${fmt(stopLoss)} invalidates every supporting read at once.`
    );
    for (const v of leader.supporters) {
      if (v.invalidation !== null)
        invalidation.push(`${v.name} is wrong ${decision === "LONG" ? "below" : "above"} ${fmt(v.invalidation)}.`);
    }
    if (opposition.length > 0)
      invalidation.push(
        `${opposition.map((v) => v.name).join(" and ")} already disagree — treat a fast move against the position as their case being confirmed.`
      );
  }

  // On a trade this is the winning case; on NO_TRADE it is the higher of the
  // two, so the UI can say "closest we got was 64%" rather than showing 50.
  const confidence = Number(leader.confidence.toFixed(1));

  return {
    symbol,
    timeframe,
    price,
    generatedAt: Math.floor(Date.now() / 1000),
    verdicts,
    long,
    short,
    decision,
    confidence: confidence,
    confidenceLabel: label(confidence),
    noTradeReason,
    entry,
    stopLoss,
    target1,
    target2,
    riskReward,
    disagreement,
    confluenceVerdict: verdictWord(decision === "NO_TRADE" ? 0 : leader.independentBases),
    explanation,
    invalidation,
  };
}
