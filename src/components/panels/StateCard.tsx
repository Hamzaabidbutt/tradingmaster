"use client";

import { useMemo } from "react";
import { GlassCard, localTime } from "@/components/ui/primitives";
import { detectConflicts } from "@/engines/conflicts";
import { readMarketState } from "@/engines/marketState";
import { readPositioning, readValueMigration, type OpenInterestPointLike } from "@/engines/positioning";
import type { FundingReport } from "@/engines/fundingRates";
import { Candle, FullAnalysis } from "@/engines/types";

/**
 * The one-line answer, and the two ways out of it.
 *
 * Deliberately laid out so the invalidation price is as prominent as the state
 * name. A read without a price that falsifies it is an opinion, and an opinion
 * at the top of a trading screen is worse than nothing — it anchors every
 * panel below it. Both resolutions are given equal width for the same reason:
 * the card is not allowed to look like it favours one.
 */
export default function StateCard({
  analysis,
  candles,
  openInterest,
  funding,
  pricePrecision,
}: {
  analysis: FullAnalysis | null;
  candles: Candle[];
  openInterest: OpenInterestPointLike[];
  funding: FundingReport | null;
  pricePrecision: number;
}) {
  const state = useMemo(() => {
    if (!analysis || candles.length === 0) return null;
    const positioning = readPositioning(candles, openInterest);
    const migration = readValueMigration(candles);
    return readMarketState({
      candles,
      structure: analysis.structure,
      volumeProfile: analysis.volumeProfile,
      migration,
      positioning,
      conflicts: detectConflicts({
        candles,
        structure: analysis.structure,
        delta: analysis.delta,
        volumeProfile: analysis.volumeProfile,
        positioning,
        migration,
        fundingPayer: funding?.payer ?? null,
      }),
    });
  }, [analysis, candles, openInterest, funding]);

  return (
    <GlassCard
      title={
        <span className="flex items-center gap-2">
          Market state
          <span className="font-mono text-[9px] normal-case tracking-normal text-slate-600">
            what this is, and both ways out
          </span>
        </span>
      }
      className="h-full"
    >
      {!state ? (
        <p className="p-4 text-center text-xs text-slate-500">Waiting on the analysis pass…</p>
      ) : (
        <div className="h-full space-y-3 overflow-y-auto p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-lg font-bold leading-tight text-slate-100">{state.label}</span>
            {state.since != null && (
              <span className="font-mono text-[10px] text-slate-500">since {localTime(state.since)}</span>
            )}
          </div>

          {state.tension && (
            <div className="rounded-lg border border-neon-amber/30 bg-neon-amber/[0.06] px-2.5 py-1.5 text-[10px] leading-relaxed text-neon-amber">
              <span className="font-semibold">Against it:</span> {state.tension}
            </div>
          )}

          <div>
            <div className="mb-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              How it got here
            </div>
            <ul className="space-y-0.5">
              {state.gotHere.map((g, i) => (
                <li key={i} className="text-[10px] leading-relaxed text-slate-400">
                  <span className="mr-1 text-slate-600">·</span>
                  {g}
                </li>
              ))}
            </ul>
          </div>

          {/* Equal width, both directions. The layout is part of the claim. */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Path arrow="↑" tone="bull" path={state.up} />
            <Path arrow="↓" tone="bear" path={state.down} />
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div className="rounded-lg border border-neon-cyan/25 bg-neon-cyan/[0.05] px-2.5 py-2">
              <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-neon-cyan">
                Watch
              </div>
              <p className="mt-0.5 text-[10px] leading-relaxed text-slate-300">{state.watch}</p>
            </div>
            <div className="rounded-lg border border-bear/25 bg-bear/[0.05] px-2.5 py-2">
              <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-bear">
                Wrong if
              </div>
              {state.invalidation ? (
                <>
                  <div className="font-mono text-lg font-bold leading-tight text-bear">
                    {state.invalidation.price.toFixed(pricePrecision)}
                  </div>
                  <p className="text-[10px] leading-relaxed text-slate-400">{state.invalidation.why}</p>
                </>
              ) : (
                <p className="mt-0.5 text-[10px] leading-relaxed text-slate-400">
                  No single price falsifies this state — which is itself the reason there is no trade in it.
                </p>
              )}
            </div>
          </div>

          <p className="border-t border-white/5 pt-2 text-[10px] leading-relaxed text-slate-500">
            {state.note}
          </p>
        </div>
      )}
    </GlassCard>
  );
}

function Path({
  arrow,
  tone,
  path,
}: {
  arrow: string;
  tone: "bull" | "bear";
  path: { condition: string; meaning: string };
}) {
  return (
    <div className="rounded-lg border border-white/8 bg-white/[0.02] px-2.5 py-2">
      <div className={`text-[9px] font-semibold uppercase tracking-[0.14em] ${tone === "bull" ? "text-bull" : "text-bear"}`}>
        {arrow} Resolves {tone === "bull" ? "up" : "down"}
      </div>
      <p className="mt-0.5 text-[10px] font-semibold leading-relaxed text-slate-300">{path.condition}</p>
      <p className="mt-1 text-[10px] leading-relaxed text-slate-500">{path.meaning}</p>
    </div>
  );
}
