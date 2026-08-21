"use client";

import { BiasBadge, GlassCard, ProbabilityBar } from "@/components/ui/primitives";
import { EmptyNote } from "./shared";
import type { OverviewResponse } from "@/app/api/overview/route";

/**
 * Block 2 — Overall Market Direction.
 *
 * `mixed` is a real answer here, not a fallback. A market where 51% of pairs
 * are up has no direction, and saying "bullish" about it would be the same
 * mistake as forcing a signal because price is moving.
 */
export default function OverallDirectionCard({
  data,
  loading,
}: {
  data: OverviewResponse | null;
  loading: boolean;
}) {
  return (
    <GlassCard
      title="Overall Market Direction"
      action={
        data ? (
          <BiasBadge
            bias={data.direction === "mixed" ? "neutral" : data.direction}
            label={data.directionLabel}
          />
        ) : null
      }
    >
      {!data ? (
        <EmptyNote>{loading ? "Measuring direction…" : "Direction unavailable."}</EmptyNote>
      ) : (
        <div className="space-y-3 p-4">
          {/* Breadth doubles as the bullish share: it is the fraction of the
              universe that is up, which is exactly what the bar means. */}
          <ProbabilityBar bullish={Math.round(data.breadthPct)} />

          <ul className="space-y-1.5">
            {data.rationale.map((line, i) => (
              <li key={i} className="flex gap-2 text-xs leading-relaxed text-slate-400">
                <span className="mt-[2px] text-neon-cyan">›</span>
                <span>{line}</span>
              </li>
            ))}
          </ul>

          <p className="border-t border-white/5 pt-2 text-[10px] leading-relaxed text-slate-600">
            Direction is measured from the breadth of the whole universe, and it does not gate the
            setups below. A strong SHORT on one coin is still a strong SHORT in a bullish tape.
          </p>
        </div>
      )}
    </GlassCard>
  );
}
