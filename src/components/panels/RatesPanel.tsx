"use client";

import { useEffect, useState } from "react";
import type { FundingReport } from "@/engines/fundingRates";
import { GlassCard } from "@/components/ui/primitives";

/**
 * The cost of carry: interest rate, funding, and who is paying it.
 *
 * Funding is the one input on this page that is a **cost** rather than an
 * inference. Every other panel reads intent off price and volume and can be
 * wrong about it; this one reports money that changed hands. Whoever pays is
 * the crowded side, and they are charged for it every settlement — which is
 * why a level that will not break while shorts are being paid to hold is a
 * different event from the same level with funding flat.
 *
 * ## The two components, kept apart
 *
 * Binance builds the rate as the premium (mark against index) clamped around a
 * fixed interest rate. They are shown separately because they say different
 * things: the interest rate is a floor the market returns to when nothing is
 * crowded, while the premium is the part that actually moves. A rate sitting
 * on the anchor means nobody is paying for anything; a rate driven by premium
 * means leveraged demand is paying up for the perp over spot.
 */
export default function RatesPanel({
  report,
  symbol,
}: {
  report: FundingReport | null;
  symbol: string;
}) {
  return (
    <GlassCard
      title={
        <span className="flex items-center gap-2">
          Interest &amp; Funding
          <span className="font-mono text-[9px] normal-case tracking-normal text-slate-600">
            {symbol}
          </span>
        </span>
      }
      className="h-full"
    >
      <div className="h-full overflow-y-auto p-3">
        {!report ? (
          <p className="p-4 text-center text-xs text-slate-500">Reading the funding series…</p>
        ) : (
          <Body report={report} />
        )}
      </div>
    </GlassCard>
  );
}

function Body({ report: r }: { report: FundingReport }) {
  const payerTone =
    r.payer === "longs" ? "text-bear" : r.payer === "shorts" ? "text-bull" : "text-slate-400";

  return (
    <div className="space-y-3">
      {/* The headline rate, and who it is costing. */}
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="text-[9px] uppercase tracking-[0.14em] text-slate-500">
            Funding now
          </div>
          <div className={`font-mono text-2xl font-bold leading-none ${payerTone}`}>
            {pct(r.currentRatePct, 4)}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[9px] uppercase tracking-[0.14em] text-slate-500">Next in</div>
          <Countdown at={r.nextFundingTime} />
        </div>
      </div>

      <p className={`text-[10px] leading-relaxed ${payerTone}`}>
        {r.payer === "longs"
          ? "Longs are paying shorts. The crowd is positioned long and is charged for it every settlement."
          : r.payer === "shorts"
            ? "Shorts are paying longs. The crowd is positioned short and is charged for it every settlement."
            : r.payer === "balanced"
              ? "Funding is flat — neither side is paying meaningfully to hold, so there is no crowded cohort here."
              : "No live rate available for this contract."}
      </p>

      {/* The two components of the rate, side by side. */}
      <div className="grid grid-cols-2 gap-2">
        <Cell
          label="Interest rate"
          value={pct(r.interestRatePct, 4)}
          hint="Binance's fixed component — the anchor the rate returns to when nothing is crowded. Not a market signal on its own."
        />
        <Cell
          label="Premium (mark/index)"
          value={pct(r.basisPct, 3)}
          tone={r.basisPct == null ? "" : r.basisPct > 0 ? "text-bull" : "text-bear"}
          hint="The perp against spot. This is the half of the funding formula that moves: positive means leveraged demand is paying up for the contract over the underlying."
        />
        <Cell
          label="Annualised"
          value={pct(r.annualisedPct, 1)}
          tone={payerTone}
          hint="The current rate quoted per year at the observed settlement cadence. It assumes the rate persists, which it will not — this is a cost expressed per year, not a forecast of one."
        />
        <Cell
          label="Paid this window"
          value={pct(r.cumulativePct, 3)}
          hint="Total the crowded side has paid across the settlements below. This is what eventually forces the exit."
        />
      </div>

      {/* Realised averages: one print is a spike, twenty is a standing cost. */}
      <div className="grid grid-cols-3 gap-2">
        <Cell label="Last" value={pct(r.avg8hPct, 4)} compact />
        <Cell label="24h avg" value={pct(r.avg24hPct, 4)} compact />
        <Cell label="7d avg" value={pct(r.avg7dPct, 4)} compact />
      </div>

      {r.consistency != null && (
        <div className="text-[10px] text-slate-400">
          <span className="font-mono text-slate-300">{(r.consistency * 100).toFixed(0)}%</span> of{" "}
          {r.history.length} settlements had the same sign.{" "}
          <span className="text-slate-600">
            {r.consistency >= 0.7
              ? "A standing cost rather than an outlier — the crowd is still carrying it."
              : "Mixed signs, so this reads as one or two spikes rather than a crowd being bled."}
          </span>
        </div>
      )}

      {r.history.length > 0 && <History points={r.history} />}

      <p className="text-[9px] leading-relaxed text-slate-600">{r.note}</p>
      {r.error && <p className="text-[9px] leading-relaxed text-bear/70">{r.error}</p>}
    </div>
  );
}

