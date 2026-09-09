"use client";

import dynamic from "next/dynamic";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import AppShell from "@/components/layout/AppShell";
import { useOpenInterest } from "@/hooks/useOpenInterest";
import { useInstitutional } from "@/hooks/useInstitutional";
import { useFunding } from "@/hooks/useFunding";
import RatesPanel from "@/components/panels/RatesPanel";
import PositioningPanel from "@/components/panels/PositioningPanel";
import ConflictPanel from "@/components/panels/ConflictPanel";
import Foldable from "@/components/layout/Foldable";
import StateCard from "@/components/panels/StateCard";
import { useSeasonality } from "@/hooks/useSeasonality";
import SeasonalityPanel from "@/components/panels/SeasonalityPanel";
import MarketSelector from "@/components/layout/MarketSelector";
import AIInsightPanel from "@/components/panels/AIInsightPanel";
import SignalPanel from "@/components/panels/SignalPanel";
import OrderFlowPanel from "@/components/panels/OrderFlowPanel";
import LiquidationPanel from "@/components/panels/LiquidationPanel";
import StructurePanel from "@/components/panels/StructurePanel";
import LevelsPanel from "@/components/panels/LevelsPanel";
import VolumeProfilePanel from "@/components/panels/VolumeProfilePanel";
import FootprintPanel from "@/components/panels/FootprintPanel";
import PressureMapPanel from "@/components/panels/PressureMapPanel";
import OrderFlowEventsPanel from "@/components/panels/OrderFlowEventsPanel";
import MultiWindowPanel from "@/components/panels/MultiWindowPanel";
import ChartAnalystPanel from "@/components/panels/ChartAnalystPanel";
import CandleCloseExpansionPanel from "@/components/panels/CandleCloseExpansionPanel";
import RangeTradingPanel from "@/components/panels/RangeTradingPanel";
import { useAnalysis } from "@/hooks/useAnalysis";
import { useLiveMarket } from "@/hooks/useLiveMarket";
import { useOrderWalls } from "@/hooks/useOrderWalls";
import OrderWallStrip from "@/components/chart/OrderWallStrip";
import EventTape from "@/components/chart/EventTape";
import WhaleOrdersPanel from "@/components/panels/WhaleOrdersPanel";
import { useCandleCountdown } from "@/hooks/useCandleCountdown";
import { useSymbols } from "@/hooks/useSymbols";
import { useMarketStore } from "@/stores/marketStore";
import { Candle } from "@/engines/types";
import { isValidTimeframe } from "@/lib/config";
import { fetchKlinesDirect } from "@/lib/marketClient";

const TradingChart = dynamic(() => import("@/components/chart/TradingChart"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-xs text-slate-500">Loading chart engine…</div>
  ),
});

/**
 * The trading terminal: live chart with SMC overlays, AI analyst feed,
 * signal engine, order flow, liquidations, structure and key levels.
 *
 * `useSearchParams` needs a Suspense boundary, or the prerender of this
 * statically-rendered route bails out.
 */
export default function TerminalPage() {
  return (
    <Suspense
      fallback={
        <AppShell>
          <p className="p-4 text-sm text-slate-500">Loading terminal…</p>
        </AppShell>
      }
    >
      <Terminal />
    </Suspense>
  );
}

/** Symbols are uppercase alphanumerics; anything else came from a mangled link. */
const SYMBOL_RE = /^[A-Z0-9]{4,20}$/;

