"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import AppShell from "@/components/layout/AppShell";
import MarketSelector from "@/components/layout/MarketSelector";
import AIInsightPanel from "@/components/panels/AIInsightPanel";
import SignalPanel from "@/components/panels/SignalPanel";
import OrderFlowPanel from "@/components/panels/OrderFlowPanel";
import LiquidationPanel from "@/components/panels/LiquidationPanel";
import StructurePanel from "@/components/panels/StructurePanel";
import LevelsPanel from "@/components/panels/LevelsPanel";
import VolumeProfilePanel from "@/components/panels/VolumeProfilePanel";
import FootprintPanel from "@/components/panels/FootprintPanel";
import OrderFlowEventsPanel from "@/components/panels/OrderFlowEventsPanel";
import { useAnalysis } from "@/hooks/useAnalysis";
import { useLiveMarket } from "@/hooks/useLiveMarket";
import { useCandleCountdown } from "@/hooks/useCandleCountdown";
import { useMarketStore } from "@/stores/marketStore";
import { MARKETS } from "@/lib/config";
import { Candle } from "@/engines/types";

const TradingChart = dynamic(() => import("@/components/chart/TradingChart"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-xs text-slate-500">Loading chart engine…</div>
  ),
});

/**
 * The trading terminal: live chart with SMC overlays, AI analyst feed,
 * signal engine, order flow, liquidations, structure and key levels.
 */
export default function TerminalPage() {
  const { symbol, timeframe, overlays } = useMarketStore();
  const market = MARKETS.find((m) => m.symbol === symbol);
  const { analysis } = useAnalysis(symbol, timeframe);
  const { kline, price, liquidations, connected } = useLiveMarket(symbol, timeframe);
  const [candles, setCandles] = useState<Candle[]>([]);
  const { formatted } = useCandleCountdown(timeframe, candles[candles.length - 1]?.time);

  // Historical candles for the chart (analysis polls separately server-side).
  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/market/klines?symbol=${symbol}&timeframe=${timeframe}&limit=400`, { cache: "no-store" });
        const data = await res.json();
        if (!stop && data.candles) setCandles(data.candles);
      } catch {
        /* transient */
      }
    };
    setCandles([]);
    load();
    // Slow reconciliation only — the websocket is the live source of truth.
    const t = setInterval(load, 60_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [symbol, timeframe]);

  // Fold finished websocket candles straight into local state so a new bar
  // appears the instant it closes instead of waiting for the next poll.
  useEffect(() => {
    if (!kline?.closed) return;
    setCandles((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      if (kline.time < last.time) return prev;
      const bar: Candle = {
        time: kline.time,
        open: kline.open,
        high: kline.high,
        low: kline.low,
        close: kline.close,
        volume: kline.volume,
        takerBuyVolume: kline.takerBuyVolume,
      };
      if (kline.time === last.time) return [...prev.slice(0, -1), bar];
      return [...prev.slice(-499), bar];
    });
  }, [kline?.closed, kline?.time]);

  return (
    <AppShell>
      <div className="grid h-full grid-cols-1 gap-3 p-3 xl:grid-cols-[1fr_340px] xl:grid-rows-[minmax(0,1.4fr)_minmax(0,1fr)]">
        {/* Chart cell */}
        <div className="glass flex min-h-[420px] flex-col p-3 xl:min-h-0">
          <MarketSelector connected={connected} price={price} />
          <div className="min-h-0 flex-1">
            <TradingChart
              candles={candles}
              liveKline={kline}
              analysis={analysis}
              overlays={overlays}
              pricePrecision={market?.pricePrecision ?? 4}
              datasetKey={`${symbol}:${timeframe}`}
              countdown={formatted}
              livePrice={price}
            />
          </div>
        </div>

        {/* AI analyst — right rail, spans both rows on desktop */}
        <div className="min-h-[420px] xl:row-span-2 xl:min-h-0">
          <AIInsightPanel analysis={analysis} />
        </div>

        {/* Bottom intelligence row — the pulse/signal panel gets extra width */}
        <div className="grid min-h-0 grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-5">
          <div className="min-h-[520px] sm:col-span-2 2xl:min-h-0">
            <SignalPanel analysis={analysis} pricePrecision={market?.pricePrecision ?? 4} />
          </div>
          <div className="min-h-[320px] 2xl:min-h-0"><OrderFlowPanel analysis={analysis} /></div>
          <div className="min-h-[320px] 2xl:min-h-0"><LiquidationPanel analysis={analysis} liveLiquidations={liquidations} /></div>
          <div className="min-h-[320px] 2xl:min-h-0"><StructurePanel analysis={analysis} /></div>
        </div>
      </div>

      {/* Order-flow deep dive: footprint, volume profile, absorption/exhaustion */}
      <div className="grid grid-cols-1 gap-3 p-3 pt-0 lg:grid-cols-3">
        <div className="min-h-[440px]"><FootprintPanel analysis={analysis} /></div>
        <div className="min-h-[440px]"><VolumeProfilePanel analysis={analysis} /></div>
        <div className="min-h-[440px]"><OrderFlowEventsPanel analysis={analysis} /></div>
      </div>

      {/* Levels & patterns */}
      <div className="p-3 pt-0">
        <div className="max-h-[400px]">
          <LevelsPanel analysis={analysis} />
        </div>
      </div>
    </AppShell>
  );
}
