import { analyzeMarketStructure } from "./marketStructure";
import { Candle } from "./types";

/**
 * What to do with a position that is already open.
 *
 * Every other engine here answers "is there a trade?". This one answers the
 * question that actually decides the P/L: given that a trade exists and price
 * has moved, where should the stop be now, and should the trade be closed
 * before the stop is reached at all.
 *
 * ## The two jobs
 *
 * **Protect a trade that is working.** Once price has covered most of the
 * distance to the first target, the risk on the position is no longer worth
 * carrying: give the level back and a winner becomes a full loss. The stop
 * moves to entry — plus a fee buffer, because a "break even" that ignores
 * round-trip fees and slippage is a small loss wearing a neutral name.
 *
 * **Stop paying for a trade that is not working.** A stop is a worst case, not
 * a plan. If price closes well through the position's risk, or structure turns
 * against it, or it simply sits there doing nothing for the whole expected
 * hold, the read has been refuted and holding to the stop only buys a worse
 * fill.
 *
 * ## What this costs, stated plainly
 *
 * Early exits are not free and this engine does not pretend otherwise. Cutting
 * at 0.6R turns some trades that would have recovered into 0.6R losses, and it
 * turns full 1R losses into 0.6R losses. Whether the trade is worth it depends
 * on how often price comes back from that depth — which is a measurable
 * question about *this* engine's signals, not a general truth. The exits are
 * therefore recorded with their reason so the record can answer it, and every
 * decision carries a note saying what was given up.
 *
 * Pure and synchronous: no clock, no database, no fetch. The evaluator supplies
 * price, candles and a timestamp, which is what makes this replayable over
 * closed signals to ask what the rules *would* have done.
 */

/**
 * Share of the entry→TP1 distance that must be covered before the stop moves
 * to break-even.
 *
 * Not 100%: waiting for the target itself means the most common good outcome —
 * price runs to just short of TP1 and reverses — is still a full loss. Not 50%
 * either, or ordinary noise inside the trade's own range keeps stopping it at
 * entry for nothing.
 */
const BREAKEVEN_TRIGGER = 0.75;
/**
 * Buffer past entry when moving to break-even, as a fraction of price.
 *
 * Round-trip taker fees on Binance USDT-M are roughly 0.09%, plus slippage.
 * Stopping exactly at entry books that as a loss, so the "break-even" stop sits
 * far enough beyond entry to actually break even.
 */
const FEE_BUFFER = 0.0012;
/**
 * A *close* this far through the entry→stop distance refutes the trade.
 *
 * Closes, never wicks: a wick through a level is the level being tested, a
 * close through it is the level failing. The whole point of exiting here is to
 * avoid paying the extra distance to a stop that is now very likely to be hit.
 */
const EARLY_EXIT_RISK_SHARE = 0.6;
/**
 * Share of the expected holding time after which a trade that has gone
 * nowhere is closed. Capital in a trade doing nothing is capital not in one
 * that is, and a stalled setup has usually been overtaken by events.
 */
const STALL_TIME_SHARE = 0.8;
/** Progress toward TP1 below which a trade counts as having gone nowhere. */
const STALL_PROGRESS = 0.15;
/** Bars needed before structure is re-read; below this the read is noise. */
const MIN_STRUCTURE_BARS = 40;

export type ManagementStage = "initial" | "breakeven" | "trail_tp1" | "trail_tp2";

export type ExitReason =
  | "structure_flip"
  | "adverse_close"
  | "stall";

export interface ManagedPosition {
  side: "BUY" | "SELL";
  entry: number;
  /** the stop the signal was opened with */
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp3: number;
  /** the stop currently in force; equals stopLoss until management moves it */
  managedStop?: number | null;
  status: string;
  /** unix seconds */
  openedAt: number;
  estHoldingMin: number;
}

export interface ManagementDecision {
  /** the stop that should be in force after this pass */
  stop: number;
  /** true when the stop moved on this pass */
  moved: boolean;
  stage: ManagementStage;
  /** set when the trade should be closed now, ahead of its stop */
  exit: { reason: ExitReason; detail: string } | null;
  /** favourable progress toward TP1, 0-1 (can exceed 1) */
  progressToTp1: number;
  /** how much of the entry→stop distance has been given up, 0-1 */
  riskUsed: number;
  /** what happened and why, for the management log */
  notes: string[];
}

/** Best stop for a long is the highest; for a short, the lowest. */
function tighter(side: "BUY" | "SELL", a: number, b: number): number {
  return side === "BUY" ? Math.max(a, b) : Math.min(a, b);
}

/**
 * Decide what to do with an open position.
 *
 * `candles` should be the signal's own timeframe and cover the period since it
 * opened. Passing fewer is safe: the structure check simply abstains rather
 * than reading a flip out of a handful of bars.
 */
