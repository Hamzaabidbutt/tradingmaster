"use client";

import { useCallback, useState } from "react";
import { GlassCard, timeAgo } from "@/components/ui/primitives";
import { AccumulationSetup } from "@/engines/types";
import { EmptyNote, ScanTimeframe, SCAN_TIMEFRAMES, useOpenInTerminal } from "./shared";

interface Entry {
  symbol: string;
  label: string;
  timeframe: string;
  quoteVolume: number;
  priceChangePercent: number | null;
  setup: AccumulationSetup;
}

interface ScanResult {
  timeframe: string;
  candidates: Entry[];
  forming: Entry[];
  scanned: number;
  failed: number;
  scannedAt: number;
  error?: string;
}

/**
 * Accumulation sweep.
 *
 * Deliberately run on demand rather than polled: it is a full universe sweep
 * with per-symbol order-flow work behind it, and firing that every 45 s would
 * hammer the rate limit for a question the user asks occasionally.
 */
export default function AccumulationScanner() {
  const [timeframe, setTimeframe] = useState<ScanTimeframe>("1h");
  const [data, setData] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const openTerminal = useOpenInTerminal();

  const run = useCallback(
    async (tf: ScanTimeframe) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/scan/accumulation?timeframe=${tf}`, { cache: "no-store" });
        const json = (await res.json()) as ScanResult;
        setData(json);
        if (json.error) setError(json.error);
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const candidates = data?.candidates ?? [];
  const forming = data?.forming ?? [];

  return (
    <GlassCard
      title={
        <span className="flex items-center gap-2">
          🪙 Accumulation Scanner
          {data && (
            <span className="font-mono text-[10px] font-normal text-slate-500">
              {candidates.length} found · {data.scanned} scanned · {timeAgo(data.scannedAt)}
            </span>
          )}
        </span>
      }
    >
      <div className="p-3">
        <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
          Finds coins building a reversal base: a double bottom or repeatedly defended support, with
          positive volume delta, stacked buy imbalance and absorption confirming buyers are actually
          defending it. A defended level <em>and</em> buyer aggression are both required — without
          them a coin has merely stopped falling, which is not accumulation.
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
            className="rounded-lg bg-bull/15 px-3 py-1.5 text-[11px] font-semibold text-bull transition-colors hover:bg-bull/25 disabled:opacity-50"
          >
            {loading ? "Scanning…" : `Scan ${timeframe} for accumulation`}
          </button>
        </div>

        {error && (
          <p className="mt-2 rounded-lg border border-bear/30 bg-bear/5 px-2 py-1.5 text-[10px] text-bear">
            {error}
          </p>
        )}

        <div className="mt-3 space-y-1.5">
          {!data && !loading && (
            <EmptyNote>Pick a timeframe and run the sweep.</EmptyNote>
          )}
          {data && candidates.length === 0 && !loading && (
            <EmptyNote>
              No coin currently meets the accumulation criteria on {data.timeframe}. That is a real
              answer, not a failure — bases of this quality are uncommon.
              {forming.length > 0 && ` ${forming.length} are partially formed (below).`}
            </EmptyNote>
          )}

          {candidates.map((e) => (
            <SetupRow
              key={e.symbol}
              entry={e}
              open={expanded === e.symbol}
              onToggle={() => setExpanded(expanded === e.symbol ? null : e.symbol)}
              onOpenTerminal={() => openTerminal(e.symbol, e.timeframe)}
            />
          ))}

          {forming.length > 0 && (
            <>
              <div className="pt-2 text-[9px] uppercase tracking-[0.14em] text-slate-600">
                Forming — criteria partially met
              </div>
              {forming.map((e) => (
                <SetupRow
                  key={e.symbol}
                  entry={e}
                  muted
                  open={expanded === e.symbol}
                  onToggle={() => setExpanded(expanded === e.symbol ? null : e.symbol)}
                  onOpenTerminal={() => openTerminal(e.symbol, e.timeframe)}
                />
              ))}
            </>
          )}
        </div>
      </div>
    </GlassCard>
  );
}

function SetupRow({
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
      ? "bg-bull/20 text-bull"
      : s.grade === "strong"
        ? "bg-bull/10 text-bull"
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
          <span className="font-mono text-[10px] text-slate-500">{entry.timeframe}</span>
          {entry.priceChangePercent != null && (
            <span
              className={`font-mono text-[10px] ${entry.priceChangePercent >= 0 ? "text-bull" : "text-bear"}`}
            >
              {entry.priceChangePercent >= 0 ? "+" : ""}
              {entry.priceChangePercent.toFixed(2)}%
            </span>
          )}
          <span className="ml-auto flex gap-1">
            {s.criteria.map((c) => (
              <span
                key={c.key}
                title={`${c.label}: ${c.met ? "met" : "not met"}`}
                className={`h-1.5 w-1.5 rounded-full ${c.met ? "bg-bull" : "bg-white/15"}`}
              />
            ))}
          </span>
          <span className="text-[9px] text-slate-600">{open ? "▲" : "▼"}</span>
        </div>
        <p className="mt-0.5 text-[10px] text-slate-400">{s.headline}</p>
      </button>

      {open && (
        <div className="animate-slide-up border-t border-white/5 px-2.5 py-2">
          <div className="mb-2 grid grid-cols-3 gap-1.5 font-mono text-[10px]">
            <Cell label="Price" value={fmt(s.price)} />
            <Cell label="Support" value={s.support != null ? fmt(s.support) : "—"} tone="bull" />
            <Cell label="Target" value={s.target != null ? fmt(s.target) : "—"} tone="bull" />
          </div>

          <div className="space-y-1">
            {s.criteria.map((c) => (
              <div key={c.key} className="flex gap-1.5">
                <span className={`shrink-0 text-[10px] ${c.met ? "text-bull" : "text-slate-600"}`}>
                  {c.met ? "✓" : "✗"}
                </span>
                <div>
                  <div className="text-[10px] font-semibold text-slate-300">
                    {c.label}
                    <span className="ml-1.5 font-mono font-normal text-slate-600">
                      {c.score}/{c.weight}
                    </span>
                  </div>
                  <p className="text-[10px] leading-relaxed text-slate-500">{c.detail}</p>
                </div>
              </div>
            ))}
          </div>

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

function Cell({ label, value, tone }: { label: string; value: string; tone?: "bull" }) {
  return (
    <div className="rounded bg-white/[0.03] px-1.5 py-1">
      <div className="text-[8px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={tone === "bull" ? "text-bull" : "text-slate-200"}>{value}</div>
    </div>
  );
}

function fmt(v: number): string {
  return v.toFixed(v >= 1000 ? 1 : v >= 1 ? 4 : 6).replace(/0+$/, "").replace(/\.$/, "");
}
