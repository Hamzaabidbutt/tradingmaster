"use client";

import { useState } from "react";
import { TIMEFRAMES } from "@/lib/config";
import { OverlayToggles, useMarketStore } from "@/stores/marketStore";
import { useSymbols } from "@/hooks/useSymbols";
import SymbolSearch from "./SymbolSearch";

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
      { key: "buyWalls", label: "BID WALL", title: "Large resting bid clusters from the live order book — where a decline runs into size" },
      { key: "sellWalls", label: "ASK WALL", title: "Large resting ask clusters from the live order book — supply that must be absorbed" },
    ],
  },
  {
    group: "Order Flow",
    items: [
      { key: "volume", label: "VOL", title: "Volume histogram" },
      { key: "volumeNumbers", label: "VOL#", title: "Print volume numbers under each bar" },
      { key: "deltaNumbers", label: "Δ#", title: "Print volume delta numbers under each bar" },
      { key: "liquidationDelta", label: "LIQΔ", title: "Aggregate liquidation delta per bar" },
      { key: "liquidationCumulative", label: "ΣLIQΔ", title: "Cumulative aggregate liquidation delta — running forced-flow balance" },
      { key: "pressure", label: "BUY%", title: "Buy-vs-sell pressure ribbon per bar" },
      { key: "cvd", label: "CVD", title: "Cumulative volume delta line" },
      {
        key: "openInterest",
        label: "Open Interest",
        title:
          "Open-interest line. Delta says who was aggressive; this says whether that aggression opened positions or closed them.",
      },
      { key: "orderFlowEvents", label: "ABS", title: "Absorption, exhaustion & trapped-trader markers" },
      { key: "bigTrades", label: "BIG", title: "Large-order bubbles" },
      { key: "candleInspector", label: "OHLC", title: "Hover card with the stats of the candle under the cursor" },
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
      {
        key: "buyingChecklist",
        label: "BUY ✓",
        title:
          "The institutional buying checklist drawn on the chart: the demand area, a mark on every bar an item was found on, and the tick/cross list with both side scores.",
      },
    ],
  },
];

/** Symbol + timeframe + overlay controls for the chart header. */
export default function MarketSelector({
  connected,
  price,
  countdown,
}: {
  connected: boolean;
  price: number | null;
  countdown?: string;
}) {
  const { symbol, timeframe, setSymbol, setTimeframe, overlays, toggleOverlay } = useMarketStore();
  const { precisionFor } = useSymbols();
  const [overlaysOpen, setOverlaysOpen] = useState(false);
  const activeCount = Object.values(overlays).filter(Boolean).length;

  return (
    <div className="space-y-2 px-1 pb-2">
      <div className="flex flex-wrap items-center gap-2">
        <SymbolSearch symbol={symbol} onSelect={setSymbol} />

        {price != null && (
          <span className="font-mono text-lg font-bold text-slate-100">{price.toFixed(precisionFor(symbol))}</span>
        )}
        <span
          className={`h-2 w-2 rounded-full ${connected ? "pulse-dot bg-bull" : "bg-bear"}`}
          title={connected ? "Live websocket connected" : "Reconnecting…"}
        />

        {/* Always-visible candle countdown — independent of the socket. */}
        {countdown && (
          <span
            className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1 font-mono text-[11px] font-semibold tabular-nums text-neon-cyan"
            title={`Time remaining until the current ${timeframe} candle closes`}
          >
            <span className="text-slate-500">⏱</span>
            {countdown}
          </span>
        )}

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
