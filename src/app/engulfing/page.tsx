"use client";

import { useCallback, useState } from "react";
import AppShell from "@/components/layout/AppShell";
import { GlassCard, timeAgo } from "@/components/ui/primitives";
import {
  EmptyNote,
  ScanTimeframe,
  SCAN_TIMEFRAMES,
  fmtPrice,
  useOpenInTerminal,
} from "@/components/dashboard/shared";
import { EngulfingSetup } from "@/engines/types";

interface Entry {
  symbol: string;
  label: string;
  timeframe: string;
  quoteVolume: number;
  priceChangePercent: number | null;
  setup: EngulfingSetup;
}

interface ScanResult {
  timeframe: string;
  confirmed: Entry[];
  unconfirmed: Entry[];
  scanned: number;
  failed: number;
  scannedAt: number;
  error?: string;
}

/**
 * Bullish engulfing sweep.
 *
 * The pattern alone is close to worthless — on any given 4h close a few dozen
 * perpetuals will print one — so the page is built around the filter rather
 * than the shape. Two lists: bars where flow, location and structure agree,
 * and bars where the shape is there and something behind it is not.
 *
 * The second list is shown rather than dropped. Seeing what was rejected, and
 * on what grounds, is how a filter earns trust; a scanner that only ever shows
 * its winners is asking to be believed.
 */
