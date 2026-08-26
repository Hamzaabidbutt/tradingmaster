"use client";

import { useCallback, useState } from "react";
import AppShell from "@/components/layout/AppShell";
import { GlassCard, timeAgo } from "@/components/ui/primitives";
import { EmptyNote, ScanTimeframe, SCAN_TIMEFRAMES, useOpenInTerminal } from "@/components/dashboard/shared";
import { LiquidationReversalSetup } from "@/engines/types";

interface Entry {
  symbol: string;
  label: string;
  timeframe: string;
  quoteVolume: number;
  priceChangePercent: number | null;
  setup: LiquidationReversalSetup;
}

interface ScanResult {
  timeframe: string;
  bottoms: Entry[];
  tops: Entry[];
  watching: Entry[];
  scanned: number;
  failed: number;
  scannedAt: number;
  error?: string;
}

/**
 * Liquidation Spikes.
 *
 * Finds coins where a burst of forced flow has just printed at an extreme, then
 * reports the two things that decide whether it matters: how far price reversed
 * afterwards, and whether the flow was genuinely forced.
 *
 * The forced/inferred distinction is shown on every row, not in a footnote.
 * Binance serves no historical forced-order data over REST, so a universe sweep
 * infers forced volume from the bar's signature. That is a weaker claim than
 * reading it off the tape, and a panel that presented the two identically would
 * be overstating what it knows.
 */
