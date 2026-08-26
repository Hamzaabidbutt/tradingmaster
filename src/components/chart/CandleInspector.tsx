"use client";

import { CandleStats } from "@/engines/candleStats";

/**
 * Detail card for a clicked candle.
 *
 * Rendered as an overlay inside the chart rather than a separate panel so the
 * numbers sit next to the bar they describe. Values the analysis window does
 * not cover render as "—" instead of zero, because zero forced flow and *no
 * data about* forced flow mean very different things.
 */
export default function CandleInspector({
  stats,
  pricePrecision,
  onClose,
}: {
  stats: CandleStats;
  pricePrecision: number;
  onClose: () => void;
}) {
  const p = (v: number) => v.toFixed(pricePrecision);
  const when = new Date(stats.time * 1000);

  return (
    <div className="absolute left-2 top-2 z-20 w-[248px] rounded-xl border border-white/10 bg-base-900/95 p-2.5 shadow-glass backdrop-blur-xl">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div>
          <div
            className={`font-mono text-[11px] font-bold ${stats.bullish ? "text-bull" : "text-bear"}`}
          >
            {stats.bullish ? "▲" : "▼"} {stats.changePct >= 0 ? "+" : ""}
            {stats.changePct.toFixed(2)}%
          </div>
          <div className="font-mono text-[9px] text-slate-500">
            {when.toLocaleDateString()} {when.toLocaleTimeString()}
          </div>
        </div>
        <button
          onClick={onClose}
          aria-label="Close candle details"
          className="rounded px-1.5 py-0.5 text-[11px] text-slate-500 transition-colors hover:bg-white/10 hover:text-slate-200"
        >
          ✕
        </button>
      </div>

      <div className="grid grid-cols-2 gap-1">
        <Row label="High" value={p(stats.high)} />
        <Row label="Low" value={p(stats.low)} />
        <Row label="Open" value={p(stats.open)} />
        <Row label="Close" value={p(stats.close)} />
        <Row
          label="Range"
          value={`${p(stats.range)}`}
          sub={`${stats.rangePct.toFixed(2)}%`}
          span
        />
      </div>

      <Divider />

      <div className="grid grid-cols-2 gap-1">
        <Row
          label="Volume"
          value={fmt(stats.volume)}
          sub={stats.volumeMultiple != null ? `${stats.volumeMultiple}× avg` : undefined}
          tone={stats.volumeMultiple != null && stats.volumeMultiple > 1.5 ? "amber" : "plain"}
          span
        />
        <Row label="Buy vol" value={fmt(stats.buyVolume)} tone="bull" />
        <Row label="Sell vol" value={fmt(stats.sellVolume)} tone="bear" />
        <Row
          label="Delta vol"
          value={`${stats.deltaVolume >= 0 ? "+" : ""}${fmt(stats.deltaVolume)}`}
          tone={stats.deltaVolume >= 0 ? "bull" : "bear"}
        />
        <Row
          label="Buy %"
          value={`${stats.buyPct.toFixed(1)}%`}
          tone={stats.buyPct >= 55 ? "bull" : stats.buyPct <= 45 ? "bear" : "plain"}
        />
      </div>

      {/* Buy/sell split bar — the ratio is easier to read than two numbers. */}
      <div className="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-white/5">
        <div className="bg-bull" style={{ width: `${stats.buyPct}%` }} />
        <div className="bg-bear" style={{ width: `${100 - stats.buyPct}%` }} />
      </div>

      <Divider />

      <div className="grid grid-cols-2 gap-1">
        <Row
          label="Liq Δ"
          value={
            stats.liquidationDelta == null
              ? "—"
              : `${stats.liquidationDelta >= 0 ? "+" : ""}${fmt(stats.liquidationDelta)}`
          }
          tone={
            stats.liquidationDelta == null
              ? "plain"
              : stats.liquidationDelta > 0
                ? "bull"
                : stats.liquidationDelta < 0
                  ? "bear"
                  : "plain"
          }
        />
        <Row
          label="Σ Liq Δ"
          value={
            stats.liquidationCumulative == null
              ? "—"
              : `${stats.liquidationCumulative >= 0 ? "+" : ""}${fmt(stats.liquidationCumulative)}`
          }
          tone={
            stats.liquidationCumulative == null
              ? "plain"
              : stats.liquidationCumulative >= 0
                ? "bull"
                : "bear"
          }
        />
        <Row
          label="CVD"
          value={stats.cvd == null ? "—" : `${stats.cvd >= 0 ? "+" : ""}${fmt(stats.cvd)}`}
          tone={stats.cvd == null ? "plain" : stats.cvd >= 0 ? "bull" : "bear"}
          span
        />
      </div>

      {stats.liquidationDelta == null && (
        <p className="mt-1.5 text-[9px] leading-relaxed text-slate-600">
          Forced-flow and CVD figures cover the analysed window only — this bar sits outside it.
        </p>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  sub,
  tone = "plain",
  span,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "bull" | "bear" | "amber" | "plain";
  span?: boolean;
}) {
  const color =
    tone === "bull"
      ? "text-bull"
      : tone === "bear"
        ? "text-bear"
        : tone === "amber"
          ? "text-neon-amber"
          : "text-slate-200";
  return (
    <div className={`rounded bg-white/[0.03] px-1.5 py-1 ${span ? "col-span-2" : ""}`}>
      <div className="text-[8px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`font-mono text-[10px] font-semibold ${color}`}>
        {value}
        {sub && <span className="ml-1 font-normal text-slate-500">{sub}</span>}
      </div>
    </div>
  );
}

function Divider() {
  return <div className="my-1.5 border-t border-white/5" />;
}

function fmt(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${abs.toFixed(abs < 10 ? 2 : 0)}`;
}
