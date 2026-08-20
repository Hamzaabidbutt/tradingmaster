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
  setSymbol: (s: string) => void;
  setTimeframe: (tf: Timeframe) => void;
  toggleOverlay: (key: keyof OverlayToggles) => void;
  toggleSidebar: () => void;
  setPulseWindow: (m: PulseWindow) => void;
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
        volumeProfile: true,
        vwap: true,
        movingAverages: false,
        fibonacci: false,
        equalLevels: true,
        orderFlowEvents: true,
        bigTrades: true,
        cvd: false,
      },
      sidebarCollapsed: false,
      // An hour of 1m candles reads market sentiment far more steadily than
      // five minutes, which is mostly noise.
      pulseWindowMinutes: 60,
      setSymbol: (symbol) => set({ symbol }),
      setTimeframe: (timeframe) => set({ timeframe }),
      toggleOverlay: (key) =>
        set((s) => ({ overlays: { ...s.overlays, [key]: !s.overlays[key] } })),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setPulseWindow: (pulseWindowMinutes) => set({ pulseWindowMinutes }),
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
