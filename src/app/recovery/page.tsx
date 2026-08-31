"use client";

import { useCallback, useState } from "react";
import AppShell from "@/components/layout/AppShell";
import { GlassCard, timeAgo } from "@/components/ui/primitives";
import {
  EmptyNote,
  fmtPrice,
  fmtVolume,
  useOpenInTerminal,
} from "@/components/dashboard/shared";
import { RecoverySetup } from "@/engines/types";

interface Entry {
  symbol: string;
  label: string;
  quoteVolume: number;
  priceChangePercent: number | null;
  setup: RecoverySetup;
}

interface ScanResult {
  candidates: Entry[];
  watching: Entry[];
  falling: Entry[];
  scanned: number;
  eligible: number;
  failed: number;
  scannedAt: number;
  error?: string;
}

/**
 * Deep-drawdown recovery scanner.
 *
 * Finds contracts a long way below their window high that are showing the
 * traces of accumulation rather than continued decline: a long base, a decline
 * that has stopped accelerating, higher lows, volume drying up, delta refusing
 * to follow price, open interest building at the lows.
 *
 * The page is built around a warning as much as a list, because the premise
 * invites the worst kind of thinking. An asset 90% down needs a 10x to get
 * back, and that arithmetic is seductive — but most assets 90% down go to 95%
 * down, and a scanner that ranked by drawdown alone would be a list of things
 * still falling. Drawdown is a filter here, never a score.
 */
