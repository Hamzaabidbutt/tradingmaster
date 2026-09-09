"use client";

import { useCallback, useState } from "react";
import AppShell from "@/components/layout/AppShell";
import { BarClock, GlassCard, ScanTimestamp } from "@/components/ui/primitives";
import {
  EmptyNote,
  ScanTimeframe,
  SCAN_TIMEFRAMES,
  fmtPrice,
  useOpenInTerminal,
} from "@/components/dashboard/shared";
import { BOS_STATE_LABEL, BOS_STATE_NOTE, BosMomentumSetup, BosState } from "@/engines/bosMomentum";

interface Entry {
  symbol: string;
  label: string;
  timeframe: string;
  quoteVolume: number;
  priceChangePercent: number | null;
  /** open time of the last closed bar this read used, unix seconds */
  barTime: number;
  setup: BosMomentumSetup;
}

interface ScanResult {
  timeframe: string;
  held: Entry[];
  retesting: Entry[];
  pending: Entry[];
  fresh: Entry[];
  failed: Entry[];
  extended: Entry[];
  forming: Entry[];
  scanned: number;
  failed_count: number;
  scannedAt: number;
  error?: string;
}

/**
 * Break-of-structure momentum sweep.
 *
 * Grouped by state rather than ranked into one list, because the states are
 * not degrees of the same thing. A held retest and an extended run are
 * different situations, and the extended one is not a worse version of the
 * held one — it is a break that may well have been correct and is simply no
 * longer tradable. Sorting them together would put a high-momentum break with
 * no remaining entry above a lower-momentum one you could actually take.
 *
 * The sections are ordered by how live the entry is, not by how impressive the
 * break was. Failed retests are shown at full prominence rather than hidden:
 * they are the most informative rows here, because a level that broke and did
 * not hold is now a failure point with everyone who chased the break offside.
 */

/** Section order, top to bottom: most actionable first. */
const SECTIONS: {
  key: keyof Pick<ScanResult, "held" | "retesting" | "pending" | "fresh" | "failed" | "extended" | "forming">;
  state: BosState;
  tone: string;
  emptyNote: string;
}[] = [
  {
    key: "held",
    state: "retest_held",
    tone: "text-bull",
    emptyNote: "No break has come back and held its level. This is the rarest of the states and often empty.",
  },
  {
    key: "retesting",
    state: "retesting",
    tone: "text-neon-cyan",
    emptyNote: "Nothing is sitting on its broken level right now.",
  },
  {
    key: "pending",
    state: "retest_pending",
    tone: "text-neon-cyan",
    emptyNote: "No break is waiting on a return.",
  },
  {
    key: "fresh",
    state: "fresh_break",
    tone: "text-slate-300",
    emptyNote: "Nothing broke on the last closed bar.",
  },
  {
    key: "failed",
    state: "retest_failed",
    tone: "text-bear",
    emptyNote: "No break has been reclaimed.",
  },
  {
    key: "extended",
    state: "extended",
    tone: "text-slate-500",
    emptyNote: "Nothing has run far enough from its level to be out of reach.",
  },
  {
    key: "forming",
    state: "forming",
    tone: "text-slate-500",
    emptyNote: "Nothing is pressing an unbroken level.",
  },
];

