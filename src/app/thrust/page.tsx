"use client";

import { useCallback, useState } from "react";
import AppShell from "@/components/layout/AppShell";
import { BarClock, GlassCard, ScanTimestamp } from "@/components/ui/primitives";
import { EmptyNote, fmtPrice, useOpenInTerminal } from "@/components/dashboard/shared";
import { TIMEFRAMES, Timeframe } from "@/lib/config";
import {
  RetestThrustSetup,
  THRUST_STATE_LABEL,
  THRUST_STATE_NOTE,
  ThrustState,
} from "@/engines/retestThrust";

interface Entry {
  symbol: string;
  label: string;
  timeframe: string;
  quoteVolume: number;
  priceChangePercent: number | null;
  barTime: number;
  price: number;
  setup: RetestThrustSetup;
}

interface ScanResult {
  timeframe: string;
  armed: Entry[];
  held: Entry[];
  thrusting: Entry[];
  extended: Entry[];
  failed: Entry[];
  scanned: number;
  noSetup: number;
  failed_count: number;
  scannedAt: number;
  error?: string;
}

const SECTIONS: {
  key: keyof Pick<ScanResult, "armed" | "held" | "thrusting" | "extended" | "failed">;
  state: ThrustState;
  tone: string;
  emptyNote: string;
}[] = [
  {
    key: "armed",
    state: "armed",
    tone: "text-bull",
    emptyNote:
      "Nothing is sitting on its level right now. This is the rarest state — a retest is one or two bars wide and most of the time you are looking between them.",
  },
  {
    key: "held",
    state: "held",
    tone: "text-neon-cyan",
    emptyNote: "No sequence is holding its level without having expanded yet.",
  },
  {
    key: "thrusting",
    state: "thrusting",
    tone: "text-neon-violet",
    emptyNote: "Nothing has just expanded away from a level it retested.",
  },
  {
    key: "extended",
    state: "extended",
    tone: "text-slate-500",
    emptyNote: "Nothing has run beyond the reach of its level.",
  },
  {
    key: "failed",
    state: "failed",
    tone: "text-bear",
    emptyNote: "No change of character has been given back.",
  },
];

