import { Bias, Candle, DeltaAnalysis, MarketStructureResult, VolumeProfileResult } from "./types";
import type { PositioningRead, ValueMigration } from "./positioning";

/**
 * Where the evidence disagrees with itself.
 *
 * The composite signal averages twenty-eight strategies into one number, and
 * averaging is exactly the wrong operation for the most informative thing on
 * the screen. Price making a higher high while cumulative delta makes a lower
 * one is not a weak bullish reading and a weak bearish reading that cancel to
 * neutral — it is a *specific condition* with a name, and the cancellation
 * destroys it. Every detector here exists to surface a disagreement the
 * composite would have flattened.
 *
 * ## Every check reports, including the ones that pass
 *
 * A conflict list that is empty when nothing fires cannot be told apart from a
 * conflict list that never ran, and the difference matters enormously: "flow
 * and price agree" is a real and useful state, while "we could not measure
 * flow" is not. So each detector returns `conflict`, `aligned`, or
 * `unavailable`, and the panel shows all three. Silence is never used to mean
 * agreement.
 *
 * ## What a conflict is not
 *
 * `argues` names the direction a divergence points *if it resolves*, which is
 * not a claim that it will. Divergences persist for a long time and plenty
 * simply stop diverging with no reversal at all — a market can go on making
 * higher highs on falling delta until the day it doesn't. What the check gives
 * you is a named condition and the reason to require more evidence than usual
 * before trusting the move; nothing here forecasts a price.
 */

export type ConflictStatus = "conflict" | "aligned" | "unavailable";

export interface ConflictCheck {
  id: string;
  title: string;
  status: ConflictStatus;
  /** the direction this divergence argues for if it resolves — not a forecast */
  argues: "up" | "down" | "neither";
  severity: "high" | "medium" | "low";
  /** one line: what the two sides of the evidence each say */
  says: string;
  /** what the disagreement means, or why the check could not run */
  reading: string;
}

export interface ConflictReport {
  checks: ConflictCheck[];
  conflicts: ConflictCheck[];
  alignedCount: number;
  unavailableCount: number;
  headline: string;
  note: string;
}

export interface ConflictInputs {
  candles: Candle[];
  structure: MarketStructureResult;
  delta: DeltaAnalysis;
  volumeProfile: VolumeProfileResult;
  positioning: PositioningRead;
  migration: ValueMigration | null;
  /** funding bias direction, when the funding report has loaded */
  fundingPayer?: "longs" | "shorts" | "balanced" | null;
}

/** Bars the flow checks measure over. */
const FLOW_WINDOW = 20;
/** Minimum price separation between two swings before comparing them, percent. */
const MIN_SWING_GAP_PCT = 0.3;

function unavailable(id: string, title: string, why: string): ConflictCheck {
  return { id, title, status: "unavailable", argues: "neither", severity: "low", says: "—", reading: why };
}

function aligned(id: string, title: string, says: string, reading: string): ConflictCheck {
  return { id, title, status: "aligned", argues: "neither", severity: "low", says, reading };
}

/* ------------------------------------------------------------------ *
 * 1. Price against cumulative delta
 * ------------------------------------------------------------------ */

function cvdDivergence(i: ConflictInputs): ConflictCheck {
  const id = "cvd-divergence";
  const title = "Price vs cumulative delta";
  const series = i.delta.series;
  if (series.length < 10) {
    return unavailable(id, title, "Delta series too short to compare two swings.");
  }

  const cvdAt = (t: number) => {
    // The reading at or before the swing — the series and the swings come from
    // different passes and need not share timestamps exactly.
    let best: (typeof series)[number] | null = null;
    for (const p of series) {
      if (p.time > t) break;
      best = p;
    }
    return best;
  };

  for (const kind of ["high", "low"] as const) {
    const swings = i.structure.swings.filter((s) => s.kind === kind).slice(-4);
    if (swings.length < 2) continue;
    const a = swings[swings.length - 2];
    const b = swings[swings.length - 1];
    const gapPct = a.price !== 0 ? (Math.abs(b.price - a.price) / a.price) * 100 : 0;
    if (gapPct < MIN_SWING_GAP_PCT) continue;

    const ca = cvdAt(a.time);
    const cb = cvdAt(b.time);
    if (!ca || !cb) continue;

    if (kind === "high" && b.price > a.price && cb.cvd < ca.cvd) {
      return {
        id,
        title,
        status: "conflict",
        argues: "down",
        severity: "high",
        says: `Price high ${a.price.toFixed(4)} → ${b.price.toFixed(4)}, but cumulative delta ${ca.cvd.toFixed(0)} → ${cb.cvd.toFixed(0)}.`,
        reading:
          "The advance made a new high on less net buying than the one before it — the buyers lifting the offer are doing less work each time. That is the distribution signature: someone is selling into the strength passively. It is a reason to demand more from a long here, not a short signal on its own; divergences can run for a long time before anything happens to them.",
      };
    }
    if (kind === "low" && b.price < a.price && cb.cvd > ca.cvd) {
      return {
        id,
        title,
        status: "conflict",
        argues: "up",
        severity: "high",
        says: `Price low ${a.price.toFixed(4)} → ${b.price.toFixed(4)}, but cumulative delta ${ca.cvd.toFixed(0)} → ${cb.cvd.toFixed(0)}.`,
        reading:
          "The decline made a new low on less net selling than the one before it — sellers are getting less for more. That is the accumulation signature: someone is buying into the weakness passively. A reason to demand more from a short, not a long signal by itself.",
      };
    }
  }

  return aligned(
    id,
    title,
    "The recent swings and cumulative delta point the same way.",
    "Flow is confirming the price sequence rather than fading it — the cleanest condition for trading with the move rather than against it."
  );
}

