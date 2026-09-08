import { Candle, MarketStructureResult, VolumeProfileResult } from "./types";
import type { ConflictReport } from "./conflicts";
import type { PositioningRead, ValueMigration } from "./positioning";

/**
 * One named state, and the two ways out of it.
 *
 * This is the synthesis the page was missing. Every other panel reports a
 * measurement; the composite reduces twenty-eight of them to a percentage. A
 * percentage cannot be acted on and cannot be wrong in any useful way — 69%
 * bullish makes no claim you can check tomorrow.
 *
 * So this does not forecast. It names which of a small, closed set of states
 * the market is in, what put it there, the two ways it resolves, the specific
 * thing to watch for, and the price at which the read was simply wrong. That
 * is the whole of what can honestly be said, and it is far more useful than a
 * number: every field is checkable against what price actually does.
 *
 * ## Gates, not a sum
 *
 * The classification is a chain of conditional questions, not a weighted vote.
 * Location decides first — where price sits relative to accepted value — then
 * whether the auction has confirmed the move, then what the swing structure
 * says. This ordering is the point. Averaging "price is above value" against
 * "structure is bearish" produces a number that describes neither; asking them
 * in order produces "broke out and has not been accepted", which is a state
 * with a name and an invalidation.
 *
 * ## What "exhausting" means here
 *
 * A trending or breakout state carrying a high-severity conflict against it is
 * reported as exhausting. That is not a call that it reverses — the conflicts
 * engine is explicit that divergences persist and some end by simply ceasing
 * to diverge. It means the state is intact but the evidence behind it has
 * started disagreeing with itself, which is a reason to want more before
 * adding, not a reason to take the other side.
 */

export type MarketStateId =
  | "breakout_accepted"
  | "breakout_unconfirmed"
  | "pullback_in_trend"
  | "trending_exhausting"
  | "range_at_edge"
  | "range_rotating"
  | "reversal_confirmed"
  | "unclear";

export interface StatePath {
  /** what would have to happen */
  condition: string;
  /** what it would mean */
  meaning: string;
}

export interface MarketStateRead {
  id: MarketStateId;
  label: string;
  /** when the market entered this state, unix seconds — null when unknowable */
  since: number | null;
  /** the ordered facts that put it here */
  gotHere: string[];
  up: StatePath;
  down: StatePath;
  /** the single observable most worth watching next */
  watch: string;
  /** price at which this reading was simply wrong, with the reason */
  invalidation: { price: number; why: string } | null;
  /** high-severity conflicts arguing against the state, if any */
  tension: string | null;
  note: string;
}

export interface MarketStateInputs {
  candles: Candle[];
  structure: MarketStructureResult;
  volumeProfile: VolumeProfileResult;
  migration: ValueMigration | null;
  positioning: PositioningRead;
  conflicts: ConflictReport;
}

/** Within this share of the value-area width, price counts as at the edge. */
const EDGE_SHARE = 0.15;
/** A structure event older than this many bars is history, not the current state. */
const RECENT_EVENT_BARS = 10;

const UNCLEAR: MarketStateRead = {
  id: "unclear",
  label: "No clean state",
  since: null,
  gotHere: ["The inputs do not resolve to one of the named states."],
  up: { condition: "—", meaning: "—" },
  down: { condition: "—", meaning: "—" },
  watch: "Wait for price to establish a relationship with value — accepted inside it, or rejected away from it.",
  invalidation: null,
  tension: null,
  note: "An unclear state is a real answer. Most of the time a market is between conditions, and forcing a name onto it is how a read becomes a position with nothing behind it.",
};

/**
 * Classify the current state.
 *
 * Pure and synchronous. Returns the `unclear` state rather than guessing when
 * the inputs do not resolve — which is a normal outcome, not a failure.
 */
