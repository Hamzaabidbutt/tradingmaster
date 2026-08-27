import { analyzeLiquidationDelta } from "./liquidationDelta";
import { analyzeLiquidity } from "./liquidity";
import { analyzeMarketStructure } from "./marketStructure";
import { Candle, CascadeFuel, CascadeRiskSetup, CascadeTrigger } from "./types";

/**
 * Cascade risk — where a liquidation cascade *would* trigger, and how loaded
 * the conditions are for one.
 *
 * ## What this is, and what it is not
 *
 * This does **not** predict that a cascade will happen. Nothing in public
 * market data can: a cascade needs price to reach a level, and what price does
 * next is exactly the unknown. What can be established is conditional and
 * useful on its own terms —
 *
 *   * **where** forced flow would begin, from stop pools and leverage bands
 *   * **which side** is crowded, from open interest moving against price
 *   * **how far** price has to travel to get there, in ATR rather than raw %
 *   * **whether the fuel is still there**, or was spent in a recent flush
 *
 * "Longs are crowded and the nearest stop pool is 0.8 ATR below" is a fact
 * about present positioning. "Price will fall 3% tonight" is not, and this
 * engine never says it. The score measures how *loaded* the setup is, not how
 * likely it is to fire, and the wording throughout keeps that distinction —
 * because a scanner that quietly turns the first statement into the second is
 * the most expensive kind of wrong.
 *
 * ## On leverage bands
 *
 * Binance publishes no per-position liquidation prices, so the bands here are
 * arithmetic on an assumed entry: a long at `L`× is liquidated near
 * `entry × (1 − 1/L)`, before fees and maintenance margin. That assumes every
 * position was opened at the same price, which is false. They are included
 * because clusters of leveraged entries really do sit at round multiples of a
 * recent average, and excluded from the strongest grades because the
 * assumption is crude. `basis` says which levels came from where, and stop
 * pools — actual swing structure — always outrank them.
 */

/** Leverage tiers that matter in practice on USDT perps. */
const LEVERAGE_TIERS = [25, 50, 100] as const;
/** Triggers further than this from price are not in play. */
const MAX_DISTANCE_ATR = 3;
const QUALIFY_SCORE = 62;

/** Average true range over `period` bars. */
function atr(candles: Candle[], period = 14): number {
  const window = candles.slice(-(period + 1));
  if (window.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < window.length; i++) {
    const c = window[i];
    const prev = window[i - 1];
    sum += Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close)
    );
  }
  return sum / (window.length - 1);
}

