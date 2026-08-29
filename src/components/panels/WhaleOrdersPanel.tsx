"use client";

import { FullAnalysis } from "@/engines/types";
import { GlassCard } from "@/components/ui/primitives";

/**
 * Large prints, listed with the price each happened at.
 *
 * The pressure map already surfaces whales, but folded in among squeeze zones
 * and leverage bands where they read as one input among several. They deserve
 * their own list: a large print is a *price* someone committed size at, and
 * the level is the part you trade against — a 40× bar is interesting, but "40×
 * at 4.2718, still defended" is actionable.
 *
 * `posture` is the column that matters. A whale that bought and is still above
 * its price is defending; one that is now offside is trapped, and its exit is
 * fuel for the other direction. Same print, opposite meaning.
 */
export default function WhaleOrdersPanel({
  analysis,
  pricePrecision,
}: {
  analysis: FullAnalysis | null;
  pricePrecision: number;
}) {
  const whales = analysis?.pressureMap?.whales ?? [];
  const price = analysis?.price ?? 0;

  return (
    <GlassCard
      title={
        <span className="flex items-center gap-2">
          🐋 Whale orders
          {whales.length > 0 && (
            <span className="font-mono text-[10px] font-normal text-slate-500">
              {whales.length} prints
            </span>
          )}
        </span>
      }
      className="h-full"
    >
      {!analysis ? (
        <div className="p-4 text-xs text-slate-500">Scanning for large prints…</div>
      ) : whales.length === 0 ? (
        <div className="p-4 text-xs leading-relaxed text-slate-500">
          No print in this window stands far enough above the average bar to count as a whale.
          That is a normal reading — size arrives in bursts, not continuously.
        </div>
      ) : (
        <div className="flex h-full min-h-0 flex-col">
          <div className="grid grid-cols-[auto_1fr_auto_auto_auto] gap-x-2 border-b border-white/5 px-3 py-1.5 text-[9px] uppercase tracking-wider text-slate-600">
            <span>Time</span>
            <span>Price</span>
            <span className="text-right">Size</span>
            <span className="text-right">×avg</span>
            <span className="text-right">Posture</span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {[...whales]
              .sort((a, b) => b.time - a.time)
              .map((w) => (
                <div
                  key={`${w.time}-${w.price}-${w.side}`}
                  title={w.note}
                  className="grid grid-cols-[auto_1fr_auto_auto_auto] items-center gap-x-2 border-b border-white/[0.03] px-3 py-1.5 font-mono text-[10px] hover:bg-white/[0.03]"
                >
                  <span className="text-slate-500">
                    {new Date(w.time * 1000).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  <span className={w.side === "buy" ? "text-bull" : "text-bear"}>
                    {w.side === "buy" ? "▲" : "▼"} {w.price.toFixed(pricePrecision)}
                    <span className="ml-1 text-slate-600">
                      {w.distancePct >= 0 ? "+" : ""}
                      {w.distancePct.toFixed(2)}%
                    </span>
                  </span>
                  <span className="text-right text-slate-300">{fmt(w.volume)}</span>
                  <span
                    className={`text-right ${w.multiple >= 5 ? "text-neon-amber" : "text-slate-400"}`}
                  >
                    {w.multiple.toFixed(1)}×
                  </span>
                  <span
                    className={`text-right text-[9px] uppercase tracking-wider ${
                      w.posture === "defending" ? "text-bull/80" : "text-bear/80"
                    }`}
                  >
                    {w.posture}
                  </span>
                </div>
              ))}
          </div>

          <p className="border-t border-white/5 px-3 py-2 text-[10px] leading-relaxed text-slate-600">
            Prints are sized against this window&apos;s average bar, so &ldquo;whale&rdquo; is
            relative to the contract rather than a fixed notional. Price now {price.toFixed(pricePrecision)};
            distance is measured from it, so a defending print that flips to trapped is visible as
            the sign changes.
          </p>
        </div>
      )}
    </GlassCard>
  );
}

function fmt(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(abs / 1e3).toFixed(1)}K`;
  return abs.toFixed(0);
}