/* ------------------------------------------------------------------ *
 * 2. Structure against value migration
 * ------------------------------------------------------------------ */

function structureVsValue(i: ConflictInputs): ConflictCheck {
  const id = "structure-vs-value";
  const title = "Swing structure vs value migration";
  if (!i.migration) {
    return unavailable(id, title, "Not enough history to profile two windows and compare their value areas.");
  }
  const trend: Bias = i.structure.trend;
  const m = i.migration;

  if (trend === "bullish" && m.direction === "lower") {
    return {
      id,
      title,
      status: "conflict",
      argues: "down",
      severity: "high",
      says: "Swings read bullish, but the value area has migrated lower.",
      reading:
        "The swing sequence and the auction disagree. Structure is built from extremes — the wicks — while value is built from where volume actually traded, and when they part it is usually because the highs are being made on thin participation while business is being done lower. Value is the slower and harder of the two to fake.",
    };
  }
  if (trend === "bearish" && m.direction === "higher") {
    return {
      id,
      title,
      status: "conflict",
      argues: "up",
      severity: "high",
      says: "Swings read bearish, but the value area has migrated higher.",
      reading:
        "Lows are being printed on thin trade while the bulk of the volume changes hands higher. The structure read is lagging what the auction has already done.",
    };
  }
  if ((trend === "bullish" || trend === "bearish") && m.direction === "overlapping") {
    return {
      id,
      title,
      status: "conflict",
      argues: "neither",
      severity: "medium",
      says: `Swings read ${trend}, but ${(m.overlap * 100).toFixed(0)}% of current value sits inside the previous area.`,
      reading:
        "A trend in the swings that the auction has not confirmed: the market is still rotating in the band it was already trading. Continuation setups here are fighting a range that has not actually broken, which is the most common way a good trend read loses money.",
    };
  }

  return aligned(
    id,
    title,
    `Swings read ${trend}, value is ${m.direction === "unchanged" ? "holding its shape" : m.direction}.`,
    "The sequence of highs and lows and the place business is being done tell the same story."
  );
}

/* ------------------------------------------------------------------ *
 * 3. Who is behind the move
 * ------------------------------------------------------------------ */

function advanceOnClosing(i: ConflictInputs): ConflictCheck {
  const id = "advance-on-closing";
  const title = "Is the move opening or closing positions?";
  const p = i.positioning;
  if (p.quadrant == null) {
    return unavailable(id, title, p.caveats[0] ?? "No positioning read available.");
  }
  if (p.participation === "closing") {
    const up = p.quadrant === "short_covering";
    return {
      id,
      title,
      status: "conflict",
      argues: up ? "down" : "up",
      severity: "medium",
      says: `${p.label} — price ${p.pricePct >= 0 ? "+" : ""}${p.pricePct}%, open interest ${p.oiPct >= 0 ? "+" : ""}${p.oiPct}%.`,
      reading: up
        ? "The buying moving this market is shorts closing, not new longs arriving. That is a finite bid: it ends when the shorts are out, and nothing about it obliges anyone to buy higher afterwards. The move needs new longs to take over if it is to continue."
        : "The selling is longs leaving rather than new shorts arriving — also finite. Flushes like this run out when the trapped longs are gone.",
    };
  }
  return aligned(
    id,
    title,
    `${p.label} — new money is taking a side.`,
    "The move is backed by fresh commitment rather than by people unwinding, so it has no built-in ceiling. Those new positions are also the fuel for a reversal if price turns back through them."
  );
}

/* ------------------------------------------------------------------ *
 * 4. Location against flow
 * ------------------------------------------------------------------ */

