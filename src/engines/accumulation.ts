import { analyzeDelta } from "./deltaAnalysis";
import { detectDoublePatterns } from "./doublePatterns";
import { buildFootprint } from "./footprint";
import { analyzeMarketStructure } from "./marketStructure";
import { detectOrderFlowEvents } from "./orderFlowEvents";
import { analyzePremiumDiscount } from "./premiumDiscount";
import { detectSupportResistance } from "./supportResistance";
import { analyzeLiquidationDelta } from "./liquidationDelta";
import { AccumulationCriterion, AccumulationSetup, Candle } from "./types";
import { buildVolumeProfile } from "./volumeProfile";

/**
 * Accumulation / reversal detector.
 *
 * Looks for one specific, well-defined condition rather than scoring a coin in
 * general: a base forming at a level buyers keep defending, with order flow
 * confirming that the defence is real.
 *
 * The criteria are the ones a discretionary trader would check by hand:
 *
 *   1. a double/triple bottom, OR repeated rejection from the same support
 *   2. positive volume delta — buyers are actually the aggressors
 *   3. stacked buy imbalance in the footprint — sellers given no opportunity
 *   4. absorption at the level — heavy selling that failed to move price
 *   5. an accumulation-shaped profile (b-shape at the lows, or a range with
 *      cumulative delta rising while price goes nowhere)
 *   6. a liquidation delta spike into the base — forced selling exhausting
 *   7. price at a discount rather than already extended
 *
 * Criteria 1 and 2 are mandatory. Without a level being defended and buyers
 * paying up for it, everything else is a coin that merely stopped falling —
 * which is not the same thing as accumulation, and is the mistake this
 * detector exists to avoid making.
 */

/** Criteria that must be present for any qualification at all. */
const REQUIRED = ["base", "positive_delta"] as const;
const QUALIFY_SCORE = 66;

