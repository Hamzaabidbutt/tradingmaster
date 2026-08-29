"use client";

import { useCallback, useState } from "react";
import AppShell from "@/components/layout/AppShell";
import { GlassCard, timeAgo } from "@/components/ui/primitives";
import {
  EmptyNote,
  ScanTimeframe,
  SCAN_TIMEFRAMES,
  fmtPrice,
  useOpenInTerminal,
} from "@/components/dashboard/shared";
import { InstitutionalSetup, InstitutionalZone } from "@/engines/types";

interface Entry {
  symbol: string;
  label: string;
  timeframe: string;
  quoteVolume: number;
  priceChangePercent: number | null;
  setup: InstitutionalSetup;
}

interface ScanResult {
  timeframe: string;
  footprints: Entry[];
  forming: Entry[];
  scanned: number;
  failed: number;
  scannedAt: number;
  error?: string;
}

/**
 * Institutional footprint scanner.
 *
 * Finds price bands where several *different kinds* of evidence converge —
 * unfilled demand gaps, unmitigated order blocks, absorbed selling, forced
 * supply that was bought, delta divergence, rejection wicks, discount
 * location, and open interest built while price held.
 *
 * The load-bearing idea is the word *different*. Three order blocks stacked at
 * one price is one mechanism repeating, not three confirmations; a zone only
 * counts when independent mechanisms — a gap, absorption, forced flow — land
 * on the same band. That is why `confluence` counts distinct evidence kinds
 * rather than marks.
 *
 * On "where the market is headed": the output is levels, not a forecast. The
 * scanner reports the price that would confirm the read, the price that would
 * refute it, and the next mapped objective if it confirms. Nothing in public
 * market data supports a claim about where price *will* go, and the panel says
 * so on every card rather than in a disclaimer at the bottom.
 */