export default function ThrustPage() {
  const [timeframe, setTimeframe] = useState<Timeframe>("1h");
  const [data, setData] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const openTerminal = useOpenInTerminal();

  const run = useCallback(async (tf: Timeframe) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/scan/thrust?timeframe=${tf}`, { cache: "no-store" });
      const json = (await res.json()) as ScanResult;
      setData(json);
      if (json.error) setError(json.error);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const takeable = (data?.armed.length ?? 0) + (data?.held.length ?? 0);

  return (
    <AppShell>
      <div className="space-y-3 p-3 md:p-4">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-lg font-bold tracking-tight text-slate-100">
            Retest <span className="text-neon-cyan">&amp; Thrust</span>
          </h1>
          <p className="text-[11px] text-slate-500">
            A leg, a base, a change of character, a return to the level — and what happened after
            the last ones.
          </p>
        </header>

        <GlassCard
          title={
            <span className="flex items-center gap-2">
              🎯 Change of character scanner
              {data && (
                <span className="font-mono text-[10px] font-normal text-slate-500">
                  {takeable} takeable · {data.scanned} scanned · <ScanTimestamp at={data.scannedAt} />
                </span>
              )}
            </span>
          }
        >
          <div className="p-3">
            <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
              The sequence in order: a decline of at least 3 ATR into a base, then the first close
              back above the last lower high — the change of character — then a return to that level
              that holds, then an expanded bar clear of it. Each part has to be the{" "}
              <em>first</em> thing that qualifies, never the best-looking of several candidates:
              picking the most flattering retest from a handful is how a backtest ends up describing
              a strategy nobody could have followed live.
            </p>
            <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
              The BOS scanner already finds breaks that get retested and tells you the retest held.
              That is a statement about the level, not about the trade — a level can hold perfectly
              and go nowhere, and on most charts it does. So this carries the sequence one step
              further, to the expansion, and then goes back through{" "}
              <strong className="text-slate-400">this symbol's own history</strong> to measure what
              happened after every previous instance.
            </p>
            <p className="mb-2 rounded-lg border border-neon-amber/25 bg-neon-amber/5 px-2 py-1.5 text-[10px] leading-relaxed text-neon-amber">
              The precedent figure is a measured frequency from the loaded window of one symbol. It
              is not a probability, not an edge and not a forecast, and the samples are small by
              construction. A rate from four cases is a description of four cases — the count is
              always shown beside it for that reason.
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
                {loading ? "Scanning…" : `Scan ${timeframe} for retests`}
              </button>
            </div>

            <p className="mt-1.5 text-[10px] leading-relaxed text-slate-600">
              Every timeframe is offered. The sequence is scale-free — the leg is measured in ATR so
              the threshold travels — but the precedent study is not, and not in the direction people
              expect: a fast timeframe fits more instances into the same window, so its sample is
              larger, while a daily sweep may find one or two cases and should be read as one or two
              cases.
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
                        {THRUST_STATE_LABEL[section.state]}{" "}
                        <span className="font-mono text-slate-600">{rows.length}</span>
                      </div>
                      <p className="pb-1 text-[10px] leading-relaxed text-slate-600">
                        {THRUST_STATE_NOTE[section.state]}
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
                                  expanded === `${section.key}-${e.symbol}`
                                    ? null
                                    : `${section.key}-${e.symbol}`
                                )
                              }
                              onOpenTerminal={() => openTerminal(e.symbol, e.timeframe)}
                              muted={section.key === "extended" || section.key === "failed"}
                            />
                          ))
                        )}
                      </div>
                    </section>
                  );
                })}

                <p className="text-[10px] text-slate-600">
                  {data.noSetup} symbol{data.noSetup === 1 ? "" : "s"} had no sequence this sweep —
                  most of the universe, most of the time.
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
  const long = s.direction === "long";
  const p = s.precedent;
  /* A rate under five cases is shown as a raw count, never as a percentage.
     "67%" from three cases reads as a measurement and is a coincidence. */
  const thin = p.count < 5;

  return (
    <div className={`rounded-lg border border-white/5 bg-white/[0.02] ${muted ? "opacity-70" : ""}`}>
      <button onClick={onToggle} className="w-full px-2.5 py-2 text-left" aria-expanded={open}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-slate-200">
            {entry.symbol.replace(/USDT$/, "/USDT")}
          </span>
          <BarClock at={entry.barTime} timeframe={entry.timeframe} />
          <span className={`font-mono text-[11px] font-bold ${long ? "text-bull" : "text-bear"}`}>
            {long ? "▲ LONG" : "▼ SHORT"}
          </span>
          <span className="font-mono text-[11px] text-neon-cyan">
            {s.score}/{s.checks.length}
          </span>
          <span className="font-mono text-[10px] text-slate-500">
            level {fmtPrice(s.level)}
          </span>
          {p.count > 0 && (
            <span
              className={`rounded px-1.5 py-0.5 font-mono text-[9px] ${
                thin ? "bg-white/5 text-slate-400" : "bg-neon-cyan/10 text-neon-cyan"
              }`}
              title={p.note}
            >
              {thin
                ? `${p.count} prior`
                : `${Math.round(p.boomRate * 100)}% of ${p.count}`}
            </span>
          )}
        </div>
      </button>

      {open && (
        <div className="border-t border-white/5 px-2.5 py-2">
          <div className="space-y-1">
            {s.checks.map((c) => (
              <div key={c.label} className="flex items-start gap-1.5 text-[10px]">
                <span className={c.pass ? "text-bull" : "text-slate-600"}>{c.pass ? "✓" : "·"}</span>
                <span className={c.pass ? "text-slate-300" : "text-slate-600"}>
                  <strong>{c.label}</strong> — {c.detail}
                </span>
              </div>
            ))}
          </div>

          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] sm:grid-cols-3">
            <Stat label="Level" value={fmtPrice(s.level)} />
            <Stat label="Last price" value={fmtPrice(entry.price)} />
            <Stat label="Distance" value={`${s.distanceAtr.toFixed(1)} ATR`} />
            <Stat label="Leg into base" value={`${s.legAtr.toFixed(1)} ATR`} />
            <Stat label="Bars since base" value={String(s.barsSinceBase)} />
            <Stat
              label="Bars since CHoCH"
              value={s.barsSinceChoch == null ? "—" : String(s.barsSinceChoch)}
            />
            <Stat
              label="Retest depth"
              value={s.retestDepthAtr == null ? "—" : `${s.retestDepthAtr.toFixed(2)} ATR`}
            />
            <Stat label="Thrust" value={s.thrustAtr == null ? "—" : `${s.thrustAtr.toFixed(1)} ATR`} />
            <Stat
              label="Thrust volume"
              value={s.thrustVolumeX == null ? "—" : `${s.thrustVolumeX.toFixed(1)}×`}
            />
          </div>

          <p className="mt-2 text-[10px] leading-relaxed text-slate-500">{s.note}</p>

          <div className="mt-2 rounded-lg border border-white/5 bg-white/[0.02] px-2 py-1.5">
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
              This symbol&apos;s own history
            </div>
            <p className="mt-0.5 text-[10px] leading-relaxed text-slate-500">{p.note}</p>
          </div>

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
