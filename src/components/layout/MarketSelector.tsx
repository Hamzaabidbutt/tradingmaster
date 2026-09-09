"use client";

import { useState } from "react";
import { TIMEFRAMES } from "@/lib/config";
import { OverlayToggles, useMarketStore } from "@/stores/marketStore";
import { useSymbols } from "@/hooks/useSymbols";
import SymbolSearch from "./SymbolSearch";
import MtfRibbon from "@/components/chart/MtfRibbon";

/** Overlay toggles grouped so the control strip stays readable. */
const OVERLAY_GROUPS: { group: string; items: { key: keyof OverlayToggles; label: string; title: string }[] }[] = [
  {
    group: "Smart Money",
    items: [
      { key: "orderBlocks", label: "OB", title: "Order blocks (fresh / respected / mitigated)" },
      { key: "fvg", label: "FVG", title: "Fair value gaps with fill state" },
      { key: "supplyDemand", label: "S/D", title: "Supply & demand zones, breaker blocks" },
      {
        key: "structure",
        label: "BOS",
        title:
          "BOS / CHOCH markers, each with a horizontal line back to the swing that was broken — so you can see the level the break came from, not just that it happened.",
      },
      {
        key: "swingLabels",
        label: "HH/LL",
        title:
          "Price action: every swing point labelled HH / HL / LH / LL, the sequence the structure read is built from.",
      },
      {
        key: "trendlines",
        label: "TREND",
        title:
          "Auto trendlines through swing points price actually respected — three touches minimum, and never drawn through a swing price traded straight past. Broken lines stay, dimmed.",
      },
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
      {
        key: "orderFlowEvents",
        label: "ABS",
        title:
          "Order-flow events named by side: SUPPLY ABSORBED (selling ate by resting bids, bullish) vs DEMAND ABSORBED (buying ate by resting offers, bearish); BUYERS / SELLERS EXHAUSTED; and trapped traders. Absorption also draws its price as a level.",
      },
      { key: "bigTrades", label: "BIG", title: "Large-order bubbles" },
      {
        key: "contractBubbles",
        label: "CONTRACTS",
        title:
          "A bubble on every candle sized by contracts traded and split buy against sell, with the counts printed when the bars are wide enough. Colour follows net taker delta — who crossed the spread — not the candle's direction. Needs room: zoomed out past a few pixels a bar it draws nothing rather than a smear.",
      },
      {
        key: "aggressiveCandles",
        label: "AGGR",
        title:
          "Candles where one side crossed the spread on real volume: 68%+ of takers on one side AND above-average participation. Skew alone marks a third of every quiet session, so both are required.",
      },
      {
        key: "stackedImbalance",
        label: "STACK",
        title:
          "Candles carrying three or more consecutive footprint imbalances on the same side, bracketed over the price range they span. Requires the footprint — reconstructed footprints mark shape, not exact levels.",
      },
      {
        key: "squeezeCandles",
        label: "SHAKEOUT",
        title:
          "Bars where the trend's OWN side was liquidated: shorts forced out in a downtrend, longs in an uptrend. A downtrend liquidating longs is just the trend working and is never marked — the marked bars are the ones where the people positioned correctly were removed, which both clears the fuel under the move and is where trend-followers are worst placed.",
      },
      {
        key: "cvdDivergence",
        label: "CVD DIV",
        title:
          "Price and cumulative delta pulling opposite ways, drawn as two lines rather than a label — the claim is about slope, and a marginal divergence and a screaming one look identical labelled. Higher high on falling delta is distribution; lower low on rising delta is accumulation. Not a reversal signal: divergences persist, and many end by ceasing to diverge.",
      },
      { key: "candleInspector", label: "OHLC", title: "Hover card with the stats of the candle under the cursor" },
    ],
  },
  {
    group: "Levels",
    items: [
      {
        key: "volumeProfile",
        label: "VP",
        title:
          "Volume profile: POC, value area, and both node types — HVN (price the market accepted and keeps returning to) and LVN (price it rejected and tends to travel through quickly).",
      },
      {
        key: "deltaProfile",
        label: "ΔVP",
        title:
          "Delta volume profile: the same price bins, but showing NET taker delta rather than total volume. Volume says where trading happened; this says who won at each price — buyers to the right, sellers to the left of a zero axis.",
      },
      { key: "vwap", label: "VWAP", title: "Session VWAP" },
      { key: "movingAverages", label: "MA", title: "Key moving averages (EMA 9/21/50, SMA 100/200)" },
      { key: "fibonacci", label: "FIB", title: "Auto Fibonacci with golden pocket" },
      { key: "tradeLevels", label: "TRADE", title: "Active setup entry / stop / targets" },
      { key: "patterns", label: "PAT", title: "Candlestick pattern markers" },
      {
        key: "sessions",
        label: "SESS",
        title:
          "Trading sessions shaded behind the candles: Asia 00-08, Europe 08-13, US 13-21, late 21-24 UTC. Hidden on daily and above, where a bar spans several of them.",
      },
      {
        key: "buyingChecklist",
        label: "BUY ✓",
        title:
          "The institutional buying checklist drawn on the chart: the demand area, a mark on every bar an item was found on, and the tick/cross list with both side scores.",
      },
    ],
  },
];

