"use client";

import { useCallback, useState } from "react";
import AppShell from "@/components/layout/AppShell";
import SignalRecord from "@/components/dashboard/SignalRecord";
import InstitutionalSetupCard from "@/components/dashboard/InstitutionalSetupCard";
import { GlassCard, timeAgo } from "@/components/ui/primitives";
import { EmptyNote, ScanTimeframe, SCAN_TIMEFRAMES } from "@/components/dashboard/shared";
import { InstitutionalSetup } from "@/engines/types";

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
 * supply that was bought, delta divergence, rejection wicks, discount and
 * range location, stepping structure, funding paid by the opposite side, and
 * open interest built while price held.
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
              an imbalance nobody filled, a block price walked away from, aggression that hit the
              book and went nowhere, forced liquidation that was taken, delta refusing to follow
              price, swings that step in one direction. This sweep runs a{" "}
              <strong className="text-slate-300">eleven-item checklist twice</strong> — once for
              demand and once for supply — and clusters the marks by price. A zone qualifies only
              when at least <strong className="text-slate-300">six distinct kinds</strong> land in
              the same band; repeats of one mechanism count once, because a mechanism repeating is
              not independent confirmation.
            </p>
            <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
              Both sides are always shown. Checking only demand made every chart look like
              accumulation, because a weak supply read was never visible — the asymmetry between
              them is most of the signal. Where the market is genuinely ranging, the checklist is
              also located against the range boundaries: demand at a low the market has already
              defended is a different claim from demand in mid-range. In a trend that item scores
              zero rather than inventing a boundary.
            </p>
            <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
              Funding is the one input here that is a <em>cost</em> rather than an inference:
              whoever pays it is the crowded side, and they are charged every settlement to stay
              there. Accumulation therefore wants <strong className="text-slate-300">shorts</strong>{" "}
              paying and distribution wants longs paying — funding agreeing with the side being
              read means the crowd is already positioned that way, which argues against the
              footprint rather than for it, and is scored that way. A single outlier settlement is
              a squeeze that already happened; only a consistent standing cost counts.
            </p>
            <p className="mb-2 rounded-lg border border-neon-amber/20 bg-neon-amber/5 px-2 py-1.5 text-[10px] leading-relaxed text-neon-amber/90">
              What this does not do is predict. A footprint says size was worked at a level, not
              that price will move from it — accumulation and distribution both fail regularly and
              are only obvious in hindsight. Each card gives a confirmation level, an invalidation
              level and an objective; treat those as the read, and the score as conviction that the
              trail is real, not as a probability of profit. The one historical figure — how
              comparable areas behaved when price returned to them — is measured on this symbol,
              this timeframe, this window, and is withheld entirely below four resolved cases.
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
                slower than the other sweeps — extra open-interest and funding requests per coin
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
                        Nothing on {data.timeframe} met the six-kinds bar. That is the normal
                        result — the threshold exists so the list stays worth reading.
                      </EmptyNote>
                    ) : (
                      footprints.map((e, i) => (
                        <InstitutionalSetupCard key={e.symbol} entry={e} rank={i + 1} />
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
                        // Compact: a forming read is context, and rendering
                        // eleven evidence lines for each would bury the
                        // qualified list above it.
                        <div key={e.symbol} className="opacity-70">
                          <InstitutionalSetupCard entry={e} compact />
                        </div>
                      ))}
                    </div>
                  </section>
                )}
              </div>
            )}
          </div>
        </GlassCard>

        {/*
          The record. A scanner that never showed how its calls turned out
          would be asking to be trusted rather than earning it — and a
          footprint is exactly the kind of read that is easy to narrate
          convincingly after the fact.
        */}
        <GlassCard title="📒 Institutional footprint signal record">
          <div className="p-3">
            <SignalRecord
              source="INSTITUTIONAL"
              title="Every footprint signal this scanner has opened"
              blurb="Qualified footprints with tradable geometry are written as tracked signals and evaluated against price on the same lifecycle as every other source. Successful, partial and failed use the same definitions as Signal History: a partial reached the first target and then reversed — a correct read managed badly, which is worth separating from a wrong one."
            />
          </div>
        </GlassCard>
      </div>
    </AppShell>
  );
}
