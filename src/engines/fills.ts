import { Candle } from "./types";

/**
 * Did this signal ever actually get filled?
 *
 * The entry on a setup is a *limit* price — a level the engine wants to buy or
 * sell at, not the price at the moment of publication. Until price trades
 * there the position does not exist. Booking profit and loss from that entry
 * regardless is the single most flattering mistake a backtest can make, and it
 * flatters in one specific direction: the setups whose entry ran away without
 * being touched are exactly the ones that were about to move. The unfilled set
 * is not a random sample of the whole, so dropping it silently does not merely
 * add noise — it removes the losers' near-misses and keeps the winners'.
 *
 * ## What counts as a fill
 *
 * A resting buy limit fills when price trades down to it: the bar's *low* must
 * reach the entry, not its close. Symmetrically a sell limit needs the bar's
 * high. Using the close would miss every fill that happened intrabar and
 * reported them as unfilled, which is the same error with the sign flipped.
 *
 * ## The case this deliberately does not model
 *
 * Queue position. A limit order at a price that was touched exactly once, by a
 * single tick, may not have been filled in reality — the book has to trade
 * *through* the level for a fill to be certain. This treats a touch as a fill,
 * which is optimistic. It is stated here rather than hidden because the
 * remaining bias is small and knowable, unlike the one it replaces.
 */

/** Once price has run this far past the entry without touching it, stop waiting. */
const RUNAWAY_R = 1;

/**
 * Is this entry already marketable at publication?
 *
 * A buy limit at or above the current price fills immediately — it is a market
 * order wearing a limit price — and pretending otherwise would leave signals
 * sitting PENDING while the position was in fact open. Only entries that
 * require price to come *to* them start as pending.
 */
export function fillsImmediately(side: "BUY" | "SELL", entry: number, price: number): boolean {
  return side === "BUY" ? price <= entry : price >= entry;
}

export type FillState = "filled" | "waiting" | "unfilled";

export interface FillCheck {
  state: FillState;
  /** the bar the fill happened on, unix seconds — null unless filled */
  filledAt: number | null;
  /** bars waited before the fill, or waited so far */
  barsWaited: number;
  reason: string;
}

export interface FillInputs {
  side: "BUY" | "SELL";
  entry: number;
  stopLoss: number;
  /** publication time, unix seconds */
  openedAt: number;
  /** bars at or after publication, oldest first */
  bars: Candle[];
  /** how long the setup was expected to take, in minutes */
  estHoldingMin: number;
}

/**
 * Decide whether a pending signal filled, is still waiting, or never will.
 *
 * Pure and synchronous. Only bars at or after `openedAt` are considered — a
 * signal cannot be filled by a price that printed before it was published,
 * and letting one is how a backtest reads the future.
 */
export function checkFill(i: FillInputs): FillCheck {
  const bars = i.bars.filter((b) => b.time >= i.openedAt);
  if (bars.length === 0) {
    return {
      state: "waiting",
      filledAt: null,
      barsWaited: 0,
      reason: "No bars since publication yet.",
    };
  }

  const isBuy = i.side === "BUY";
  const risk = Math.abs(i.entry - i.stopLoss);

  for (let n = 0; n < bars.length; n++) {
    const b = bars[n];
    // A resting buy fills on the low reaching the entry, not on the close.
    const touched = isBuy ? b.low <= i.entry : b.high >= i.entry;
    if (touched) {
      return {
        state: "filled",
        filledAt: b.time,
        barsWaited: n,
        reason:
          n === 0
            ? "Filled on the publication bar — price was already at the entry."
            : `Filled after ${n} bar${n === 1 ? "" : "s"} of waiting.`,
      };
    }

    /* Price left without us. Measured in units of the trade's own risk rather
       than a flat percentage, because a setup with a wide stop can tolerate
       far more drift before the entry is stale than one with a tight stop —
       and a single threshold would be wrong for both. */
    if (risk > 0) {
      const away = isBuy ? b.close - i.entry : i.entry - b.close;
      if (away >= RUNAWAY_R * risk) {
        return {
          state: "unfilled",
          filledAt: null,
          barsWaited: n,
          reason: `Price moved ${(away / risk).toFixed(1)}R past the entry without trading at it. The move happened without us — waiting longer only risks entering after it is over.`,
        };
      }
    }
  }

  // Still unfilled, but has it waited too long to be worth holding open?
  const barSec = bars.length > 1 ? Math.max(1, bars[1].time - bars[0].time) : 60;
  const waitedMin = (bars.length * barSec) / 60;
  if (waitedMin > i.estHoldingMin) {
    return {
      state: "unfilled",
      filledAt: null,
      barsWaited: bars.length,
      reason: `Never traded at the entry within ${Math.round(waitedMin)} minutes — longer than the setup's own expected holding time, so the read it was based on has expired whether or not price is still nearby.`,
    };
  }

  return {
    state: "waiting",
    filledAt: null,
    barsWaited: bars.length,
    reason: `Waiting for price to reach ${i.entry}. ${bars.length} bar${bars.length === 1 ? "" : "s"} so far.`,
  };
}
