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
import {
  InstitutionalHistory,
  InstitutionalRange,
  InstitutionalSetup,
  InstitutionalSideRead,
  InstitutionalZone,
} from "@/engines/types";

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
              an imbalance nobody filled, a block price walked away from, aggression that hit the
              book and went nowhere, forced liquidation that was taken, delta refusing to follow
              price, swings that step in one direction. This sweep runs a{" "}
              <strong className="text-slate-300">ten-item checklist twice</strong> — once for
              demand and once for supply — and clusters the marks by price. A zone qualifies only
              when at least <strong className="text-slate-300">five distinct kinds</strong> land in
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
                        Nothing on {data.timeframe} met the five-kinds bar. That is the normal
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
  const distribution = s.demand.score < s.supply.score;
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
          <span
            className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${
              distribution ? "bg-bear/15 text-bear" : "bg-bull/15 text-bull"
            }`}
            title={
              s.side === "none"
                ? "The leading side, shown even though nothing qualified — which side the marks favour is worth seeing either way."
                : undefined
            }
          >
            {distribution ? "distribution" : "accumulation"}
            {s.side === "none" && " (unqualified)"}
          </span>
          <span className="font-mono text-[10px] text-slate-400">
            {found.length} of {s.evidence.length} kinds
          </span>
          {s.range && (
            <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[9px] text-slate-400">
              range {(s.range.position * 100).toFixed(0)}%
            </span>
          )}
          {s.history.holdRatePct != null && (
            <span
              className="font-mono text-[10px] text-slate-400"
              title={`Measured on ${s.history.samples} comparable areas in this window — a record, not an edge.`}
            >
              held {s.history.holdRatePct.toFixed(0)}% ({s.history.samples})
            </span>
          )}
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
            {/* Labels follow the side: "confirm above" is simply wrong on a
                distribution read, where the confirming break is downward. */}
            <Cell
              label={distribution ? "Confirm below" : "Confirm above"}
              value={fmtPrice(s.confirmLevel)}
              tone={distribution ? "bear" : "bull"}
            />
            <Cell
              label={distribution ? "Invalidate above" : "Invalidate below"}
              value={fmtPrice(s.invalidateLevel)}
              tone={distribution ? "bull" : "bear"}
            />
            <Cell
              label="Objective"
              value={fmtPrice(s.objective)}
              tone={distribution ? "bear" : "bull"}
            />
            <Cell label="Confluence" value={s.zone ? `${s.zone.confluence} kinds` : "—"} />
          </div>

          {/* The two sides, side by side. A demand read is worth far less when
              the supply read next to it is equally lit, and that comparison is
              invisible unless both are on screen. */}
          <div className="grid grid-cols-2 gap-1.5">
            <SideCard read={s.demand} leading={s.demand.score >= s.supply.score} />
            <SideCard read={s.supply} leading={s.supply.score > s.demand.score} />
          </div>

          <RangeStrip range={s.range} price={s.price} />
          <HistoryBlock history={s.history} side={s.side} />

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

/** One side's headline numbers, so the two can be compared at a glance. */
function SideCard({ read, leading }: { read: InstitutionalSideRead; leading: boolean }) {
  const buy = read.side === "accumulation";
  return (
    <div
      className={`rounded border px-2 py-1.5 ${
        leading
          ? buy
            ? "border-bull/30 bg-bull/[0.05]"
            : "border-bear/30 bg-bear/[0.05]"
          : "border-white/5 bg-white/[0.02] opacity-70"
      }`}
    >
      <div className="flex items-baseline gap-1.5">
        <span
          className={`text-[10px] font-semibold uppercase tracking-wider ${buy ? "text-bull" : "text-bear"}`}
        >
          {buy ? "Demand" : "Supply"}
        </span>
        <span className="font-mono text-[11px] text-slate-200">{read.score}</span>
        {read.qualified && (
          <span className="rounded bg-neon-cyan/15 px-1 text-[8px] font-bold uppercase tracking-wider text-neon-cyan">
            qualified
          </span>
        )}
      </div>
      <div className="mt-0.5 font-mono text-[9px] text-slate-500">
        {read.kinds}/{read.evidence.length} items ·{" "}
        {read.zone ? `${read.zone.confluence} kinds converging` : "no converging area"}
      </div>
      {read.zone && (
        <div className="font-mono text-[9px] text-slate-400">
          {fmtPrice(read.zone.low)}–{fmtPrice(read.zone.high)}
        </div>
      )}
    </div>
  );
}

/** The balance area the checklist was located against, or why there isn't one. */
function RangeStrip({ range, price }: { range: InstitutionalRange | null; price: number }) {
  if (!range) {
    return (
      <p className="rounded border border-white/5 bg-white/[0.02] px-2 py-1.5 text-[10px] leading-relaxed text-slate-500">
        No balance area — the market is trending, so range position scores nothing. A high and low
        taken out of a trend are two arbitrary numbers dressed as levels.
      </p>
    );
  }
  const pct = Math.max(0, Math.min(100, range.position * 100));
  return (
    <div className="rounded border border-white/5 bg-white/[0.02] px-2 py-1.5">
      <div className="flex flex-wrap items-baseline gap-x-2 font-mono text-[9px] text-slate-500">
        <span className="uppercase tracking-wider">Range</span>
        <span className="text-slate-300">
          {fmtPrice(range.low)}–{fmtPrice(range.high)}
        </span>
        <span>{range.bars} bars</span>
        <span>
          low ×{range.touchesLow} · high ×{range.touchesHigh}
        </span>
        <span className="ml-auto text-neon-cyan">{pct.toFixed(0)}%</span>
      </div>
      {/* Where price sits between the two boundaries the market has defended. */}
      <div className="relative mt-1 h-1.5 rounded-full bg-gradient-to-r from-bull/25 via-white/5 to-bear/25">
        <span
          className="absolute top-1/2 h-2.5 w-0.5 -translate-y-1/2 rounded-full bg-neon-cyan"
          style={{ left: `${pct}%` }}
          aria-hidden
        />
      </div>
      <div className="mt-0.5 flex justify-between font-mono text-[8px] text-slate-600">
        <span>{fmtPrice(range.low)} (price {fmtPrice(price)})</span>
        <span>{fmtPrice(range.high)}</span>
      </div>
    </div>
  );
}

/**
 * What comparable areas did earlier in this same series.
 *
 * The rate is deliberately absent below the engine's sample floor — the cases
 * are still listed, because seeing four outcomes is useful where a percentage
 * computed from four is misleading.
 */
function HistoryBlock({
  history,
  side,
}: {
  history: InstitutionalHistory;
  side: InstitutionalSetup["side"];
}) {
  return (
    <div className="rounded border border-white/5 bg-white/[0.02] px-2 py-1.5">
      <div className="pb-1 text-[9px] uppercase tracking-[0.14em] text-slate-600">
        What happened last time — measured, not forecast
      </div>
      {history.holdRatePct != null ? (
        <div className="mb-1 flex flex-wrap items-baseline gap-x-3 font-mono text-[10px]">
          <span className="text-slate-300">
            {history.held} held / {history.broke} broke
          </span>
          <span className="text-neon-cyan">{history.holdRatePct.toFixed(0)}% held</span>
          {history.medianFavourablePct != null && (
            <span className="text-bull">
              median +{history.medianFavourablePct.toFixed(2)}% in favour
            </span>
          )}
          {history.medianAdversePct != null && (
            <span className="text-bear">
              median {history.medianAdversePct.toFixed(2)}% against
            </span>
          )}
        </div>
      ) : (
        <div className="mb-1 font-mono text-[10px] text-slate-500">
          {history.samples} resolved case{history.samples === 1 ? "" : "s"} — rate withheld
        </div>
      )}
      <p className="mb-1 text-[10px] leading-relaxed text-slate-500">{history.note}</p>
      {history.analogues.length > 0 && (
        <div className="space-y-0.5">
          {history.analogues.map((a, i) => (
            <div
              key={i}
              className="flex flex-wrap items-baseline gap-x-2 rounded bg-white/[0.03] px-1.5 py-1 font-mono text-[9px]"
            >
              <span className="text-slate-500">{localDate(a.time)}</span>
              <span className="text-slate-300">
                {fmtPrice(a.low)}–{fmtPrice(a.high)}
              </span>
              <span className="text-slate-500">{a.confluence} kinds</span>
              <span
                className={
                  a.outcome === "held"
                    ? "text-bull"
                    : a.outcome === "broke"
                      ? "text-bear"
                      : "text-slate-600"
                }
              >
                {a.outcome}
              </span>
              {a.outcome !== "unresolved" && (
                <span className="text-slate-500">
                  +{a.favourablePct.toFixed(2)}% / −{Math.abs(a.adversePct).toFixed(2)}%
                </span>
              )}
              <span className="ml-auto text-slate-600">
                {a.tapTime ? `tapped ${localDate(a.tapTime)}` : "never tapped"}
              </span>
            </div>
          ))}
        </div>
      )}
      {side === "none" && (
        <p className="mt-1 text-[9px] text-slate-600">
          Nothing qualified on this symbol, so these are the historical areas of the leading side
          rather than a record behind a live signal.
        </p>
      )}
    </div>
  );
}

function localDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
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
