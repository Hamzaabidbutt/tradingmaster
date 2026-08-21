"use client";

import { GlassCard } from "@/components/ui/primitives";
import SetupCard from "./SetupCard";
import { EmptyNote } from "./shared";
import type { UniverseScanDto } from "@/hooks/useDashboard";

/**
 * Block 4 — Top LONG / Top SHORT Opportunities.
 *
 * One component with a direction prop, rendered twice. That is how request 5's
 * parity is kept honest in the UI as well as the engine: there is no separate
 * long-side code path that could get a nicer layout, a longer list, or a lower
 * bar than the short side.
 */
export default function TopOpportunities({
  direction,
  scan,
  loading,
  limit = 5,
}: {
  direction: "LONG" | "SHORT";
  scan: UniverseScanDto | null;
  loading: boolean;
  limit?: number;
}) {
  const long = direction === "LONG";
  const entries = (long ? scan?.long : scan?.short) ?? [];

  return (
    <GlassCard
      title={
        <span className={long ? "text-bull" : "text-bear"}>
          {long ? "▲ Top LONG Opportunities" : "▼ Top SHORT Opportunities"}
        </span>
      }
      action={
        scan ? (
          <span className="font-mono text-[10px] text-slate-500">
            {entries.length} qualifying · {scan.timeframe}
          </span>
        ) : null
      }
    >
      {entries.length === 0 ? (
        <EmptyNote>
          {!scan
            ? loading
              ? "Scanning…"
              : "Scan unavailable."
            : `No ${direction} setup cleared ${scan.minConfidence}% on ${scan.timeframe} out of ${scan.scanned} coins scanned. An empty side is a reading, not a gap.`}
        </EmptyNote>
      ) : (
        <ul className="space-y-2 p-3">
          {entries.slice(0, limit).map((e, i) => (
            <li key={e.symbol}>
              <SetupCard entry={e} rank={i + 1} compact />
            </li>
          ))}
        </ul>
      )}
    </GlassCard>
  );
}
