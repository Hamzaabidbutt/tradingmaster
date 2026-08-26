"use client";

import { OrderWallResult } from "@/engines/types";

/**
 * One-line readout for the wall overlays.
 *
 * The chart lines say *where* the size is; this says how big and how far,
 * which is the part that decides whether a wall is worth trading against. It
 * only renders when a wall overlay is on, so the chart header stays clean for
 * everyone else.
 *
 * The "resting size can be pulled" caveat is printed, not buried in a tooltip:
 * visible book size is the one market-data input that is routinely placed in
 * order to be seen, and an overlay that presents it as a wall without saying so
 * is the overlay doing the misleading.
 */
export default function OrderWallStrip({
  walls,
  showBids,
  showAsks,
  precision,
  error,
}: {
  walls: OrderWallResult | null;
  showBids: boolean;
  showAsks: boolean;
  precision: number;
  error?: string | null;
}) {
  if (!showBids && !showAsks) return null;

  if (error) {
    return (
      <div className="mb-2 rounded-lg border border-bear/25 bg-bear/5 px-2 py-1 text-[10px] text-bear">
        Order book unavailable — {error}
      </div>
    );
  }
  if (!walls) {
    return (
      <div className="mb-2 rounded-lg border border-white/5 bg-white/[0.02] px-2 py-1 text-[10px] text-slate-500">
        Sampling the order book…
      </div>
    );
  }

  const bids = showBids ? walls.bids : [];
  const asks = showAsks ? walls.asks : [];

  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-white/5 bg-white/[0.02] px-2 py-1 text-[10px]">
      <span className="uppercase tracking-[0.12em] text-slate-600">Walls</span>

      {bids.length === 0 && asks.length === 0 ? (
        <span className="text-slate-500">
          Nothing stands out within 3% of price — resting size is spread evenly.
        </span>
      ) : (
        <>
          {bids.map((w) => (
            <span key={`bid-${w.price}`} className="font-mono text-bull" title={w.note}>
              BID {w.price.toFixed(precision)} · {w.multiple.toFixed(1)}× ·{" "}
              {Math.abs(w.distancePct).toFixed(2)}% below
            </span>
          ))}
          {asks.map((w) => (
            <span key={`ask-${w.price}`} className="font-mono text-bear" title={w.note}>
              ASK {w.price.toFixed(precision)} · {w.multiple.toFixed(1)}× ·{" "}
              {w.distancePct.toFixed(2)}% above
            </span>
          ))}
        </>
      )}

      <span className="ml-auto text-slate-600">
        book {walls.imbalance >= 0 ? "+" : ""}
        {(walls.imbalance * 100).toFixed(0)}% · resting size can be pulled
      </span>
    </div>
  );
}