export default function LiquidationsPage() {
  const [timeframe, setTimeframe] = useState<ScanTimeframe>("15m");
  const [data, setData] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const openTerminal = useOpenInTerminal();

  const run = useCallback(async (tf: ScanTimeframe) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/scan/liquidations?timeframe=${tf}`, { cache: "no-store" });
      const json = (await res.json()) as ScanResult;
      setData(json);
      if (json.error) setError(json.error);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const bottoms = data?.bottoms ?? [];
  const tops = data?.tops ?? [];
  const watching = data?.watching ?? [];

  return (
    <AppShell>
      <div className="space-y-3 p-3 md:p-4">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-lg font-bold tracking-tight text-slate-100">
            Liquidation <span className="text-neon-cyan">Spikes</span>
          </h1>
          <p className="text-[11px] text-slate-500">
            Forced flow at an extreme, and the reversal it produced.
          </p>
        </header>

        <GlassCard
          title={
            <span className="flex items-center gap-2">
              💥 Liquidation spike reversal scanner
              {data && (
                <span className="font-mono text-[10px] font-normal text-slate-500">
                  {bottoms.length + tops.length} at an extreme · {data.scanned} scanned ·{" "}
                  {timeAgo(data.scannedAt)}
                </span>
              )}
            </span>
          }
        >
          <div className="p-3">
            <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
              Forced flow is price-insensitive — a margin engine closes because collateral ran out,
              not because it has a view — so it is finite by construction. When it lands at the
              extreme of a move and price holds, the pressure that made the extreme has been spent.
              A spike halfway down is just a fast leg of a decline, and is filed under{" "}
              <em>watching</em> rather than treated as a reversal.
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
                className="rounded-lg bg-neon-amber/15 px-3 py-1.5 text-[11px] font-semibold text-neon-amber transition-colors hover:bg-neon-amber/25 disabled:opacity-50"
              >
                {loading ? "Scanning…" : `Scan ${timeframe} for liquidation spikes`}
              </button>
            </div>

            {error && (
              <p className="mt-2 rounded-lg border border-bear/30 bg-bear/5 px-2 py-1.5 text-[10px] text-bear">
                {error}
              </p>
            )}

            {!data && !loading && (
              <div className="mt-3">
                <EmptyNote>Pick a timeframe and run the sweep.</EmptyNote>
              </div>
            )}

            {data && (
              <div className="mt-3 grid gap-3 lg:grid-cols-2">
                <Column
                  title="Long flush at the low"
                  tone="bull"
                  entries={bottoms}
                  empty={`No long flush has printed at a low on ${data.timeframe}.`}
                  expanded={expanded}
                  setExpanded={setExpanded}
                  onOpenTerminal={openTerminal}
                />
                <Column
                  title="Short squeeze at the high"
                  tone="bear"
                  entries={tops}
                  empty={`No short squeeze has printed at a high on ${data.timeframe}.`}
                  expanded={expanded}
                  setExpanded={setExpanded}
                  onOpenTerminal={openTerminal}
                />
              </div>
            )}

            {watching.length > 0 && (
              <div className="mt-3">
                <div className="pb-1 text-[9px] uppercase tracking-[0.14em] text-slate-600">
                  Watching — spiked, but mid-move or no reversal yet
                </div>
                <div className="space-y-1.5">
                  {watching.map((e) => (
                    <SpikeRow
                      key={e.symbol}
                      entry={e}
                      muted
                      open={expanded === e.symbol}
                      onToggle={() => setExpanded(expanded === e.symbol ? null : e.symbol)}
                      onOpenTerminal={() => openTerminal(e.symbol, e.timeframe)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </GlassCard>
      </div>
    </AppShell>
  );
}

function Column({
  title,
  tone,
  entries,
  empty,
  expanded,
  setExpanded,
  onOpenTerminal,
}: {
  title: string;
  tone: "bull" | "bear";
  entries: Entry[];
  empty: string;
  expanded: string | null;
  setExpanded: (v: string | null) => void;
  onOpenTerminal: (symbol: string, timeframe: string) => void;
}) {
  return (
    <div>
      <div className={`pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${tone === "bull" ? "text-bull" : "text-bear"}`}>
        {title} <span className="font-mono text-slate-600">{entries.length}</span>
      </div>
      <div className="space-y-1.5">
        {entries.length === 0 ? (
          <EmptyNote>{empty}</EmptyNote>
        ) : (
          entries.map((e) => (
            <SpikeRow
              key={e.symbol}
              entry={e}
              open={expanded === e.symbol}
              onToggle={() => setExpanded(expanded === e.symbol ? null : e.symbol)}
              onOpenTerminal={() => onOpenTerminal(e.symbol, e.timeframe)}
            />
          ))
        )}
      </div>
    </div>
  );
}

const FORCED_STYLE: Record<LiquidationReversalSetup["forced"], string> = {
  confirmed: "bg-bull/15 text-bull",
  inferred: "bg-neon-amber/15 text-neon-amber",
  unlikely: "bg-white/5 text-slate-500",
};

const FORCED_LABEL: Record<LiquidationReversalSetup["forced"], string> = {
  confirmed: "forced · measured",
  inferred: "forced · inferred",
  unlikely: "not forced",
};

function SpikeRow({
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
  const flush = s.spike?.side === "long";
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
          <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${gradeColor}`}>
            {s.grade}
          </span>
          <span className="font-mono text-[11px] text-neon-cyan">{s.score}</span>
          <span className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${FORCED_STYLE[s.forced]}`}>
            {FORCED_LABEL[s.forced]}
          </span>
          {s.spike && (
            <span className={`font-mono text-[10px] ${flush ? "text-bear" : "text-bull"}`}>
              {flush ? "long flush" : "short squeeze"} · {s.spike.multiple.toFixed(1)}×
            </span>
          )}
          <span className="font-mono text-[10px] text-slate-500">{entry.timeframe}</span>
          <span className={`font-mono text-[10px] ${s.reversalPct > 0 ? "text-bull" : "text-slate-500"}`}>
            {s.reversalPct >= 0 ? "+" : ""}
            {s.reversalPct.toFixed(2)}% reversal
          </span>
          <span className="font-mono text-[10px] text-slate-600">
            peak {s.peakReversalPct.toFixed(2)}%
          </span>
          <span className="ml-auto text-[9px] text-slate-600">{open ? "▲" : "▼"}</span>
        </div>
        <p className="mt-0.5 text-[10px] text-slate-400">{s.headline}</p>
      </button>

      {open && (
        <div className="animate-slide-up border-t border-white/5 px-2.5 py-2">
          <div className="mb-2 grid grid-cols-2 gap-1.5 font-mono text-[10px] sm:grid-cols-4">
            <Cell label="Price" value={fmt(s.price)} />
            <Cell
              label={flush ? "Flush low" : "Squeeze high"}
              value={s.spike ? fmt(s.spike.extreme) : "—"}
              tone="bear"
            />
            <Cell label="Forced size" value={s.spike ? fmt(s.spike.volume) : "—"} />
            <Cell label="Target" value={s.target != null ? fmt(s.target) : "—"} tone="bull" />
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

function Cell({ label, value, tone }: { label: string; value: string; tone?: "bull" | "bear" }) {
  const color = tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : "text-slate-200";
  return (
    <div className="rounded bg-white/[0.03] px-1.5 py-1">
      <div className="text-[8px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={color}>{value}</div>
    </div>
  );
}

function fmt(v: number): string {
  return v.toFixed(v >= 1000 ? 1 : v >= 1 ? 4 : 6).replace(/0+$/, "").replace(/\.$/, "");
}
