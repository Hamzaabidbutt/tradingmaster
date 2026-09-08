"use client";

import { useMemo } from "react";
import { GlassCard } from "@/components/ui/primitives";
import { ConflictCheck, detectConflicts } from "@/engines/conflicts";
import { readPositioning, readValueMigration, type OpenInterestPointLike } from "@/engines/positioning";
import type { FundingReport } from "@/engines/fundingRates";
import { Candle, FullAnalysis } from "@/engines/types";

/**
 * Where the evidence disagrees with itself.
 *
 * Every check is listed with its own state, including the ones that came back
 * clean and the ones that could not run at all. An empty conflict list is
 * ambiguous — it could mean the evidence agrees or it could mean nothing was
 * measured — and those are opposite situations. Showing the whole board is what
 * makes "no conflicts" mean something.
 *
 * Conflicts sort to the top because they are the reason to open this box, but
 * the passing checks stay visible underneath rather than collapsing away: the
 * fact that four things were tested is the context that makes the fifth
 * worth reading.
 */
export default function ConflictPanel({
  analysis,
  candles,
  openInterest,
  funding,
}: {
  analysis: FullAnalysis | null;
  candles: Candle[];
  openInterest: OpenInterestPointLike[];
  funding: FundingReport | null;
}) {
  const report = useMemo(() => {
    if (!analysis || candles.length === 0) return null;
    return detectConflicts({
      candles,
      structure: analysis.structure,
      delta: analysis.delta,
      volumeProfile: analysis.volumeProfile,
      positioning: readPositioning(candles, openInterest),
      migration: readValueMigration(candles),
      fundingPayer: funding?.payer ?? null,
    });
  }, [analysis, candles, openInterest, funding]);

  return (
    <GlassCard
      title={
        <span className="flex items-center gap-2">
          Conflicts
          <span className="font-mono text-[9px] normal-case tracking-normal text-slate-600">
            where the evidence disagrees
          </span>
          {report && report.conflicts.length > 0 && (
            <span className="rounded-full bg-neon-amber/15 px-1.5 py-0.5 font-mono text-[9px] text-neon-amber">
              {report.conflicts.length}
            </span>
          )}
        </span>
      }
      className="h-full"
    >
      <div className="h-full space-y-2.5 overflow-y-auto p-3">
        {!report ? (
          <p className="p-4 text-center text-xs text-slate-500">Waiting on the analysis pass…</p>
        ) : (
          <>
            <p
              className={`text-xs font-semibold leading-relaxed ${
                report.conflicts.length === 0 ? "text-bull" : "text-neon-amber"
              }`}
            >
              {report.headline}
            </p>

            {/* Conflicts first, then the clean checks, then what could not run.
                Within each group the original detector order is preserved so
                the list does not reshuffle as conditions change. */}
            {(["conflict", "aligned", "unavailable"] as const).flatMap((status) =>
              report.checks.filter((c) => c.status === status).map((c) => <Row key={c.id} check={c} />)
            )}

            <p className="border-t border-white/5 pt-2 text-[10px] leading-relaxed text-slate-500">
              {report.note}
            </p>
          </>
        )}
      </div>
    </GlassCard>
  );
}

function Row({ check: c }: { check: ConflictCheck }) {
  const tone =
    c.status === "conflict"
      ? { border: "border-neon-amber/30", bg: "bg-neon-amber/[0.06]", text: "text-neon-amber", pill: "CONFLICT" }
      : c.status === "aligned"
        ? { border: "border-white/8", bg: "bg-white/[0.02]", text: "text-bull", pill: "ALIGNED" }
        : { border: "border-white/5", bg: "bg-white/[0.01]", text: "text-slate-500", pill: "NO DATA" };

  return (
    <div className={`rounded-lg border ${tone.border} ${tone.bg} px-2.5 py-2`}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-[11px] font-semibold text-slate-200">{c.title}</span>
        <span className="flex shrink-0 items-center gap-1">
          {c.status === "conflict" && c.argues !== "neither" && (
            <span
              className={`font-mono text-[9px] ${c.argues === "up" ? "text-bull" : "text-bear"}`}
              title="The direction this divergence argues for if it resolves. Not a forecast — divergences persist, and some end by simply ceasing to diverge."
            >
              argues {c.argues === "up" ? "↑" : "↓"}
            </span>
          )}
          <span
            className={`rounded px-1.5 py-0.5 font-mono text-[8px] font-semibold tracking-wider ${tone.text}`}
          >
            {tone.pill}
          </span>
        </span>
      </div>
      <p className="mt-0.5 font-mono text-[10px] leading-relaxed text-slate-400">{c.says}</p>
      <p className="mt-1 text-[10px] leading-relaxed text-slate-500">{c.reading}</p>
    </div>
  );
}
