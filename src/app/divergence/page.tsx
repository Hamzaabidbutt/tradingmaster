"use client";

import { useCallback, useMemo, useState } from "react";
import AppShell from "@/components/layout/AppShell";
import {
  GlassCard,
  LocalZone,
  ScanTimestamp,
  localStamp,
  localTime,
  localZone,
  timeAgo,
} from "@/components/ui/primitives";
import { EmptyNote, fmtPrice, useOpenInTerminal } from "@/components/dashboard/shared";
import { TIMEFRAMES, Timeframe } from "@/lib/config";

interface Row {
  source: "rsi" | "cvd";
  symbol: string;
  label: string;
  timeframe: string;
  quoteVolume: number;
  priceChangePercent: number | null;
  barTime: number;
  price: number;
  at: number;
  kind: string;
  side: "long" | "short";
  regular: boolean;
  pricePct: number;
  indicatorDelta: number;
  indicatorUnit: string;
  barsApart: number;
  strength: number;
  kindLabel: string;
  note: string;
}

interface ScanResult {
  timeframe: string;
  rows: Row[];
  scanned: number;
  noDivergence: number;
  failed_count: number;
  scannedAt: number;
  error?: string;
}

type Filter = "all" | "rsi" | "cvd";

/**
 * RSI and CVD divergence, in one list, newest first.
 *
 * Two scanners rather than one because they disagree for different reasons:
 * RSI measures how one-sided recent *closes* have been, CVD measures who
 * actually crossed the spread. A move can lose momentum without losing
 * aggression, or the reverse, and the two readings are worth seeing side by
 * side for exactly that reason.
 *
 * Ordered by when the divergence *completed* — the later of its two pivots —
 * not by when the sweep noticed it and not by strength. A divergence that
 * formed thirty bars ago is thirty bars old however recently it was found, and
 * sorting by score would quietly turn a recency page into a ranking page.
 */
