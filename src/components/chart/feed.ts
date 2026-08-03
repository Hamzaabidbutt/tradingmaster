import { Candle } from "@/engines/types";

/**
 * Incremental chart-feed reconciliation.
 *
 * lightweight-charts rejects `update()` with a timestamp older than the
 * series head ("Cannot update oldest data"). Two independent sources feed
 * the same series — the websocket (fast, opens new bars first) and the REST
 * poll (slow, and served from a short cache) — so a poll's tail is
 * routinely OLDER than the bar the socket has already opened.
 *
 * This helper decides which bars may legally be pushed, and what the new
 * head becomes. The head only ever moves forward, which is the invariant
 * that keeps the two sources from fighting each other.
 */
export function selectBarsToAppend(
  candles: Candle[],
  seriesHead: number
): { bars: Candle[]; nextHead: number } {
  if (candles.length === 0) return { bars: [], nextHead: seriesHead };

  // A head of 0 means the series is empty — caller must do a full setData.
  const bars = seriesHead === 0 ? candles : candles.filter((c) => c.time >= seriesHead);
  const nextHead = bars.length > 0 ? Math.max(seriesHead, bars[bars.length - 1].time) : seriesHead;

  return { bars, nextHead };
}

/**
 * Whether a live websocket frame may be applied to the series.
 * Frames older than the head are stale (a reconnect replaying an earlier
 * bar, or a late frame from the previously selected symbol).
 */
export function canApplyLiveFrame(frameTime: number, seriesHead: number): boolean {
  // The series must already hold data before any incremental update.
  if (seriesHead === 0) return false;
  return frameTime >= seriesHead;
}
