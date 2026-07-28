"use client";

import { MARKETS, TIMEFRAMES } from "@/lib/config";
import { useMarketStore } from "@/stores/marketStore";

/** Symbol + timeframe + overlay controls for the chart header. */
export default function MarketSelector({ connected, price }: { connected: boolean; price: number | null }) {
  const { symbol, timeframe, setSymbol, setTimeframe, overlays, toggleOverlay } = useMarketStore();
  const market = MARKETS.find((m) => m.symbol === symbol);

  return (
    <div className="flex flex-wrap items-center gap-2 px-1 pb-2">
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

      <div className="ml-auto flex flex-wrap gap-1">
        {(
          [
            ["orderBlocks", "OB"],
            ["fvg", "FVG"],
            ["liquidity", "LIQ"],
            ["structure", "BOS"],
            ["supportResistance", "S/R"],
            ["supplyDemand", "S/D"],
            ["premiumDiscount", "P/D"],
            ["patterns", "PAT"],
            ["tradeLevels", "TRADE"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => toggleOverlay(key)}
            aria-pressed={overlays[key]}
            className={`rounded-md border px-1.5 py-0.5 font-mono text-[9px] font-semibold transition-colors ${
              overlays[key]
                ? "border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan"
                : "border-white/10 text-slate-600 hover:text-slate-400"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