export default function DivergencePage() {
  const [timeframe, setTimeframe] = useState<Timeframe>("1h");
  const [filter, setFilter] = useState<Filter>("all");
  const [data, setData] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const openTerminal = useOpenInTerminal();

  const run = useCallback(async (tf: Timeframe) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/scan/divergence?timeframe=${tf}`, { cache: "no-store" });
      const json = (await res.json()) as ScanResult;
      setData(json);
      if (json.error) setError(json.error);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  /* Filtered in the browser rather than refetched. Both indicators come from
     the same klines call, so a source toggle that re-swept would pay the whole
     universe cost again to show a subset of what is already loaded. */
  const rows = useMemo(
    () => (data ? data.rows.filter((r) => filter === "all" || r.source === filter) : []),
    [data, filter]
  );

  const counts = useMemo(() => {
    const all = data?.rows ?? [];
    return {
      all: all.length,
      rsi: all.filter((r) => r.source === "rsi").length,
      cvd: all.filter((r) => r.source === "cvd").length,
    };
  }, [data]);

  return (
    <AppShell>
      <div className="space-y-3 p-3 md:p-4">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-lg font-bold tracking-tight text-slate-100">
            Divergence <span className="text-neon-cyan">Finder</span>
          </h1>
          <p className="text-[11px] text-slate-500">
            Price disagreeing with RSI or cumulative delta, newest first, on your clock.
          </p>
        </header>

        <GlassCard
          title={
            <span className="flex items-center gap-2">
              🔀 RSI &amp; CVD divergence
              {data && (
                <span className="font-mono text-[10px] font-normal text-slate-500">
                  {counts.all} found · {data.scanned} scanned ·{" "}
                  <ScanTimestamp at={data.scannedAt} />
                </span>
              )}
            </span>
          }
        >
          <div className="p-3">
            <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
              Two indicators, because they disagree for different reasons.{" "}
              <strong className="text-slate-400">RSI</strong> measures how one-sided recent closes
              have been; <strong className="text-slate-400">CVD</strong> measures who actually
              crossed the spread. A push can lose momentum without losing aggression, or the
              reverse, and seeing both is the point of running them together.
            </p>
            <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
              Only the last two pivots on each side are compared. Reaching further back for a pair
              that happens to disagree is how a divergence scanner ends up finding one on
              literally every chart — with enough pivots, some pair always diverges.{" "}
              <strong className="text-slate-400">Regular</strong> divergence is the reversal
              reading; <strong className="text-slate-400">hidden</strong> is read as continuation
              and points the opposite way, so the two are labelled separately rather than merged.
            </p>
            <p className="mb-2 rounded-lg border border-neon-amber/25 bg-neon-amber/5 px-2 py-1.5 text-[10px] leading-relaxed text-neon-amber">
              Divergence is the most over-traded pattern in technical analysis, because it looks
              predictive while being among the least reliable things on a chart. Markets make
              higher highs on falling RSI for weeks, and many divergences end by ceasing to
              diverge rather than by turning. In a strong trend these fire almost continuously —
              which is precisely when acting on them costs most. Treat a row as a reason to demand
              more evidence, never as a reason to take the other side.
            </p>

            <div className="flex flex-wrap items-center gap-2">
              <div className="flex flex-wrap gap-0.5 rounded-lg bg-white/5 p-0.5">
                {TIMEFRAMES.map((tf) => (
                  <button
                    key={tf}
                    onClick={() => setTimeframe(tf)}
                    aria-pressed={timeframe === tf}
                    className={`rounded-md px-2 py-1 font-mono text-[10px] transition-colors ${
                      timeframe === tf
                        ? "bg-neon-cyan/15 font-bold text-neon-cyan"
                        : "text-slate-500 hover:text-slate-300"
                    }`}
                  >
                    {tf}
                  </button>
                ))}
              </div>
              <button
                onClick={() => run(timeframe)}
                disabled={loading}
                className="rounded-lg bg-neon-cyan/15 px-3 py-1.5 text-[11px] font-semibold text-neon-cyan transition-colors hover:bg-neon-cyan/25 disabled:opacity-50"
              >
                {loading ? "Scanning…" : `Scan ${timeframe} for divergence`}
              </button>
            </div>

            {data && (
              <div className="mt-2 flex flex-wrap gap-0.5 rounded-lg bg-white/5 p-0.5">
                {(
                  [
                    ["all", `Both · ${counts.all}`],
                    ["rsi", `RSI · ${counts.rsi}`],
                    ["cvd", `CVD · ${counts.cvd}`],
                  ] as const
                ).map(([key, text]) => (
                  <button
                    key={key}
                    onClick={() => setFilter(key)}
                    aria-pressed={filter === key}
                    className={`rounded-md px-2.5 py-1 font-mono text-[10px] transition-colors ${
                      filter === key
                        ? "bg-neon-violet/20 font-bold text-neon-violet"
                        : "text-slate-500 hover:text-slate-300"
                    }`}
                  >
                    {text}
                  </button>
                ))}
              </div>
            )}

            <p className="mt-1.5 text-[10px] leading-relaxed text-slate-600">
              Every timeframe is offered, and the times below are your own —{" "}
              <span className="font-mono">
                <LocalZone />
              </span>
              . Rows are ordered by when the
              divergence <em>completed</em>, meaning the later of its two pivots, not by when the
              sweep found it and not by strength.
            </p>

            {error && (
              <p className="mt-2 rounded-lg border border-bear/30 bg-bear/5 px-2 py-1.5 text-[10px] text-bear">
                {error}
              </p>
            )}

            {!data && !loading && (
              <div className="mt-3">
                <EmptyNote>
                  Pick a timeframe and run the sweep. Nothing is fetched until you do.
                </EmptyNote>
              </div>
            )}

            {data && (
              <div className="mt-3 space-y-1.5">
                {rows.length === 0 ? (
                  <EmptyNote>
                    {counts.all === 0
                      ? "No divergence on any scanned symbol at this timeframe. On a trending session that is the normal answer."
                      : "Nothing from this indicator. Try the other tab."}
                  </EmptyNote>
                ) : (
                  rows.map((r) => {
                    const id = `${r.source}-${r.symbol}-${r.at}`;
                    return (
                      <RowCard
                        key={id}
                        row={r}
                        open={expanded === id}
                        onToggle={() => setExpanded(expanded === id ? null : id)}
                        onOpenTerminal={() => openTerminal(r.symbol, r.timeframe)}
                      />
                    );
                  })
                )}

                <p className="pt-1 text-[10px] text-slate-600">
                  {data.noDivergence} symbol{data.noDivergence === 1 ? "" : "s"} had neither
                  indicator disagreeing with price.
                  {data.failed_count > 0 && <> {data.failed_count} could not be read.</>}
                </p>
              </div>
            )}
          </div>
        </GlassCard>
      </div>
    </AppShell>
  );
}

function RowCard({
  row,
  open,
  onToggle,
  onOpenTerminal,
}: {
  row: Row;
  open: boolean;
  onToggle: () => void;
  onOpenTerminal: () => void;
}) {
  const long = row.side === "long";
  const tone = long ? "text-bull" : "text-bear";

  return (
    <div className="rounded-lg border border-white/5 bg-white/[0.02]">
      <button onClick={onToggle} className="w-full px-2.5 py-2 text-left" aria-expanded={open}>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider ${
              row.source === "rsi"
                ? "bg-neon-cyan/15 text-neon-cyan"
                : "bg-neon-violet/15 text-neon-violet"
            }`}
          >
            {row.source}
          </span>
          <span className="text-xs font-semibold text-slate-200">
            {row.symbol.replace(/USDT$/, "/USDT")}
          </span>
          {/* Local time on every row, with the full stamp and zone on hover —
              the ordering claim of this page is recency, so the timestamp is
              part of the row rather than a detail hidden behind a click. */}
          <span
            className="font-mono text-[10px] text-slate-300"
            title={`Divergence completed ${localStamp(row.at)} (${localZone()})`}
          >
            {localTime(row.at)}
          </span>
          <span className="font-mono text-[9px] text-slate-600">{timeAgo(row.at)}</span>
          <span className={`font-mono text-[11px] font-bold ${tone}`}>
            {long ? "▲" : "▼"} {row.kindLabel}
          </span>
          {!row.regular && (
            <span
              className="rounded bg-white/5 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-slate-400"
              title="Continuation reading, not reversal — points the opposite way to a regular divergence."
            >
              continuation
            </span>
          )}
          <span className="font-mono text-[11px] text-neon-cyan">{row.strength}</span>
        </div>
      </button>

      {open && (
        <div className="border-t border-white/5 px-2.5 py-2">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] sm:grid-cols-3">
            <Stat label="Completed" value={`${localTime(row.at)} · ${timeAgo(row.at)}`} />
            <Stat label="Date" value={localStamp(row.at)} />
            <Stat label="Timeframe" value={row.timeframe} />
            <Stat label="Price move" value={`${row.pricePct >= 0 ? "+" : ""}${row.pricePct.toFixed(2)}%`} />
            <Stat
              label={row.source === "rsi" ? "RSI move" : "CVD move"}
              value={`${row.indicatorDelta >= 0 ? "+" : ""}${row.indicatorDelta.toFixed(1)} ${row.indicatorUnit}`}
            />
            <Stat label="Pivots apart" value={`${row.barsApart} bars`} />
            <Stat label="Last price" value={fmtPrice(row.price)} />
            <Stat label="Strength" value={String(row.strength)} />
            <Stat label="Reading" value={row.regular ? "reversal" : "continuation"} />
          </div>

          <p className="mt-2 text-[10px] leading-relaxed text-slate-500">{row.note}</p>

          <button
            onClick={onOpenTerminal}
            className="mt-2 rounded-md bg-white/5 px-2 py-1 text-[10px] text-slate-300 transition-colors hover:bg-white/10"
          >
            Open in terminal →
          </button>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-slate-600">{label}</span>
      <span className="font-mono text-slate-300">{value}</span>
    </div>
  );
}
