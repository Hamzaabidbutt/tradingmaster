"use client";

import { useState } from "react";
import { MARKETS, TIMEFRAMES } from "@/lib/config";
import { OverlayToggles, useMarketStore } from "@/stores/marketStore";

/** Overlay toggles grouped so the control strip stays readable. */
const OVERLAY_GROUPS: { group: string; items: { key: keyof OverlayToggles; label: string; title: string }[] }[] = [
  {
    group: "Smart Money",
    items: [
      { key: "orderBlocks", label: "OB", title: "Order blocks (fresh / respected / mitigated)" },
      { key: "fvg", label: "FVG", title: "Fair value gaps with fill state" },
      { key: "supplyDemand", label: "S/D", title: "Supply & demand zones, breaker blocks" },
      { key: "structure", label: "BOS", title: "BOS / CHOCH structure markers" },
      { key: "premiumDiscount", label: "P/D", title: "Premium / discount zones with equilibrium" },
    ],
  },
  {
    group: "Liquidity",
    items: [
      { key: "liquidity", label: "LIQ", title: "Buy/sell-side liquidity and sweeps" },
      { key: "equalLevels", label: "EQH/L", title: "Equal highs & lows connected with lines" },
      { key: "supportResistance", label: "S/R", title: "Scored support & resistance levels" },
    ],
  },
  {
    group: "Order Flow",
    items: [
      { key: "volume", label: "VOL", title: "Volume histogram" },
      { key: "volumeNumbers", label: "VOL#", title: "Print volume numbers under each bar" },
      { key: "deltaNumbers", label: "Δ#", title: "Print volume delta numbers under each bar" },
      { key: "liquidationDelta", label: "LIQΔ", title: "Aggregate liquidation delta per bar" },
      { key: "cvd", label: "CVD", title: "Cumulative volume delta line" },
      { key: "orderFlowEvents", label: "ABS", title: "Absorption, exhaustion & trapped-trader markers" },
      { key: "bigTrades", label: "BIG", title: "Large-order bubbles" },
    ],
  },
  {
    group: "Levels",
    items: [
      { key: "volumeProfile", label: "VP", title: "Volume profile: POC, value area, LVNs" },
      { key: "vwap", label: "VWAP", title: "Session VWAP" },
      { key: "movingAverages", label: "MA", title: "Key moving averages (EMA 9/21/50, SMA 100/200)" },
      { key: "fibonacci", label: "FIB", title: "Auto Fibonacci with golden pocket" },
      { key: "tradeLevels", label: "TRADE", title: "Active setup entry / stop / targets" },
      { key: "patterns", label: "PAT", title: "Candlestick pattern markers" },
    ],
  },
];

/** Symbol + timeframe + overlay controls for the chart header. */
export default function MarketSelector({ connected, price }: { connected: boolean; price: number | null }) {
  const { symbol, timeframe, setSymbol, setTimeframe, overlays, toggleOverlay } = useMarketStore();
  const market = MARKETS.find((m) => m.symbol === symbol);
  const [overlaysOpen, setOverlaysOpen] = useState(false);
  const activeCount = Object.values(overlays).filter(Boolean).length;

  return (
    <div className="space-y-2 px-1 pb-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          className="rounded-lg border border-white/10 bg-base-800 px-2.5 py-1.5 font-mono text-sm font-semibold text-slate-100 outline-none focus:border-neon-cyan/50"
          aria-label="Trading pair"
        >
          {MARKETS.map((m) => (
            <option key={m.symbol} value={m.symbol}>{m.label}</option>
          ))}
        </select>

        {price != null && (
          <span className="font-mono text-lg font-bold text-slate-100">
            {price.toFixed(market?.pricePrecision ?? 4)}
          </span>
        )}
        <span
          className={`h-2 w-2 rounded-full ${connected ? "pulse-dot bg-bull" : "bg-bear"}`}
          title={connected ? "Live websocket connected" : "Reconnecting…"}
        />

        <div className="flex flex-wrap gap-0.5 rounded-lg bg-white/5 p-0.5" role="tablist" aria-label="Timeframe">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              onClick={() => setTimeframe(tf)}
              role="tab"
              aria-selected={timeframe === tf}
              className={`rounded-md px-1.5 py-1 font-mono text-[10px] transition-colors ${
                timeframe === tf ? "bg-neon-cyan/15 font-bold text-neon-cyan" : "text-slate-500 hover:text-slate-300"
              }`}
            >
              {tf}
            </button>
          ))}
        </div>

        <button
          onClick={() => setOverlaysOpen((o) => !o)}
          aria-expanded={overlaysOpen}
          className="ml-auto rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-300 transition-colors hover:border-neon-cyan/40 hover:text-neon-cyan"
        >
          Indicators
          <span className="ml-1.5 rounded-full bg-neon-cyan/15 px-1.5 py-0.5 font-mono text-[9px] text-neon-cyan">
            {activeCount}
          </span>
          <span className="ml-1.5 text-slate-500">{overlaysOpen ? "▲" : "▼"}</span>
        </button>
      </div>

      {overlaysOpen && (
        <div className="animate-slide-up grid grid-cols-1 gap-2 rounded-xl border border-white/5 bg-white/[0.02] p-2.5 sm:grid-cols-2 lg:grid-cols-4">
          {OVERLAY_GROUPS.map((g) => (
            <div key={g.group}>
              <div className="mb-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                {g.group}
              </div>
              <div className="flex flex-wrap gap-1">
                {g.items.map((item) => (
                  <button
                    key={item.key}
                    onClick={() => toggleOverlay(item.key)}
                    aria-pressed={overlays[item.key]}
                    title={item.title}
                    className={`rounded-md border px-1.5 py-0.5 font-mono text-[9px] font-semibold transition-colors ${
                      overlays[item.key]
                        ? "border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan"
                        : "border-white/10 text-slate-600 hover:text-slate-400"
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
