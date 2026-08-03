"use client";

import { RecentWindowSummary } from "@/engines/types";
import { ProbabilityBar, timeAgo } from "@/components/ui/primitives";

/**
 * The "what just happened" view: a complete conclusion of the last few
 * minutes — most traded prices, absorbed aggression (bearish candles that
 * closed with positive delta and vice versa), the institutional footprint
 * band, and an explicit directional read with transparent odds.
 */
export default function MarketPulse({
  pulse,
  pricePrecision,
}: {
  pulse: RecentWindowSummary | null;
  pricePrecision: number;
}) {
  if (!pulse) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-xs text-slate-500">
        Waiting for minute data to build the recent-window conclusion…
      </div>
    );
  }

  const p = (v: number) => v.toFixed(pricePrecision);
  const dir = pulse.nextMove.direction;
  const dirColor = dir === "bullish" ? "text-bull" : dir === "bearish" ? "text-bear" : "text-slate-300";
  const zone = pulse.institutionalZones[0];

  return (
    <div className="flex h-full flex-col">
      {/* Verdict header */}
      <div
        className={`px-4 py-3 ${
          dir === "bullish" ? "bg-bull/5" : dir === "bearish" ? "bg-bear/5" : "bg-white/[0.02]"
        }`}
      >
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-[0.14em] text-slate-500">
            Last {pulse.windowMinutes} minutes · {timeAgo(pulse.to)}
          </span>
          <span className={`font-mono text-sm font-bold ${pulse.changePct >= 0 ? "text-bull" : "text-bear"}`}>
            {pulse.changePct >= 0 ? "+" : ""}
            {pulse.changePct.toFixed(2)}%
          </span>
        </div>

        <ProbabilityBar bullish={pulse.bullishOdds} />

        <p className={`mt-2.5 text-[11px] font-semibold leading-relaxed ${dirColor}`}>
          {dir === "bullish" ? "▲ " : dir === "bearish" ? "▼ " : "◆ "}
          {pulse.verdict}
        </p>

        <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-[10px]">
          <Cell label="Target" value={p(pulse.nextMove.target)} tone={dir === "bearish" ? "bear" : "bull"} />
          <Cell label="Invalidation" value={p(pulse.nextMove.invalidation)} tone="slate" />
          <Cell
            label="Buy pressure"
            value={`${pulse.buyPct.toFixed(0)}%`}
            tone={pulse.buyPct >= 50 ? "bull" : "bear"}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {/* ---- Most traded prices ---- */}
        <Section title="Most traded prices" hint="where business actually got done">
          <div className="space-y-1">
            {pulse.mostTradedPrices.map((mt, i) => (
              <div key={i} className="flex items-center gap-2">
                <span
                  className={`w-16 shrink-0 font-mono text-[11px] ${
                    i === 0 ? "font-bold text-neon-amber" : "text-slate-300"
                  }`}
                >
                  {p(mt.price)}
                </span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/5">
                  <div
                    className="h-full bg-gradient-to-r from-bull/60 to-bear/60"
                    style={{ width: `${Math.min(100, mt.share * 240)}%` }}
                  />
                </div>
                <span className="w-9 shrink-0 text-right font-mono text-[9px] text-slate-500">
                  {(mt.share * 100).toFixed(0)}%
                </span>
                <span
                  className={`w-9 shrink-0 text-right font-mono text-[9px] ${
                    mt.buyShare >= 0.5 ? "text-bull" : "text-bear"
                  }`}
                  title="share of volume on the buy side at this price"
                >
                  {(mt.buyShare * 100).toFixed(0)}b
                </span>
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500">
            {p(pulse.poc)} is the window&apos;s point of control — the near-term magnet and the level to watch on a
            retest.
          </p>
        </Section>

        {/* ---- Institutional footprint area ---- */}
        {zone && (
          <Section title="Institutional footprint area" hint="where size was working">
            <div
              className={`rounded-lg border p-2 ${
                zone.side === "accumulation"
                  ? "border-bull/25 bg-bull/5"
                  : zone.side === "distribution"
                    ? "border-bear/25 bg-bear/5"
                    : "border-white/10 bg-white/[0.02]"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-[11px] font-semibold text-slate-200">
                  {p(zone.priceLow)} – {p(zone.priceHigh)}
                </span>
                <span
                  className={`rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
                    zone.side === "accumulation"
                      ? "border-bull/30 text-bull"
                      : zone.side === "distribution"
                        ? "border-bear/30 text-bear"
                        : "border-slate-500/30 text-slate-400"
                  }`}
                >
                  {zone.side}
                </span>
              </div>
              <p className="mt-1 text-[10px] leading-relaxed text-slate-400">{zone.note}</p>
            </div>
          </Section>
        )}

        {/* ---- Absorbed aggression ---- */}
        <Section
          title="Absorbed aggression"
          hint="candles that closed against their own delta"
        >
          {pulse.absorptionCandles.length === 0 ? (
            <p className="text-[10px] text-slate-500">
              No candle closed against its delta in this window — aggression and price agreed throughout, which is
              what a clean, un-absorbed move looks like.
            </p>
          ) : (
            <div className="space-y-1.5">
              {pulse.absorptionCandles.slice(-4).reverse().map((a, i) => (
                <div
                  key={i}
                  className={`rounded-lg border p-2 ${
                    a.type === "bearish_positive_delta"
                      ? "border-bear/25 bg-bear/[0.04]"
                      : "border-bull/25 bg-bull/[0.04]"
                  }`}
                >
                  <div className="flex items-center justify-between font-mono text-[10px]">
                    <span
                      className={a.type === "bearish_positive_delta" ? "font-bold text-bear" : "font-bold text-bull"}
                    >
                      {a.type === "bearish_positive_delta" ? "RED bar · +Δ" : "GREEN bar · −Δ"}
                    </span>
                    <span className="text-slate-500">
                      {p(a.close)} · {a.delta >= 0 ? "+" : ""}
                      {fmt(a.delta)} · {a.volumeMultiple}×
                    </span>
                  </div>
                  <p className="mt-1 text-[10px] leading-relaxed text-slate-400">{a.note}</p>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* ---- Quick stats ---- */}
        <Section title="Quick read" hint="window vitals">
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            <Stat label="Range" value={`${p(pulse.low)}–${p(pulse.high)}`} />
            <Stat
              label="Volume"
              value={`${pulse.volumeMultiple}× avg`}
              tone={pulse.volumeMultiple > 1.3 ? "amber" : "slate"}
            />
            <Stat
              label="Delta"
              value={`${pulse.delta >= 0 ? "+" : ""}${fmt(pulse.delta)}`}
              tone={pulse.delta >= 0 ? "bull" : "bear"}
            />
            <Stat
              label="Range exp."
              value={`${pulse.rangeMultiple}×`}
              tone={pulse.rangeMultiple > 1.8 ? "amber" : "slate"}
            />
            <Stat
              label="Participation"
              value={`${pulse.volumeTrendPct >= 0 ? "+" : ""}${pulse.volumeTrendPct.toFixed(0)}%`}
              tone={pulse.volumeTrendPct < -25 ? "bear" : "slate"}
            />
            <Stat label="Large prints" value={String(pulse.bigTrades.length)} tone={pulse.bigTrades.length > 0 ? "amber" : "slate"} />
          </div>
        </Section>

        {/* ---- Stop hunts ---- */}
        {pulse.sweeps.length > 0 && (
          <Section title="Stop hunts" hint="liquidity taken in this window">
            <div className="space-y-1">
              {pulse.sweeps.slice(-3).reverse().map((s, i) => (
                <p key={i} className="text-[10px] leading-relaxed text-neon-amber">
                  ▪ {s.note}
                </p>
              ))}
            </div>
          </Section>
        )}

        {/* ---- Why (transparent factor breakdown) ---- */}
        <Section title="Why these odds" hint="every factor that moved the number">
          <div className="space-y-1">
            {[...pulse.factors]
              .sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
              .map((f, i) => (
                <div key={i} className="rounded-md bg-white/[0.03] px-2 py-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-semibold text-slate-300">{f.label}</span>
                    <span
                      className={`font-mono text-[10px] font-bold ${
                        f.points > 0 ? "text-bull" : f.points < 0 ? "text-bear" : "text-slate-500"
                      }`}
                    >
                      {f.points > 0 ? "+" : ""}
                      {f.points.toFixed(0)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[10px] leading-relaxed text-slate-500">{f.detail}</p>
                </div>
              ))}
          </div>
        </Section>

        {/* ---- Takeaways ---- */}
        <Section title="Key takeaways">
          <ul className="space-y-1">
            {pulse.keyTakeaways.map((t, i) => (
              <li key={i} className="flex gap-1.5 text-[10px] leading-relaxed text-slate-400">
                <span className="text-neon-cyan">›</span>
                {t}
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="mb-1.5 flex items-baseline gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">{title}</span>
        {hint && <span className="text-[9px] text-slate-600">— {hint}</span>}
      </h4>
      {children}
    </section>
  );
}

function Cell({ label, value, tone }: { label: string; value: string; tone: "bull" | "bear" | "slate" }) {
  const color = tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : "text-slate-300";
  return (
    <div className="rounded-md bg-white/[0.04] px-2 py-1">
      <div className="text-[9px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`font-semibold ${color}`}>{value}</div>
    </div>
  );
}

function Stat({ label, value, tone = "slate" }: { label: string; value: string; tone?: "bull" | "bear" | "amber" | "slate" }) {
  const color =
    tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : tone === "amber" ? "text-neon-amber" : "text-slate-200";
  return (
    <div className="rounded-md bg-white/[0.03] px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`font-mono text-[11px] font-semibold ${color}`}>{value}</div>
    </div>
  );
}

function fmt(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${abs.toFixed(0)}`;
}