/**
 * The settled rates, most recent last.
 *
 * A bar per settlement rather than a number list: the shape is the point —
 * a run of same-sided bars is a crowd paying continuously, and a single tall
 * bar in an otherwise flat row is a squeeze that has already happened.
 */
function History({ points }: { points: { time: number; rate: number }[] }) {
  const max = Math.max(...points.map((p) => Math.abs(p.rate)), 1e-9);
  return (
    <div>
      <div className="mb-1 text-[9px] uppercase tracking-[0.14em] text-slate-500">
        Settled payments
      </div>
      <div className="flex h-12 items-center gap-[2px]">
        {points.map((p) => {
          const share = Math.abs(p.rate) / max;
          const up = p.rate >= 0;
          return (
            <div
              key={p.time}
              className="flex h-full flex-1 flex-col justify-center"
              title={`${new Date(p.time * 1000).toLocaleString()} · ${(p.rate * 100).toFixed(4)}% — ${
                up ? "longs paid shorts" : "shorts paid longs"
              }`}
            >
              <div className="flex h-1/2 items-end">
                {up && (
                  <div
                    className="w-full rounded-t-[1px] bg-bear/70"
                    style={{ height: `${Math.max(4, share * 100)}%` }}
                  />
                )}
              </div>
              <div className="flex h-1/2 items-start">
                {!up && (
                  <div
                    className="w-full rounded-b-[1px] bg-bull/70"
                    style={{ height: `${Math.max(4, share * 100)}%` }}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-0.5 flex justify-between font-mono text-[8px] text-slate-600">
        <span>{new Date(points[0].time * 1000).toLocaleDateString()}</span>
        <span className="text-bear/60">▲ longs pay</span>
        <span className="text-bull/60">▼ shorts pay</span>
        <span>now</span>
      </div>
    </div>
  );
}

function Cell({
  label,
  value,
  hint,
  tone = "",
  compact = false,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: string;
  compact?: boolean;
}) {
  return (
    <div
      className="rounded-lg border border-white/5 bg-white/[0.02] px-2 py-1.5"
      title={hint}
    >
      <div className="text-[8px] uppercase tracking-[0.12em] text-slate-500">{label}</div>
      <div className={`font-mono ${compact ? "text-[11px]" : "text-xs"} ${tone || "text-slate-200"}`}>
        {value}
      </div>
    </div>
  );
}

/** Time until the next settlement, ticking. */
function Countdown({ at }: { at: number | null }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  if (at == null) return <span className="font-mono text-sm text-slate-600">—</span>;
  const left = Math.max(0, at - now);
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;
  return (
    <span
      className="font-mono text-sm font-semibold tabular-nums text-neon-cyan"
      title={`Next settlement at ${new Date(at * 1000).toLocaleTimeString()}`}
    >
      {String(h).padStart(2, "0")}:{String(m).padStart(2, "0")}:{String(s).padStart(2, "0")}
    </span>
  );
}

function pct(v: number | null, dp: number): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(dp)}%`;
}
