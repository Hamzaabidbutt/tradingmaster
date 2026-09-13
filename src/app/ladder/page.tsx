"use client";

import { useCallback, useState } from "react";
import AppShell from "@/components/layout/AppShell";
import { BarClock, GlassCard, ScanTimestamp } from "@/components/ui/primitives";
import { EmptyNote, fmtPrice, useOpenInTerminal } from "@/components/dashboard/shared";
import { TIMEFRAMES, Timeframe } from "@/lib/config";
import { CandleLadder } from "@/engines/candleLadder";

interface Entry {
  symbol: string;
  label: string;
  timeframe: string;
  quoteVolume: number;
  priceChangePercent: number | null;
  barTime: number;
  price: number;
  ladder: CandleLadder;
}

interface ScanResult {
  timeframe: string;
  climbing: Entry[];
  falling: Entry[];
  stalled: Entry[];
  broken: Entry[];
  scanned: number;
  noRun: number;
  failed_count: number;
  scannedAt: number;
  error?: string;
}

/**
 * Staircase runs across the universe.
 *
 * The shape is the one people point at and call a clean trend: each bar's low
 * above the last bar's low and each high above the last bar's high, repeated,
 * so the lows fall on a line you could draw with a ruler.
 *
 * Split by direction and by whether the run is still going, because a finished
 * run is not a weaker version of a live one. Ranking them together would put a
 * beautiful dead staircase above the modest live one somebody could act on.
 */

const SECTIONS: {
  key: keyof Pick<ScanResult, "climbing" | "falling" | "stalled" | "broken">;
  title: string;
  note: string;
  tone: string;
  emptyNote: string;
}[] = [
  {
    key: "climbing",
    title: "Climbing",
    note: "Each bar's low and high above the one before it, still stepping on the last closed bar.",
    tone: "text-bull",
    emptyNote: "Nothing is walking a line upward right now. On a choppy session this is normal.",
  },
  {
    key: "falling",
    title: "Falling",
    note: "The mirror image: every bar's high and low below the last, still stepping.",
    tone: "text-bear",
    emptyNote: "Nothing is walking a line downward right now.",
  },
  {
    key: "stalled",
    title: "Stalled",
    note:
      "The stepping stopped, but no bar has closed through the line yet. A pause here is what a pullback looks like before it is either a pullback or a top.",
    tone: "text-neon-amber",
    emptyNote: "No run has paused without giving up its line.",
  },
  {
    key: "broken",
    title: "Line gone",
    note:
      "A later bar closed through the fitted line. Shown rather than dropped: where a run ended is worth as much as where one is running.",
    tone: "text-slate-500",
    emptyNote: "No recent run has lost its line.",
  },
];