function acceptanceVsFlow(i: ConflictInputs): ConflictCheck {
  const id = "acceptance-vs-flow";
  const title = "Position in value vs net flow";
  const recent = i.candles.slice(-FLOW_WINDOW);
  let net = 0;
  let have = false;
  for (const c of recent) {
    if (c.takerBuyVolume == null) continue;
    have = true;
    net += c.takerBuyVolume - (c.volume - c.takerBuyVolume);
  }
  if (!have) {
    return unavailable(id, title, "No taker breakdown on these candles, so net flow could not be measured.");
  }

  const acc = i.volumeProfile.acceptance;
  if (acc === "above_value" && net < 0) {
    return {
      id,
      title,
      status: "conflict",
      argues: "down",
      severity: "medium",
      says: `Price is trading above value on net selling over the last ${recent.length} bars.`,
      reading:
        "Price has extended past the band the market accepted, but the aggression over those bars was on the sell side — so the extension is being held up by something other than buyers paying up. Extensions that are not supported by flow are the ones that return to value.",
    };
  }
  if (acc === "below_value" && net > 0) {
    return {
      id,
      title,
      status: "conflict",
      argues: "up",
      severity: "medium",
      says: `Price is trading below value on net buying over the last ${recent.length} bars.`,
      reading:
        "Price is under the accepted band while the aggressive flow is buying. Someone is taking the other side down here rather than defending lower.",
    };
  }

  return aligned(
    id,
    title,
    `Price is ${acc.replace(/_/g, " ")} and net flow ${net >= 0 ? "is buying" : "is selling"}.`,
    "Where price sits relative to value and who is being aggressive agree with each other."
  );
}

/* ------------------------------------------------------------------ *
 * 5. Cost of carry against fresh commitment
 * ------------------------------------------------------------------ */

function fundingVsPositioning(i: ConflictInputs): ConflictCheck {
  const id = "funding-vs-positioning";
  const title = "Who pays vs who is opening";
  const payer = i.fundingPayer;
  if (payer == null) return unavailable(id, title, "Funding has not loaded for this contract.");
  if (payer === "balanced") {
    return aligned(
      id,
      title,
      "Funding is flat — effectively nothing changes hands.",
      "Neither side is paying to hold, so there is no crowding to square against positioning."
    );
  }
  if (i.positioning.quadrant == null) {
    return unavailable(id, title, "No positioning read to compare the funding against.");
  }

  const openingLongs = i.positioning.quadrant === "new_longs";
  const openingShorts = i.positioning.quadrant === "new_shorts";

  if (payer === "longs" && openingLongs) {
    return {
      id,
      title,
      status: "conflict",
      argues: "down",
      severity: "medium",
      says: "Longs are already paying to hold, and new longs are still opening.",
      reading:
        "Fresh money is joining the side that is already crowded and already being charged for it. That does not make the move wrong, but it does mean the position is expensive to hold and densely stacked — which is the condition a long squeeze needs. Whether it fires depends on price reaching those stops, not on the funding.",
    };
  }
  if (payer === "shorts" && openingShorts) {
    return {
      id,
      title,
      status: "conflict",
      argues: "up",
      severity: "medium",
      says: "Shorts are already paying to hold, and new shorts are still opening.",
      reading:
        "New shorts are stacking onto a side that is already paying for the privilege. Densely packed shorts above a market are the fuel a squeeze runs on — again, only if price gets to them.",
    };
  }

  return aligned(
    id,
    title,
    `${payer === "longs" ? "Longs" : "Shorts"} pay, and the new positions are not adding to that side.`,
    "The crowded side is not getting more crowded."
  );
}

/**
 * Run every check.
 *
 * Pure and synchronous. Each detector is independent and self-gating: none of
 * them can be made to fire by another's result, and every one that lacks its
 * inputs says so rather than falling through to "aligned".
 */
export function detectConflicts(i: ConflictInputs): ConflictReport {
  const checks = [
    cvdDivergence(i),
    structureVsValue(i),
    advanceOnClosing(i),
    acceptanceVsFlow(i),
    fundingVsPositioning(i),
  ];

  const conflicts = checks.filter((c) => c.status === "conflict");
  const alignedCount = checks.filter((c) => c.status === "aligned").length;
  const unavailableCount = checks.filter((c) => c.status === "unavailable").length;

  const up = conflicts.filter((c) => c.argues === "up").length;
  const down = conflicts.filter((c) => c.argues === "down").length;

  let headline: string;
  if (conflicts.length === 0) {
    headline =
      alignedCount === 0
        ? "Nothing could be checked — every detector is missing its inputs."
        : `No conflicts across ${alignedCount} check${alignedCount === 1 ? "" : "s"}. The evidence agrees with itself.`;
  } else if (up > 0 && down > 0) {
    headline = `${conflicts.length} conflicts, and they do not agree with each other either — ${up} argue up, ${down} argue down.`;
  } else {
    const dir = down > 0 ? "against the upside" : "against the downside";
    headline = `${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}, all arguing ${dir}.`;
  }

  return {
    checks,
    conflicts,
    alignedCount,
    unavailableCount,
    headline,
    note:
      conflicts.length === 0
        ? "Agreement is a condition, not a signal — it says the evidence is consistent, not that the move continues."
        : "A divergence is a reason to require more before trusting the move. It is not a countertrend entry: these conditions can persist for a long time, and some resolve by simply ceasing to diverge.",
  };
}
