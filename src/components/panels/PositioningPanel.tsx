"use client";

import { useMemo } from "react";
import { GlassCard } from "@/components/ui/primitives";
import {
  PositioningQuadrant,
  readPositioning,
  readValueMigration,
  type OpenInterestPointLike,
} from "@/engines/positioning";
import { Candle } from "@/engines/types";

/**
 * Positioning — is this move adding commitment or spending it?
 *
 * The quadrant grid is drawn in full rather than as a single verdict line,
 * because the value of this read is in seeing which of four cases the market
 * is in *and* which three it is not. A rally on rising open interest and a
 * rally on falling open interest produce identical candles and opposite
 * meanings, and naming only the winner hides that they were ever different.
 *
 * Value migration sits underneath because it answers the same question over a
 * slower horizon: not who committed in the last few bars, but whether the
 * market has been finding business at new prices or rotating in the old ones.
 */
export default function PositioningPanel({
  candles,
  openInterest,
  timeframe,
}: {
  candles: Candle[];
  openInterest: OpenInterestPointLike[];
  timeframe: string;
}) {
  const read = useMemo(() => readPositioning(candles, openInterest), [candles, openInterest]);
  const migration = useMemo(() => readValueMigration(candles), [candles]);

  return (
    <GlassCard
      title={
        <span className="flex items-center gap-2">
          Positioning
          <span className="font-mono text-[9px] normal-case tracking-normal text-slate-600">
            open interest × price
          </span>
        </span>
      }
      className="h-full"
    >
      <div className="h-full space-y-3 overflow-y-auto p-3">
        <QuadrantGrid active={read.quadrant} />

        <div>
          <p
            className={`text-xs font-semibold leading-relaxed ${
              read.quadrant == null
                ? "text-slate-400"
                : read.participation === "opening"
                  ? "text-neon-cyan"
                  : "text-neon-amber"
            }`}
          >
            {read.headline}
          </p>
          {read.mechanism && (
            <p className="mt-1 text-[10px] leading-relaxed text-slate-400">{read.mechanism}</p>
          )}
        </div>

        <div className="grid grid-cols-3 gap-2">
          <Cell
            label="Price"
            value={`${read.pricePct >= 0 ? "+" : ""}${read.pricePct.toFixed(2)}%`}
            tone={read.pricePct > 0 ? "text-bull" : read.pricePct < 0 ? "text-bear" : ""}
            hint={`Close-to-close across the window, on the ${timeframe} series.`}
          />
          <Cell
            label="Open interest"
            value={`${read.oiPct >= 0 ? "+" : ""}${read.oiPct.toFixed(2)}%`}
            tone={read.oiPct > 0 ? "text-bull" : read.oiPct < 0 ? "text-bear" : ""}
            hint="Contracts still open. Rising means positions were added; falling means positions were closed. It says nothing about which side."
          />
          <Cell
            label="Window"
            value={read.barsCovered > 0 ? `${read.barsCovered} bars` : "—"}
            hint="Open interest publishes every five minutes at best, so a short window on a fast timeframe can straddle a single print — which the read refuses rather than guesses at."
          />
        </div>

        {/* The delta cross-check, stated only when there is an answer. */}
        {read.deltaAgrees !== null && (
          <div
            className={`rounded-lg border px-2.5 py-1.5 text-[10px] leading-relaxed ${
              read.deltaAgrees
                ? "border-white/10 bg-white/[0.03] text-slate-400"
                : "border-neon-amber/30 bg-neon-amber/5 text-neon-amber"
            }`}
          >
            {read.deltaAgrees
              ? "Taker delta points the same way as price — the move went with the aggressive flow."
              : "Price moved against the aggressive flow over these bars. Someone was filling the aggressors passively, which is the absorption signature."}
          </div>
        )}

        {read.caveats.length > 0 && (
          <ul className="space-y-1">
            {read.caveats.map((c, i) => (
              <li key={i} className="text-[10px] leading-relaxed text-slate-500">
                <span className="mr-1 text-slate-600">·</span>
                {c}
              </li>
            ))}
          </ul>
        )}

        <div className="border-t border-white/5 pt-3">
          <div className="mb-1.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            Value migration
          </div>
          {!migration ? (
            <p className="text-[10px] leading-relaxed text-slate-500">
              Not enough history on this timeframe to profile two windows and compare them.
            </p>
          ) : (
            <>
              <p
                className={`text-xs font-semibold ${
                  migration.direction === "higher"
                    ? "text-bull"
                    : migration.direction === "lower"
                      ? "text-bear"
                      : "text-slate-300"
                }`}
              >
                {migration.headline}
              </p>
              <p className="mt-1 text-[10px] leading-relaxed text-slate-400">{migration.detail}</p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Cell
                  label="Value now"
                  value={`${migration.current.low.toFixed(4)} – ${migration.current.high.toFixed(4)}`}
                  hint="The band that held about 70% of the recent window's volume — prices the market accepted, not merely visited."
                />
                <Cell
                  label="Value before"
                  value={`${migration.prior.low.toFixed(4)} – ${migration.prior.high.toFixed(4)}`}
                  hint="The same measurement over the window before this one."
                />
              </div>
              <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
                <span className="mr-1 text-slate-600">·</span>
                {migration.caveats.join(" ")}
              </p>
            </>
          )}
        </div>
      </div>
    </GlassCard>
  );
}

/** Cell layout of the four cases, with the live one lit. */
function QuadrantGrid({ active }: { active: PositioningQuadrant | null }) {
  const cells: { key: PositioningQuadrant; row: string; text: string }[] = [
    { key: "new_longs", row: "Price ↑ · OI ↑", text: "New longs" },
    { key: "short_covering", row: "Price ↑ · OI ↓", text: "Short covering" },
    { key: "new_shorts", row: "Price ↓ · OI ↑", text: "New shorts" },
    { key: "long_liquidation", row: "Price ↓ · OI ↓", text: "Long liquidation" },
  ];
  return (
    <div className="grid grid-cols-2 gap-1.5">
      {cells.map((c) => {
        const on = c.key === active;
        // Colour by opening vs closing, not by up vs down: the split this
        // grid exists to show is whether commitment is being added or spent.
        const opening = c.key === "new_longs" || c.key === "new_shorts";
        return (
          <div
            key={c.key}
            className={`rounded-lg border px-2 py-1.5 transition-colors ${
              on
                ? opening
                  ? "border-neon-cyan/50 bg-neon-cyan/10"
                  : "border-neon-amber/50 bg-neon-amber/10"
                : "border-white/5 bg-white/[0.02]"
            }`}
          >
            <div className={`font-mono text-[9px] ${on ? "text-slate-300" : "text-slate-600"}`}>
              {c.row}
            </div>
            <div
              className={`text-[11px] font-semibold ${
                on ? (opening ? "text-neon-cyan" : "text-neon-amber") : "text-slate-600"
              }`}
            >
              {c.text}
            </div>
            <div className={`text-[8px] uppercase tracking-wider ${on ? "text-slate-400" : "text-slate-700"}`}>
              {opening ? "opening" : "closing"}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Cell({
  label,
  value,
  tone = "",
  hint,
}: {
  label: string;
  value: string;
  tone?: string;
  hint: string;
}) {
  return (
    <div className="rounded-lg border border-white/5 bg-white/[0.02] px-2 py-1.5" title={hint}>
      <div className="text-[9px] uppercase tracking-[0.12em] text-slate-500">{label}</div>
      <div className={`font-mono text-sm font-semibold ${tone || "text-slate-200"}`}>{value}</div>
    </div>
  );
}
