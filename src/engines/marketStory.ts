import { AnomalyReport } from "./anomalies";
import { Candle, DeltaAnalysis, LiquidationDeltaPoint, VwapResult } from "./types";

/**
 * What happened, in order, with the clock on every line.
 *
 * "Buyers are aggressive" is a state with no timestamp and no antecedent — it
 * could have been true for four bars or forty, and it says nothing about what
 * preceded it. A market read is a *sequence*: selling, then forced selling,
 * then selling that stopped working, then buying. Each step only means
 * anything because of the one before it, and a panel that reports the current
 * state throws that away.
 *
 * So this builds two things: a chronological event feed where every line
 * carries the time it happened, and a phase narrative grouping those events
 * into the arc they form.
 *
 * ## The phases are detected, not assumed
 *
 * A four-act structure is easy to impose on any chart if you are willing to
 * squint, which would make it decoration. Each phase here has mechanical
 * entry conditions and is emitted only when they hold; a market that went
 * sideways produces one phase, not four, and the interpretation says so.
 * There is no minimum number of phases and no requirement that they occur in
 * a particular order.
 *
 * ## The confidence number
 *
 * It scores how *complete and consistent* the observed sequence is — how many
 * phases were found, whether they form a coherent arc, and whether the flow
 * agreed with itself. It is explicitly not a probability that the
 * interpretation is correct, and the note attached to every story says so.
 * Nothing here is measured against future outcomes, so nothing here can be a
 * hit rate.
 */

/** Bars the story looks back over. */
const WINDOW = 60;
/** A phase needs at least this many bars to be a phase rather than a bar. */
const MIN_PHASE_BARS = 3;
/** Delta must lean this far for a phase to be called one-sided. */
const LEAN = 0.58;

export type PhaseKind =
  | "selling"
  | "buying"
  | "liquidation"
  | "absorption"
  | "confirmation"
  | "drift";

export interface StoryEvent {
  /** unix seconds — every line in the feed is dated */
  time: number;
  /** short machine tag, for grouping and icons */
  kind: string;
  /** the sentence, written to stand alone in a feed */
  text: string;
  tone: "bull" | "bear" | "neutral";
}

export interface StoryPhase {
  kind: PhaseKind;
  label: string;
  /** unix seconds of the first and last bar in the phase */
  from: number;
  to: number;
  bars: number;
  summary: string;
  tone: "bull" | "bear" | "neutral";
  /** taker buy share across the phase, 0-1; null when takers were unavailable */
  share: number | null;
}

export interface MarketStory {
  phases: StoryPhase[];
  events: StoryEvent[];
  /** what the sequence adds up to, as a description rather than a forecast */
  interpretation: string;
  /** 0-100: completeness and internal consistency of the sequence, not a probability */
  coherence: number;
  note: string;
}

export interface StoryInputs {
  candles: Candle[];
  delta: DeltaAnalysis | null;
  liquidations: LiquidationDeltaPoint[];
  vwap: VwapResult | null;
  openInterest: { time: number; openInterest: number }[];
  anomalies: AnomalyReport | null;
}

const PHASE_LABEL: Record<PhaseKind, string> = {
  selling: "Selling",
  buying: "Buying",
  liquidation: "Liquidation",
  absorption: "Absorption",
  confirmation: "Confirmation",
  drift: "Drift",
};

/** Buy share of a slice's taker flow, or null when takers are missing. */
function buyShare(bars: Candle[]): number | null {
  let buy = 0;
  let total = 0;
  for (const c of bars) {
    if (c.takerBuyVolume == null) continue;
    buy += c.takerBuyVolume;
    total += c.volume;
  }
  return total > 0 ? buy / total : null;
}

/**
 * Build the story.
 *
 * Pure and synchronous. Returns an empty story rather than a manufactured one
 * when there is not enough history — a narrative assembled from eight bars is
 * a narrative about noise.
 */