function fmt(v: number): string {
  return v.toFixed(v >= 1000 ? 2 : v >= 1 ? 4 : 6).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Which cohort has been building, from open interest against price.
 *
 * Rising OI with rising price means new longs are being opened into strength —
 * they sit above their entries with stops below. Rising OI with falling price
 * is the mirror. *Falling* OI is the important negative case: positions are
 * closing, so whatever was crowded is being unwound and the fuel is draining
 * regardless of where price goes.
 */
function readFuel(
  openInterest: number[] | null,
  priceChangePct: number
): CascadeFuel {
  if (!openInterest || openInterest.length < 4) {
    return {
      openInterestChangePct: null,
      priceChangePct: Number(priceChangePct.toFixed(3)),
      crowded: "unknown",
      unwinding: false,
      note: "No open-interest history available, so how crowded either side is cannot be read here — the levels below are still where forced flow would begin, but there is no evidence about how much is resting on them.",
    };
  }

  const first = openInterest[0];
  const last = openInterest[openInterest.length - 1];
  const oiChangePct = first > 0 ? ((last - first) / first) * 100 : 0;
  const unwinding = oiChangePct < -2;

  let crowded: CascadeFuel["crowded"] = "balanced";
  if (oiChangePct > 2 && priceChangePct > 0.5) crowded = "long";
  else if (oiChangePct > 2 && priceChangePct < -0.5) crowded = "short";

  const note = unwinding
    ? `Open interest is down ${Math.abs(oiChangePct).toFixed(1)}% over the window — positions are being closed, so whatever was crowded here is unwinding and there is less left to force out.`
    : crowded === "long"
      ? `Open interest is up ${oiChangePct.toFixed(1)}% while price rose ${priceChangePct.toFixed(1)}% — new longs opening into strength, which is what puts a stack of stops below the market.`
      : crowded === "short"
        ? `Open interest is up ${oiChangePct.toFixed(1)}% while price fell ${Math.abs(priceChangePct).toFixed(1)}% — new shorts opening into weakness, which is what puts a stack of stops above the market.`
        : `Open interest changed ${oiChangePct >= 0 ? "+" : ""}${oiChangePct.toFixed(1)}% with price ${priceChangePct >= 0 ? "+" : ""}${priceChangePct.toFixed(1)}% — no clear one-sided build-up, so neither cohort is obviously the crowded one.`;

  return {
    openInterestChangePct: Number(oiChangePct.toFixed(3)),
    priceChangePct: Number(priceChangePct.toFixed(3)),
    crowded,
    unwinding,
    note,
  };
}

export function detectCascadeRisk(
  symbol: string,
  timeframe: string,
  candles: Candle[],
  openInterest?: number[] | null
): CascadeRiskSetup {
  const price = candles[candles.length - 1]?.close ?? 0;
  const empty: CascadeRiskSetup = {
    symbol,
    timeframe,
    price,
    side: "none",
    trigger: null,
    triggers: [],
    fuel: readFuel(null, 0),
    recentlyDischarged: false,
    score: 0,
    qualified: false,
    grade: "none",
    headline: "No cascade trigger within range",
    explanation: ["No stop pool or leverage band sits close enough to price to be in play."],
  };
  if (candles.length < 40 || price <= 0) {
    return { ...empty, headline: "Not enough history to map triggers" };
  }

  const range = atr(candles);
  if (range <= 0) return empty;

  const structure = analyzeMarketStructure(candles);
  const liquidity = analyzeLiquidity(candles, structure.swings);
  const liqDelta = analyzeLiquidationDelta(candles);

  // Window for the positioning read: the same span the OI series covers, or
  // 48 bars, whichever is shorter.
  const windowBars = Math.min(48, candles.length - 1);
  const windowStart = candles[candles.length - 1 - windowBars];
  const priceChangePct = ((price - windowStart.close) / Math.max(windowStart.close, 1e-9)) * 100;
  const fuel = readFuel(openInterest ?? null, priceChangePct);

  /* ---- Triggers ---- */
  const triggers: CascadeTrigger[] = [];

  // 1. Unswept stop pools. These are real structure: price made a high or a
  //    low there, and the orders resting beyond it have not been taken.
  for (const level of liquidity.levels.filter((l) => !l.swept)) {
    const above = level.price > price;
    const distancePct = ((level.price - price) / price) * 100;
    const distanceAtr = Math.abs(level.price - price) / range;
    if (distanceAtr > MAX_DISTANCE_ATR) continue;
    const equal = level.kind === "equal_highs" || level.kind === "equal_lows";
    triggers.push({
      price: level.price,
      distancePct: Number(distancePct.toFixed(3)),
      distanceAtr: Number(distanceAtr.toFixed(2)),
      // Stops above the market belong to shorts; taking them forces buying.
      side: above ? "short" : "long",
      basis: equal ? "equal_levels" : "stop_pool",
      note: `${equal ? "Equal " + (above ? "highs" : "lows") : above ? "Swing high" : "Swing low"} at ${fmt(level.price)}, unswept, ${Math.abs(distancePct).toFixed(2)}% away (${distanceAtr.toFixed(1)} ATR). Trading through it forces ${above ? "buying" : "selling"} from stops resting beyond.`,
    });
  }

  // 2. Leverage bands, measured off the window's average price as an entry
  //    proxy. Crude by construction — see the note at the top of this file.
  const entryProxy =
    candles.slice(-windowBars).reduce((s, c) => s + (c.high + c.low + c.close) / 3, 0) /
    Math.max(windowBars, 1);
  for (const tier of LEVERAGE_TIERS) {
    for (const side of ["long", "short"] as const) {
      const level = side === "long" ? entryProxy * (1 - 1 / tier) : entryProxy * (1 + 1 / tier);
      const distancePct = ((level - price) / price) * 100;
      const distanceAtr = Math.abs(level - price) / range;
      if (distanceAtr > MAX_DISTANCE_ATR) continue;
      // A long band above price, or a short band below it, is already past.
      if (side === "long" && level > price) continue;
      if (side === "short" && level < price) continue;
      triggers.push({
        price: Number(level.toFixed(8)),
        distancePct: Number(distancePct.toFixed(3)),
        distanceAtr: Number(distanceAtr.toFixed(2)),
        side,
        basis: "leverage_band",
        note: `Inferred ${tier}× ${side} liquidation band near ${fmt(level)}, ${Math.abs(distancePct).toFixed(2)}% away (${distanceAtr.toFixed(1)} ATR). Arithmetic on an average entry, not a book of real positions — treat as indicative.`,
      });
    }
  }

  if (triggers.length === 0) return { ...empty, fuel };
  triggers.sort((a, b) => Math.abs(a.distanceAtr) - Math.abs(b.distanceAtr));

  /* ---- Which side is at risk ---- */
  // Positioning decides it where positioning is known; otherwise the nearest
  // trigger does, which is a weaker read and scores lower for it.
  const side: CascadeRiskSetup["side"] =
    fuel.crowded === "long" || fuel.crowded === "short" ? fuel.crowded : triggers[0].side;

  const trigger = triggers.find((t) => t.side === side) ?? triggers[0];

  // A cascade that already fired has spent its fuel; the same levels are then
  // far less loaded than the arithmetic suggests.
  const recentFlush = liqDelta.series.slice(-8);
  const flushed = recentFlush.reduce((s, p) => s + p.longLiquidated + p.shortLiquidated, 0);
  const windowFlow = liqDelta.series.reduce(
    (s, p) => s + p.longLiquidated + p.shortLiquidated,
    0
  );
  const recentlyDischarged = windowFlow > 0 && flushed / windowFlow > 0.6;

  /* ---- Scoring: how loaded, not how likely ---- */
  let score = 0;
  // Proximity dominates: a loaded setup three ATR away is not a setup yet.
  score += Math.max(0, 34 * (1 - Math.min(1, trigger.distanceAtr / MAX_DISTANCE_ATR)));
  if (fuel.crowded === side) score += 24;
  if (trigger.basis === "equal_levels") score += 18;
  else if (trigger.basis === "stop_pool") score += 14;
  else score += 4;
  // Several triggers stacked on one side is a zone, not a line.
  const sameSide = triggers.filter((t) => t.side === side && t.distanceAtr <= MAX_DISTANCE_ATR);
  score += Math.min(12, (sameSide.length - 1) * 4);
  if (fuel.unwinding) score -= 18;
  if (recentlyDischarged) score -= 14;
  if (fuel.crowded === "unknown") score -= 8;
  score = Math.round(Math.max(0, Math.min(100, score)));

  const qualified =
    score >= QUALIFY_SCORE && !fuel.unwinding && !recentlyDischarged && trigger.distanceAtr <= 2;
  const grade: CascadeRiskSetup["grade"] = qualified
    ? score >= 80
      ? "prime"
      : "strong"
    : score >= 40
      ? "forming"
      : "none";

  const direction = side === "long" ? "long flush" : "short squeeze";
  const headline = qualified
    ? `${grade === "prime" ? "Prime" : "Strong"} ${direction} setup — ${Math.abs(trigger.distancePct).toFixed(2)}% to the trigger at ${fmt(trigger.price)}`
    : fuel.unwinding
      ? `Positioning is unwinding — ${direction} fuel draining`
      : recentlyDischarged
        ? `Already discharged — most of this window's forced flow has fired`
        : `${direction} conditions forming, score ${score} below the ${QUALIFY_SCORE} threshold`;

  const explanation: string[] = [
    headline,
    // The framing sentence. Deliberately first among the details.
    `This is a conditional read, not a forecast: it says where forced flow would begin and how crowded that side is, not that price will get there. Nothing here estimates the odds of the level being reached.`,
    trigger.note,
    fuel.note,
    `Nearest trigger is ${trigger.distanceAtr.toFixed(1)} ATR away. Distance is quoted in ATR because ${Math.abs(trigger.distancePct).toFixed(2)}% is an ordinary hour on one contract and a week on another.`,
  ];
  if (sameSide.length > 1) {
    explanation.push(
      `${sameSide.length} triggers stack on the ${side} side within ${MAX_DISTANCE_ATR} ATR — that is a band rather than a single level, and price entering it keeps finding more.`
    );
  }
  if (recentlyDischarged) {
    explanation.push(
      "Most of the forced flow in this window has already printed, so the positions these levels would have caught are largely gone. The same arithmetic on a spent market overstates the risk."
    );
  }
  if (trigger.basis === "leverage_band") {
    explanation.push(
      "The nearest trigger is an inferred leverage band rather than observed structure, which is the weakest of the three bases — it assumes a common entry price that does not really exist."
    );
  }

  return {
    symbol,
    timeframe,
    price,
    side,
    trigger,
    triggers: triggers.slice(0, 8),
    fuel,
    recentlyDischarged,
    score,
    qualified,
    grade,
    headline,
    explanation,
  };
}