export default function BosPage() {
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
      const res = await fetch(`/api/scan/bos?timeframe=${tf}`, { cache: "no-store" });
      const json = (await res.json()) as ScanResult;
      setData(json);
      if (json.error) setError(json.error);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const actionable = (data?.held.length ?? 0) + (data?.retesting.length ?? 0);

  return (
    <AppShell>
      <div className="space-y-3 p-3 md:p-4">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-lg font-bold tracking-tight text-slate-100">
            BOS <span className="text-neon-cyan">Momentum</span>
          </h1>
          <p className="text-[11px] text-slate-500">
            Breaks of structure with something behind them, sorted by where each one is in its life.
          </p>
        </header>

        <GlassCard
          title={
            <span className="flex items-center gap-2">
              ⚡ Break-of-structure scanner
              {data && (
                <span className="font-mono text-[10px] font-normal text-slate-500">
                  {actionable} actionable · {data.scanned} scanned · <ScanTimestamp at={data.scannedAt} />
                </span>
              )}
            </span>
          }
        >
          <div className="p-3">
            <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
              Every chart breaks structure constantly, so the break itself is close to free — this
              scans for the ones that <em>displaced</em>. Six checks decide the momentum score: the
              break bar closed clear of the level rather than on it, on above-average volume, with
              an expanded range, with taker delta on the same side as the break, closing near its
              own extreme, and with no close back through the level since. Scored on the last{" "}
              <em>closed</em> bar only.
            </p>
            <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
              The score ranks within a state; the state decides whether there is a trade at all.
              Entries are always a limit at the broken level, never the current price — chasing a
              break is the mistake the whole scan exists to avoid, and an order that never fills is
              a better outcome than one that fills badly.
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
                {loading ? "Scanning…" : `Scan ${timeframe} for structure breaks`}
              </button>
            </div>

            {error && (
              <p className="mt-2 rounded-lg border border-bear/30 bg-bear/5 px-2 py-1.5 text-[10px] text-bear">
                {error}
              </p>
            )}

            {!data && !loading && (
              <div className="mt-3">
                <EmptyNote>
                  Pick a timeframe and run the sweep. 1h is the default — below it the universe
                  breaks structure constantly and the lists fill with noise.
                </EmptyNote>
              </div>
            )}

            {data && (
              <div className="mt-3 space-y-3">
                {SECTIONS.map((section) => {
                  const rows = data[section.key];
                  return (
                    <section key={section.key}>
                      <div className={`pb-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${section.tone}`}>
                        {BOS_STATE_LABEL[section.state]}{" "}
                        <span className="font-mono text-slate-600">{rows.length}</span>
                      </div>
                      <p className="pb-1 text-[10px] leading-relaxed text-slate-600">
                        {BOS_STATE_NOTE[section.state]}
                      </p>
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
                                  expanded === `${section.key}-${e.symbol}` ? null : `${section.key}-${e.symbol}`
                                )
                              }
                              onOpenTerminal={() => openTerminal(e.symbol, e.timeframe)}
                              muted={section.key === "extended" || section.key === "forming"}
                            />
                          ))
                        )}
                      </div>
                    </section>
                  );
                })}

                {data.failed_count > 0 && (
                  <p className="text-[10px] text-slate-600">
                    {data.failed_count} symbol{data.failed_count === 1 ? "" : "s"} could not be read
                    this sweep.
                  </p>
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
    s.grade === "A"
      ? "bg-neon-cyan/20 text-neon-cyan"
      : s.grade === "B"
        ? "bg-neon-cyan/10 text-neon-cyan"
        : "bg-white/5 text-slate-400";

  return (
    <div className={`rounded-lg border border-white/5 bg-white/[0.02] ${muted ? "opacity-70" : ""}`}>
      <button onClick={onToggle} className="w-full px-2.5 py-2 text-left" aria-expanded={open}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-slate-200">
            {entry.symbol.replace(/USDT$/, "/USDT")}
          </span>
          <BarClock at={entry.barTime} timeframe={entry.timeframe} />
          {s.grade && (
            <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${gradeColor}`}>
              {s.grade}
            </span>
          )}
          <span className="font-mono text-[11px] text-neon-cyan">{s.momentum}</span>
          {s.direction && (
            <span
              className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${
                s.direction === "bullish" ? "bg-bull/15 text-bull" : "bg-bear/15 text-bear"
              }`}
            >
              {s.direction === "bullish" ? "break up" : "break down"}
            </span>
          )}
          {s.found && (
            <span className="font-mono text-[10px] text-slate-400" title="Bars since the break">
              {s.barsSinceBreak}b ago
            </span>
          )}
          <span
            className="font-mono text-[10px] text-slate-400"
            title="Distance from the broken level, in ATR. This is what decides whether a stop against the level is still sensible."
          >
            {s.distanceAtr >= 0 ? "+" : ""}
            {s.distanceAtr} ATR
          </span>
          {s.actionable ? (
            <span className="rounded bg-bull/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-bull">
              entry defined
            </span>
          ) : (
            <span className="rounded bg-white/5 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-slate-500">
              no entry
            </span>
          )}
          <span className="font-mono text-[10px] text-slate-500">{entry.timeframe}</span>
          <span className="ml-auto text-[9px] text-slate-600">{open ? "▲" : "▼"}</span>
        </div>
        <p className="mt-0.5 text-[10px] text-slate-400">{s.headline}</p>
      </button>

      {open && (
        <div className="animate-slide-up border-t border-white/5 px-2.5 py-2">
          <div className="mb-2 grid grid-cols-2 gap-1.5 font-mono text-[10px] sm:grid-cols-4">
            <Cell label="Broken level" value={fmtPrice(s.level)} />
            <Cell label="Price now" value={fmtPrice(s.price)} />
            <Cell
              label="From level"
              value={`${s.distancePct >= 0 ? "+" : ""}${s.distancePct}%`}
              tone={s.distancePct >= 0 ? "bull" : "bear"}
            />
            <Cell label="Momentum" value={`${s.momentum}/100`} />
          </div>

          {s.trade ? (
            <div className="mb-2 grid grid-cols-2 gap-1.5 font-mono text-[10px] sm:grid-cols-5">
              <Cell label="Side" value={s.trade.side} tone={s.trade.side === "BUY" ? "bull" : "bear"} />
              <Cell label="Entry (limit)" value={fmtPrice(s.trade.entry)} />
              <Cell label="Stop" value={fmtPrice(s.trade.stopLoss)} tone="bear" />
              <Cell label="TP1" value={fmtPrice(s.trade.tp1)} tone="bull" />
              <Cell label="R:R" value={`${s.trade.riskReward}`} />
            </div>
          ) : (
            <p className="mb-2 rounded border border-white/5 bg-white/[0.02] px-2 py-1.5 text-[10px] text-slate-500">
              No entry in this state. Quoting one anyway would be inventing geometry that is not on
              the chart.
            </p>
          )}
          {s.trade && <p className="mb-2 text-[10px] leading-relaxed text-slate-500">{s.trade.note}</p>}

          {/* The checks, pass and fail alike. A scanner that shows only what it
              liked is asking to be believed. */}
          <div className="mb-2 space-y-1">
            {s.checks.map((c) => (
              <div key={c.key} className="flex items-start gap-1.5">
                <span className={`mt-px font-mono text-[10px] ${c.found ? "text-bull" : "text-slate-600"}`}>
                  {c.found ? "✓" : "✗"}
                </span>
                <span className="text-[10px] leading-relaxed">
                  <span className={c.found ? "text-slate-300" : "text-slate-500"}>{c.label}</span>
                  <span className="text-slate-500"> — {c.detail}</span>
                </span>
              </div>
            ))}
          </div>

          <ul className="space-y-1">
            {s.narrative.map((line, i) => (
              <li key={i} className="text-[10px] leading-relaxed text-slate-400">
                {line}
              </li>
            ))}
          </ul>

          {s.caveats.length > 0 && (
            <ul className="mt-1.5 space-y-1 border-t border-white/5 pt-1.5">
              {s.caveats.map((line, i) => (
                <li key={i} className="text-[10px] leading-relaxed text-slate-600">
                  <span className="mr-1">·</span>
                  {line}
                </li>
              ))}
            </ul>
          )}

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