export default function RecoveryPage() {
  const [data, setData] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const openTerminal = useOpenInTerminal();

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/scan/recovery`, { cache: "no-store" });
      const json = (await res.json()) as ScanResult;
      setData(json);
      if (json.error) setError(json.error);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const candidates = data?.candidates ?? [];
  const watching = data?.watching ?? [];
  const falling = data?.falling ?? [];

  return (
    <AppShell>
      <div className="space-y-3 p-3 md:p-4">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-lg font-bold tracking-tight text-slate-100">
            Recovery <span className="text-neon-cyan">Candidates</span>
          </h1>
          <p className="text-[11px] text-slate-500">
            Deep drawdowns showing the traces of accumulation rather than decline.
          </p>
        </header>

        <GlassCard
          title={
            <span className="flex items-center gap-2">
              🌱 Deep-drawdown recovery scanner
              {data && (
                <span className="font-mono text-[10px] font-normal text-slate-500">
                  {candidates.length} candidates · {data.eligible} deep enough · {data.scanned}{" "}
                  scanned · {timeAgo(data.scannedAt)}
                </span>
              )}
            </span>
          }
        >
          <div className="p-3">
            <p className="mb-2 rounded-lg border border-bear/25 bg-bear/[0.06] px-2 py-1.5 text-[10px] leading-relaxed text-bear/90">
              Read this first. An asset 90% down needs a 10× to get back, and that arithmetic is
              the most seductive thing on this page — it is also why the base rate here is brutal.
              Most coins 90% down go to 95% down. Nothing on this page is a prediction that any
              coin will multiply, and no scanner can produce one: a long base and heavy
              accumulation evidence make a decline <em>worth watching</em>, not likely to reverse.
              Coins that never recover look exactly like this on the way to zero.
            </p>
            <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
              So drawdown is used as a <strong className="text-slate-300">filter</strong>, never as
              a score. A contract has to be at least 70% below the highest price in its loaded
              window to be considered at all; after that it is ranked purely on evidence that
              someone is accumulating — an extended base, a decline that has stopped accelerating,
              higher lows, volume drying up into the low, bullish delta divergence, a reclaimed
              50-day average, and open interest building while price is flat. Ranking by how far
              something has fallen would produce a list of things still falling.
            </p>
            <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
              &ldquo;All-time high&rdquo; is measured from the highest price in the{" "}
              <strong className="text-slate-300">loaded window</strong> — up to about four years of
              daily futures candles. That is not the asset&apos;s real all-time high: spot usually
              trades long before the perpetual is listed, so for many coins the true peak sits
              outside anything measurable here and the real drawdown is deeper. Each card reports
              the window it used.
            </p>
            <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
              Each card also lists <strong className="text-slate-300">this coin&apos;s own
              previous episodes</strong> at a comparable depth, with what the following year
              actually did — both the best price it reached and the worst drawdown along the way.
              That pair matters: a 4× that first halved is not the same trade as a steady 4×, and
              one number cannot tell you which happened.
            </p>

            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={run}
                disabled={loading}
                className="rounded-lg bg-neon-cyan/15 px-3 py-1.5 text-[11px] font-semibold text-neon-cyan transition-colors hover:bg-neon-cyan/25 disabled:opacity-50"
              >
                {loading ? "Scanning daily history…" : "Scan for recovery candidates"}
              </button>
              <span className="text-[9px] text-slate-600">
                daily candles only — a base takes months, so this question does not exist on
                shorter intervals
              </span>
            </div>

            {error && (
              <p className="mt-2 rounded-lg border border-bear/30 bg-bear/5 px-2 py-1.5 text-[10px] text-bear">
                {error}
              </p>
            )}

            {!data && !loading && (
              <div className="mt-3">
                <EmptyNote>Run the sweep. It reads four years of daily candles per coin, so
                it takes longer than the other scanners.</EmptyNote>
              </div>
            )}

            {data && (
              <div className="mt-3 space-y-3">
                <Section
                  title="Candidates — deep, based, and showing accumulation"
                  tone="bull"
                  entries={candidates}
                  empty="Nothing cleared the bar. That is the normal result and the honest one — most deep drawdowns are not accumulating, they are still declining."
                  expanded={expanded}
                  setExpanded={setExpanded}
                  onOpenTerminal={openTerminal}
                />

                {watching.length > 0 && (
                  <Section
                    title="Watching — deep and based, evidence not there yet"
                    tone="neutral"
                    entries={watching}
                    empty=""
                    expanded={expanded}
                    setExpanded={setExpanded}
                    onOpenTerminal={openTerminal}
                  />
                )}

                {falling.length > 0 && (
                  <Section
                    title="Still falling — deep but with no base. This is what the filter is protecting you from"
                    tone="bear"
                    entries={falling}
                    empty=""
                    expanded={expanded}
                    setExpanded={setExpanded}
                    onOpenTerminal={openTerminal}
                  />
                )}
              </div>
            )}
          </div>
        </GlassCard>
      </div>
    </AppShell>
  );
}

function Section({
  title,
  tone,
  entries,
  empty,
  expanded,
  setExpanded,
  onOpenTerminal,
}: {
  title: string;
  tone: "bull" | "bear" | "neutral";
  entries: Entry[];
  empty: string;
  expanded: string | null;
  setExpanded: (v: string | null) => void;
  onOpenTerminal: (symbol: string, timeframe: string) => void;
}) {
  const colour =
    tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : "text-slate-500";
  return (
    <section>
      <div className={`pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${colour}`}>
        {title} <span className="font-mono text-slate-600">{entries.length}</span>
      </div>
      <div className="space-y-1.5">
        {entries.length === 0 ? (
          empty ? (
            <EmptyNote>{empty}</EmptyNote>
          ) : null
        ) : (
          entries.map((e) => (
            <Row
              key={e.symbol}
              entry={e}
              muted={tone === "bear"}
              open={expanded === e.symbol}
              onToggle={() => setExpanded(expanded === e.symbol ? null : e.symbol)}
              onOpenTerminal={() => onOpenTerminal(e.symbol, "1d")}
            />
          ))
        )}
      </div>
    </section>
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
          <span className="font-mono text-[10px] text-bear">
            −{s.drawdownPct.toFixed(0)}% from window high
          </span>
          <span className="font-mono text-[10px] text-slate-400">
            {s.baseDays}d based
          </span>
          <span className="font-mono text-[10px] text-bull">+{s.offLowPct.toFixed(0)}% off low</span>
          <span className="font-mono text-[10px] text-slate-500">
            {s.evidence.filter((e) => e.found).length}/{s.evidence.length} signs
          </span>
          <span className="font-mono text-[10px] text-slate-600">
            {fmtVolume(entry.quoteVolume)}
          </span>
          <span className="ml-auto text-[9px] text-slate-600">{open ? "▲" : "▼"}</span>
        </div>
        <p className="mt-0.5 text-[10px] text-slate-400">{s.headline}</p>
      </button>

      {open && (
        <div className="animate-slide-up space-y-2 border-t border-white/5 px-2.5 py-2">
          <div className="grid grid-cols-2 gap-1.5 font-mono text-[10px] sm:grid-cols-5">
            <Cell label="Price" value={fmtPrice(s.price)} />
            <Cell label="Window high" value={fmtPrice(s.windowHigh)} />
            <Cell label="Window low" value={fmtPrice(s.windowLow)} tone="bear" />
            <Cell label="Invalidation" value={fmtPrice(s.invalidation)} tone="bear" />
            <Cell label="Window" value={`${s.windowDays}d`} />
          </div>

          {/* Arithmetic, framed as arithmetic. */}
          <div className="rounded border border-white/5 bg-white/[0.02] px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-[0.14em] text-slate-600">
              What a recovery would be worth — arithmetic, not a target
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 font-mono text-[10px]">
              <span className="text-slate-300">
                back to window high = <span className="text-neon-cyan">{s.upside.toWindowHigh}×</span>
              </span>
              <span className="text-slate-300">
                halfway = <span className="text-neon-cyan">{s.upside.toHalfway}×</span>
              </span>
              {s.upside.nextSupply != null && (
                <span className="text-slate-500">
                  next mapped supply {fmtPrice(s.upside.nextSupply)}
                </span>
              )}
            </div>
            <p className="mt-1 text-[9px] leading-relaxed text-slate-600">
              These are ratios between two prices on the chart. They say nothing about whether the
              market will trade there, and the engine does not estimate the odds that it does.
            </p>
          </div>

          {s.episodes.length > 0 && (
            <div>
              <div className="pb-1 text-[9px] uppercase tracking-[0.14em] text-slate-600">
                This coin&apos;s own previous episodes at a comparable depth
              </div>
              <div className="space-y-0.5">
                {s.episodes.map((ep, i) => (
                  <div
                    key={i}
                    className="flex flex-wrap items-baseline gap-x-2 rounded bg-white/[0.03] px-1.5 py-1 font-mono text-[9px]"
                  >
                    <span className="text-slate-500">
                      {new Date(ep.startTime * 1000).toLocaleDateString()}
                    </span>
                    <span className="text-bear">−{ep.drawdownPct.toFixed(0)}% in</span>
                    <span className="text-bull">peak +{ep.peakGainPct.toFixed(0)}%</span>
                    <span className="text-bear">
                      worst {ep.worstDrawdownPct.toFixed(0)}% first
                    </span>
                    <span className="ml-auto text-slate-600">{ep.barsToPeak}d to peak</span>
                  </div>
                ))}
              </div>
              <p className="mt-1 text-[9px] leading-relaxed text-slate-600">
                The peak is the best price it ever traded in that year, not an exit anyone
                achieved, and the worst drawdown is what holding through would have cost first.
              </p>
            </div>
          )}

          <ul className="space-y-1">
            {s.explanation.map((line, i) => (
              <li key={i} className="text-[10px] leading-relaxed text-slate-400">
                {line}
              </li>
            ))}
          </ul>

          <button
            onClick={onOpenTerminal}
            className="rounded-md bg-neon-cyan/10 px-2 py-1 text-[10px] font-semibold text-neon-cyan hover:bg-neon-cyan/20"
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