/**
 * Reading layers — one click per stage of a chart read.
 *
 * The toggle list below is the full instrument panel and stays exactly as it
 * is; this sits on top of it. Thirty-odd independent switches describe what
 * *can* be drawn but say nothing about the order to look in, and a market read
 * is not a set of facts gathered in parallel — it is a sequence of conditional
 * questions, each of which decides what the next one is even allowed to mean:
 *
 *  1. REGIME     which playbook applies at all
 *  2. LOCATION   is this a price worth acting from
 *  3. STRUCTURE  which side carries the burden of proof
 *  4. FLOW       who is actually acting, right now
 *  5. POSITION   who is already committed, and what it costs them
 *
 * The rule the sequence exists to enforce: flow without location is noise, and
 * location without flow is a hope. Only the conjunction is worth anything, and
 * you cannot see a conjunction while looking at everything at once.
 *
 * Applying a layer switches its own overlays on and the other layers' off, so
 * each click is a clean pass rather than an accumulation. Overlays belonging to
 * no layer (the inspector, the trade levels) are left exactly as the user set
 * them — a preset is a lens on the chart, not a reset of their preferences.
 */
const LAYER_PRESETS: { id: string; label: string; title: string; keys: (keyof OverlayToggles)[] }[] = [
  {
    id: "regime",
    label: "1 · REGIME",
    title:
      "Which playbook applies. Trend or range, and the clock it is running on — before any signal means anything. A mean-reversion setup inside a strong trend and a breakout inside a range are the same evidence read the wrong way round.",
    keys: ["movingAverages", "trendlines", "sessions", "vwap", "volume"],
  },
  {
    id: "location",
    label: "2 · LOCATION",
    title:
      "Is this a price worth acting from? Value, the nodes either side of it, and the levels price has already respected. Location is what decides the risk-to-reward of everything that follows — mid-range, nothing is worth taking however good the flow looks.",
    keys: [
      "volumeProfile",
      "supportResistance",
      "orderBlocks",
      "fvg",
      "premiumDiscount",
      "supplyDemand",
      "equalLevels",
    ],
  },
  {
    id: "structure",
    label: "3 · STRUCTURE",
    title:
      "Which side carries the burden of proof. The swing sequence, the breaks in it, and the liquidity those breaks ran into.",
    keys: ["structure", "swingLabels", "trendlines", "liquidity", "equalLevels"],
  },
  {
    id: "flow",
    label: "4 · FLOW",
    title:
      "Who is acting right now. Delta, the footprint reads, aggression and absorption — the only layer that answers whether anybody is actually behind the level, and the trigger for everything the first three layers set up.",
    keys: [
      "volume",
      "deltaNumbers",
      "orderFlowEvents",
      "aggressiveCandles",
      "stackedImbalance",
      "cvd",
      "cvdDivergence",
      "squeezeCandles",
      "bigTrades",
    ],
  },
  {
    id: "position",
    label: "5 · POSITION",
    title:
      "Who is already committed and what it costs them. Open interest, forced flow and the resting size — this is where the fuel for the next move is, and who supplies it.",
    keys: ["openInterest", "liquidationDelta", "liquidationCumulative", "buyWalls", "sellWalls"],
  },
];

