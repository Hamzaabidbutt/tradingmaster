"use client";

import { FullAnalysis, PressureZone, WhaleOrder } from "@/engines/types";
import { BiasBadge, GlassCard, timeAgo } from "@/components/ui/primitives";

/**
 * Where the forced buyers and forced sellers are.
 *
 * Every price here is one the market has a *mechanical* reason to reach —
 * stop clusters, leverage bands, offside whale inventory — as opposed to a
 * price someone considers fair. The basis of each row is labelled, because
 * a modelled leverage band and an observed whale print deserve very
 * different amounts of trust.
 */
export default function PressureMapPanel({
  analysis,
  pricePrecision,
}: {
  analysis: FullAnalysis | null;
  pricePrecision: number;
}) {
  const map = analysis?.pressureMap;
  const p = (v: number) => v.toFixed(pricePrecision);

  return (
    <GlassCard
      title={
        <span className="flex items-center gap-2">
          Squeeze &amp; Liquidation Map
          {map && <BiasBadge bias={map.lean} label={`${map.lean} pull`} />}
        </span>
      }
      className="h-full"
    >
      {!map ? (
        <div className="p-4 text-xs text-slate-500">Mapping forced flow…</div>
      ) : (
        <div className="h-full space-y-3 overflow-y-auto p-3">
          {/* Squeeze zones, both sides */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <ZoneList
              title="Short squeeze"
              hint="stops above — a touch forces buying"
              zones={map.shortSqueeze}
              tone="bull"
              fmt={p}
            />
            <ZoneList
              title="Long squeeze"
              hint="stops below — a touch forces selling"
              zones={map.longSqueeze}
              tone="bear"
              fmt={p}
            />
          </div>

          {/* Forced liquidation bands */}
          <div>
            <Heading title="Forced liquidation prices" hint="modelled leverage bands, not measured open interest" />
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <ZoneList title="Longs liquidated" zones={map.forcedLongLiquidation} tone="bear" fmt={p} compact />
              <ZoneList title="Shorts liquidated" zones={map.forcedShortLiquidation} tone="bull" fmt={p} compact />
            </div>
          </div>

          {/* Whale prints */}
          <div>
            <Heading title="Whale orders" hint="outsized prints and whether they are defending or offside" />
            {map.whales.length === 0 ? (
              <p className="text-[10px] text-slate-500">
                No outsized prints on the recent tape — current movement is retail-sized flow.
              </p>
            ) : (
              <div className="space-y-1">
                {map.whales.map((w, i) => (
                  <WhaleRow key={i} whale={w} fmt={p} />
                ))}
              </div>
            )}
          </div>

          {/* CVD divergence */}
          <div
            className={`rounded-lg border p-2 ${
              !map.cvdDivergence.present
                ? "border-white/10 bg-white/[0.02]"
                : map.cvdDivergence.bias === "bullish"
                  ? "border-bull/25 bg-bull/5"
                  : "border-bear/25 bg-bear/5"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                Cumulative delta divergence
              </span>
              {map.cvdDivergence.present && (
                <span
                  className={`font-mono text-[10px] font-bold ${
                    map.cvdDivergence.bias === "bullish" ? "text-bull" : "text-bear"
                  }`}
                >
                  {map.cvdDivergence.kind?.replace(/_/g, " ")} · {map.cvdDivergence.strength}
                </span>
              )}
            </div>
            <p className="mt-1 text-[10px] leading-relaxed text-slate-400">{map.cvdDivergence.note}</p>
          </div>

          <ul className="space-y-1 border-t border-white/5 pt-2">
            {map.summary.map((s, i) => (
              <li key={i} className="text-[10px] leading-relaxed text-slate-400">
                • {s}
              </li>
            ))}
          </ul>
        </div>
      )}
    </GlassCard>
  );
}

function Heading({ title, hint }: { title: string; hint?: string }) {
  return (
    <h4 className="mb-1 flex items-baseline gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">{title}</span>
      {hint && <span className="text-[9px] text-slate-600">— {hint}</span>}
    </h4>
  );
}

function ZoneList({
  title,
  hint,
  zones,
  tone,
  fmt,
  compact,
}: {
  title: string;
  hint?: string;
  zones: PressureZone[];
  tone: "bull" | "bear";
  fmt: (v: number) => string;
  compact?: boolean;
}) {
  const color = tone === "bull" ? "text-bull" : "text-bear";
  const bar = tone === "bull" ? "bg-bull" : "bg-bear";
  return (
    <div>
      {!compact && <Heading title={title} hint={hint} />}
      {compact && (
        <div className="mb-1 text-[9px] uppercase tracking-wider text-slate-500">{title}</div>
      )}
      {zones.length === 0 ? (
        <p className="text-[10px] text-slate-600">None within range.</p>
      ) : (
        <div className="space-y-1">
          {zones.map((z, i) => (
            <div key={i} className="rounded-md bg-white/[0.03] px-2 py-1" title={z.note}>
              <div className="flex items-center justify-between gap-2 font-mono text-[10px]">
                <span className={`font-semibold ${color}`}>{fmt(z.price)}</span>
                <span className="text-slate-500">
                  {z.distancePct >= 0 ? "+" : ""}
                  {z.distancePct.toFixed(2)}%
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5">
                <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/5">
                  <div className={`h-full ${bar} opacity-70`} style={{ width: `${z.intensity}%` }} />
                </div>
                <span className="shrink-0 text-[8px] uppercase tracking-wider text-slate-600">
                  {z.basis.replace(/_/g, " ")}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function WhaleRow({ whale, fmt }: { whale: WhaleOrder; fmt: (v: number) => string }) {
  const buy = whale.side === "buy";
  return (
    <div
      className={`rounded-md border px-2 py-1 ${
        whale.posture === "defending" ? "border-white/10 bg-white/[0.03]" : "border-neon-amber/25 bg-neon-amber/5"
      }`}
      title={whale.note}
    >
      <div className="flex flex-wrap items-center gap-x-2 font-mono text-[10px]">
        <span className={buy ? "font-semibold text-bull" : "font-semibold text-bear"}>
          {buy ? "BUY" : "SELL"} {fmt(whale.price)}
        </span>
        <span className="text-slate-400">${fmtNum(whale.notional)}</span>
        <span className="text-slate-600">{whale.multiple}×</span>
        <span
          className={`ml-auto text-[9px] uppercase tracking-wider ${
            whale.posture === "defending" ? "text-slate-500" : "text-neon-amber"
          }`}
        >
          {whale.posture}
        </span>
      </div>
      <div className="mt-0.5 flex justify-between text-[9px] text-slate-600">
        <span>
          {whale.distancePct >= 0 ? "+" : ""}
          {whale.distancePct.toFixed(2)}% away
        </span>
        <span>{timeAgo(whale.time)}</span>
      </div>
    </div>
  );
}

function fmtNum(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}
