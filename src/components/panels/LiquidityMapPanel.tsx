"use client";

import { useMemo } from "react";
import { GlassCard } from "@/components/ui/primitives";
import { buildLiquidationHeatmap, buildLiquidityMap, HeatRow, LiquidityRung } from "@/engines/liquidityMap";
import { FullAnalysis, OrderWallResult } from "@/engines/types";

/**
 * Where the size is, drawn as a ladder.
 *
 * The point of this panel is that "nearest bid wall: $48M" is a fact nobody
 * can act on. What decides anything is the *shape*: how much sits above versus
 * below, how far each block is, and therefore which direction has less
 * standing in its way. That is a picture, and a single figure throws away the
 * only part that matters.
 *
 * Two ladders side by side, because they answer different questions with
 * different kinds of evidence. The liquidity map mixes measured book size with
 * inferred stop locations and marks which is which. The heatmap is purely the
 * inferred half, laid on a fixed price grid so the *empty* bands stay visible
 * — where there is no liquidity is as useful as where there is a lot, and a
 * list that only contains hits hides it.
 */
export default function LiquidityMapPanel({
  analysis,
  walls,
  price,
  pricePrecision,
}: {
  analysis: FullAnalysis | null;
  walls: OrderWallResult | null;
  price: number | null;
  pricePrecision: number;
}) {
  const live = price ?? analysis?.price ?? 0;

  const zones = useMemo(() => {
    if (!analysis) return [];
    const p = analysis.pressureMap;
    return [...p.shortSqueeze, ...p.longSqueeze, ...p.forcedLongLiquidation, ...p.forcedShortLiquidation];
  }, [analysis]);

  const map = useMemo(
    () => (live > 0 ? buildLiquidityMap(live, walls ? { bids: walls.bids, asks: walls.asks } : null, zones) : null),
    [live, walls, zones]
  );
  const heat = useMemo(() => (live > 0 ? buildLiquidationHeatmap(live, zones) : null), [live, zones]);

  const p = (v: number) => v.toFixed(pricePrecision);

  return (
    <GlassCard
      title={
        <span className="flex items-center gap-2">
          Liquidity Map
          <span className="font-mono text-[9px] normal-case tracking-normal text-slate-600">
            where the size is
          </span>
        </span>
      }
      className="h-full"
    >
      <div className="grid h-full grid-cols-1 gap-3 overflow-y-auto p-3 lg:grid-cols-2">
        {/* ---- the ladder ---- */}
        <section>
          <div className="mb-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            Liquidity ladder
          </div>
          {!map || map.rungs.length === 0 ? (
            <p className="rounded-lg border border-white/5 bg-white/[0.02] px-2.5 py-2 text-[10px] leading-relaxed text-slate-500">
              {map?.headline ?? "Waiting on price and book data…"}
            </p>
          ) : (
            <>
              <p className="mb-1.5 text-[11px] font-semibold leading-relaxed text-slate-200">
                {map.headline}
              </p>

              <div className="space-y-0.5">
                {map.rungs
                  .filter((r) => r.side === "above")
                  .map((r) => (
                    <Rung key={`a-${r.source}-${r.price}`} rung={r} fmt={p} />
                  ))}

                {/* The current price, as its own rung. Without it the ladder is
                    a list of numbers with no anchor. */}
                <div className="flex items-center gap-2 rounded border border-neon-cyan/30 bg-neon-cyan/[0.07] px-2 py-1">
                  <span className="font-mono text-[10px] font-bold text-neon-cyan">{p(live)}</span>
                  <span className="text-[9px] uppercase tracking-wider text-neon-cyan/80">current</span>
                </div>

                {map.rungs
                  .filter((r) => r.side === "below")
                  .map((r) => (
                    <Rung key={`b-${r.source}-${r.price}`} rung={r} fmt={p} />
                  ))}
              </div>

              <div className="mt-2 rounded-lg border border-white/5 bg-white/[0.02] px-2.5 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-[9px] uppercase tracking-wider text-slate-500">
                    Attraction
                  </span>
                  <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
                    {/* Diverging from the centre: the sign is the whole point. */}
                    <div
                      className={`absolute top-0 h-full ${map.attraction >= 0 ? "bg-bull/70" : "bg-bear/70"}`}
                      style={{
                        left: map.attraction >= 0 ? "50%" : `${50 + map.attraction / 2}%`,
                        width: `${Math.abs(map.attraction) / 2}%`,
                      }}
                    />
                    <div className="absolute left-1/2 top-0 h-full w-px bg-white/30" />
                  </div>
                  <span
                    className={`font-mono text-[10px] ${map.attraction >= 0 ? "text-bull" : "text-bear"}`}
                    title="Positive means more pull above than below, weighted by proximity."
                  >
                    {map.attraction >= 0 ? "+" : ""}
                    {map.attraction}
                  </span>
                </div>
                <p className="mt-1 text-[10px] leading-relaxed text-slate-500">{map.note}</p>
              </div>

              <ul className="mt-1.5 space-y-1">
                {map.caveats.map((c, i) => (
                  <li key={i} className="text-[10px] leading-relaxed text-slate-600">
                    <span className="mr-1">·</span>
                    {c}
                  </li>
                ))}
              </ul>

              {/* The book is polled only while a wall overlay is on, so this
                  panel can be missing its measured half without anything being
                  broken. Say which switch fixes it rather than opening a
                  network poll nobody asked for. */}
              {!walls && (
                <p className="mt-1.5 rounded border border-neon-cyan/20 bg-neon-cyan/[0.04] px-2 py-1.5 text-[10px] leading-relaxed text-neon-cyan/90">
                  Switch on <span className="font-mono">BID WALL</span> or{" "}
                  <span className="font-mono">ASK WALL</span> under Indicators to add live book size
                  to this ladder. It is off by default because it opens an order-book poll.
                </p>
              )}
            </>
          )}
        </section>

        {/* ---- the heatmap ---- */}
        <section>
          <div className="mb-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            Liquidation heatmap
          </div>
          {!heat || heat.rows.length === 0 ? (
            <p className="rounded-lg border border-white/5 bg-white/[0.02] px-2.5 py-2 text-[10px] leading-relaxed text-slate-500">
              {heat?.headline ?? "Waiting on the analysis pass…"}
            </p>
          ) : (
            <>
              <p className="mb-1.5 text-[11px] font-semibold leading-relaxed text-slate-200">
                {heat.headline}
              </p>
              <div className="space-y-px">
                {heat.rows.map((r) => (
                  <HeatBar key={r.price} row={r} fmt={p} />
                ))}
              </div>
              {heat.major && (
                <p className="mt-1.5 rounded-lg border border-neon-amber/25 bg-neon-amber/[0.05] px-2 py-1.5 font-mono text-[10px] text-neon-amber">
                  Major cluster {p(heat.major.low)}–{p(heat.major.high)} ·{" "}
                  {heat.major.distancePct >= 0 ? "+" : ""}
                  {heat.major.distancePct}%
                </p>
              )}
              <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500">{heat.note}</p>
            </>
          )}
        </section>
      </div>
    </GlassCard>
  );
}

