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
}

interface MarketState {
  symbol: string;
  timeframe: Timeframe;
  overlays: OverlayToggles;
  sidebarCollapsed: boolean;
  setSymbol: (s: string) => void;
  setTimeframe: (tf: Timeframe) => void;
  toggleOverlay: (key: keyof OverlayToggles) => void;
  toggleSidebar: () => void;
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
      },
      sidebarCollapsed: false,
      setSymbol: (symbol) => set({ symbol }),
      setTimeframe: (timeframe) => set({ timeframe }),
      toggleOverlay: (key) =>
        set((s) => ({ overlays: { ...s.overlays, [key]: !s.overlays[key] } })),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
    }),
    { name: "tm-market" }
  )
);