export function manageTrade(
  pos: ManagedPosition,
  price: number,
  candles: Candle[],
  nowSec: number = Math.floor(Date.now() / 1000)
): ManagementDecision {
  const isBuy = pos.side === "BUY";
  const dir = isBuy ? 1 : -1;
  const notes: string[] = [];

  const risk = Math.abs(pos.entry - pos.stopLoss);
  const toTp1 = Math.abs(pos.tp1 - pos.entry);
  const moved = (price - pos.entry) * dir;
  const progressToTp1 = toTp1 > 0 ? moved / toTp1 : 0;
  const riskUsed = risk > 0 ? Math.max(0, -moved / risk) : 0;

  const current = pos.managedStop ?? pos.stopLoss;
  let stop = current;
  let stage: ManagementStage = "initial";

  /* ---- 1. Protect what is working ---- */
  const breakEvenStop = pos.entry * (1 + FEE_BUFFER * dir);
  const tagged = pos.status === "TP1_HIT" || pos.status === "TP2_HIT";

  if (pos.status === "TP2_HIT") {
    // Two targets banked: the first is now the floor. Giving back a trade that
    // has run this far is the single most expensive management mistake there
    // is, and it is entirely avoidable.
    stage = "trail_tp2";
    stop = tighter(pos.side, stop, pos.tp1);
    notes.push(`TP2 tagged — stop trailed to TP1 (${pos.tp1}).`);
  } else if (tagged || progressToTp1 >= BREAKEVEN_TRIGGER) {
    stage = tagged ? "trail_tp1" : "breakeven";
    stop = tighter(pos.side, stop, breakEvenStop);
    notes.push(
      tagged
        ? `TP1 tagged — stop at break-even plus fees (${breakEvenStop.toFixed(8).replace(/0+$/, "")}). The first target is banked; the rest rides for free.`
        : `Covered ${(progressToTp1 * 100).toFixed(0)}% of the distance to TP1 — stop moved to break-even plus fees. Past this point the trade is no longer worth its original risk.`
    );
  }

  const stopMoved = stop !== current;

  /* ---- 2. Stop paying for what is not working ----
     Checked in order of how conclusive each is. Structure turning against the
     position is the strongest: it means the thing the trade was reasoning
     about has changed, not merely that price has wobbled. */
  let exit: ManagementDecision["exit"] = null;

  const since = candles.filter((c) => c.time >= pos.openedAt);

  if (candles.length >= MIN_STRUCTURE_BARS) {
    const structure = analyzeMarketStructure(candles);
    const against = structure.events
      .filter((e) => e.time >= pos.openedAt && e.type === "CHOCH")
      .filter((e) => (isBuy ? e.direction === "bearish" : e.direction === "bullish"));
    if (against.length > 0 && moved < 0) {
      const last = against[against.length - 1];
      exit = {
        reason: "structure_flip",
        detail:
          `Structure changed character against the position after entry (${last.type} ${last.direction} at ${last.price}). ` +
          `The read was that this level would hold; structure now says it did not. Holding to the stop from here is paying for a thesis that has already been refuted.`,
      };
    }
  }

  if (!exit && risk > 0 && since.length > 0) {
    // A close, not a wick: a wick through a level is the level being tested.
    const trigger = pos.entry - risk * EARLY_EXIT_RISK_SHARE * dir;
    const breached = since.some((c) => (isBuy ? c.close < trigger : c.close > trigger));
    if (breached && riskUsed >= EARLY_EXIT_RISK_SHARE * 0.9) {
      exit = {
        reason: "adverse_close",
        detail:
          `A candle closed ${(EARLY_EXIT_RISK_SHARE * 100).toFixed(0)}% of the way from entry to the stop (through ${trigger.toFixed(8).replace(/0+$/, "")}). ` +
          `Closing here rather than waiting means giving up the chance of a recovery in exchange for a smaller loss — that trade is only worth making if price rarely comes back from this depth, which the signal record now measures.`,
      };
    }
  }

  if (!exit && pos.estHoldingMin > 0) {
    const ageMin = (nowSec - pos.openedAt) / 60;
    const stalled =
      ageMin >= pos.estHoldingMin * STALL_TIME_SHARE &&
      progressToTp1 < STALL_PROGRESS &&
      moved <= 0;
    if (stalled) {
      exit = {
        reason: "stall",
        detail:
          `${Math.round(ageMin)} minutes into an expected ${pos.estHoldingMin}-minute hold with ${(progressToTp1 * 100).toFixed(0)}% of the first target covered and price at or below entry. ` +
          `The setup has not been invalidated so much as overtaken — whatever was going to happen here has had its time.`,
      };
    }
  }

  if (exit) notes.push(`Early exit (${exit.reason}): ${exit.detail}`);
  if (!exit && !stopMoved && stage === "initial") {
    notes.push(
      `Running at ${(progressToTp1 * 100).toFixed(0)}% toward TP1, ${(riskUsed * 100).toFixed(0)}% of risk used. Original stop still in force.`
    );
  }

  return {
    stop,
    moved: stopMoved,
    stage,
    exit,
    progressToTp1: Number(progressToTp1.toFixed(4)),
    riskUsed: Number(riskUsed.toFixed(4)),
    notes,
  };
}

/**
 * Did this position close at break-even rather than as a win or a loss?
 *
 * "Break-even" here means the managed stop was at or beyond entry when it was
 * hit — the trade was protected and then retraced — rather than any close that
 * happens to land near zero. The distinction matters because a break-even exit
 * is a *management* outcome and belongs in neither the win nor the loss column;
 * counting it either way misstates what the engine got right.
 */
export function isBreakEvenExit(
  pos: Pick<ManagedPosition, "side" | "entry">,
  managedStop: number | null | undefined,
  closedPrice: number
): boolean {
  if (managedStop == null) return false;
  const isBuy = pos.side === "BUY";
  // The stop had been moved to entry or better...
  const protectedStop = isBuy ? managedStop >= pos.entry : managedStop <= pos.entry;
  if (!protectedStop) return false;
  // ...and that is where the trade ended, within a small tolerance.
  const gap = Math.abs(closedPrice - managedStop) / Math.max(1e-9, pos.entry);
  return gap <= 0.003;
}