export function buildMarketStory(i: StoryInputs): MarketStory {
  const bars = i.candles.slice(-WINDOW);
  if (bars.length < 20) {
    return {
      phases: [],
      events: [],
      interpretation: "Not enough history on this timeframe to tell a story.",
      coherence: 0,
      note: "A narrative built from a handful of bars describes noise. Nothing is reported rather than something invented.",
    };
  }

  const liqAt = new Map(i.liquidations.map((l) => [l.time, l]));

  /* ---------------- phases ----------------
     Walked forward in slices, each classified on its own evidence. Adjacent
     slices of the same kind merge, so a phase is as long as the condition
     actually lasted rather than as long as the slice width. */
  const SLICE = Math.max(MIN_PHASE_BARS, Math.floor(bars.length / 8));
  const raw: { kind: PhaseKind; from: number; to: number; bars: number; share: number | null }[] = [];

  for (let start = 0; start + SLICE <= bars.length; start += SLICE) {
    const slice = bars.slice(start, start + SLICE);
    const share = buyShare(slice);
    const first = slice[0];
    const lastBar = slice[slice.length - 1];
    const movePct = first.open !== 0 ? ((lastBar.close - first.open) / first.open) * 100 : 0;

    const forced = slice.reduce((s, c) => {
      const l = liqAt.get(c.time);
      return s + (l ? l.longLiquidated + l.shortLiquidated : 0);
    }, 0);
    const baselineForced =
      i.liquidations.length > 0
        ? i.liquidations.reduce((s, l) => s + l.longLiquidated + l.shortLiquidated, 0) /
          i.liquidations.length
        : 0;

    let kind: PhaseKind;
    if (baselineForced > 0 && forced > baselineForced * slice.length * 2.5) {
      kind = "liquidation";
    } else if (share != null && share <= 1 - LEAN && movePct > -0.2) {
      // Heavy selling that did not move price down: someone took the other side.
      kind = "absorption";
    } else if (share != null && share >= LEAN && movePct < 0.2) {
      kind = "absorption";
    } else if (share != null && share <= 1 - LEAN) {
      kind = "selling";
    } else if (share != null && share >= LEAN) {
      kind = "buying";
    } else if (Math.abs(movePct) < 0.3) {
      kind = "drift";
    } else {
      kind = movePct > 0 ? "buying" : "selling";
    }

    const prev = raw[raw.length - 1];
    if (prev && prev.kind === kind) {
      prev.to = lastBar.time;
      prev.bars += slice.length;
    } else {
      raw.push({ kind, from: first.time, to: lastBar.time, bars: slice.length, share });
    }
  }

  /* A confirmation phase is not a slice classification — it is an event that
     happens at the end: flow turning while price reclaims a reference. */
  const tail = bars.slice(-SLICE);
  const tailShare = buyShare(tail);
  /* The cross is looked for anywhere in the tail rather than only at its
     first bar. Comparing just the endpoints misses a reclaim that happened
     two bars in and then held — which is the ordinary shape of one. */
  const closeNow = bars[bars.length - 1].close;
  const tailLow = Math.min(...tail.map((c) => c.close));
  const tailHigh = Math.max(...tail.map((c) => c.close));
  const reclaimedVwap = i.vwap != null && closeNow > i.vwap.current && tailLow <= i.vwap.current;
  const lostVwap = i.vwap != null && closeNow < i.vwap.current && tailHigh >= i.vwap.current;
  if ((reclaimedVwap || lostVwap) && tailShare != null) {
    raw.push({
      kind: "confirmation",
      from: tail[0].time,
      to: tail[tail.length - 1].time,
      bars: tail.length,
      share: tailShare,
    });
  }

  const phases: StoryPhase[] = raw.map((p) => {
    const tone: StoryPhase["tone"] =
      p.kind === "buying" || (p.kind === "confirmation" && reclaimedVwap)
        ? "bull"
        : p.kind === "selling" || p.kind === "liquidation"
          ? "bear"
          : "neutral";
    return {
      kind: p.kind,
      label: PHASE_LABEL[p.kind],
      from: p.from,
      to: p.to,
      bars: p.bars,
      tone,
      share: p.share,
      summary: summaryFor(p.kind, p.share, reclaimedVwap),
    };
  });

  /* ---------------- events ----------------
     The feed is what makes the phases checkable: each is a dated observation
     the reader can go and look at on the chart. */
  const events: StoryEvent[] = [];

  for (const p of phases) {
    events.push({
      time: p.from,
      kind: `phase:${p.kind}`,
      text: `${p.label} phase began — ${p.summary}`,
      tone: p.tone,
    });
  }

  // Anomalies are already dated events; they belong in the same feed.
  for (const a of i.anomalies?.anomalies ?? []) {
    events.push({
      time: a.time,
      kind: `anomaly:${a.kind}`,
      text: `${a.label}: ${a.headline}`,
      tone: a.direction === "up" ? "bull" : a.direction === "down" ? "bear" : "neutral",
    });
  }

  if (i.vwap && (reclaimedVwap || lostVwap)) {
    events.push({
      time: bars[bars.length - 1].time,
      kind: "vwap",
      text: `Price ${reclaimedVwap ? "reclaimed" : "lost"} session VWAP at ${i.vwap.current.toFixed(6).replace(/0+$/, "")}.`,
      tone: reclaimedVwap ? "bull" : "bear",
    });
  }

  // Open interest, as a dated change rather than a level.
  if (i.openInterest.length >= 2) {
    const oi = [...i.openInterest].sort((a, b) => a.time - b.time);
    const prev = oi[oi.length - 2].openInterest;
    const now = oi[oi.length - 1].openInterest;
    if (prev > 0) {
      const pct = ((now - prev) / prev) * 100;
      if (Math.abs(pct) >= 0.3) {
        events.push({
          time: oi[oi.length - 1].time,
          kind: "oi",
          text: `Open interest ${pct >= 0 ? "rose" : "fell"} ${Math.abs(pct).toFixed(2)}% — positions ${pct >= 0 ? "opening" : "closing"}.`,
          tone: "neutral",
        });
      }
    }
  }

  events.sort((a, b) => a.time - b.time);

  /* ---------------- what it adds up to ---------------- */
  const kinds = phases.map((p) => p.kind);
  const interpretation = interpret(phases, kinds, reclaimedVwap, lostVwap);

  /* Coherence: how complete and internally consistent the sequence is. Not a
     probability — nothing here has been measured against outcomes, so nothing
     here can be a hit rate. */
  let coherence = Math.min(60, phases.length * 14);
  if (kinds.includes("absorption")) coherence += 12;
  if (kinds.includes("liquidation")) coherence += 10;
  if (kinds.includes("confirmation")) coherence += 18;
  const lastPhase = phases[phases.length - 1];
  const firstPhase = phases[0];
  if (lastPhase && firstPhase && lastPhase.tone !== "neutral" && lastPhase.tone !== firstPhase.tone) {
    coherence += 8; // an arc that actually turned
  }
  coherence = Math.max(0, Math.min(100, coherence));

  return {
    phases,
    events,
    interpretation,
    coherence,
    note: "Coherence scores how complete and self-consistent this sequence is — how many phases were found and whether they form an arc. It is not a probability that the interpretation is right: nothing in this story has been measured against what happened next.",
  };
}

