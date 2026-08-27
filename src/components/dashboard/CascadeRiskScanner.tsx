"use client";

import { useCallback, useState } from "react";
import { GlassCard, timeAgo } from "@/components/ui/primitives";
import { CascadeRiskSetup } from "@/engines/types";
import { EmptyNote, ScanTimeframe, SCAN_TIMEFRAMES, useOpenInTerminal } from "./shared";

interface Entry {
  symbol: string;
  label: string;
  timeframe: string;
  quoteVolume: number;
  priceChangePercent: number | null;
  setup: CascadeRiskSetup;
}

interface ScanResult {
  timeframe: string;
  longFlush: Entry[];
  shortSqueeze: Entry[];
  forming: Entry[];
  scanned: number;
  failed: number;
  scannedAt: number;
  error?: string;
}

/**
 * Cascade risk — the companion to the spike scanner above it.
 *
 * That one reports cascades that have already fired; this one reports the
 * conditions for one. The framing is load-bearing and repeated in the UI as
 * well as the data: it says where forced flow *would* begin and which side is
 * crowded, never that price is going there.
 */
export default function CascadeRiskScanner() {
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
      const res = await fetch(`/api/scan/cascade?timeframe=${tf}`, { cache: "no-store" });
      const json = (await res.json()) as ScanResult;
      setData(json);
      if (json.error) setError(json.error);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const longFlush = data?.longFlush ?? [];
  const shortSqueeze = data?.shortSqueeze ?? [];
  const forming = data?.forming ?? [];

  return (
    <GlassCard
      title={
        <span className="flex items-center gap-2">
          🧨 Cascade risk — where the next one would start
          {data && (
            <span className="font-mono text-[10px] font-normal text-slate-500">
              {longFlush.length + shortSqueeze.length} loaded · {data.scanned} scanned ·{" "}
              {timeAgo(data.scannedAt)}
            </span>
          )}
        </span>
      }
    >
      <div className="p-3">
        <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
          Finds coins where one side is crowded and a trigger sits within reach: unswept stop
          pools, equal highs/lows, and inferred leverage bands, with open interest saying which
          cohort has been building.{" "}
          <strong className="text-slate-400">
            This is a conditional read, not a forecast.
          </strong>{" "}
          It says where forced flow would begin and how much is resting there — never that price
          will reach it. Distance is quoted in ATR, because 2% is an ordinary hour on one contract
          and a week on another.
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
            {loading ? "Scanning…" : `Scan ${timeframe} for cascade risk`}
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
              title="Long flush risk — crowded longs, trigger below"
              tone="bear"
              entries={longFlush}
              empty={`No coin has crowded longs with a trigger in reach on ${data.timeframe}.`}
              expanded={expanded}
              setExpanded={setExpanded}
              onOpenTerminal={openTerminal}
            />
            <Column
              title="Short squeeze risk — crowded shorts, trigger above"
              tone="bull"
              entries={shortSqueeze}
              empty={`No coin has crowded shorts with a trigger in reach on ${data.timeframe}.`}
              expanded={expanded}
              setExpanded={setExpanded}
              onOpenTerminal={openTerminal}
            />
          </div>
        )}

        {forming.length > 0 && (
          <div className="mt-3">
            <div className="pb-1 text-[9px] uppercase tracking-[0.14em] text-slate-600">
              Forming — trigger further out, or positioning unwinding
            </div>
            <div className="space-y-1.5">
              {forming.map((e) => (
                <RiskRow
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
        className={`pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${
          tone === "bull" ? "text-bull" : "text-bear"
        }`}
      >
        {title} <span className="font-mono text-slate-600">{entries.length}</span>
      </div>
      <div className="space-y-1.5">
        {entries.length === 0 ? (
          <EmptyNote>{empty}</EmptyNote>
        ) : (
          entries.map((e) => (
            <RiskRow
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

const BASIS_LABEL: Record<string, string> = {
  stop_pool: "stop pool",
  equal_levels: "equal levels",
  leverage_band: "leverage band (inferred)",
};

function RiskRow({
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
  const flush = s.side === "long";
  const gradeColor =
    s.grade === "prime"
      ? "bg-neon-amber/20 text-neon-amber"
      : s.grade === "strong"
        ? "bg-neon-amber/10 text-neon-amber"
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
          <span className={`font-mono text-[10px] ${flush ? "text-bear" : "text-bull"}`}>
            {flush ? "long flush" : "short squeeze"}
          </span>
          {s.trigger && (
            <span className="font-mono text-[10px] text-slate-400">
              {Math.abs(s.trigger.distancePct).toFixed(2)}% · {s.trigger.distanceAtr.toFixed(1)} ATR
            </span>
          )}
          {s.fuel.openInterestChangePct != null && (
            <span
              className={`font-mono text-[10px] ${s.fuel.unwinding ? "text-slate-500" : "text-neon-amber"}`}
              title="Open interest change over the window"
            >
              OI {s.fuel.openInterestChangePct >= 0 ? "+" : ""}
              {s.fuel.openInterestChangePct.toFixed(1)}%
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
            <Cell label="Price" value={fmt(s.price)} />
            <Cell
              label="Trigger"
              value={s.trigger ? fmt(s.trigger.price) : "—"}
              tone={flush ? "bear" : "bull"}
            />
            <Cell label="Distance" value={s.trigger ? `${s.trigger.distanceAtr.toFixed(1)} ATR` : "—"} />
            <Cell label="Crowded" value={s.fuel.crowded} />
          </div>

          <ul className="space-y-1">
            {s.explanation.map((line, i) => (
              <li key={i} className="text-[10px] leading-relaxed text-slate-400">
                {line}
              </li>
            ))}
          </ul>

          {s.triggers.length > 1 && (
            <div className="mt-2">
              <div className="pb-1 text-[9px] uppercase tracking-[0.14em] text-slate-600">
                Triggers in range, nearest first
              </div>
              <div className="space-y-0.5">
                {s.triggers.map((t) => (
                  <div
                    key={`${t.basis}-${t.price}`}
                    className="flex flex-wrap items-center gap-2 rounded bg-white/[0.03] px-1.5 py-1 font-mono text-[10px]"
                  >
                    <span className={t.side === "long" ? "text-bear" : "text-bull"}>
                      {fmt(t.price)}
                    </span>
                    <span className="text-slate-500">
                      {t.distancePct >= 0 ? "+" : ""}
                      {t.distancePct.toFixed(2)}% · {t.distanceAtr.toFixed(1)} ATR
                    </span>
                    <span className="text-slate-600">{BASIS_LABEL[t.basis] ?? t.basis}</span>
                  </div>
                ))}
              </div>
            </div>
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

function fmt(v: number): string {
  return v.toFixed(v >= 1000 ? 1 : v >= 1 ? 4 : 6).replace(/0+$/, "").replace(/\.$/, "");
}
