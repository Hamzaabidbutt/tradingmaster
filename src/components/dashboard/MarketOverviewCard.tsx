"use client";

import { GlassCard, StatChip, timeAgo } from "@/components/ui/primitives";
import { EmptyNote, fmtPct, fmtPrice, fmtVolume, useOpenInTerminal } from "./shared";
import type { OverviewResponse } from "@/app/api/overview/route";

/**
 * Block 1 — Market Overview.
 *
 * Breadth across the whole perpetual universe, not a hand-picked basket: the
 * advance/decline count is what tells you whether BTC being up 2% is the market
 * or just BTC.
 */
export default function MarketOverviewCard({
  data,
  error,
  loading,
}: {
  data: OverviewResponse | null;
  error: string | null;
  loading: boolean;
}) {
  const open = useOpenInTerminal();

  return (
    <GlassCard
      title="Market Overview"
      action={
        data ? (
          <span className="font-mono text-[10px] text-slate-500">
            {data.universe} pairs · {timeAgo(data.generatedAt)}
          </span>
        ) : null
      }
    >
      {!data ? (
        <EmptyNote>
          {loading ? "Reading the universe…" : `Market breadth unavailable${error ? ` — ${error}` : ""}.`}
        </EmptyNote>
      ) : (
        <div className="space-y-3 p-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StatChip label="Advancing" value={data.advancing} tone="bull" />
            <StatChip label="Declining" value={data.declining} tone="bear" />
            <StatChip
              label="A/D ratio"
              value={data.advanceDeclineRatio.toFixed(2)}
              tone={data.advanceDeclineRatio >= 1 ? "bull" : "bear"}
            />
            <StatChip label="24h volume" value={fmtVolume(data.totalQuoteVolume)} tone="cyan" />
          </div>

          {/* Breadth bar: the share of the universe that is up on the day. */}
          <div>
            <div className="mb-1 flex justify-between font-mono text-[10px] text-slate-500">
              <span>Breadth — {data.breadthPct.toFixed(1)}% of pairs up</span>
              <span>
                median {fmtPct(data.medianChangePct)} · mean {fmtPct(data.meanChangePct)}
              </span>
            </div>
            <div className="flex h-1.5 overflow-hidden rounded-full bg-base-800">
              <div className="bg-bull transition-all duration-700" style={{ width: `${data.breadthPct}%` }} />
              <div className="flex-1 bg-bear/70" />
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            {data.majors.map((m) => (
              <button
                key={m.symbol}
                onClick={() => open(m.symbol)}
                className="flex items-baseline justify-between rounded-lg bg-white/[0.03] px-3 py-2 text-left transition-colors hover:bg-white/[0.07]"
              >
                <span className="text-xs font-semibold text-slate-300">{m.label}</span>
                <span className="flex items-baseline gap-2 font-mono text-xs">
                  <span className="text-slate-200">{fmtPrice(m.lastPrice)}</span>
                  <span className={m.changePct >= 0 ? "text-bull" : "text-bear"}>{fmtPct(m.changePct)}</span>
                </span>
              </button>
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <MoverList title="Top gainers" rows={data.topGainers} tone="bull" onOpen={open} />
            <MoverList title="Top losers" rows={data.topLosers} tone="bear" onOpen={open} />
          </div>
        </div>
      )}
    </GlassCard>
  );
}

function MoverList({
  title,
  rows,
  tone,
  onOpen,
}: {
  title: string;
  rows: { symbol: string; changePct: number; quoteVolume: number }[];
  tone: "bull" | "bear";
  onOpen: (symbol: string) => void;
}) {
  return (
    <div>
      <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">{title}</h4>
      <ul className="space-y-0.5">
        {rows.slice(0, 5).map((r) => (
          <li key={r.symbol}>
            <button
              onClick={() => onOpen(r.symbol)}
              className="flex w-full items-baseline justify-between rounded px-1.5 py-1 font-mono text-[11px] transition-colors hover:bg-white/5"
            >
              <span className="text-slate-400">{r.symbol.replace(/USDT$/, "")}</span>
              <span className="flex gap-2">
                <span className="text-slate-600">{fmtVolume(r.quoteVolume)}</span>
                <span className={tone === "bull" ? "text-bull" : "text-bear"}>{fmtPct(r.changePct)}</span>
              </span>
            </button>
          </li>
        ))}
        {rows.length === 0 && <li className="px-1.5 text-[11px] text-slate-600">—</li>}
      </ul>
    </div>
  );
}