function Terminal() {
  const {
    symbol,
    timeframe,
    overlays,
    pulseWindowMinutes,
    setSymbol,
    setTimeframe,
    inspectorPos,
    setInspectorPos,
    inspectorMinimized,
    toggleInspectorMinimized,
  } = useMarketStore();
  const searchParams = useSearchParams();

  /**
   * Adopt `?symbol=` / `?timeframe=` from the URL.
   *
   * This is what makes a terminal link work at all — from a scanner opening a
   * new tab, from a Telegram alert, or from a bookmark. Keyed on the query
   * string alone, so switching coin inside the app is never reverted by a
   * stale param.
   */
  useEffect(() => {
    const wanted = searchParams.get("symbol")?.toUpperCase();
    if (wanted && SYMBOL_RE.test(wanted)) setSymbol(wanted);
    const tf = searchParams.get("timeframe");
    if (tf && isValidTimeframe(tf)) setTimeframe(tf);
  }, [searchParams, setSymbol, setTimeframe]);
  const { precisionFor } = useSymbols();
  const pricePrecision = precisionFor(symbol);
  const { analysis } = useAnalysis(symbol, timeframe, 8000, pulseWindowMinutes);
  const { kline, price, liquidations, connected } = useLiveMarket(symbol, timeframe);
  /* Open interest is now polled unconditionally rather than only while its
     overlay is on. It stopped being an overlay input the moment the
     positioning panel started reading it: that box is always on screen, and
     the same reasoning applies as for funding below — there is nothing to gate
     it on. One request a minute per symbol, served from the same cache the
     overlay uses. The overlay itself is unchanged and still opt-in. */
  const { openInterest } = useOpenInterest(symbol, timeframe, true);
  // Same gating: the footprint costs a full engine pass and three Binance
  // calls, so it runs only while the overlay that draws it is switched on.
  const { setup: institutional, loading: institutionalLoading } = useInstitutional(
    symbol,
    timeframe,
    overlays.buyingChecklist
  );
  // Not gated — the rates box is always on screen, so there is nothing to
  // gate it on.
  const { report: funding } = useFunding(symbol);
  // Fetched once per symbol, never polled: a year-long profile cannot move
  // between page views.
  const {
    report: seasonality,
    loading: seasonalityLoading,
    error: seasonalityError,
  } = useSeasonality(symbol);
  const { walls, error: wallError } = useOrderWalls(
    symbol,
    overlays.buyWalls || overlays.sellWalls
  );
  const [candles, setCandles] = useState<Candle[]>([]);
  const { formatted } = useCandleCountdown(timeframe, candles[candles.length - 1]?.time);
  /** Where chart candles came from — surfaced so a degraded feed is visible. */
  const [dataSource, setDataSource] = useState<"server" | "browser" | "failed" | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);

  // Historical candles for the chart (analysis polls separately server-side).
  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/market/klines?symbol=${symbol}&timeframe=${timeframe}&limit=400`, { cache: "no-store" });
        const data = await res.json();
        if (!res.ok || !data.candles?.length) throw new Error(data.error ?? `HTTP ${res.status}`);
        if (!stop) {
          setCandles(data.candles);
          setDataSource("server");
        }
      } catch (serverErr) {
        // The server may be geo-blocked by Binance (US regions get HTTP
        // 451) even though the visitor's own connection is fine — fall
        // back to fetching directly from the browser.
        try {
          const direct = await fetchKlinesDirect(symbol, timeframe, 400);
          if (!stop && direct.length > 0) {
            setCandles(direct);
            setDataSource("browser");
          }
        } catch (directErr) {
          if (!stop) {
            setDataSource("failed");
            setFeedError(
              `Market data unavailable. Server said: ${String(serverErr)}. Direct browser fetch said: ${String(directErr)}.`
            );
          }
        }
      }
    };
    setCandles([]);
    setFeedError(null);
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
      {/*
        `minmax(0,1fr)` rather than `1fr`, and `min-w-0` on the cells.

        A grid item defaults to `min-width: auto`, which resolves to its
        content's min-content width — so a bare `1fr` track cannot shrink below
        whatever its widest child wants. The event tape, the timeframe row and
        the wall strip are all long horizontal rows; any one of them pushed the
        chart column past the viewport and shoved the 360px AI rail off the
        right edge. Their own `overflow-x-auto` does not help, because the
        blow-out happens on the track, not inside them.
      */}
      {/* The state card leads the page. It is the only box that answers the
          question the rest of them are evidence for — which state this is,
          both ways out, and the price that would make the read wrong. Above
          the chart because a read formed after scrolling past seventeen panels
          is a read assembled from whichever ones were remembered. */}
      <div className="p-3 pb-0">
        <Foldable id="state" label="Market state" height={420}>
          <StateCard
            analysis={analysis}
            candles={candles}
            openInterest={openInterest}
            funding={funding}
            pricePrecision={pricePrecision}
          />
        </Foldable>
      </div>

      <div className="grid grid-cols-1 gap-3 p-3 xl:grid-cols-[minmax(0,1fr)_360px]">
        {/* Chart cell */}
        <div className="glass flex h-[620px] min-w-0 flex-col p-3 xl:h-auto">
          {/* Above the coin name: what the tape has done recently, with times. */}
          <EventTape analysis={analysis} />
          <MarketSelector connected={connected} price={price} countdown={formatted} />
          {dataSource === "browser" && (
            <div className="mb-2 rounded-lg border border-neon-amber/30 bg-neon-amber/5 px-3 py-1.5 text-[10px] leading-relaxed text-neon-amber">
              Server could not reach Binance (it is likely deployed in a geo-blocked region) — chart data is being
              fetched directly from your browser instead. Server-side analysis panels will stay empty until the
              deployment region is changed.
            </div>
          )}
          {dataSource === "failed" && feedError && (
            <div className="mb-2 rounded-lg border border-bear/30 bg-bear/5 px-3 py-1.5 text-[10px] leading-relaxed text-bear">
              {feedError}
            </div>
          )}
          <OrderWallStrip
            walls={walls}
            showBids={overlays.buyWalls}
            showAsks={overlays.sellWalls}
            precision={pricePrecision}
            error={wallError}
          />
          <div className="min-h-0 flex-1">
            <TradingChart
              candles={candles}
              liveKline={kline}
              analysis={analysis}
              overlays={overlays}
              pricePrecision={pricePrecision}
              datasetKey={`${symbol}:${timeframe}`}
              countdown={formatted}
              livePrice={price}
              walls={walls}
              inspectorPos={inspectorPos}
              onInspectorMove={setInspectorPos}
              inspectorMinimized={inspectorMinimized}
              onInspectorMinimizeToggle={toggleInspectorMinimized}
              openInterest={openInterest}
              institutional={institutional}
              institutionalLoading={institutionalLoading}
            />
          </div>
        </div>

        {/* Right rail: the analyst feed alone.
            The rail sets the row height on desktop and the chart cell
            stretches to match — which is why that cell drops its fixed height
            at xl, and why anything stacked here makes the chart taller. The
            funding box used to sit beneath the feed and was pushing the chart
            to nearly a thousand pixels; it now leads the conclusion row
            instead, where it reads as context for the pulse rather than as
            extra rail. */}
        <div className="flex min-w-0 flex-col gap-3">
          <div className="h-[620px]">
            <AIInsightPanel analysis={analysis} />
          </div>
        </div>

        <div className="h-[620px] xl:hidden">
          <PressureMapPanel analysis={analysis} pricePrecision={pricePrecision} />
        </div>
      </div>

      {/* Conclusion row: recent-window pulse + the cost of carry beside it.
          The pulse window itself is user-selectable (1h by default) — see
          MarketPulse. Funding sits here because it prices the conclusion: the
          same pulse means something different when the crowd is paying to hold
          the side it favours. Fixed heights keep every panel's own body
          scrollable rather than letting content overflow and get clipped. */}
      <div className="grid grid-cols-1 gap-3 p-3 pt-0 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Foldable id="signal" label="Pulse & Setup" height={640}>
          <SignalPanel analysis={analysis} pricePrecision={pricePrecision} />
        </Foldable>
        <Foldable id="rates" label="Interest & Funding" height={640}>
          <RatesPanel report={funding} symbol={symbol} />
        </Foldable>
      </div>

      {/* Positioning and conflicts, beneath the conclusion they qualify.
          Funding says what the crowded side is paying; positioning says
          whether the last few bars were that crowd arriving or leaving; and
          conflicts says which parts of all of it disagree — the part the
          composite score averages away. */}
      <div className="grid grid-cols-1 gap-3 p-3 pt-0 [&>*]:min-w-0 xl:grid-cols-2">
        <Foldable id="positioning" label="Positioning" height={560}>
          <PositioningPanel candles={candles} openInterest={openInterest} timeframe={timeframe} />
        </Foldable>
        <Foldable id="conflicts" label="Conflicts" height={560}>
          <ConflictPanel
            analysis={analysis}
            candles={candles}
            openInterest={openInterest}
            funding={funding}
          />
        </Foldable>
      </div>

      {/* Evidence for the pulse above it: the ladder, and the read taken off
          the ladder. One instance at every breakpoint now — this row is full
          width, so the old arrangement of a mobile copy under the AI feed plus
          a desktop copy down in the deep-dive row has nothing left to solve. */}
      <div className="grid grid-cols-1 gap-3 p-3 pt-0 [&>*]:min-w-0 xl:grid-cols-2">
        <Foldable id="footprint" label="Footprint" height={560}>
          <FootprintPanel analysis={analysis} />
        </Foldable>
        <Foldable id="orderflow" label="Order Flow" height={560}>
          <OrderFlowPanel analysis={analysis} />
        </Foldable>
      </div>

      {/* The multi-window read, below the single-window one it generalises. */}
      <div className="p-3 pt-0">
        <Foldable id="multiwindow" label="Multi-Window Read" height={640}>
          <MultiWindowPanel analysis={analysis} pricePrecision={pricePrecision} />
        </Foldable>
      </div>

      {/* Independent analysts. These three read the chart on their own terms
          and never feed the composite signal above — they are deliberately a
          separate opinion, not another input to it. */}
      <div className="grid grid-cols-1 gap-3 p-3 pt-0 [&>*]:min-w-0 md:grid-cols-2 2xl:grid-cols-3">
        <Foldable id="chartanalyst" label="Chart Analyst" height={600}>
          <ChartAnalystPanel analysis={analysis} pricePrecision={pricePrecision} /></Foldable>
        <Foldable id="candleclose" label="Candle Close Expansion" height={600}>
          <CandleCloseExpansionPanel analysis={analysis} pricePrecision={pricePrecision} /></Foldable>
        <Foldable id="range" label="Range Trading" height={600}>
          <RangeTradingPanel analysis={analysis} pricePrecision={pricePrecision} /></Foldable>
      </div>

      {/* Core intelligence row. Order flow used to lead here; it now follows
          the footprint below, since the footprint is the evidence and the
          order-flow read is the conclusion drawn from it — reading them in
          that order costs nothing and saves scrolling back up. */}
      <div className="grid grid-cols-1 gap-3 p-3 pt-0 [&>*]:min-w-0 md:grid-cols-2 2xl:grid-cols-3">
        <Foldable id="liquidation" label="Liquidation Engine" height={560}>
          <LiquidationPanel analysis={analysis} liveLiquidations={liquidations} /></Foldable>
        <Foldable id="structure" label="Market Structure" height={560}>
          <StructurePanel analysis={analysis} /></Foldable>
        <Foldable id="whales" label="Whale Orders" height={560}>
          <WhaleOrdersPanel analysis={analysis} pricePrecision={pricePrecision} /></Foldable>
      </div>

      {/* Order-flow deep dive: volume profile and absorption/exhaustion. The
          footprint and the order-flow read moved up under the pulse, so what
          is left here is the pair that stands on its own. */}
      <div className="grid grid-cols-1 gap-3 p-3 pt-0 [&>*]:min-w-0 lg:grid-cols-2">
        <Foldable id="volprofile" label="Volume Profile" height={600}>
          <VolumeProfilePanel analysis={analysis} /></Foldable>
        <Foldable id="flowevents" label="Absorption & Traps" height={600}>
          <OrderFlowEventsPanel analysis={analysis} /></Foldable>
      </div>

      {/* Forced-flow map. */}
      <div className="hidden p-3 pt-0 xl:block">
        <Foldable id="pressuremap" label="Squeeze & Liquidation Map" height={620}>
          <PressureMapPanel analysis={analysis} pricePrecision={pricePrecision} />
        </Foldable>
      </div>

      {/* Levels & patterns */}
      <div className="p-3 pt-0">
        <Foldable id="levels" label="Key Levels" height={460}>
          <LevelsPanel analysis={analysis} />
        </Foldable>
      </div>

      {/* The clock. Last on the page because it is the slowest-moving thing
          here — a year-long profile does not change between visits — and
          because it is context for everything above rather than a live read. */}
      <div className="p-3 pt-0">
        <Foldable id="seasonality" label="Time & Seasonality" height={680}>
          <SeasonalityPanel
            report={seasonality}
            loading={seasonalityLoading}
            error={seasonalityError}
            symbol={symbol}
          />
        </Foldable>
      </div>
    </AppShell>
  );
}