export default function LadderPage() {
  const [timeframe, setTimeframe] = useState<Timeframe>("1h");
  const [minBars, setMinBars] = useState(5);
  const [data, setData] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const openTerminal = useOpenInTerminal();

  const run = useCallback(async (tf: Timeframe, bars: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/scan/ladder?timeframe=${tf}&minBars=${bars}`, {
        cache: "no-store",
      });
      const json = (await res.json()) as ScanResult;
      setData(json);
      if (json.error) setError(json.error);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const live = (data?.climbing.length ?? 0) + (data?.falling.length ?? 0);

  return (
    <AppShell>
      <div className="space-y-3 p-3 md:p-4">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-lg font-bold tracking-tight text-slate-100">
            Trendline <span className="text-neon-cyan">Ladders</span>
          </h1>
          <p className="text-[11px] text-slate-500">
            Runs of consecutive candles stepping along a straight line, in either direction.
          </p>
        </header>

        <GlassCard
          title={
            <span className="flex items-center gap-2">
              📐 Staircase scanner
              {data && (
                <span className="font-mono text-[10px] font-normal text-slate-500">
                  {live} live · {data.scanned} scanned · <ScanTimestamp at={data.scannedAt} />
                </span>
              )}
            </span>
          }
        >
          <div className="p-3">
            <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
              A run is counted only while every step holds: each bar's low above the previous bar's
              low <em>and</em> its high above the previous bar's high. The first bar that takes out
              the one before it ends the run, with no tolerance band for &ldquo;nearly
              held&rdquo; — stretching that to keep a pretty run alive would mean the bar count is
              not the thing measured.
            </p>
            <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
              <strong className="text-slate-400">R²</strong> is how straight the steps are: a
              least-squares line under the lows of a climb, over the highs of a fall — the line you
              would draw yourself. A run that accelerates away from it still counts and simply
              scores lower, rather than being dropped as if it never happened.{" "}
              <strong className="text-slate-400">Body</strong> is the share of bars closing in the
              run's own direction: higher highs made of red candles is a grind, not a drive, and
              the two look identical until you check.
            </p>
            <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
              This describes bars that have already closed. Runs end — that is what makes them
              runs — and eight bars holding a line says nothing about the ninth.
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

              <label className="flex items-center gap-1.5 text-[10px] text-slate-500">
                min bars
                <input
                  type="number"
                  min={4}
                  max={50}
                  value={minBars}
                  onChange={(e) => setMinBars(Math.max(4, Math.min(50, Number(e.target.value) || 4)))}
                  className="w-14 rounded-md border border-white/10 bg-white/5 px-1.5 py-1 font-mono text-[10px] text-slate-200"
                />
              </label>

              <button
                onClick={() => run(timeframe, minBars)}
                disabled={loading}
                className="rounded-lg bg-neon-cyan/15 px-3 py-1.5 text-[11px] font-semibold text-neon-cyan transition-colors hover:bg-neon-cyan/25 disabled:opacity-50"
              >
                {loading ? "Scanning…" : `Scan ${timeframe} for ladders`}
              </button>
            </div>

            <p className="mt-1.5 text-[10px] leading-relaxed text-slate-600">
              Every timeframe is offered, including the fast ones the other sweeps steer away from:
              a run of higher lows is exactly as true on 1m as on 1d, just a smaller event. Raise{" "}
              <em>min bars</em> rather than avoiding the timeframe — four consecutive steps on 1m is
              most of the universe most of the time, and on 1d it is rare and large.
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
              <div className="mt-3 space-y-3">
                {SECTIONS.map((section) => {
                  const rows = data[section.key];
                  return (
                    <section key={section.key}>
                      <div
                        className={`pb-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${section.tone}`}
                      >
                        {section.title} <span className="font-mono text-slate-600">{rows.length}</span>
                      </div>
                      <p className="pb-1 text-[10px] leading-relaxed text-slate-600">{section.note}</p>
                      <div className="space-y-1.5">
                        {rows.length === 0 ? (
                          <EmptyNote>{section.emptyNote}</EmptyNote>
                        ) : (
                          rows.map((e) => (
                            <Row
                              key={`${section.key}-${e.symbol}`}
                              entry={e}
                              open={expanded === `${section.key}-${e.symbol}`}
                              onToggle={() =>
                                setExpanded(
                                  expanded === `${section.key}-${e.symbol}`
                                    ? null
                                    : `${section.key}-${e.symbol}`
                                )
                              }
                              onOpenTerminal={() => openTerminal(e.symbol, e.timeframe)}
                              muted={section.key === "broken"}
                            />
                          ))
                        )}
                      </div>
                    </section>
                  );
                })}

                <p className="text-[10px] text-slate-600">
                  {data.noRun} symbol{data.noRun === 1 ? "" : "s"} had no run of {minBars}+ bars this
                  sweep — most of the universe, most of the time.
                  {data.failed_count > 0 && (
                    <> {data.failed_count} could not be read.</>
                  )}
                </p>
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
  const l = entry.ladder;
  const up = l.direction === "up";
  const tone = up ? "text-bull" : "text-bear";
  /* Distance to the line is the number a reader actually uses: it is where the
     staircase would next be tested, and how much room there is before that. */
  const toLine = entry.price > 0 ? ((entry.price - l.lineNow) / entry.price) * 100 : 0;

  return (
    <div className={`rounded-lg border border-white/5 bg-white/[0.02] ${muted ? "opacity-70" : ""}`}>
      <button onClick={onToggle} className="w-full px-2.5 py-2 text-left" aria-expanded={open}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-slate-200">
            {entry.symbol.replace(/USDT$/, "/USDT")}
          </span>
          <BarClock at={entry.barTime} timeframe={entry.timeframe} />
          <span className={`font-mono text-[11px] font-bold ${tone}`}>
            {up ? "▲" : "▼"} {l.bars} bars
          </span>
          <span className="font-mono text-[11px] text-neon-cyan">{l.score}</span>
          <span className={`font-mono text-[10px] ${tone}`}>
            {l.movePct >= 0 ? "+" : ""}
            {l.movePct.toFixed(2)}%
          </span>
          <span className="font-mono text-[10px] text-slate-500">R² {l.r2.toFixed(2)}</span>
        </div>
      </button>

      {open && (
        <div className="border-t border-white/5 px-2.5 py-2">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] sm:grid-cols-3">
            <Stat label="Bars" value={String(l.bars)} />
            <Stat label="Move" value={`${l.movePct.toFixed(2)}%`} />
            <Stat label="Move (ATR)" value={`${l.moveAtr.toFixed(1)}×`} />
            <Stat label="Straightness" value={l.r2.toFixed(3)} />
            <Stat label="Slope / bar" value={`${l.slopePctPerBar.toFixed(3)}%`} />
            <Stat label="Body agreement" value={`${Math.round(l.bodyShare * 100)}%`} />
            <Stat label="Line now" value={fmtPrice(l.lineNow)} />
            <Stat label="Last price" value={fmtPrice(entry.price)} />
            <Stat
              label={up ? "Above line" : "Below line"}
              value={`${Math.abs(toLine).toFixed(2)}%`}
            />
          </div>

          <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
            {l.broken
              ? "A bar has closed through the line. The run is over; what is left is the level it failed at."
              : l.barsSinceEnd === 0
                ? `Still stepping as of the last closed bar. The line sits at ${fmtPrice(l.lineNow)} — that is where the next step has to hold, not a target.`
                : `Stopped stepping ${l.barsSinceEnd} bar${l.barsSinceEnd === 1 ? "" : "s"} ago, but nothing has closed through ${fmtPrice(l.lineNow)} yet.`}
          </p>
          {l.bodyShare < 0.5 && (
            <p className="mt-1 text-[10px] leading-relaxed text-neon-amber">
              Fewer than half these bars closed in the run's direction — the steps are holding, but
              the bodies are not driving. That is a grind, and it behaves differently from a run of
              the same shape made of full-bodied candles.
            </p>
          )}

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
