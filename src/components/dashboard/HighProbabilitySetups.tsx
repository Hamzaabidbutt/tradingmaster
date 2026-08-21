"use client";

import { GlassCard, timeAgo } from "@/components/ui/primitives";
import SetupCard from "./SetupCard";
import { SCAN_TIMEFRAMES, ScanTimeframe, SideBadge, fmtPct } from "./shared";
import type { UniverseScanDto } from "@/hooks/useDashboard";

/**
 * Block 3 — 🔥 High Probability Setups.
 *
 * The setups where more than one *independent* method agrees, ranked strongest
 * first across both directions in one list — a strong SHORT outranks a weaker
 * LONG, because the point is the best setup on the board, not the best bullish
 * one.
 *
 * The empty state is the feature. "None of the 527 coins scanned met the 70%
 * threshold" is a finding, and printing the three that came closest with the
 * reason each fell short is what makes it a finding rather than a blank panel.
 */
export default function HighProbabilitySetups({
  scan,
  timeframe,
  onTimeframe,
  loading,
  error,
  onRefresh,
}: {
  scan: UniverseScanDto | null;
  timeframe: ScanTimeframe;
  onTimeframe: (tf: ScanTimeframe) => void;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  // One board, both directions, strongest first.
  const ranked = scan
    ? [...scan.long, ...scan.short].sort((a, b) => b.setup.confidence - a.setup.confidence)
    : [];

  return (
    <GlassCard
      title={<span className="text-neon-amber">🔥 High Probability Setups</span>}
      action={
        <div className="flex items-center gap-1.5">
          {SCAN_TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              onClick={() => onTimeframe(tf)}
              className={`rounded px-2 py-0.5 font-mono text-[10px] transition-colors ${
                tf === timeframe
                  ? "bg-neon-cyan/15 font-semibold text-neon-cyan"
                  : "text-slate-500 hover:bg-white/5 hover:text-slate-300"
              }`}
              aria-pressed={tf === timeframe}
            >
              {tf}
            </button>
          ))}
          <button
            onClick={onRefresh}
            className="ml-1 rounded px-1.5 py-0.5 text-[11px] text-slate-500 transition-colors hover:text-neon-cyan"
            title="Re-scan now"
            aria-label="Re-scan now"
          >
            ↻
          </button>
        </div>
      }
    >
      <div className="space-y-3 p-3">
        {!scan ? (
          <p className="py-6 text-center text-xs text-slate-500">
            {loading
              ? `Scanning the universe on ${timeframe}…`
              : `Scan unavailable${error ? ` — ${error}` : ""}.`}
          </p>
        ) : ranked.length === 0 ? (
          <NoSetupState scan={scan} />
        ) : (
          <>
            <ul className="space-y-2.5">
              {ranked.map((e, i) => (
                <li key={`${e.symbol}-${e.timeframe}`}>
                  <SetupCard entry={e} rank={i + 1} />
                </li>
              ))}
            </ul>
            <p className="text-[10px] leading-relaxed text-slate-600">
              {ranked.length} setup{ranked.length === 1 ? "" : "s"} cleared the{" "}
              {scan.minConfidence}% confluence threshold with at least two independent methods
              agreeing. {scan.noTradeCount} coin{scan.noTradeCount === 1 ? "" : "s"} returned NO
              TRADE.
            </p>
          </>
        )}

        {scan && <CoverageLine scan={scan} />}
      </div>
    </GlassCard>
  );
}

/**
 * The explicit no-setup answer.
 *
 * Deliberately worded as a conclusion about the market rather than an error
 * about the app, and it names the threshold so the reader can judge it.
 */
function NoSetupState({ scan }: { scan: UniverseScanDto }) {
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-slate-600/30 bg-slate-500/[0.05] px-4 py-4 text-center">
        <p className="text-sm font-bold uppercase tracking-wider text-slate-300">
          No trade / no high-probability setup
        </p>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">
          {scan.scanned} coin{scan.scanned === 1 ? "" : "s"} scanned on {scan.timeframe}; none met
          the {scan.minConfidence}% confluence threshold with two independent methods agreeing.
          Nothing is forced simply because the market is moving.
        </p>
      </div>

      {scan.nearMisses.length > 0 && (
        <div>
          <h5 className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            Closest calls — and why each fell short
          </h5>
          <ul className="space-y-1.5">
            {scan.nearMisses.map((e) => {
              const leaning =
                e.setup.long.confidence >= e.setup.short.confidence ? "LONG" : "SHORT";
              return (
                <li
                  key={e.symbol}
                  className="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold text-slate-300">{e.label}</span>
                    <SideBadge side={leaning as "LONG" | "SHORT"} />
                    <span className="font-mono text-[11px] text-slate-400">
                      {e.setup.confidence.toFixed(0)}%
                    </span>
                    <span className="ml-auto font-mono text-[10px] text-slate-600">
                      {fmtPct(e.priceChangePercent)}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                    {e.setup.noTradeReason ?? "Below threshold."}
                  </p>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Honest coverage: what was scanned live, what came from the worker, what is missing. */
function CoverageLine({ scan }: { scan: UniverseScanDto }) {
  const { onDemand, persisted, universe } = scan.coverage;
  const covered = onDemand + persisted;
  return (
    <p className="border-t border-white/5 pt-2 font-mono text-[10px] leading-relaxed text-slate-600">
      {onDemand} scanned on demand
      {persisted > 0 && ` · ${persisted} from the background worker`} · {covered} of {universe}{" "}
      pairs covered · updated {timeAgo(scan.scannedAt)}
      {scan.partial && (
        <span className="text-neon-amber">
          {" "}
          · {scan.failed} symbol{scan.failed === 1 ? "" : "s"} could not be read, so coverage is
          incomplete
        </span>
      )}
      {scan.error && <span className="text-bear"> · {scan.error}</span>}
    </p>
  );
}