export default function InstitutionalPage() {
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
      const res = await fetch(`/api/scan/institutional?timeframe=${tf}`, { cache: "no-store" });
      const json = (await res.json()) as ScanResult;
      setData(json);
      if (json.error) setError(json.error);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const footprints = data?.footprints ?? [];
  const forming = data?.forming ?? [];

  return (
    <AppShell>
      <div className="space-y-3 p-3 md:p-4">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-lg font-bold tracking-tight text-slate-100">
            Institutional <span className="text-neon-cyan">Footprint</span>
          </h1>
          <p className="text-[11px] text-slate-500">
            Where size was worked, and the levels that confirm or refute it.
          </p>
        </header>

        <GlassCard
          title={
            <span className="flex items-center gap-2">
              🏛 Institutional buying-area scanner
              {data && (
                <span className="font-mono text-[10px] font-normal text-slate-500">
                  {footprints.length} footprints · {data.scanned} scanned · {timeAgo(data.scannedAt)}
                </span>
              )}
            </span>
          }
        >
          <div className="p-3">
            <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
              Size cannot be filled at one price without moving the market, so it leaves a trail:
              an imbalance nobody filled, a block price walked away from, selling that hit the bid
              and went nowhere, forced liquidation that was bought, delta rising while price does
              not. This sweep collects eight such traces per coin and clusters them by price. A
              zone qualifies only when at least{" "}
              <strong className="text-slate-300">four distinct kinds</strong> of evidence land in
              the same band — repeats of one mechanism are counted once, because a mechanism
              repeating is not the same as independent confirmation.
            </p>
            <p className="mb-2 rounded-lg border border-neon-amber/20 bg-neon-amber/5 px-2 py-1.5 text-[10px] leading-relaxed text-neon-amber/90">
              What this does not do is predict. A footprint says size was worked at a level, not
              that price will rise from it — accumulation fails regularly and is only visible in
              hindsight. Each card gives a confirmation level, an invalidation level and an
              objective; treat those as the read, and the score as conviction that the trail is
              real, not as a probability of profit.
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
                {loading ? "Scanning…" : `Scan ${timeframe} for institutional footprints`}
              </button>
              <span className="text-[9px] text-slate-600">
                slower than the other sweeps — one extra open-interest request per coin
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
                <section>
                  <div className="pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-bull">
                    Footprints <span className="font-mono text-slate-600">{footprints.length}</span>
                  </div>
                  <div className="space-y-1.5">
                    {footprints.length === 0 ? (
                      <EmptyNote>
                        Nothing on {data.timeframe} met the four-kinds bar. That is the normal
                        result — the threshold exists so the list stays worth reading.
                      </EmptyNote>
                    ) : (
                      footprints.map((e) => (
                        <Row
                          key={e.symbol}
                          entry={e}
                          open={expanded === e.symbol}
                          onToggle={() => setExpanded(expanded === e.symbol ? null : e.symbol)}
                          onOpenTerminal={() => openTerminal(e.symbol, e.timeframe)}
                        />
                      ))
                    )}
                  </div>
                </section>

                {forming.length > 0 && (
                  <section>
                    <div className="pb-1 text-[9px] uppercase tracking-[0.14em] text-slate-600">
                      Forming — evidence present but scattered, or too few distinct kinds
                    </div>
                    <div className="space-y-1.5">
                      {forming.map((e) => (
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
    s.grade === "prime"
      ? "bg-neon-cyan/20 text-neon-cyan"
      : s.grade === "strong"
        ? "bg-neon-cyan/10 text-neon-cyan"
        : "bg-white/5 text-slate-400";
  const found = s.evidence.filter((e) => e.found);

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
          {s.side !== "none" && (
            <span className="rounded bg-bull/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-bull">
              {s.side}
            </span>
          )}
          <span className="font-mono text-[10px] text-slate-400">
            {found.length} of {s.evidence.length} kinds
          </span>
          {s.zone && (
            <span className="font-mono text-[10px] text-slate-300">
              zone {fmtPrice(s.zone.low)}–{fmtPrice(s.zone.high)}
              <span className="ml-1 text-slate-500">
                ({s.zone.distancePct >= 0 ? "+" : ""}
                {s.zone.distancePct.toFixed(2)}%)
              </span>
            </span>
          )}
          {s.openInterestChangePct != null && (
            <span
              className={`font-mono text-[10px] ${s.openInterestChangePct >= 0 ? "text-bull" : "text-bear"}`}
            >
              OI {s.openInterestChangePct >= 0 ? "+" : ""}
              {s.openInterestChangePct.toFixed(1)}%
            </span>
          )}
          <span className="font-mono text-[10px] text-slate-500">{entry.timeframe}</span>
          <span className="ml-auto text-[9px] text-slate-600">{open ? "▲" : "▼"}</span>
        </div>
        <p className="mt-0.5 text-[10px] text-slate-400">{s.headline}</p>
      </button>

      {open && (
        <div className="animate-slide-up space-y-2 border-t border-white/5 px-2.5 py-2">
          <div className="grid grid-cols-2 gap-1.5 font-mono text-[10px] sm:grid-cols-4">
            <Cell label="Price" value={fmtPrice(s.price)} />
            <Cell label="Zone mid" value={s.zone ? fmtPrice(s.zone.mid) : "—"} />
            <Cell label="Confirm above" value={fmtPrice(s.confirmAbove)} tone="bull" />
            <Cell label="Invalidate below" value={fmtPrice(s.invalidateBelow)} tone="bear" />
            <Cell label="Objective" value={fmtPrice(s.objective)} tone="bull" />
            <Cell label="Confluence" value={s.zone ? `${s.zone.confluence} kinds` : "—"} />
          </div>

          {/* Evidence ledger — what was found, what was not, and the weight each carried. */}
          <div>
            <div className="pb-1 text-[9px] uppercase tracking-[0.14em] text-slate-600">
              Evidence
            </div>
            <div className="space-y-1">
              {s.evidence.map((ev) => (
                <div
                  key={ev.key}
                  className={`rounded border px-2 py-1 ${
                    ev.found
                      ? "border-bull/20 bg-bull/[0.04]"
                      : "border-white/5 bg-white/[0.02] opacity-60"
                  }`}
                >
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span
                      className={`text-[10px] font-semibold ${ev.found ? "text-slate-200" : "text-slate-500"}`}
                    >
                      {ev.found ? "✓" : "·"} {ev.label}
                    </span>
                    {ev.price != null && (
                      <span className="font-mono text-[10px] text-neon-cyan">
                        {fmtPrice(ev.price)}
                      </span>
                    )}
                    <span className="ml-auto font-mono text-[9px] text-slate-600">
                      {ev.score.toFixed(0)}/{ev.weight}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[10px] leading-relaxed text-slate-400">{ev.detail}</p>
                </div>
              ))}
            </div>
          </div>

          {s.zones.length > 1 && (
            <div>
              <div className="pb-1 text-[9px] uppercase tracking-[0.14em] text-slate-600">
                Other areas with converging evidence
              </div>
              <div className="space-y-1">
                {s.zones.slice(1, 5).map((z, i) => (
                  <ZoneRow key={i} zone={z} />
                ))}
              </div>
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

function ZoneRow({ zone }: { zone: InstitutionalZone }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 rounded bg-white/[0.03] px-2 py-1">
      <span className="font-mono text-[10px] text-slate-200">
        {fmtPrice(zone.low)}–{fmtPrice(zone.high)}
      </span>
      <span className="font-mono text-[10px] text-slate-500">
        {zone.distancePct >= 0 ? "+" : ""}
        {zone.distancePct.toFixed(2)}%
      </span>
      <span className="font-mono text-[10px] text-neon-cyan">{zone.confluence} kinds</span>
      <span className="text-[9px] text-slate-500">{zone.sources.join(" · ")}</span>
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
