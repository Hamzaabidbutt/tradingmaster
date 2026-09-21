"use client";

import { ReactNode, useCallback, useState } from "react";
import {
  GlassCard,
  LocalZone,
  ScanTimestamp,
  localStamp,
  localTime,
  localTimeOrDate,
  localZone,
  timeAgo,
} from "@/components/ui/primitives";
import { EmptyNote, fmtPrice, useOpenInTerminal } from "@/components/dashboard/shared";
import { TIMEFRAMES, Timeframe } from "@/lib/config";

export interface DivergenceRow {
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

export interface DivergenceScanResult {
  timeframe: string;
  rsiPeriod: number;
  rows: DivergenceRow[];
  scanned: number;
  noDivergence: number;
  failed_count: number;
  scannedAt: number;
  error?: string;
}

/**
 * The shared body of both divergence scanners.
 *
 * The two pages differ in which indicator they sweep and in what is worth
 * saying about it; everything else — the timeframe row, the ordering, the
 * local-time stamps, the row card — is identical, and identical is the point.
 * Two copies of this would drift the moment either page was touched, and the
 * drift would be invisible: both would still render rows, just not the same
 * way.
 */
export default function DivergenceScanner({
  source,
  icon,
  cardTitle,
  intro,
  emptyNote,
  accent,
}: {
  source: "rsi" | "cvd";
  icon: string;
  cardTitle: string;
  /** what is worth knowing about *this* indicator, above the controls */
  intro: ReactNode;
  /** what an empty result means for this indicator specifically */
  emptyNote: string;
  accent: "cyan" | "violet";
}) {
  const [timeframe, setTimeframe] = useState<Timeframe>("1h");
  const [period, setPeriod] = useState(14);
  const [data, setData] = useState<DivergenceScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const openTerminal = useOpenInTerminal();

  const run = useCallback(
    async (tf: Timeframe, rsiPeriod: number) => {
      setLoading(true);
      setError(null);
      try {
        const url =
          `/api/scan/divergence?timeframe=${tf}&source=${source}` +
          (source === "rsi" ? `&period=${rsiPeriod}` : "");
        const res = await fetch(url, { cache: "no-store" });
        const json = (await res.json()) as DivergenceScanResult;
        setData(json);
        if (json.error) setError(json.error);
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    },
    [source]
  );

  /* Written out in full rather than interpolated. Tailwind generates classes
     by scanning source text for literal names, so `bg-${tone}/15` produces no
     class at all — it simply renders unstyled, which is the kind of bug that
     looks like a design choice. */
  const styles =
    accent === "cyan"
      ? {
          tfOn: "bg-neon-cyan/15 font-bold text-neon-cyan",
          button: "bg-neon-cyan/15 text-neon-cyan hover:bg-neon-cyan/25",
        }
      : {
          tfOn: "bg-neon-violet/20 font-bold text-neon-violet",
          button: "bg-neon-violet/20 text-neon-violet hover:bg-neon-violet/30",
        };

  return (
    <GlassCard
      title={
        <span className="flex items-center gap-2">
          {icon} {cardTitle}
          {data && (
            <span className="font-mono text-[10px] font-normal text-slate-500">
              {data.rows.length} found · {data.scanned} scanned ·{" "}
              <ScanTimestamp at={data.scannedAt} />
            </span>
          )}
        </span>
      }
    >
      <div className="p-3">
        {intro}

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-0.5 rounded-lg bg-white/5 p-0.5">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf}
                onClick={() => setTimeframe(tf)}
                aria-pressed={timeframe === tf}
                className={`rounded-md px-2 py-1 font-mono text-[10px] transition-colors ${
                  timeframe === tf ? styles.tfOn : "text-slate-500 hover:text-slate-300"
                }`}
              >
                {tf}
              </button>
            ))}
          </div>

          {source === "rsi" && (
            <label className="flex items-center gap-1.5 text-[10px] text-slate-500">
              RSI period
              <input
                type="number"
                min={2}
                max={50}
                value={period}
                onChange={(e) => setPeriod(Math.max(2, Math.min(50, Number(e.target.value) || 14)))}
                className="w-14 rounded-md border border-white/10 bg-white/5 px-1.5 py-1 font-mono text-[10px] text-slate-200"
              />
            </label>
          )}

          <button
            onClick={() => run(timeframe, period)}
            disabled={loading}
            className={`rounded-lg px-3 py-1.5 text-[11px] font-semibold transition-colors disabled:opacity-50 ${styles.button}`}
          >
            {loading ? "Scanning…" : `Scan ${timeframe}`}
          </button>
        </div>

        {source === "rsi" && period !== 14 && (
          <p className="mt-1.5 rounded-lg border border-neon-amber/25 bg-neon-amber/5 px-2 py-1.5 text-[10px] leading-relaxed text-neon-amber">
            Period {period}, not the default 14. Wilder&apos;s 14 is what every charting package
            draws, so a different lookback means these readings will not line up with the RSI on
            your own chart — which is fine if you meant it and confusing if you did not.
          </p>
        )}

        <p className="mt-1.5 text-[10px] leading-relaxed text-slate-600">
          Every timeframe is offered, and the times below are your own —{" "}
          <span className="font-mono">
            <LocalZone />
          </span>
          . Rows are ordered by when the divergence <em>completed</em>, meaning the later of its two
          pivots, not by when the sweep found it and not by strength.
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
            {data.rows.length === 0 ? (
              <EmptyNote>{emptyNote}</EmptyNote>
            ) : (
              data.rows.map((r) => {
                const id = `${r.symbol}-${r.at}-${r.kind}`;
                return (
                  <RowCard
                    key={id}
                    row={r}
                    open={expanded === id}
                    onToggle={() => setExpanded(expanded === id ? null : id)}
                    /* Opens with this scanner's own overlay switched on, so
                       the row's claim is actually drawn on the chart it links
                       to rather than left for the reader to find. */
                    onOpenTerminal={() =>
                      openTerminal(
                        r.symbol,
                        r.timeframe,
                        source === "rsi" ? "rsiDivergence" : "cvdDivergence"
                      )
                    }
                  />
                );
              })
            )}

            <p className="pt-1 text-[10px] text-slate-600">
              {data.noDivergence} symbol{data.noDivergence === 1 ? "" : "s"} showed no divergence on
              this indicator.
              {data.failed_count > 0 && <> {data.failed_count} could not be read.</>}
            </p>
          </div>
        )}
      </div>
    </GlassCard>
  );
}

function RowCard({
  row,
  open,
  onToggle,
  onOpenTerminal,
}: {
  row: DivergenceRow;
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
            {localTimeOrDate(row.at)}
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
            <Stat
              label="Price move"
              value={`${row.pricePct >= 0 ? "+" : ""}${row.pricePct.toFixed(2)}%`}
            />
            <Stat
              label="Indicator move"
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