/**
 * Word the phase from what the flow actually showed.
 *
 * A slice with a neutral taker split but a decisive price move is still
 * classified by direction — that is the last branch of the chain, and it is
 * right, because price went somewhere. But the summary must not then claim
 * aggression the share does not support: "aggressive buying led the tape (42%
 * of takers lifted the offer)" is a sentence contradicting its own
 * parenthesis, and it is what this function used to print.
 */
function summaryFor(kind: PhaseKind, share: number | null, reclaimed: boolean): string {
  const pct = share == null ? null : (share * 100).toFixed(0);
  const buyLed = share != null && share >= LEAN;
  const sellLed = share != null && share <= 1 - LEAN;
  switch (kind) {
    case "selling":
      if (pct == null) return "Price declined. No taker breakdown on these bars, so who was aggressive is unknown.";
      return sellLed
        ? `Aggressive selling led the tape (${100 - Number(pct)}% of takers hit the bid).`
        : `Price declined without either side dominating the tape (${100 - Number(pct)}% of takers hit the bid).`;
    case "buying":
      if (pct == null) return "Price advanced. No taker breakdown on these bars, so who was aggressive is unknown.";
      return buyLed
        ? `Aggressive buying led the tape (${pct}% of takers lifted the offer).`
        : `Price advanced without either side dominating the tape (${pct}% of takers lifted the offer).`;
    case "liquidation":
      return "Forced closes ran well above normal — positions closed by the exchange rather than by choice.";
    case "absorption":
      return "Flow stayed one-sided but price stopped following it. Someone was taking the other side passively.";
    case "confirmation":
      return reclaimed
        ? "Flow turned and price reclaimed its session reference."
        : "Flow turned and price lost its session reference.";
    case "drift":
      return "Two-sided and directionless — no one was forcing anything.";
  }
}

function interpret(
  phases: StoryPhase[],
  kinds: PhaseKind[],
  reclaimed: boolean,
  lost: boolean
): string {
  const has = (k: PhaseKind) => kinds.includes(k);

  if (has("selling") && has("liquidation") && has("absorption") && reclaimed) {
    return "Selling, then forced selling, then selling that stopped working, then a reclaim. That is the full capitulation-and-turn sequence — the strongest version of this arc, and it is a description of what has happened, not a prediction that it continues.";
  }
  if (has("buying") && has("liquidation") && has("absorption") && lost) {
    return "The mirror: buying, forced buying, buying that stopped working, then a break of the session reference.";
  }
  /* Absorption reads off its own flow rather than off a neighbouring phase.
     A window that is *entirely* absorption has no selling or buying phase to
     pair with, and falling through to the generic branch reported the most
     distinctive condition on the chart as "two-sided". */
  const absorbing = phases.filter((p) => p.kind === "absorption" && p.share != null);
  if (absorbing.length > 0) {
    const sellSide = absorbing.some((p) => (p.share as number) < 0.5);
    return sellSide
      ? "Selling that price stopped responding to. Absorption without a reclaim is unfinished — it says the sellers are being met, not that the buyers have taken over."
      : "Buying that price stopped responding to — the distribution shape, and unfinished for the same reason in reverse.";
  }
  if (has("liquidation")) {
    return "A forced-flow event dominates the window. Liquidations overshoot and the overshoot is often given back, but nothing marks where the stack ends.";
  }
  if (kinds.every((k) => k === "drift")) {
    return "Nothing happened. No side forced anything and price went nowhere — which is most of the time, and is a real answer rather than a gap in the read.";
  }
  const bull = kinds.filter((k) => k === "buying").length;
  const bear = kinds.filter((k) => k === "selling").length;
  if (bull > bear) return "One-sided buying with no absorption or reclaim to structure it. A trend in progress rather than a turn.";
  if (bear > bull) return "One-sided selling with no absorption yet. A decline in progress rather than a bottom.";
  return "Two-sided: the window contains both directions without either establishing control.";
}
