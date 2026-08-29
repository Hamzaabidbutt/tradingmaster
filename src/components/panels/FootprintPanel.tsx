"use client";

import { useState } from "react";
import { FullAnalysis } from "@/engines/types";
import { collectImbalanceLevels, ImbalanceLevel } from "@/engines/footprint";
import { GlassCard, timeAgo } from "@/components/ui/primitives";

/**
 * Footprint viewer — the x-ray of a candle.
 * Left column = volume traded at the bid (aggressive sellers),
 * right column = volume traded at the ask (aggressive buyers).
 * Highlighted cells mark diagonal imbalances above the threshold.
 */
export default function FootprintPanel({ analysis }: { analysis: FullAnalysis | null }) {
  const fp = analysis?.footprint;
  const [idx, setIdx] = useState<number | null>(null);

  const candles = fp?.candles ?? [];
  const selected = candles.length > 0 ? candles[idx ?? candles.length - 1] : null;
  const maxCell = selected
    ? Math.max(...selected.cells.map((c) => Math.max(c.bidVolume, c.askVolume)), 1e-9)
    : 1;

  return (
    <GlassCard
      title={
        <span className="flex items-center gap-2">
          Footprint
          {fp && (
            <span
              className={`rounded px-1 py-0.5 text-[8px] font-bold uppercase ${
                fp.fidelity === "sub_candle" ? "bg-bull/15 text-bull" : "bg-neon-amber/15 text-neon-amber"
              }`}
              title={
                fp.fidelity === "sub_candle"
                  ? `Reconstructed from ${fp.sourceTimeframe} candles`
                  : "Modelled from bar-level taker volume — indicative only"
              }
            >
              {fp.fidelity === "sub_candle" ? "reconstructed" : "modelled"}
            </span>
          )}
        </span>
      }
      className="h-full"
    >
      {!fp || !selected ? (
        <div className="p-4 text-xs text-slate-500">Building footprint…</div>
      ) : (
        <div className="flex h-full flex-col">
          {/* Bar selector */}
          <div className="flex gap-0.5 overflow-x-auto border-b border-white/5 px-2 py-1.5">
            {candles.slice(-18).map((c, i) => {
              const realIdx = candles.length - Math.min(18, candles.length) + i;
              const active = realIdx === (idx ?? candles.length - 1);
              const bull = c.close >= c.open;
              return (
                <button
                  key={c.time}
                  onClick={() => setIdx(realIdx)}
                  title={`${new Date(c.time * 1000).toLocaleTimeString()} · Δ${c.delta.toFixed(0)}`}
                  className={`h-6 w-2 shrink-0 rounded-sm transition-all ${
                    active ? "ring-1 ring-neon-cyan" : ""
                  } ${bull ? "bg-bull/50" : "bg-bear/50"} ${c.deltaDivergence ? "ring-1 ring-neon-amber" : ""}`}
                />
              );
            })}
          </div>

          {/* Header stats */}
          <div className="grid grid-cols-3 gap-1 border-b border-white/5 px-3 py-2 font-mono text-[10px]">
            <div>
              <div className="text-slate-500">Bar delta</div>
              <div className={selected.delta >= 0 ? "text-bull" : "text-bear"}>
                {selected.delta >= 0 ? "+" : ""}{fmt(selected.delta)}
              </div>
            </div>
            <div>
              <div className="text-slate-500">Bar POC</div>
              <div className="text-neon-amber">{selected.poc.toFixed(4)}</div>
            </div>
            <div>
              <div className="text-slate-500">Time</div>
              <div className="text-slate-300">{timeAgo(selected.time)}</div>
            </div>
          </div>

          {/* Warnings */}
          {(selected.deltaDivergence || selected.stackedImbalances.length > 0) && (
            <div className="space-y-1 border-b border-white/5 px-3 py-1.5">
              {selected.deltaDivergence && (
                <p className="text-[10px] leading-relaxed text-neon-amber">
                  ⚠ Delta diverges from the candle body — the aggressive side was absorbed and is now offside.
                </p>
              )}
              {selected.stackedImbalances.map((si, i) => (
                <p key={i} className={`text-[10px] ${si.direction === "buy" ? "text-bull" : "text-bear"}`}>
                  ▪ Stacked {si.direction} imbalance ×{si.count} ({si.fromPrice.toFixed(4)}–{si.toPrice.toFixed(4)})
                </p>
              ))}
            </div>
          )}

          {/* Ladder */}
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            <div className="mb-1 grid grid-cols-[1fr_auto_1fr] gap-1 text-[9px] uppercase tracking-wider text-slate-600">
              <span className="text-right">bid · sellers</span>
              <span className="px-2 text-center">price</span>
              <span>buyers · ask</span>
            </div>
            {[...selected.cells].reverse().map((cell, i) => {
              const isPoc = Math.abs(cell.price - selected.poc) < 1e-9;
              const bidW = (cell.bidVolume / maxCell) * 100;
              const askW = (cell.askVolume / maxCell) * 100;
              return (
                <div
                  key={i}
                  className={`grid grid-cols-[1fr_auto_1fr] items-center gap-1 py-[1px] font-mono text-[9px] ${
                    isPoc ? "bg-neon-amber/10" : ""
                  }`}
                >
                  {/* Bid side */}
                  <div className="relative flex justify-end">
                    <div
                      className={`absolute right-0 h-full ${cell.imbalance === "sell" ? "bg-bear/35" : "bg-bear/15"}`}
                      style={{ width: `${bidW}%` }}
                    />
                    <span className={`relative z-10 pr-1 ${cell.imbalance === "sell" ? "font-bold text-bear" : "text-slate-400"}`}>
                      {fmt(cell.bidVolume)}
                    </span>
                  </div>
                  <span className={`px-1 ${isPoc ? "font-bold text-neon-amber" : "text-slate-500"}`}>
                    {cell.price.toFixed(4)}
                  </span>
                  {/* Ask side */}
                  <div className="relative flex justify-start">
                    <div
                      className={`absolute left-0 h-full ${cell.imbalance === "buy" ? "bg-bull/35" : "bg-bull/15"}`}
                      style={{ width: `${askW}%` }}
                    />
                    <span className={`relative z-10 pl-1 ${cell.imbalance === "buy" ? "font-bold text-bull" : "text-slate-400"}`}>
                      {fmt(cell.askVolume)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          <ImbalanceLadder analysis={analysis} />

          <div className="border-t border-white/5 px-3 py-1.5 text-[9px] text-slate-600">
            Imbalance threshold {fp.imbalanceThreshold}x · tune per asset & session
          </div>
        </div>
      )}
    </GlassCard>
  );
}

function fmt(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${abs.toFixed(0)}`;
}


/** Tier colours: the further past the threshold, the hotter. */
function tierClass(tier: number, side: "buy" | "sell"): string {
  const bull = side === "buy";
  if (tier >= 20) return bull ? "bg-bull/30 text-bull" : "bg-bear/30 text-bear";
  if (tier >= 10) return bull ? "bg-bull/20 text-bull" : "bg-bear/20 text-bear";
  return bull ? "bg-bull/10 text-bull/80" : "bg-bear/10 text-bear/80";
}

function LadderColumn({ title, levels, side }: { title: string; levels: ImbalanceLevel[]; side: "buy" | "sell" }) {
  return (
    <div className="min-w-0">
      <div className={`pb-1 text-[9px] uppercase tracking-[0.12em] ${side === "buy" ? "text-bull" : "text-bear"}`}>
        {title} <span className="font-mono text-slate-600">{levels.length}</span>
      </div>
      {levels.length === 0 ? (
        <p className="text-[10px] text-slate-600">None above threshold.</p>
      ) : (
        <div className="space-y-0.5">
          {levels.map((l) => (
            <div
              key={`${l.time}-${l.price}`}
              className="flex items-center gap-1.5 font-mono text-[10px]"
              title={`${new Date(l.time * 1000).toLocaleTimeString()} · ratio ${l.ratio}x · ${fmt(l.volume)} on the ${side} side`}
            >
              <span className={`rounded px-1 py-[1px] text-[9px] font-bold ${tierClass(l.tier, side)}`}>
                {l.tier >= 20 ? "20x+" : `${l.tier}x`}
              </span>
              <span className="text-slate-300">{l.price.toFixed(l.price >= 1000 ? 1 : 4)}</span>
              <span className="text-slate-500">{fmt(l.volume)}</span>
              {l.stacked && (
                <span className="text-[9px] uppercase tracking-wider text-neon-amber" title="Part of a run of 3+ consecutive imbalances">
                  stacked
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The imbalanced levels as a list rather than as highlighted cells.
 *
 * Reading imbalance off the grid means scanning a matrix for coloured cells
 * across a dozen bars. The question being asked is simpler than that — *where*
 * is one side getting no fills, and how badly — and a ranked list answers it
 * directly. Tiers cap at 20x because past that point a diagonal is just
 * "the other side printed almost nothing", and sorting by raw ratio would put
 * near-empty levels above genuinely large ones.
 */
function ImbalanceLadder({ analysis }: { analysis: FullAnalysis }) {
  const { buy, sell } = collectImbalanceLevels(analysis.footprint, { bars: 12, limit: 20 });
  if (buy.length === 0 && sell.length === 0) return null;

  return (
    <div className="border-t border-white/5 px-3 py-2">
      <div className="mb-1.5 text-[9px] uppercase tracking-[0.14em] text-slate-600">
        Imbalance ladder · last 12 bars
      </div>
      <div className="grid grid-cols-2 gap-3">
        <LadderColumn title="Buy imbalance" levels={buy} side="buy" />
        <LadderColumn title="Sell imbalance" levels={sell} side="sell" />
      </div>
    </div>
  );
}