export default function EngulfingPage() {
  const [timeframe, setTimeframe] = useState<ScanTimeframe>("4h");
  const [data, setData] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const openTerminal = useOpenInTerminal();

  const run = useCallback(async (tf: ScanTimeframe) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/scan/engulfing?timeframe=${tf}`, { cache: "no-store" });
      const json = (await res.json()) as ScanResult;
      setData(json);
      if (json.error) setError(json.error);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const confirmed = data?.confirmed ?? [];
  const unconfirmed = data?.unconfirmed ?? [];

  return (
    <AppShell>
      <div className="space-y-3 p-3 md:p-4">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-lg font-bold tracking-tight text-slate-100">
            Bullish <span className="text-neon-cyan">Engulfing</span>
          </h1>
          <p className="text-[11px] text-slate-500">
            Coins whose last closed {timeframe} bar swallowed the one before it.
          </p>
        </header>

        <GlassCard
          title={
            <span className="flex items-center gap-2">
              🟩 Engulfing scanner
              {data && (
                <span className="font-mono text-[10px] font-normal text-slate-500">
                  {confirmed.length} confirmed · {data.scanned} scanned · {timeAgo(data.scannedAt)}
                </span>
              )}
            </span>
          }
        >
          <div className="p-3">
            <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
              Scored on the <em>last closed</em> bar, never the forming one — an engulfing that has
              not closed is not an engulfing, and half of what the pattern claims is that the close
              held. Four things decide whether it matters: how completely it engulfs (body, or the
              whole range including wicks), whether taker delta was positive (a bar can close up
              because buyers arrived, or merely because the seller stopped), whether it happened at
              mapped support or in open space, and whether it runs with the trend or against it.
            </p>

            <div className="flex flex-wrap items-center gap-2">
              <div className="flex flex-wrap gap-0.5 rounded-lg bg-white/5 p-0.5">
                {SCAN_TIMEFRAMES.map((tf) => (
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
                {loading ? "Scanning…" : `Scan ${timeframe} for bullish engulfing`}
              </button>
            </div>

            {error && (
              <p className="mt-2 rounded-lg border border-bear/30 bg-bear/5 px-2 py-1.5 text-[10px] text-bear">
                {error}
              </p>
            )}

            {!data && !loading && (
              <div className="mt-3">
                <EmptyNote>Pick a timeframe and run the sweep. 4h is the default.</EmptyNote>
              </div>
            )}

            {data && (
              <div className="mt-3 space-y-3">
                <section>
                  <div className="pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-bull">
                    Confirmed <span className="font-mono text-slate-600">{confirmed.length}</span>
                  </div>
                  <div className="space-y-1.5">
                    {confirmed.length === 0 ? (
                      <EmptyNote>
                        No engulfing bar on {data.timeframe} cleared the filter. Common, and not a
                        fault — most of them do not.
                      </EmptyNote>
                    ) : (
                      confirmed.map((e) => (
                        <Row
                          key={e.symbol}
                          entry={e}
                          open={expanded === e.symbol}
                          onToggle={() => setExpanded(expanded === e.symbol ? null : e.symbol)}
                          onOpenTerminal={() => openTerminal(e.symbol, e.timeframe)}
                        />
                      ))
                    )}
                  </div>
                </section>

                {unconfirmed.length > 0 && (
                  <section>
                    <div className="pb-1 text-[9px] uppercase tracking-[0.14em] text-slate-600">
                      Pattern printed, filter not cleared — shown so the rejection is visible
                    </div>
                    <div className="space-y-1.5">
                      {unconfirmed.map((e) => (
                        <Row
                          key={e.symbol}
                          entry={e}
                          muted
                          open={expanded === e.symbol}
                          onToggle={() => setExpanded(expanded === e.symbol ? null : e.symbol)}
                          onOpenTerminal={() => openTerminal(e.symbol, e.timeframe)}
                        />
                      ))}
                    </div>
                  </section>
                )}
              </div>
            )}
          </div>
        </GlassCard>
      </div>
    </AppShell>
  );
}

function Row({
  entry,
  open,
  onToggle,
  onOpenTerminal,
  muted,
}: {
  entry: Entry;
  open: boolean;
  onToggle: () => void;
  onOpenTerminal: () => void;
  muted?: boolean;
}) {
  const s = entry.setup;
  const gradeColor =
    s.grade === "prime"
      ? "bg-neon-cyan/20 text-neon-cyan"
      : s.grade === "strong"
        ? "bg-neon-cyan/10 text-neon-cyan"
        : "bg-white/5 text-slate-400";

  return (
    <div className={`rounded-lg border border-white/5 bg-white/[0.02] ${muted ? "opacity-70" : ""}`}>
      <button onClick={onToggle} className="w-full px-2.5 py-2 text-left" aria-expanded={open}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-slate-200">
            {entry.symbol.replace(/USDT$/, "/USDT")}
          </span>
          <span
            className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${gradeColor}`}
          >
            {s.grade}
          </span>
          <span className="font-mono text-[11px] text-neon-cyan">{s.score}</span>
          <span className="font-mono text-[10px] text-slate-400">{s.bodyRatio.toFixed(1)}× body</span>
          {s.fullRange && (
            <span className="rounded bg-bull/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-bull">
              full range
            </span>
          )}
          <span
            className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${
              s.deltaConfirms ? "bg-bull/15 text-bull" : "bg-bear/15 text-bear"
            }`}
          >
            {s.deltaConfirms ? "delta confirms" : "delta against"}
          </span>
          {s.atSupport && (
            <span className="rounded bg-neon-amber/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-neon-amber">
              on support
            </span>
          )}
          <span className="font-mono text-[10px] text-slate-500">{entry.timeframe}</span>
          <span
            className="font-mono text-[10px] text-slate-400"
            title={`Bar opened ${localDateTime(s.time)} (your local time)`}
          >
            🕒 {localDateTime(s.time)}
          </span>
          <span className="ml-auto text-[9px] text-slate-600">{open ? "▲" : "▼"}</span>
        </div>
        <p className="mt-0.5 text-[10px] text-slate-400">{s.headline}</p>
      </button>

      {open && (
        <div className="animate-slide-up border-t border-white/5 px-2.5 py-2">
          <div className="mb-2 grid grid-cols-2 gap-1.5 font-mono text-[10px] sm:grid-cols-4">
            <Cell label="Bar close" value={fmtPrice(s.entry)} />
            <Cell label="Price now" value={fmtPrice(s.price)} />
            <Cell label="Invalidation" value={fmtPrice(s.invalidation)} tone="bear" />
            <Cell label="Objective" value={fmtPrice(s.target)} tone="bull" />
            <Cell label="Bar delta" value={s.delta.toFixed(0)} tone={s.delta > 0 ? "bull" : "bear"} />
            <Cell label="Structure" value={s.trend} />
          </div>

          <ul className="space-y-1">
            {s.explanation.map((line, i) => (
              <li key={i} className="text-[10px] leading-relaxed text-slate-400">
                {line}
              </li>
            ))}
          </ul>

          <button
            onClick={onOpenTerminal}
            className="mt-2 rounded-md bg-neon-cyan/10 px-2 py-1 text-[10px] font-semibold text-neon-cyan hover:bg-neon-cyan/20"
          >
            Open in terminal →
          </button>
        </div>
      )}
    </div>
  );
}

function Cell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "bull" | "bear";
}) {
  const color = tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : "text-slate-200";
  return (
    <div className="rounded bg-white/[0.03] px-1.5 py-1">
      <div className="text-[8px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={color}>{value}</div>
    </div>
  );
}

/** The bar's own clock time, in the reader's timezone rather than the server's. */
function localDateTime(unixSeconds: number): string {
  if (!unixSeconds) return "—";
  const d = new Date(unixSeconds * 1000);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}
