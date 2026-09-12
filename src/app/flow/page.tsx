"use client";

import { useCallback, useState } from "react";
import AppShell from "@/components/layout/AppShell";
import { BarClock, GlassCard, ScanTimestamp } from "@/components/ui/primitives";
import {
  EmptyNote,
  ScanTimeframe,
  SCAN_TIMEFRAMES,
  fmtPct,
  useOpenInTerminal,
} from "@/components/dashboard/shared";
import {
  AxisRead,
  FLOW_STATE_LABEL,
  FLOW_STATE_NOTE,
  FlowAlignmentRead,
  FlowState,
} from "@/engines/flowAlignment";

interface Entry {
  symbol: string;
  label: string;
  timeframe: string;
  quoteVolume: number;
  priceChangePercent: number | null;
  /** open time of the last closed bar this read used, unix seconds */
  barTime: number;
  read: FlowAlignmentRead;
}

interface ScanResult {
  timeframe: string;
  lookback: number;
  longsBuilding: Entry[];
  shortsBuilding: Entry[];
  covering: Entry[];
  deleveraging: Entry[];
  absorbedRallies: Entry[];
  absorbedSelloffs: Entry[];
  scanned: number;
  noRead: number;
  failed_count: number;
  scannedAt: number;
  error?: string;
}

/**
 * Price, cumulative delta and open interest, checked against each other.
 *
 * A rally made of new buyers and a rally made of trapped shorts being squeezed
 * out are the same green candles. Cumulative delta says whether anybody
 * actually crossed the spread for the move; open interest says whether the
 * resulting positions stayed open. Only when all three agree is the move both
 * bought and committed to — and that is the top section here.
 *
 * The four contrast sections are not filler. They are what the top section
 * rejected and why, and a scanner that showed only its hits would leave the
 * reader unable to tell an empty market from a broken sweep.
 */

type SectionKey = Extract<
  keyof ScanResult,
  "longsBuilding" | "shortsBuilding" | "covering" | "deleveraging" | "absorbedRallies" | "absorbedSelloffs"
>;

/** Section order: the three-way agreements first, then what missed and how. */
const SECTIONS: { key: SectionKey; state: FlowState; tone: string; emptyNote: string }[] = [
  {
    key: "longsBuilding",
    state: "longs_building",
    tone: "text-bull",
    emptyNote:
      "Nothing has all three axes rising. This is the point of the scan and it is often empty — agreement across price, delta and open interest is rarer than any one of them alone.",
  },
  {
    key: "shortsBuilding",
    state: "shorts_building",
    tone: "text-bear",
    emptyNote: "Nothing is falling on aggressive selling with positions being added.",
  },
  {
    key: "covering",
    state: "covering_rally",
    tone: "text-neon-amber",
    emptyNote: "No rally is running on shorts closing out.",
  },
  {
    key: "deleveraging",
    state: "deleveraging",
    tone: "text-neon-amber",
    emptyNote: "Nothing is falling purely on positions being closed.",
  },
  {
    key: "absorbedRallies",
    state: "absorbed_rally",
    tone: "text-slate-400",
    emptyNote: "Nothing rose while its cumulative delta fell.",
  },
  {
    key: "absorbedSelloffs",
    state: "absorbed_selloff",
    tone: "text-slate-400",
    emptyNote: "Nothing fell while its cumulative delta rose.",
  },
];

export default function FlowPage() {
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
      const res = await fetch(`/api/scan/flow?timeframe=${tf}`, { cache: "no-store" });
      const json = (await res.json()) as ScanResult;
      setData(json);
      if (json.error) setError(json.error);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const aligned = (data?.longsBuilding.length ?? 0) + (data?.shortsBuilding.length ?? 0);

  return (
    <AppShell>
      <div className="space-y-3 p-3 md:p-4">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-lg font-bold tracking-tight text-slate-100">
            Flow <span className="text-neon-cyan">Alignment</span>
          </h1>
          <p className="text-[11px] text-slate-500">
            Where price, cumulative delta and open interest are all pushing the same way.
          </p>
        </header>

        <GlassCard
          title={
            <span className="flex items-center gap-2">
              🧭 Price × CVD × open interest
              {data && (
                <span className="font-mono text-[10px] font-normal text-slate-500">
                  {aligned} aligned · {data.scanned} scanned · <ScanTimestamp at={data.scannedAt} />
                </span>
              )}
            </span>
          }
        >
          <div className="p-3">
            <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
              Price says where the market went, not who took it there — a rally made of new buyers
              and one made of trapped shorts being squeezed look identical in candles. Two other
              series separate them: <em>cumulative delta</em> says whether anyone crossed the spread
              for the move, and <em>open interest</em> says whether the positions stayed open. All
              three rising together is the one configuration that is hard to fake.
            </p>
            <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
              Every threshold is relative, so one sweep works across the universe: delta is measured
              as a share of the window&apos;s own traded volume, not in contracts. Each axis also
              reports <em>steadiness</em> — two windows ending in the same place are not the same
              evidence if one climbed throughout and the other lurched both ways. Alignment
              describes what the move was made of; it is not a forecast, and the most confirmed
              markup on the board is also the one carrying the most stops.
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
                {loading ? "Scanning…" : `Scan ${timeframe} for three-way agreement`}
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
                  Pick a timeframe and run the sweep. 1h is the default — open interest publishes
                  every five minutes at best, so on faster windows a single print&apos;s rounding
                  decides the whole read.
                </EmptyNote>
              </div>
            )}

            {data && (
              <div className="mt-3 space-y-3">
                {SECTIONS.map((section) => {
                  const rows = data[section.key];
                  const muted = section.key.startsWith("absorbed");
                  return (
                    <section key={section.key}>
                      <div
                        className={`pb-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${section.tone}`}
                      >
                        {FLOW_STATE_LABEL[section.state]}{" "}
                        <span className="font-mono text-slate-600">{rows.length}</span>
                      </div>
                      <p className="pb-1 text-[10px] leading-relaxed text-slate-600">
                        {FLOW_STATE_NOTE[section.state]}
                      </p>
                      <div className="space-y-1.5">
                        {rows.length === 0 ? (
                          <EmptyNote>{section.emptyNote}</EmptyNote>
                        ) : (
                          rows.map((e) => {
                            const id = `${section.key}-${e.symbol}`;
                            return (
                              <Row
                                key={id}
                                entry={e}
                                open={expanded === id}
                                onToggle={() => setExpanded(expanded === id ? null : id)}
                                onOpenTerminal={() => openTerminal(e.symbol, e.timeframe)}
                                muted={muted}
                              />
                            );
                          })
                        )}
                      </div>
                    </section>
                  );
                })}

                {/* Coverage, so an empty board reads as calm rather than broken. */}
                <p className="text-[10px] leading-relaxed text-slate-600">
                  {data.scanned} symbol{data.scanned === 1 ? "" : "s"} read over {data.lookback}{" "}
                  bars of {data.timeframe}. {data.noRead} had at least one axis that could not be
                  read — no open-interest history, a stale series, or a window flat enough that
                  there was no direction to agree about.
                  {data.failed_count > 0 &&
                    ` ${data.failed_count} could not be fetched this sweep.`}
                </p>
              </div>
            )}
          </div>
        </GlassCard>
      </div>
    </AppShell>
  );
}

