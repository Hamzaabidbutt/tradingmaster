import { Candle, LiquidationDeltaPoint } from "./types";

/**
 * Bars that stand out on volume, delta and forced flow at once.
 *
 * These are the bars worth stopping on: heavy trade, one-sided aggression and
 * — in the strongest case — margin engines closing positions into it. Marking
 * them on the chart means you find them by looking rather than by scrolling a
 * panel and matching timestamps back to bars.
 *
 * ## How a bar qualifies
 *
 * Requiring all three conditions at once produces a highlight so rare the
 * feature looks broken; requiring any one produces a chart of yellow candles,
 * which is the same as no highlight at all. So there are two routes in, and
 * both are about volume:
 *
 *   * **Volume alone**, at `VOLUME_ALONE_X` or more. Three times the local
 *     average is a large enough event to be worth seeing on its own terms.
 *     Delta can be balanced and no margin engine need be involved — heavy
 *     two-way trade at one price is exactly what absorption looks like, and
 *     the previous rule hid it, because balanced delta failed the one-sided
 *     test and a 5x volume bar went unmarked.
 *   * **Volume plus corroboration**, from `VOLUME_X` up. Between two and three
 *     times, volume alone is common enough to be noise, so it needs either
 *     one-sided delta or forced flow behind it.
 *
 * The tier is a separate question from qualifying:
 *
 *   `strong`  qualified, but not both of one-sided delta and forced flow
 *   `extreme` outsized volume with **both**
 *
 * The thresholds are relative to the surrounding bars, not absolute, so the
 * same rule works on BTC and on a small cap.
 */

/** Volume multiple below which nothing qualifies, even with corroboration. */
const VOLUME_X = 2;
/** Volume multiple at which the bar is worth marking on its own. */
const VOLUME_ALONE_X = 3;
/** Share of a bar's volume that must be net one-way for delta to count. */
const DELTA_SHARE = 0.35;
/** Bars either side used to judge what "average" means here. */
const CONTEXT = 30;

export type CandleStrength = "strong" | "extreme";

export interface StrongCandle {
  time: number;
  strength: CandleStrength;
  volumeMultiple: number;
  /** signed net delta as a share of the bar's volume, -1..1 */
  deltaShare: number;
  /** forced flow on the bar, when the window covers it */
  forced: number;
  reasons: string[];
}

/**
 * Classify every bar in `candles`, using `liquidation` where it reaches.
 *
 * The liquidation series covers only the analysed window, so bars outside it
 * are judged on volume and delta alone rather than being disqualified — an
 * older bar is not weaker for being older.
 */
export function findStrongCandles(
  candles: Candle[],
  liquidation: LiquidationDeltaPoint[] = []
): Map<number, StrongCandle> {
  const out = new Map<number, StrongCandle>();
  if (candles.length < 5) return out;

  const forcedByTime = new Map(
    liquidation.map((p) => [p.time, p.longLiquidated + p.shortLiquidated])
  );

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (c.volume <= 0) continue;

    // Local average, excluding the bar itself so a huge bar cannot raise the
    // bar it is being compared against.
    const from = Math.max(0, i - CONTEXT);
    const context = candles.slice(from, i);
    if (context.length < 5) continue;
    const avg = context.reduce((s, x) => s + x.volume, 0) / context.length;
    if (avg <= 0) continue;

    const volumeMultiple = c.volume / avg;
    if (volumeMultiple < VOLUME_X) continue;

    const buy = c.takerBuyVolume ?? c.volume / 2;
    const delta = buy - (c.volume - buy);
    const deltaShare = delta / c.volume;
    const forced = forcedByTime.get(c.time) ?? 0;

    const oneSided = Math.abs(deltaShare) >= DELTA_SHARE;
    const hasForced = forced > 0;
    // Three times the local average stands on its own; below that the bar has
    // to bring something else with it.
    const volumeAlone = volumeMultiple >= VOLUME_ALONE_X;
    if (!volumeAlone && !oneSided && !hasForced) continue;

    const reasons = [`${volumeMultiple.toFixed(1)}× average volume`];
    if (volumeAlone && !oneSided && !hasForced) {
      reasons.push("heavy two-way trade — balanced delta at this size is what absorption looks like");
    }
    if (oneSided) {
      reasons.push(
        `${(Math.abs(deltaShare) * 100).toFixed(0)}% net ${deltaShare > 0 ? "buying" : "selling"}`
      );
    }
    if (hasForced) reasons.push("forced flow on the bar");

    out.set(c.time, {
      time: c.time,
      strength: oneSided && hasForced ? "extreme" : "strong",
      volumeMultiple: Number(volumeMultiple.toFixed(2)),
      deltaShare: Number(deltaShare.toFixed(3)),
      forced: Number(forced.toFixed(2)),
      reasons,
    });
  }
  return out;
}