/** Every key any layer touches — the set a preset is allowed to turn off. */
const LAYER_KEYS = Array.from(new Set(LAYER_PRESETS.flatMap((l) => l.keys)));

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
  const { symbol, timeframe, setSymbol, setTimeframe, overlays, toggleOverlay, setOverlays } =
    useMarketStore();
  const { precisionFor } = useSymbols();
  const [overlaysOpen, setOverlaysOpen] = useState(false);
  const activeCount = Object.values(overlays).filter(Boolean).length;

  /** Switch one layer's overlays on and the other layers' off. */
  const applyLayer = (keys: (keyof OverlayToggles)[]) => {
    const wanted = new Set(keys);
    const patch: Partial<OverlayToggles> = {};
    for (const k of LAYER_KEYS) patch[k] = wanted.has(k);
    setOverlays(patch);
  };

  /**
   * A layer reads as active when everything it asks for is on. Deliberately
   * not "no other layer's keys are on" — layers share overlays (trendlines
   * belong to both regime and structure), so exclusivity would mean no layer
   * ever lit up.
   */
  const layerActive = (keys: (keyof OverlayToggles)[]) => keys.every((k) => overlays[k]);

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

      {/* Reading layers, and the higher clocks beside them. Above the toggle
          list because both are coarser controls: pick the pass you are on and
          check what the bigger timeframes say, then reach for individual
          switches only if that pass needs adjusting. */}
      <div className="flex flex-wrap items-center gap-1">
        <MtfRibbon symbol={symbol} />
        <span className="mx-1 h-3 w-px bg-white/10" />
        <span
          className="mr-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500"
          title="One click per stage of a chart read. Work through them in order: regime decides which playbook applies, location decides whether the price is worth acting from, structure says who has the burden of proof, flow says who is acting now, position says who is already committed. Flow without location is noise; location without flow is a hope."
        >
          Layers
        </span>
        {LAYER_PRESETS.map((layer) => {
          const on = layerActive(layer.keys);
          return (
            <button
              key={layer.id}
              onClick={() => applyLayer(layer.keys)}
              aria-pressed={on}
              title={layer.title}
              className={`rounded-md border px-2 py-0.5 font-mono text-[9px] font-semibold tracking-wide transition-colors ${
                on
                  ? "border-neon-cyan/50 bg-neon-cyan/15 text-neon-cyan"
                  : "border-white/10 text-slate-500 hover:border-neon-cyan/30 hover:text-slate-300"
              }`}
            >
              {layer.label}
            </button>
          );
        })}
        <button
          onClick={() => applyLayer(LAYER_KEYS)}
          title="Every layer's overlays at once. Useful for a final sweep, but this is the view the layers exist to break up — everything on is the state in which nothing stands out."
          className="rounded-md border border-white/10 px-2 py-0.5 font-mono text-[9px] font-semibold text-slate-500 transition-colors hover:border-neon-cyan/30 hover:text-slate-300"
        >
          ALL
        </button>
        <button
          onClick={() => applyLayer([])}
          title="Clear every layer overlay, leaving a bare chart. Overlays outside the layers — the candle inspector, trade levels, patterns — are left as you set them."
          className="rounded-md border border-white/10 px-2 py-0.5 font-mono text-[9px] font-semibold text-slate-500 transition-colors hover:border-bear/40 hover:text-slate-300"
        >
          CLEAR
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
