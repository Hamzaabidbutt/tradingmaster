"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { Timeframe } from "@/lib/config";

export interface OverlayToggles {
  orderBlocks: boolean;
  fvg: boolean;
  liquidity: boolean;
  structure: boolean;
  supportResistance: boolean;
  premiumDiscount: boolean;
  supplyDemand: boolean;
  tradeLevels: boolean;
  patterns: boolean;
  /** volume histogram + printed volume numbers */
  volume: boolean;
  volumeNumbers: boolean;
  /** per-bar delta row with numbers */
  deltaNumbers: boolean;
  /** per-bar aggregate liquidation delta row */
  liquidationDelta: boolean;
  /** cumulative aggregate liquidation delta line (running total) */
  liquidationCumulative: boolean;
  /** rolling buy-vs-sell pressure ribbon */
  pressure: boolean;
  /** hover card showing the stats of the candle under the cursor */
  candleInspector: boolean;
  /** resting bid clusters from the order book, drawn as price lines */
  buyWalls: boolean;
  /** resting ask clusters from the order book, drawn as price lines */
  sellWalls: boolean;
  volumeProfile: boolean;
  vwap: boolean;
  movingAverages: boolean;
  fibonacci: boolean;
  equalLevels: boolean;
  /** absorption / exhaustion / trapped-trader markers */
  orderFlowEvents: boolean;
  /** big-trade "bubbles" */
  bigTrades: boolean;
  cvd: boolean;
  /** open-interest line, two-tone like the CVD line */
  openInterest: boolean;
}

/** Where the candle inspector has been dragged to, in px from the chart's top-left. */
export interface InspectorPosition {
  x: number;
  y: number;
}

/** Market Pulse conclusion window, in minutes. */
export type PulseWindow = 5 | 15 | 60;

interface MarketState {
  symbol: string;
  timeframe: Timeframe;
  overlays: OverlayToggles;
  sidebarCollapsed: boolean;
  /** how far back the Market Pulse box concludes over */
  pulseWindowMinutes: PulseWindow;
  /** null until the user drags the inspector; then remembered across sessions */
  inspectorPos: InspectorPosition | null;
  /**
   * Collapsed to a one-line strip. Persisted because it is a standing
   * preference about screen real estate, not a per-visit choice — a user who
   * minimised it once wants it minimised tomorrow.
   */
  inspectorMinimized: boolean;
  setSymbol: (s: string) => void;
  setTimeframe: (tf: Timeframe) => void;
  toggleOverlay: (key: keyof OverlayToggles) => void;
  toggleSidebar: () => void;
  setPulseWindow: (m: PulseWindow) => void;
  setInspectorPos: (p: InspectorPosition | null) => void;
  toggleInspectorMinimized: () => void;
}

export const useMarketStore = create<MarketState>()(
  persist(
    (set) => ({
      symbol: "UNIUSDT",
      timeframe: "15m",
      overlays: {
        orderBlocks: true,
        fvg: true,
        liquidity: true,
        structure: true,
        supportResistance: true,
        premiumDiscount: false,
        supplyDemand: false,
        tradeLevels: true,
        patterns: true,
        volume: true,
        volumeNumbers: false,
        deltaNumbers: true,
        liquidationDelta: false,
        liquidationCumulative: false,
        pressure: false,
        candleInspector: true,
        // Off by default: both poll the order book, and a chart that quietly
        // opens a network poll nobody asked for is the wrong default.
        buyWalls: false,
        sellWalls: false,
        volumeProfile: true,
        vwap: true,
        movingAverages: false,
        fibonacci: false,
        equalLevels: true,
        orderFlowEvents: true,
        bigTrades: true,
        cvd: false,
        // Off by default alongside the order-book overlays: it opens a polling
        // loop, and a chart should not start one nobody asked for.
        openInterest: false,
      },
      sidebarCollapsed: false,
      // An hour of 1m candles reads market sentiment far more steadily than
      // five minutes, which is mostly noise.
      pulseWindowMinutes: 60,
      inspectorPos: null,
      inspectorMinimized: false,
      setSymbol: (symbol) => set({ symbol }),
      setTimeframe: (timeframe) => set({ timeframe }),
      toggleOverlay: (key) =>
        set((s) => ({ overlays: { ...s.overlays, [key]: !s.overlays[key] } })),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setPulseWindow: (pulseWindowMinutes) => set({ pulseWindowMinutes }),
      setInspectorPos: (inspectorPos) => set({ inspectorPos }),
      toggleInspectorMinimized: () =>
        set((st) => ({ inspectorMinimized: !st.inspectorMinimized })),
    }),
    {
      name: "tm-market",
      version: 3,
      /**
       * Overlay toggles are additive over time. Merge persisted values on
       * top of the current defaults so a browser holding an older shape
       * still receives newly added overlays (instead of them arriving as
       * `undefined` and silently rendering nothing).
       */
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<MarketState>;
        return {
          ...current,
          ...saved,
          overlays: { ...current.overlays, ...(saved.overlays ?? {}) },
        };
      },
    }
  )
);