export function detectAccumulation(
  symbol: string,
  timeframe: string,
  candles: Candle[]
): AccumulationSetup {
  const price = candles[candles.length - 1]?.close ?? 0;

  const structure = analyzeMarketStructure(candles);
  const srLevels = detectSupportResistance(candles, timeframe);
  const doubles = detectDoublePatterns(candles, structure.swings);
  const delta = analyzeDelta(candles);
  const profile = buildVolumeProfile(candles.slice(-Math.min(240, candles.length)), { bins: 50 });
  const footprint = buildFootprint(candles, null, { count: 12 });
  const events = detectOrderFlowEvents(candles, footprint, profile, srLevels);
  const pd = analyzePremiumDiscount(candles, structure.swings);
  const liqDelta = analyzeLiquidationDelta(candles);

  const criteria: AccumulationCriterion[] = [];

  /* ---- 1. The base: double bottom or a repeatedly defended support ---- */
  const bottom = doubles.find((d) => d.type === "double_bottom" || d.type === "triple_bottom");
  const supports = srLevels
    .filter((l) => l.kind === "support" && l.price <= price)
    .sort((a, b) => b.price - a.price);
  // "Defended" means the level was tested repeatedly and held most of the time.
  const defended = supports.find(
    (l) => l.touches >= 3 && l.rejections >= 2 && Math.abs(price - l.price) / price < 0.05
  );

  const baseLevel = bottom
    ? Math.min(...bottom.points.map((p) => p.price))
    : defended
      ? defended.price
      : null;

  criteria.push({
    key: "base",
    label: bottom ? `${bottom.type.replace("_", " ")}` : "Defended support",
    met: Boolean(bottom || defended),
    weight: 26,
    score: bottom ? 26 : defended ? Math.min(26, 12 + defended.rejections * 4) : 0,
    detail: bottom
      ? `${bottom.type.replace("_", " ")} with the neckline at ${bottom.neckline.toFixed(6).replace(/0+$/, "")} — a confirmed break projects ${bottom.measuredTarget.toFixed(6).replace(/0+$/, "")}.`
      : defended
        ? `Support at ${defended.price.toFixed(6).replace(/0+$/, "")} has been tested ${defended.touches} times and rejected ${defended.rejections} of them (strength ${defended.strength}).`
        : "No double bottom and no support with a repeated-rejection history — there is no level being defended here.",
  });

  /* ---- 2. Positive volume delta ---- */
  const recentDelta = delta.series.slice(-10);
  const netDelta = recentDelta.reduce((s, d) => s + d.delta, 0);
  const cvdRising = delta.cvdTrend === "bullish";
  criteria.push({
    key: "positive_delta",
    label: "Positive volume delta",
    met: netDelta > 0,
    weight: 20,
    score: netDelta > 0 ? (cvdRising ? 20 : 13) : 0,
    detail:
      netDelta > 0
        ? `Net delta over the last 10 bars is +${netDelta.toFixed(0)}${cvdRising ? " and cumulative delta is rising — buyers are being rewarded, not just present." : ", though cumulative delta is not yet trending up."}`
        : `Net delta over the last 10 bars is ${netDelta.toFixed(0)} — sellers are still the aggressors, so any base here is unconfirmed.`,
  });

  /* ---- 3. Stacked buy imbalance ---- */
  const stacks = footprint.candles
    .slice(-6)
    .flatMap((c) => c.stackedImbalances.filter((s) => s.direction === "buy"));
  criteria.push({
    key: "stacked_buy_imbalance",
    label: "Stacked buy imbalance",
    met: stacks.length > 0,
    weight: 16,
    // Modelled footprints earn less than reconstructed ones.
    score: stacks.length > 0 ? (footprint.fidelity === "sub_candle" ? 16 : 9) : 0,
    detail:
      stacks.length > 0
        ? `${stacks.length} stacked buy imbalance${stacks.length > 1 ? "s" : ""} in the last 6 bars (deepest ${Math.max(...stacks.map((s) => s.count))} levels) — sellers were given no opportunity to fill.${footprint.fidelity === "estimated" ? " Footprint is modelled here, so treat the level detail as indicative." : ""}`
        : "No stacked buy imbalance in the recent bars — buying is present but not one-sided.",
  });

  /* ---- 4. Absorption at the level ---- */
  const absorption = events.absorptions.filter((a) => a.side === "buy").slice(-1)[0];
  criteria.push({
    key: "absorption",
    label: "Buy absorption",
    met: Boolean(absorption),
    weight: 16,
    score: absorption ? (absorption.atKeyLevel ? 16 : 7) : 0,
    detail: absorption
      ? absorption.explanation
      : "No buy-side absorption detected — nothing is soaking up the selling yet.",
  });

  /* ---- 5. Accumulation signature in the profile ---- */
  // A b-shaped profile at the lows is long liquidation, not fresh selling;
  // a flat range with rising CVD is textbook quiet accumulation.
  const bShapeAtLows = profile.shape === "b" && price <= profile.poc;
  const quietAccumulation = structure.isRange && delta.cvd > 0 && cvdRising;
  criteria.push({
    key: "accumulation_profile",
    label: "Accumulation signature",
    met: bShapeAtLows || quietAccumulation,
    weight: 12,
    score: bShapeAtLows && quietAccumulation ? 12 : bShapeAtLows || quietAccumulation ? 8 : 0,
    detail: bShapeAtLows
      ? "b-shaped volume profile printed at the lows — the selling is forced liquidation rather than fresh supply, which is what exhausts and reverses."
      : quietAccumulation
        ? "Price is ranging while cumulative delta climbs — inventory is being taken quietly without moving the price, the classic accumulation footprint."
        : "Profile shows no accumulation signature; volume is not concentrating at the lows.",
  });

  /* ---- 6. Liquidation delta spike into the base ---- */
  // A burst of forced long liquidation near the low is the seller side being
  // *made* to sell rather than choosing to. That supply is finite and, once
  // cleared, removes the pressure that was holding price down — which is why
  // capitulation spikes so often mark the end of a decline rather than the
  // middle of one.
  const liqWindow = liqDelta.series.slice(-15);
  const longFlush = liqWindow.filter((p) => p.longLiquidated > 0);
  const flushTotal = longFlush.reduce((s, p) => s + p.longLiquidated, 0);
  const peakFlush = longFlush.length > 0 ? Math.max(...longFlush.map((p) => p.longLiquidated)) : 0;
  // Near the low of the analysed window = the flush happened at the base,
  // not somewhere on the way down.
  const windowLow = Math.min(...candles.slice(-liqWindow.length || -15).map((c) => c.low));
  const flushBar = longFlush.length > 0
    ? candles.find((c) => c.time === longFlush.reduce((a, b) => (a.longLiquidated >= b.longLiquidated ? a : b)).time)
    : undefined;
  const flushAtBase = flushBar ? (flushBar.low - windowLow) / Math.max(windowLow, 1e-9) < 0.02 : false;
  // Reclaimed = price closed back above the flush bar's midpoint since.
  const reclaimed = flushBar
    ? price > (flushBar.high + flushBar.low) / 2
    : false;

  const spikeMet = flushTotal > 0 && peakFlush > 0 && flushAtBase;
  criteria.push({
    key: "liquidation_spike",
    label: "Liquidation delta spike",
    met: spikeMet,
    weight: 14,
    score: spikeMet ? (reclaimed ? 14 : 8) : 0,
    detail: spikeMet
      ? `Forced long liquidation spiked into the base${flushBar ? ` at ${flushBar.low.toFixed(6).replace(/0+$/, "")}` : ""} — the selling there was mechanical, not discretionary.${reclaimed ? " Price has since reclaimed the flush, so that supply is spent." : " Price has not yet reclaimed the flush, so the cascade may not be finished."}`
      : longFlush.length > 0
        ? "Forced liquidation is present but not concentrated at the low — the flush happened on the way down rather than at the base, which does not mark exhaustion."
        : "No liquidation delta spike detected; any selling here is discretionary, so there is no forced supply about to run out.",
  });

  /* ---- 7. Discount location ---- */
  const atDiscount = pd.currentZone === "discount";
  criteria.push({
    key: "discount",
    label: "Discount pricing",
    met: atDiscount,
    weight: 10,
    score: atDiscount ? 10 : pd.currentZone === "equilibrium" ? 5 : 0,
    detail: atDiscount
      ? `Price sits in the discount half of the dealing range (${(pd.positionInRange * 100).toFixed(0)}% of range) — buying here has favourable geometry.`
      : `Price is at ${(pd.positionInRange * 100).toFixed(0)}% of the dealing range (${pd.currentZone}); the easy part of any bounce may already be gone.`,
  });

  /* ---- Scoring ---- */
  const score = Math.round(criteria.reduce((s, c) => s + c.score, 0));
  const missingRequired = REQUIRED.filter((k) => !criteria.find((c) => c.key === k)?.met);
  const qualified = missingRequired.length === 0 && score >= QUALIFY_SCORE;

  const grade: AccumulationSetup["grade"] =
    !qualified && missingRequired.length > 0
      ? "none"
      : score >= 82
        ? "prime"
        : score >= QUALIFY_SCORE
          ? "strong"
          : score >= 45
            ? "forming"
            : "none";

  /* ---- Levels ---- */
  const support = baseLevel ?? (supports[0]?.price ?? null);
  const invalidation = support != null ? support * 0.99 : null;
  const target = bottom
    ? bottom.measuredTarget
    : support != null
      ? // Without a measured pattern the honest target is the nearest
        // resistance, not an arbitrary multiple of risk.
        (srLevels.find((l) => l.kind === "resistance" && l.price > price)?.price ??
          profile.vah)
      : null;

  const met = criteria.filter((c) => c.met);
  const headline = qualified
    ? `${grade === "prime" ? "Prime" : "Strong"} accumulation setup — ${met.length}/${criteria.length} criteria met`
    : missingRequired.length > 0
      ? `Not an accumulation setup — missing ${missingRequired.map((k) => (k === "base" ? "a defended level" : "buyer aggression")).join(" and ")}`
      : `Forming — ${met.length}/${criteria.length} criteria met, score ${score} is below the ${QUALIFY_SCORE} threshold`;

  const explanation: string[] = [headline];
  for (const c of criteria) {
    if (c.met) explanation.push(`✓ ${c.label}: ${c.detail}`);
  }
  for (const c of criteria) {
    if (!c.met) explanation.push(`✗ ${c.label}: ${c.detail}`);
  }
  if (qualified && support != null && target != null) {
    const rr = Math.abs(price - (invalidation ?? support)) > 0
      ? (target - price) / Math.abs(price - (invalidation ?? support))
      : 0;
    explanation.push(
      `Entry around ${price.toFixed(6).replace(/0+$/, "")} with invalidation below ${(invalidation ?? support).toFixed(6).replace(/0+$/, "")} and the first objective at ${target.toFixed(6).replace(/0+$/, "")} — roughly ${rr.toFixed(1)}R.`
    );
  }

  return {
    symbol,
    timeframe,
    price,
    criteria,
    score,
    qualified,
    grade,
    support,
    target,
    invalidation,
    headline,
    explanation,
  };
}