function Rung({ rung: r, fmt }: { rung: LiquidityRung; fmt: (v: number) => string }) {
  /* Measured and inferred rows are drawn differently on purpose: a solid block
     for size that exists, a hatched one for a location that was estimated. */
  const bookish = r.source === "book";
  const tone = r.side === "above" ? "text-bear" : "text-bull";
  return (
    <div
      className="flex items-center gap-2 rounded px-2 py-0.5 hover:bg-white/[0.03]"
      title={r.note}
    >
      <span className="w-[68px] shrink-0 font-mono text-[10px] text-slate-300">{fmt(r.price)}</span>
      <span className={`w-[42px] shrink-0 font-mono text-[9px] ${tone}`}>
        {r.distancePct >= 0 ? "+" : ""}
        {r.distancePct}%
      </span>
      <span
        className={`h-2 shrink-0 rounded-sm ${bookish ? (r.side === "above" ? "bg-bear/60" : "bg-bull/60") : "bg-slate-500/40"}`}
        style={{ width: `${Math.min(100, bookish ? 60 : r.magnitude)}px` }}
      />
      <span className="truncate text-[9px] text-slate-500">
        {r.label}
        {!r.measured && <span className="ml-1 text-slate-600">(inferred)</span>}
      </span>
    </div>
  );
}

function HeatBar({ row: r, fmt }: { row: HeatRow; fmt: (v: number) => string }) {
  const colour = r.side === "long" ? "bg-bull/70" : "bg-bear/70";
  return (
    <div className={`flex items-center gap-2 ${r.current ? "rounded bg-neon-cyan/10" : ""}`}>
      <span
        className={`w-[68px] shrink-0 font-mono text-[9px] ${r.current ? "font-bold text-neon-cyan" : "text-slate-400"}`}
      >
        {fmt(r.price)}
      </span>
      <div className="h-2 flex-1 overflow-hidden rounded-sm bg-white/[0.04]">
        {r.heat > 0 && <div className={`h-full ${colour}`} style={{ width: `${r.heat}%` }} />}
      </div>
      <span className="w-[30px] shrink-0 text-right font-mono text-[8px] text-slate-600">
        {r.heat > 0 ? r.heat : ""}
      </span>
    </div>
  );
}
