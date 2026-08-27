"use client";

import { useCallback, useState } from "react";
import AppShell from "@/components/layout/AppShell";
import { GlassCard, timeAgo } from "@/components/ui/primitives";
import { EmptyNote, ScanTimeframe, SCAN_TIMEFRAMES, useOpenInTerminal } from "@/components/dashboard/shared";
import AccumulationScanner from "@/components/dashboard/AccumulationScanner";
import { ZoneReaction, ZoneReversalSetup } from "@/engines/types";

interface Entry {
  symbol: string;
  label: string;
  timeframe: string;
  quoteVolume: number;
  priceChangePercent: number | null;
  setup: ZoneReversalSetup;
}

interface ScanResult {
  timeframe: string;
  bullish: Entry[];
  bearish: Entry[];
  forming: Entry[];
  scanned: number;
  failed: number;
  scannedAt: number;
  error?: string;
}

/**
 * Zone Reversals.
 *
 * Order blocks and fair value gaps are locations, not signals. This page asks
 * the second question — has price gone back to one and been *expelled* from it?
 *
 * Long and short are separate columns rather than one ranked list: a bounce off
 * demand and a rejection from supply are opposite trades, and putting them in
 * one column invites reading rank as agreement.
 */
export default function ReversalsPage() {
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
      const res = await fetch(`/api/scan/reversals?timeframe=${tf}`, { cache: "no-store" });
      const json = (await res.json()) as ScanResult;
      setData(json);
      if (json.error) setError(json.error);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const bullish = data?.bullish ?? [];
  const bearish = data?.bearish ?? [];
  const forming = data?.forming ?? [];

  return (
    <AppShell>
      <div className="space-y-3 p-3 md:p-4">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-lg font-bold tracking-tight text-slate-100">
            Zone <span className="text-neon-cyan">Reversals</span>
          </h1>
          <p className="text-[11px] text-slate-500">
            Coins reacting off an unmitigated order block or an unfilled fair value gap.
          </p>
        </header>

        <GlassCard
          title={
            <span className="flex items-center gap-2">
              🧱 Order block / FVG reversal scanner
              {data && (
                <span className="font-mono text-[10px] font-normal text-slate-500">
                  {bullish.length + bearish.length} confirmed · {data.scanned} scanned ·{" "}
                  {timeAgo(data.scannedAt)}
                </span>
              )}
            </span>
          }
        >
          <div className="p-3">
            <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
              A zone being <em>tapped</em> is not a reversal. This requires price to have traded
              into a zone that still holds unfilled orders, then closed back out of it the way it
              came, leaving a rejection wick with taker flow pointing the same way. Without that
              reclaim a setup is listed as forming, never as confirmed — price sitting inside a
              bullish order block is not bullish; price being expelled from it is.
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
                {loading ? "Scanning…" : `Scan ${timeframe} for zone reversals`}
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
                  title="Bullish — reversal from demand"
                  tone="bull"
                  entries={bullish}
                  empty={`No coin is being expelled from a bullish zone on ${data.timeframe} right now.`}
                  expanded={expanded}
                  setExpanded={setExpanded}
                  onOpenTerminal={openTerminal}
                />
                <Column
                  title="Bearish — rejection from supply"
                  tone="bear"
                  entries={bearish}
                  empty={`No coin is being rejected from a bearish zone on ${data.timeframe} right now.`}
                  expanded={expanded}
                  setExpanded={setExpanded}
                  onOpenTerminal={openTerminal}
                />
              </div>
            )}

            {forming.length > 0 && (
              <div className="mt-3">
                <div className="pb-1 text-[9px] uppercase tracking-[0.14em] text-slate-600">
                  Forming — price inside a zone, no reclaim yet
                </div>
                <div className="space-y-1.5">
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
                </div>
              </div>
            )}
          </div>
        </GlassCard>

        {/*
          Accumulation belongs beside zone reversals, not on the dashboard.
          Both answer the same question from different evidence — "is this
          coin turning?" — one from a zone being defended, the other from a
          base being built. The dashboard answers "where is the best setup",
          which is a different question and was the wrong home for it.
        */}
        <AccumulationScanner />
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
            <SetupRow
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
  const bullish = s.best?.direction === "bullish";
  const gradeColor =
    s.grade === "prime"
      ? bullish
        ? "bg-bull/20 text-bull"
        : "bg-bear/20 text-bear"
      : s.grade === "strong"
        ? bullish
          ? "bg-bull/10 text-bull"
          : "bg-bear/10 text-bear"
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
          {s.best && (
            <span className="rounded bg-white/5 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-slate-400">
              {zoneLabel(s.best.zoneType)}
              {s.best.confluence.length > 0 && ` +${s.best.confluence.length}`}
            </span>
          )}
          <span className="font-mono text-[10px] text-slate-500">{entry.timeframe}</span>
          {s.best && (
            <span className={`font-mono text-[10px] ${s.best.reversalPct >= 0 ? "text-bull" : "text-bear"}`}>
              {s.best.reversalPct >= 0 ? "+" : ""}
              {s.best.reversalPct.toFixed(2)}% off zone
            </span>
          )}
          <span className="ml-auto text-[9px] text-slate-600">{open ? "▲" : "▼"}</span>
        </div>
        <p className="mt-0.5 text-[10px] text-slate-400">{s.headline}</p>
      </button>

      {open && (
        <div className="animate-slide-up border-t border-white/5 px-2.5 py-2">
          <div className="mb-2 grid grid-cols-2 gap-1.5 font-mono text-[10px] sm:grid-cols-4">
            <Cell label="Price" value={fmt(s.price)} />
            <Cell label="Zone edge" value={s.entry != null ? fmt(s.entry) : "—"} tone="cyan" />
            <Cell label="Invalidation" value={s.invalidation != null ? fmt(s.invalidation) : "—"} tone="bear" />
            <Cell label="Target" value={s.target != null ? fmt(s.target) : "—"} tone="bull" />
          </div>

          <ul className="space-y-1">
            {s.explanation.map((line, i) => (
              <li key={i} className="text-[10px] leading-relaxed text-slate-400">
                {line}
              </li>
            ))}
          </ul>

          {s.reactions.length > 1 && (
            <div className="mt-2">
              <div className="pb-1 text-[9px] uppercase tracking-[0.14em] text-slate-600">
                All zones in play
              </div>
              <div className="space-y-1">
                {s.reactions.map((r) => (
                  <ReactionRow key={r.zoneId} reaction={r} />
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

function ReactionRow({ reaction: r }: { reaction: ZoneReaction }) {
  return (
    <div className="rounded bg-white/[0.03] px-1.5 py-1">
      <div className="flex flex-wrap items-center gap-2 font-mono text-[10px]">
        <span className={r.direction === "bullish" ? "text-bull" : "text-bear"}>
          {zoneLabel(r.zoneType)}
        </span>
        <span className="text-slate-400">
          {fmt(r.bottom)}–{fmt(r.top)}
        </span>
        <span className="text-slate-500">{r.score}</span>
        <span className={r.reclaimed ? "text-bull" : "text-slate-600"}>
          {r.reclaimed ? "reclaimed" : "no reclaim"}
        </span>
        <span className={r.deltaConfirms ? "text-bull" : "text-slate-600"}>
          {r.deltaConfirms ? "Δ confirms" : "Δ against"}
        </span>
        <span className="text-slate-600">
          wick {(r.rejectionWick * 100).toFixed(0)}% · {r.barsSinceTap} bar
          {r.barsSinceTap === 1 ? "" : "s"} ago
        </span>
      </div>
      <p className="mt-0.5 text-[10px] leading-relaxed text-slate-500">{r.note}</p>
    </div>
  );
}

function zoneLabel(type: string): string {
  if (type === "fvg") return "FVG";
  if (type === "breaker_block") return "Breaker";
  if (type === "order_block") return "Order block";
  return type.replace("_", " ");
}

function Cell({ label, value, tone }: { label: string; value: string; tone?: "bull" | "bear" | "cyan" }) {
  const color =
    tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : tone === "cyan" ? "text-neon-cyan" : "text-slate-200";
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
