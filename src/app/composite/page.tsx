"use client";

import { useCallback, useState } from "react";
import AppShell from "@/components/layout/AppShell";
import SignalRecord from "@/components/dashboard/SignalRecord";
import { GlassCard, timeAgo } from "@/components/ui/primitives";
import {
  EmptyNote,
  ScanTimeframe,
  SCAN_TIMEFRAMES,
  fmtPrice,
  fmtVolume,
  useOpenInTerminal,
} from "@/components/dashboard/shared";
import { Bias, TradeSetup } from "@/engines/types";

interface Entry {
  symbol: string;
  label: string;
  timeframe: string;
  quoteVolume: number;
  priceChangePercent: number | null;
  price: number;
  bias: Bias;
  bullishProbability: number;
  setup: TradeSetup | null;
  topStrategies: { key: string; name: string; score: number; weight: number }[];
}

interface ScanResult {
  timeframe: string;
  long: Entry[];
  short: Entry[];
  watching: Entry[];
  scanned: number;
  failed: number;
  scannedAt: number;
  error?: string;
}

/**
 * Composite setups — the weighted 28-strategy ensemble, run on every coin.
 *
 * The dashboard board answers a narrow question: do three *independent*
 * analysts, reading different kinds of evidence, agree right now? Most coins
 * answer that with silence, which is correct behaviour for a confluence filter
 * and also why the board can look empty while plenty is happening.
 *
 * This page answers the other question. Every engine in the app — structure,
 * order flow, footprint, volume profile, delta, liquidity, liquidations,
 * patterns, moving averages, VWAP — is scored and weighted into one verdict per
 * coin. The two reads are genuinely different, not the same number twice: a
 * coin can carry a strong composite setup with no confluence at all, and that
 * is information rather than a contradiction.
 *
 * Which is more trustworthy is a question for the record at the bottom of this
 * page, not for a claim here.
 */