/** One axis as an arrow, a number and its steadiness. */
function Axis({ name, read, unit }: { name: string; read: AxisRead; unit: string }) {
  const tone =
    read.direction === "up" ? "text-bull" : read.direction === "down" ? "text-bear" : "text-slate-500";
  const arrow = read.direction === "up" ? "▲" : read.direction === "down" ? "▼" : "—";
  return (
    <div
      className="rounded-md border border-white/5 bg-white/[0.02] px-2 py-1"
      title={`${read.steps} step${read.steps === 1 ? "" : "s"} measured; ${(read.steadiness * 100).toFixed(0)}% went this way`}
    >
      <div className="text-[9px] uppercase tracking-[0.1em] text-slate-600">{name}</div>
      <div className={`font-mono text-[11px] ${tone}`}>
        {arrow} {read.changePct >= 0 ? "+" : ""}
        {read.changePct.toFixed(2)}
        {unit}
      </div>
      {/* Steadiness as a bar rather than a number: the eye compares three bars
          faster than it compares three percentages, and this is the field that
          separates a clean climb from a lurch ending in the same place. */}
      <div className="mt-0.5 h-0.5 w-full overflow-hidden rounded-full bg-white/10">
        <div
          className={read.direction === "down" ? "h-full bg-bear/60" : "h-full bg-bull/60"}
          style={{ width: `${Math.round(read.steadiness * 100)}%` }}
        />
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
  const r = entry.read;

  return (
    <div className={`rounded-lg border border-white/5 bg-white/[0.02] ${muted ? "opacity-70" : ""}`}>
      <button onClick={onToggle} className="w-full px-2.5 py-2 text-left" aria-expanded={open}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-slate-200">
            {entry.symbol.replace(/USDT$/, "/USDT")}
          </span>
          <BarClock at={entry.barTime} timeframe={entry.timeframe} />
          {r.unanimous && (
            <span
              className="rounded bg-neon-cyan/20 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-neon-cyan"
              title="All three axes moved and all three agree"
            >
              3/3
            </span>
          )}
          <span className="font-mono text-[11px] text-neon-cyan">{r.score}</span>
          <span className="ml-auto font-mono text-[10px] text-slate-500">
            24h {fmtPct(entry.priceChangePercent)}
          </span>
        </div>

        <div className="mt-1.5 grid grid-cols-3 gap-1">
          <Axis name="Price" read={r.price} unit="%" />
          <Axis name="CVD / vol" read={r.cvd} unit="%" />
          <Axis name="Open int." read={r.openInterest} unit="%" />
        </div>
      </button>

      {open && (
        <div className="space-y-1.5 border-t border-white/5 px-2.5 py-2">
          <p className="font-mono text-[10px] text-slate-300">{r.headline}</p>
          <p className="text-[10px] leading-relaxed text-slate-400">{r.mechanism}</p>
          <ul className="space-y-0.5">
            {r.caveats.map((c) => (
              <li key={c} className="text-[9px] leading-relaxed text-slate-600">
                {c}
              </li>
            ))}
          </ul>
          <button
            onClick={onOpenTerminal}
            className="rounded-md bg-white/5 px-2 py-1 text-[10px] text-slate-300 transition-colors hover:bg-white/10"
          >
            Open {entry.symbol.replace(/USDT$/, "/USDT")} in terminal →
          </button>
        </div>
      )}
    </div>
  );
}