export function readMarketState(i: MarketStateInputs): MarketStateRead {
  if (i.candles.length < 5) return UNCLEAR;

  const last = i.candles[i.candles.length - 1];
  const price = last.close;
  const vp = i.volumeProfile;
  const vaWidth = Math.max(vp.vah - vp.val, 1e-9);
  const barSec =
    i.candles.length > 1 ? Math.max(1, i.candles[1].time - i.candles[0].time) : 60;

  /* High-severity conflicts pointing against whatever the price is doing.
     Collected once and applied at the end, so every state is classified on
     what it is before it is qualified by what disagrees with it. */
  const against = i.conflicts.conflicts.filter(
    (c) => c.severity === "high" && ((price >= vp.poc && c.argues === "down") || (price < vp.poc && c.argues === "up"))
  );
  const tension = against.length > 0 ? against.map((c) => c.title).join("; ") : null;

  const recentEvent = i.structure.events
    .filter((e) => last.time - e.time <= RECENT_EVENT_BARS * barSec)
    .slice(-1)[0];

  const withTension = (s: MarketStateRead): MarketStateRead => {
    if (!tension) return s;
    const trendingish =
      s.id === "breakout_accepted" || s.id === "pullback_in_trend" || s.id === "reversal_confirmed";
    if (!trendingish) return { ...s, tension };
    return {
      ...s,
      id: "trending_exhausting",
      label: `${s.label} — but exhausting`,
      tension,
      gotHere: [...s.gotHere, `Against it: ${tension}.`],
      watch: `${s.watch} The divergence is the thing to resolve first — it does not have to break the state, but it does have to stop getting worse.`,
      note: "The state is intact and the evidence behind it has started disagreeing with itself. That is a reason to demand more before adding to a position, not a reason to take the other side: divergences persist, and some end by simply ceasing to diverge.",
    };
  };

  /* ---- 1. A confirmed change of character comes first. -------------------
     It is the one event that says the previous state has already ended, so
     nothing below it is worth asking yet. */
  if (recentEvent?.type === "CHOCH" && recentEvent.scope === "external") {
    const up = recentEvent.direction === "bullish";
    return withTension({
      id: "reversal_confirmed",
      label: `Change of character — ${up ? "bullish" : "bearish"}`,
      since: recentEvent.time,
      gotHere: [
        `External CHOCH ${up ? "up" : "down"} through ${recentEvent.price.toFixed(4)}, breaking the swing that held the previous sequence.`,
        `Structure now reads ${i.structure.trend}.`,
        i.positioning.quadrant
          ? `${i.positioning.label} over the last ${i.positioning.barsCovered} bars.`
          : "No positioning read to confirm who is behind it.",
      ],
      up: {
        condition: up
          ? `Price holds above ${recentEvent.price.toFixed(4)} and builds a higher low from here.`
          : `Price reclaims ${recentEvent.price.toFixed(4)} and the break fails.`,
        meaning: up
          ? "The change of character becomes a trend rather than a single break."
          : "The break was a liquidity grab and the previous structure is still in force.",
      },
      down: {
        condition: up
          ? `Price loses ${recentEvent.price.toFixed(4)} again.`
          : `Price continues below ${recentEvent.price.toFixed(4)} and takes out the next low.`,
        meaning: up
          ? "A failed change of character, which usually means the break was the liquidity event rather than the start of something."
          : "The reversal is extending into a trend.",
      },
      watch: "The first pullback after the break. Whether it holds above the broken level is what separates a change of character from a stop hunt.",
      invalidation: {
        price: recentEvent.price,
        why: "The level the break came from. Trading back through it means the break did not hold, whatever the structure label now says.",
      },
      tension: null,
      note: "A change of character is the earliest reversal evidence, which also makes it the least confirmed. It is a reason to stop trading the old direction before it is a reason to trade the new one.",
    });
  }

  /* ---- 2. Location: is price outside the band the market accepted? ------ */
  if (vp.acceptance === "above_value" || vp.acceptance === "below_value") {
    const above = vp.acceptance === "above_value";
    const edge = above ? vp.vah : vp.val;
    const migAgrees =
      i.migration != null &&
      ((above && i.migration.direction === "higher") || (!above && i.migration.direction === "lower"));

    if (migAgrees) {
      return withTension({
        id: "breakout_accepted",
        label: `Accepted ${above ? "above" : "below"} value`,
        since: null,
        gotHere: [
          `Price ${price.toFixed(4)} is trading ${above ? "above" : "below"} the value area (${vp.val.toFixed(4)}–${vp.vah.toFixed(4)}).`,
          `Value itself has migrated ${above ? "higher" : "lower"} — the market is finding business at the new prices, not merely visiting them.`,
          i.positioning.participation === "opening"
            ? `${i.positioning.label}: new money is committing to the move.`
            : i.positioning.participation === "closing"
              ? `${i.positioning.label}: the move is being made by positions closing, which is finite.`
              : "No positioning read available.",
        ],
        up: {
          condition: above
            ? "Value keeps migrating higher and pullbacks hold above the old value area high."
            : `Price reclaims ${vp.val.toFixed(4)} and trades back inside value.`,
          meaning: above
            ? "The trend continues — this is the condition trend-following is built for."
            : "The breakdown is being rejected and the market returns to rotation.",
        },
        down: {
          condition: above
            ? `Price loses ${edge.toFixed(4)} and trades back inside value.`
            : "Value keeps migrating lower and rallies fail below the old value area low.",
          meaning: above
            ? "Acceptance failed. Returning inside value after being accepted outside it usually means the move up was the excess, and the whole value area comes back into play."
            : "The downtrend continues.",
        },
        watch: `Pullbacks to ${edge.toFixed(4)}. Whether the old edge of value now holds as support is the single cleanest test of whether the breakout was real.`,
        invalidation: {
          price: edge,
          why: `The edge of the value area price broke out from. Back inside it and the market never accepted the new prices — which is the definition of this state being wrong.`,
        },
        tension: null,
        note: "Acceptance is the strongest of the trend states because value has confirmed it. It is also the latest — by the time value has migrated, most of the move is behind price.",
      });
    }

    return withTension({
      id: "breakout_unconfirmed",
      label: `Broken ${above ? "above" : "below"} value — not accepted`,
      since: null,
      gotHere: [
        `Price ${price.toFixed(4)} is ${above ? "above" : "below"} the value area (${vp.val.toFixed(4)}–${vp.vah.toFixed(4)}).`,
        i.migration
          ? `But value has not followed: it is ${i.migration.direction === "overlapping" ? "still overlapping the previous area" : `reading "${i.migration.direction}"`}.`
          : "Value migration could not be measured, so acceptance is unconfirmed.",
        `Auction state: ${vp.auctionState}.`,
      ],
      up: {
        condition: above
          ? "Volume builds at the new prices and value starts migrating up to meet them."
          : `Price reclaims ${vp.val.toFixed(4)} quickly.`,
        meaning: above
          ? "The break becomes acceptance and this state graduates to a trend."
          : "A failed breakdown — often the cleanest long in a range, because the trapped shorts have to buy back.",
      },
      down: {
        condition: above
          ? `Price returns inside value below ${vp.vah.toFixed(4)} without volume building outside.`
          : "Volume builds at the lower prices and value migrates down.",
        meaning: above
          ? "A failed breakout. The excursion was excess rather than a move, and price typically rotates back across the value area toward the point of control."
          : "The breakdown is being accepted and becomes a downtrend.",
      },
      watch: `Whether volume builds out here. Time spent beyond ${edge.toFixed(4)} matters more than distance — a sharp spike that comes straight back is rejection, and slow trade at the new prices is acceptance.`,
      invalidation: {
        price: edge,
        why: "Back inside value and the excursion was excess, not a move. This is the most common way a breakout entry fails.",
      },
      tension: null,
      note: "This is the highest-variance state on the list: it resolves into either the strongest continuation or the cleanest failure, and it is genuinely not knowable which from here. Position size belongs to the uncertainty, not to the direction.",
    });
  }

  /* ---- 3. Inside value. Is the auction rotating, or is value trending? -- */
  const nearHigh = Math.abs(price - vp.vah) <= vaWidth * EDGE_SHARE;
  const nearLow = Math.abs(price - vp.val) <= vaWidth * EDGE_SHARE;
  const mig = i.migration?.direction ?? null;

  if (mig === "higher" || mig === "lower") {
    const up = mig === "higher";
    const trendAgrees = (up && i.structure.trend === "bullish") || (!up && i.structure.trend === "bearish");
    return withTension({
      id: trendAgrees ? "pullback_in_trend" : "trending_exhausting",
      label: trendAgrees ? `Pullback inside value — trend ${up ? "up" : "down"}` : "Trend and structure disagree",
      since: null,
      gotHere: [
        `Value has migrated ${mig}, so the auction is trending ${up ? "up" : "down"}.`,
        `But price ${price.toFixed(4)} is back inside the value area (${vp.val.toFixed(4)}–${vp.vah.toFixed(4)}).`,
        `Swing structure reads ${i.structure.trend}${trendAgrees ? ", which agrees" : ", which does not"}.`,
      ],
      up: {
        condition: up
          ? `Price holds above the point of control ${vp.poc.toFixed(4)} and pushes back through ${vp.vah.toFixed(4)}.`
          : `Price accepts back above ${vp.vah.toFixed(4)}.`,
        meaning: up
          ? "The pullback is over and the trend resumes — this is the entry the state exists to set up."
          : "The downtrend in value is being reversed.",
      },
      down: {
        condition: up
          ? `Price loses ${vp.val.toFixed(4)}.`
          : `Price stays below the point of control ${vp.poc.toFixed(4)} and breaks ${vp.val.toFixed(4)}.`,
        meaning: up
          ? "A pullback that goes through the whole value area is not a pullback — it is the trend ending."
          : "The downtrend continues.",
      },
      watch: `The point of control at ${vp.poc.toFixed(4)}. In a trending auction a pullback that holds the POC is a pullback; one that trades through it is a change of control.`,
      invalidation: {
        price: up ? vp.val : vp.vah,
        why: "The far edge of value. Retracing the entire value area against the direction value has been migrating is not a pullback in the trend.",
      },
      tension: null,
      note: trendAgrees
        ? "The most tradable of the states: a trend that has already proven itself in value, with price temporarily back at a reasonable price. The risk is that pullback and reversal look identical until one of them is over."
        : "Value and the swing sequence point different ways. One of them is early and the other is late, and which is which is not knowable from here — it is a reason to stand aside rather than to pick.",
    });
  }

  if (nearHigh || nearLow) {
    const atHigh = nearHigh && !nearLow;
    return withTension({
      id: "range_at_edge",
      label: `At the ${atHigh ? "high" : "low"} edge of value`,
      since: null,
      gotHere: [
        `Price ${price.toFixed(4)} is within ${(EDGE_SHARE * 100).toFixed(0)}% of the value area's width of its ${atHigh ? "high" : "low"} edge (${(atHigh ? vp.vah : vp.val).toFixed(4)}).`,
        i.migration ? `Value is ${i.migration.direction}, so this is rotation rather than trend.` : "Value migration unmeasured.",
        `Auction state: ${vp.auctionState}.`,
      ],
      up: {
        condition: atHigh
          ? `Acceptance above ${vp.vah.toFixed(4)} — volume building outside, not a wick through it.`
          : `Rejection from ${vp.val.toFixed(4)} back toward the point of control.`,
        meaning: atHigh ? "The range is breaking and this becomes a breakout state." : "The range is holding and price rotates back across it.",
      },
      down: {
        condition: atHigh
          ? `Rejection from ${vp.vah.toFixed(4)} back toward the point of control.`
          : `Acceptance below ${vp.val.toFixed(4)}.`,
        meaning: atHigh ? "The range is holding — the rotation back to the POC is the trade the edge sets up." : "The range is breaking down.",
      },
      watch: "Whether the edge is absorbed or broken. Aggression into the edge that fails to move price is absorption and argues for the rotation; aggression that carries through it on building volume argues for the break.",
      invalidation: {
        price: atHigh ? vp.vah : vp.val,
        why: "Acceptance beyond the edge — not a touch of it — means this is no longer a range trade.",
      },
      tension: null,
      note: "Edges are where range trades and breakout trades sit on top of each other, taking opposite sides at the same price. Which one is right is decided by what happens after the touch, not by the touch.",
    });
  }

  return withTension({
    id: "range_rotating",
    label: "Rotating inside value",
    since: null,
    gotHere: [
      `Price ${price.toFixed(4)} is inside the value area (${vp.val.toFixed(4)}–${vp.vah.toFixed(4)}) and not near either edge.`,
      i.migration
        ? `Value is ${i.migration.direction}${i.migration.direction === "overlapping" ? ` — ${(i.migration.overlap * 100).toFixed(0)}% of it sits inside the previous area` : ""}.`
        : "Value migration unmeasured.",
      `Auction state: ${vp.auctionState}.`,
    ],
    up: {
      condition: `Price works to ${vp.vah.toFixed(4)} and finds acceptance beyond it.`,
      meaning: "The rotation ends and a breakout state begins.",
    },
    down: {
      condition: `Price works to ${vp.val.toFixed(4)} and finds acceptance beyond it.`,
      meaning: "The rotation ends to the downside.",
    },
    watch: `The edges at ${vp.val.toFixed(4)} and ${vp.vah.toFixed(4)}. Mid-range there is nothing to do: the reward is small in both directions and the stop has to sit outside a level price is nowhere near.`,
    invalidation: null,
    tension: null,
    note: "The state with the least to offer, and the one most trades are taken in. Mid-range is where location is worst — flow can look excellent and the geometry still be unusable.",
  });
}