export default function CompositePage() {
  const [timeframe, setTimeframe] = useState<ScanTimeframe>("1h");
  const [data, setData] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const openTerminal = useOpenInTerminal();

  const run = useCallback(async (tf: ScanTimeframe) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/scan/composite?timeframe=${tf}`, { cache: "no-store" });
      const json = (await res.json()) as ScanResult;
      setData(json);
      if (json.error) setError(json.error);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const long = data?.long ?? [];
  const short = data?.short ?? [];
  const watching = data?.watching ?? [];

  return (
    <AppShell>
      <div className="space-y-3 p-3 md:p-4">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-lg font-bold tracking-tight text-slate-100">
            Composite <span className="text-neon-cyan">Setups</span>
          </h1>
          <p className="text-[11px] text-slate-500">
            The full weighted ensemble&apos;s verdict on every coin.
          </p>
        </header>

        <GlassCard
          title={
            <span className="flex items-center gap-2">
              🧮 Composite signal scanner
              {data && (
                <span className="font-mono text-[10px] font-normal text-slate-500">
                  {long.length + short.length} setups · {data.scanned} coins · {timeAgo(data.scannedAt)}
                  {data.failed > 0 && ` · ${data.failed} failed`}
                </span>
              )}
            </span>
          }
        >
          <div className="p-3">
            <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
              Every engine in the app is scored and weighted into one verdict per coin — structure,
              order flow, footprint, volume profile, delta, liquidity, liquidations, patterns,
              moving averages, VWAP. This is a different read from the dashboard board, which asks
              whether three <em>independent</em> analysts agree and stays silent on most coins by
              design. A strong composite setup with no confluence behind it is a real state, not a
              contradiction — and the strategies that carried each read are listed so you can see
              which it was.
            </p>
            <p className="mb-2 rounded-lg border border-neon-amber/20 bg-neon-amber/5 px-2 py-1.5 text-[10px] leading-relaxed text-neon-amber/90">
              Confidence is the ensemble&apos;s agreement, not a probability of profit. Whether that
              agreement has actually paid is measured at the bottom of this page from closed
              signals — the only honest answer to &ldquo;how good is this?&rdquo;
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
                {loading ? "Scanning every coin…" : `Scan all coins on ${timeframe}`}
              </button>
              <span className="text-[9px] text-slate-600">
                full universe — around 25 engines per coin, so this takes longer than the other
                sweeps
              </span>
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
              <div className="mt-3 space-y-3">
                <div className="grid gap-3 lg:grid-cols-2">
                  <Column
                    title="Long"
                    tone="bull"
                    entries={long}
                    empty={`No composite long setup on ${data.timeframe}.`}
                    expanded={expanded}
                    setExpanded={setExpanded}
                    onOpenTerminal={openTerminal}
                  />
                  <Column
                    title="Short"
                    tone="bear"
                    entries={short}
                    empty={`No composite short setup on ${data.timeframe}.`}
                    expanded={expanded}
                    setExpanded={setExpanded}
                    onOpenTerminal={openTerminal}
                  />
                </div>

                {watching.length > 0 && (
                  <section>
                    <div className="pb-1 text-[9px] uppercase tracking-[0.14em] text-slate-600">
                      Leaning, but no tradable geometry — the ensemble has a view and the levels
                      do not justify an entry
                    </div>
                    <div className="space-y-1.5">
                      {watching.map((e) => (
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

        <GlassCard title="📒 Composite signal record">
          <div className="p-3">
            <SignalRecord
              source="COMPOSITE"
              title="Every composite signal opened"
              blurb="Setups clearing the confidence floor are written to the tracker and evaluated against price. Successful, partial and failed use the same definitions as Signal History — a partial reached the first target and then reversed, which is a correct read managed badly rather than a wrong one."
            />
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
      <div
        className={`pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${tone === "bull" ? "text-bull" : "text-bear"}`}
      >
        {title} <span className="font-mono text-slate-600">{entries.length}</span>
      </div>
      <div className="space-y-1.5">
        {entries.length === 0 ? (
          <EmptyNote>{empty}</EmptyNote>
        ) : (
          entries.map((e) => (
            <Row
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
  const bullish = entry.bias === "bullish";

  return (
    <div className={`rounded-lg border border-white/5 bg-white/[0.02] ${muted ? "opacity-70" : ""}`}>
      <button onClick={onToggle} className="w-full px-2.5 py-2 text-left" aria-expanded={open}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-slate-200">
            {entry.symbol.replace(/USDT$/, "/USDT")}
          </span>
          {s && (
            <>
              <span
                className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
                  s.side === "BUY" ? "bg-bull/15 text-bull" : "bg-bear/15 text-bear"
                }`}
              >
                {s.side}
              </span>
              <span className="font-mono text-[11px] text-neon-cyan">{s.confidence}%</span>
              <span className="font-mono text-[10px] text-slate-400">{s.confidenceLabel}</span>
              <span className="font-mono text-[10px] text-slate-500">RR {s.riskReward}</span>
            </>
          )}
          {!s && (
            <span
              className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${
                bullish ? "bg-bull/10 text-bull" : "bg-bear/10 text-bear"
              }`}
            >
              {entry.bias}
            </span>
          )}
          <span
            className={`font-mono text-[10px] ${entry.bullishProbability >= 50 ? "text-bull" : "text-bear"}`}
          >
            {entry.bullishProbability}% bull
          </span>
          <span className="font-mono text-[10px] text-slate-500">{entry.timeframe}</span>
          <span className="font-mono text-[10px] text-slate-600">
            {fmtVolume(entry.quoteVolume)}
          </span>
          {entry.priceChangePercent != null && (
            <span
              className={`font-mono text-[10px] ${entry.priceChangePercent >= 0 ? "text-bull" : "text-bear"}`}
            >
              {entry.priceChangePercent >= 0 ? "+" : ""}
              {entry.priceChangePercent.toFixed(2)}%
            </span>
          )}
          <span className="ml-auto text-[9px] text-slate-600">{open ? "▲" : "▼"}</span>
        </div>
        {entry.topStrategies.length > 0 && (
          <p className="mt-0.5 truncate text-[10px] text-slate-500">
            {entry.topStrategies.map((t) => t.name).join(" · ")}
          </p>
        )}
      </button>

      {open && (
        <div className="animate-slide-up space-y-2 border-t border-white/5 px-2.5 py-2">
          {s ? (
            <div className="grid grid-cols-3 gap-1.5 font-mono text-[10px] sm:grid-cols-6">
              <Cell label="Price" value={fmtPrice(entry.price)} />
              <Cell label="Entry" value={fmtPrice(s.entry)} />
              <Cell label="Stop" value={fmtPrice(s.stopLoss)} tone="bear" />
              <Cell label="TP1" value={fmtPrice(s.tp1)} tone="bull" />
              <Cell label="TP2" value={fmtPrice(s.tp2)} tone="bull" />
              <Cell label="TP3" value={fmtPrice(s.tp3)} tone="bull" />
            </div>
          ) : (
            <p className="text-[10px] leading-relaxed text-slate-500">
              The ensemble leans {entry.bias} at {entry.bullishProbability}% but produced no setup:
              the geometry available did not clear the risk-reward floor. Shown because &ldquo;a
              view with nothing tradable yet&rdquo; is a real state worth watching, not an absence.
            </p>
          )}

          {/* Contribution, not raw score — a strategy that was down-weighted
              cannot present itself as the reason for a signal it barely moved. */}
          {entry.topStrategies.length > 0 && (
            <div>
              <div className="pb-1 text-[9px] uppercase tracking-[0.14em] text-slate-600">
                What carried the read
              </div>
              <div className="space-y-0.5">
                {entry.topStrategies.map((t) => (
                  <div
                    key={t.key}
                    className="flex items-baseline gap-2 rounded bg-white/[0.03] px-1.5 py-1 font-mono text-[9px]"
                  >
                    <span className="text-slate-300">{t.name}</span>
                    <span className={t.score >= 0 ? "text-bull" : "text-bear"}>
                      {t.score >= 0 ? "+" : ""}
                      {t.score.toFixed(0)}
                    </span>
                    <span className="ml-auto text-slate-600">weight {t.weight}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {s && s.reasoning.length > 0 && (
            <ul className="space-y-1">
              {s.reasoning.slice(0, 8).map((line, i) => (
                <li key={i} className="text-[10px] leading-relaxed text-slate-400">
                  {line}
                </li>
              ))}
            </ul>
          )}

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
