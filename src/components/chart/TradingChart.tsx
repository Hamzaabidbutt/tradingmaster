"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickData,
  ColorType,
  CrosshairMode,
  HistogramData,
  IChartApi,
  IPriceLine,
  ISeriesApi,
  LineStyle,
  SeriesMarker,
  Time,
  UTCTimestamp,
  createChart,
} from "lightweight-charts";
import { Candle, FullAnalysis, OrderWallResult } from "@/engines/types";
import { OverlayToggles } from "@/stores/marketStore";
import { LiveKline } from "@/hooks/useLiveMarket";
import { canApplyLiveFrame, selectBarsToAppend } from "./feed";
import { candleAtTime, computeCandleStats, CandleStats } from "@/engines/candleStats";
import CandleInspector from "./CandleInspector";

interface Props {
  candles: Candle[];
  liveKline: LiveKline | null;
  analysis: FullAnalysis | null;
  overlays: OverlayToggles;
  pricePrecision: number;
  /** identity of the current dataset — changing it re-anchors the view */
  datasetKey: string;
  /** live countdown until the in-progress candle closes */
  countdown?: string;
  livePrice?: number | null;
  /** resting order-book walls; null when both wall overlays are off */
  walls?: OrderWallResult | null;
}

const BULL = "#00e5a0";
const BEAR = "#ff4d6d";

/** Height (px) of each numeric data row rendered under the price panel. */
const ROW_H = 22;

/**
 * TradingView-style chart with a custom overlay canvas.
 *
 * The lightweight-charts instance renders candles, volume, moving averages
 * and VWAP as real series; everything positional (SMC zones, volume
 * profile, Fibonacci, equal-level lines, footprint numbers) is drawn on a
 * canvas layered above it, re-projected through the chart's own
 * time/price coordinate functions so drawings stay glued to the data
 * through pan and zoom.
 */
export default function TradingChart({
  candles,
  liveKline,
  analysis,
  overlays,
  pricePrecision,
  datasetKey,
  countdown,
  livePrice,
  walls,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const maSeriesRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const vwapSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const cvdSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const liqCumSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  /**
   * Wall lines are held apart from `priceLinesRef` because they refresh on a
   * different clock: the analysis effect reruns every 8 s, the book every 6 s,
   * and sharing one array means whichever fires second wipes the other's lines.
   */
  const wallLinesRef = useRef<IPriceLine[]>([]);
  const [ready, setReady] = useState(false);

  /** Dataset currently loaded into the series — guards incremental updates. */
  const loadedKeyRef = useRef<string | null>(null);
  /**
   * Newest bar time actually pushed into the series.
   *
   * lightweight-charts refuses `update()` with a time older than the series
   * head ("Cannot update oldest data"), and the websocket routinely opens a
   * new bar before a REST poll returns — so a poll's tail can legitimately
   * be older than what the chart already holds. This value must therefore
   * only ever move forward; it is never derived from the incoming array.
   */
  const seriesHeadRef = useRef<number>(0);
  /** Set before chart.remove() so late async callbacks bail out. */
  const disposedRef = useRef(false);
  /** True while the user is parked at the right edge (auto-follow allowed). */
  const followRef = useRef(true);
  /** Latest overlay draw function, invoked on live ticks. */
  const drawRef = useRef<(() => void) | null>(null);
  const rafRef = useRef<number | null>(null);
  /** Y position (px) of the live price, for the countdown badge. */
  const [badgeY, setBadgeY] = useState<number | null>(null);
  /** Timestamp of the candle under the cursor, if any. */
  const [hoveredTime, setHoveredTime] = useState<number | null>(null);
  /** Mirrors hoveredTime without re-rendering, so the crosshair handler can
   *  compare cheaply and only call setState when the bar actually changes. */
  const hoveredTimeRef = useRef<number | null>(null);

  /** How many numeric rows are switched on (reserves space at the bottom). */
  const numericRows =
    (overlays.volumeNumbers ? 1 : 0) +
    (overlays.deltaNumbers ? 1 : 0) +
    (overlays.liquidationDelta ? 1 : 0) +
    (overlays.pressure ? 1 : 0);

  // --- Chart lifecycle ---
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#8b93a7",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.04)" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "rgba(34,211,238,0.4)", labelBackgroundColor: "#1a2138" },
        horzLine: { color: "rgba(34,211,238,0.4)", labelBackgroundColor: "#1a2138" },
      },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
      timeScale: {
        borderColor: "rgba(255,255,255,0.08)",
        timeVisible: true,
        secondsVisible: false,
      },
      // Sizing is driven manually below. The library's built-in autoSize
      // observer can fire after remove() and throw "Object is disposed".
      width: el.clientWidth,
      height: el.clientHeight,
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: BULL,
      downColor: BEAR,
      wickUpColor: BULL,
      wickDownColor: BEAR,
      borderVisible: false,
      priceFormat: { type: "price", precision: pricePrecision, minMove: 1 / 10 ** pricePrecision },
    });
    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    disposedRef.current = false;
    // A fresh chart holds no bars — force the next feed to do a full load.
    loadedKeyRef.current = null;
    seriesHeadRef.current = 0;
    setReady(true);

    // Own the resize loop so it can be stopped before disposal.
    const resize = new ResizeObserver(() => {
      if (disposedRef.current) return;
      try {
        chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
      } catch {
        /* chart disposed between the check and the call */
      }
    });
    resize.observe(el);

    return () => {
      // Order matters: stop every callback source before disposing, so no
      // late observer/rAF frame can touch a destroyed chart.
      disposedRef.current = true;
      resize.disconnect();
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      drawRef.current = null;
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      maSeriesRef.current.clear();
      vwapSeriesRef.current = null;
      cvdSeriesRef.current = null;
      liqCumSeriesRef.current = null;
      priceLinesRef.current = [];
      loadedKeyRef.current = null;
      seriesHeadRef.current = 0;
      setReady(false);
      chart.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pricePrecision]);

  // Reserve bottom space for the numeric rows so they never cover candles.
  useEffect(() => {
    if (!ready || disposedRef.current || !candleSeriesRef.current) return;
    const el = containerRef.current;
    const h = el?.clientHeight ?? 500;
    const reserved = Math.min(0.4, (numericRows * ROW_H + 8) / Math.max(h, 1));
    try {
      candleSeriesRef.current.priceScale().applyOptions({
        scaleMargins: { top: 0.06, bottom: Math.max(0.12, reserved + 0.1) },
      });
    } catch {
      /* disposed */
    }
  }, [ready, numericRows]);

  // --- Track whether the user is following the right edge ---
  useEffect(() => {
    const chart = chartRef.current;
    if (!ready || !chart) return;
    const ts = chart.timeScale();
    const onRangeChange = () => {
      const range = ts.getVisibleLogicalRange();
      if (!range) return;
      // Within ~2 bars of the newest bar counts as "following".
      followRef.current = range.to >= candles.length - 2;
    };
    ts.subscribeVisibleLogicalRangeChange(onRangeChange);
    return () => {
      if (disposedRef.current) return;
      try { ts.unsubscribeVisibleLogicalRangeChange(onRangeChange); } catch { /* disposed */ }
    };
  }, [ready, candles.length]);

  // --- Hover to inspect a candle ---
  //
  // Crosshair events fire on every mouse move, so the handler compares
  // against a ref and only touches React state when the hovered BAR changes.
  // Without that guard a slow drag across one candle would re-render the
  // whole chart tree dozens of times per second.
  useEffect(() => {
    const chart = chartRef.current;
    if (!ready || !chart) return;
    const onMove = (param: { time?: unknown }) => {
      const next = param.time == null ? null : Number(param.time);
      if (next === hoveredTimeRef.current) return;
      hoveredTimeRef.current = next;
      setHoveredTime(next);
    };
    chart.subscribeCrosshairMove(onMove);
    return () => {
      if (disposedRef.current) return;
      try { chart.unsubscribeCrosshairMove(onMove); } catch { /* disposed */ }
    };
  }, [ready]);

  // Switching symbol/timeframe invalidates whatever was hovered.
  useEffect(() => {
    hoveredTimeRef.current = null;
    setHoveredTime(null);
  }, [datasetKey]);

  const inspectorStats: CandleStats | null = useMemo(() => {
    if (candles.length === 0) return null;
    // With the cursor off the chart, show the newest bar — the same thing
    // Binance does, so the panel is never blank while the market moves.
    const candle =
      hoveredTime == null ? candles[candles.length - 1] : candleAtTime(candles, hoveredTime);
    if (!candle) return null;
    return computeCandleStats(candle, candles, analysis);
  }, [hoveredTime, candles, analysis]);

  // --- Data feed (incremental: a refetch must never reset the view) ---
  useEffect(() => {
    if (!ready || !candleSeriesRef.current || candles.length === 0) return;
    const isNewDataset = loadedKeyRef.current !== datasetKey;

    const toBar = (c: Candle): CandlestickData => ({
      time: c.time as UTCTimestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    });
    const toVol = (c: Candle): HistogramData => {
      const buy = c.takerBuyVolume ?? c.volume / 2;
      return {
        time: c.time as UTCTimestamp,
        value: c.volume,
        color: buy >= c.volume - buy ? "rgba(0,229,160,0.35)" : "rgba(255,77,109,0.35)",
      };
    };

    try {
      if (isNewDataset) {
        // Switching symbol/timeframe: full load, then anchor to the right edge.
        candleSeriesRef.current.setData(candles.map(toBar));
        volumeSeriesRef.current?.setData(overlays.volume ? candles.map(toVol) : []);
        loadedKeyRef.current = datasetKey;
        followRef.current = true;
        seriesHeadRef.current = candles[candles.length - 1].time;
        chartRef.current?.timeScale().scrollToRealTime();
      } else {
        // Same dataset refreshed. Only push bars at or after the series head:
        // a REST response can legitimately be older than the live bar the
        // websocket already opened, and update() cannot rewrite history.
        const { bars, nextHead } = selectBarsToAppend(candles, seriesHeadRef.current);
        for (const c of bars) {
          candleSeriesRef.current.update(toBar(c));
          if (overlays.volume) volumeSeriesRef.current?.update(toVol(c));
        }
        // Monotonic by construction — never regresses on a stale poll.
        seriesHeadRef.current = nextHead;
      }
    } catch (err) {
      // A rejected update means our head tracking drifted from the series
      // (e.g. a dataset swap raced a poll). Rebuild rather than stay broken.
      if (process.env.NODE_ENV !== "production") console.warn("chart feed resync", err);
      try {
        candleSeriesRef.current.setData(candles.map(toBar));
        volumeSeriesRef.current?.setData(overlays.volume ? candles.map(toVol) : []);
        seriesHeadRef.current = candles[candles.length - 1].time;
      } catch {
        /* chart disposed mid-update */
      }
    }
  }, [ready, candles, overlays.volume, datasetKey]);

  // Volume histogram must be rebuilt when it is toggled back on.
  useEffect(() => {
    if (!ready || disposedRef.current || !volumeSeriesRef.current) return;
    if (!overlays.volume) {
      try { volumeSeriesRef.current.setData([]); } catch { /* disposed */ }
      return;
    }
    try {
    volumeSeriesRef.current.setData(
      candles.map((c) => {
        const buy = c.takerBuyVolume ?? c.volume / 2;
        return {
          time: c.time as UTCTimestamp,
          value: c.volume,
          color: buy >= c.volume - buy ? "rgba(0,229,160,0.35)" : "rgba(255,77,109,0.35)",
        };
      }) as HistogramData[]
    );
    } catch { /* disposed */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, overlays.volume]);

  // --- Live tick: the in-progress candle updates on every websocket frame ---
  useEffect(() => {
    if (!ready || !liveKline || disposedRef.current || !candleSeriesRef.current) return;
    // Rejects stale frames and refuses to update an empty series.
    if (!canApplyLiveFrame(liveKline.time, seriesHeadRef.current)) return;

    const openedNewBar = liveKline.time > seriesHeadRef.current;
    try {
      candleSeriesRef.current.update({
        time: liveKline.time as UTCTimestamp,
        open: liveKline.open,
        high: liveKline.high,
        low: liveKline.low,
        close: liveKline.close,
      });
      if (overlays.volume) {
        const buy = liveKline.takerBuyVolume ?? liveKline.volume / 2;
        volumeSeriesRef.current?.update({
          time: liveKline.time as UTCTimestamp,
          value: liveKline.volume,
          color: buy >= liveKline.volume - buy ? "rgba(0,229,160,0.35)" : "rgba(255,77,109,0.35)",
        });
      }
      seriesHeadRef.current = liveKline.time;
    } catch {
      // Disposed or out-of-order; the next poll rebuilds the series.
      return;
    }

    // A brand-new bar opened — extend the view only if the user is following.
    if (openedNewBar && followRef.current) {
      try { chartRef.current?.timeScale().scrollToRealTime(); } catch { /* disposed */ }
    }

    // Keep overlays and the countdown badge glued to the live price.
    if (rafRef.current == null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        if (disposedRef.current) return;
        drawRef.current?.();
        try {
          setBadgeY(candleSeriesRef.current?.priceToCoordinate(liveKline.close) ?? null);
        } catch {
          /* disposed between frames */
        }
      });
    }
  }, [ready, liveKline, overlays.volume]);

  // --- Moving averages (real line series) ---
  useEffect(() => {
    const chart = chartRef.current;
    if (!ready || !chart || disposedRef.current) return;
    const seriesMap = maSeriesRef.current;

    if (!overlays.movingAverages || !analysis) {
      for (const s of seriesMap.values()) {
        try { chart.removeSeries(s); } catch { /* already disposed */ }
      }
      seriesMap.clear();
      return;
    }

    const wanted = new Set(analysis.movingAverages.averages.map((m) => m.key));
    for (const [key, s] of seriesMap) {
      if (!wanted.has(key)) {
        try { chart.removeSeries(s); } catch { /* already disposed */ }
        seriesMap.delete(key);
      }
    }
    for (const ma of analysis.movingAverages.averages) {
      let s = seriesMap.get(ma.key);
      if (!s) {
        s = chart.addLineSeries({
          color: ma.color,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        seriesMap.set(ma.key, s);
      }
      s.setData(ma.values.map((v) => ({ time: v.time as UTCTimestamp, value: v.value })));
    }
  }, [ready, analysis, overlays.movingAverages]);

  // --- VWAP ---
  useEffect(() => {
    const chart = chartRef.current;
    if (!ready || !chart || disposedRef.current) return;
    if (!overlays.vwap || !analysis) {
      if (vwapSeriesRef.current) {
        try { chart.removeSeries(vwapSeriesRef.current); } catch { /* disposed */ }
        vwapSeriesRef.current = null;
      }
      return;
    }
    if (!vwapSeriesRef.current) {
      vwapSeriesRef.current = chart.addLineSeries({
        color: "#facc15",
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: true,
        crosshairMarkerVisible: false,
        title: "VWAP",
      });
    }
    vwapSeriesRef.current.setData(
      analysis.vwap.values.map((v) => ({ time: v.time as UTCTimestamp, value: v.value }))
    );
  }, [ready, analysis, overlays.vwap]);

  // --- CVD (own scale, drawn as an overlay line) ---
  useEffect(() => {
    const chart = chartRef.current;
    if (!ready || !chart || disposedRef.current) return;
    if (!overlays.cvd || !analysis) {
      if (cvdSeriesRef.current) {
        try { chart.removeSeries(cvdSeriesRef.current); } catch { /* disposed */ }
        cvdSeriesRef.current = null;
      }
      return;
    }
    if (!cvdSeriesRef.current) {
      cvdSeriesRef.current = chart.addLineSeries({
        color: "#38bdf8",
        lineWidth: 2,
        priceScaleId: "cvd",
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      chart.priceScale("cvd").applyOptions({ scaleMargins: { top: 0.05, bottom: 0.75 } });
    }
    cvdSeriesRef.current.setData(
      analysis.delta.series.map((d) => ({ time: d.time as UTCTimestamp, value: d.cvd }))
    );
  }, [ready, analysis, overlays.cvd]);

  // --- Aggregate liquidation delta, cumulative (forced-flow balance) ---
  useEffect(() => {
    const chart = chartRef.current;
    if (!ready || !chart || disposedRef.current) return;
    if (!overlays.liquidationCumulative || !analysis) {
      if (liqCumSeriesRef.current) {
        try { chart.removeSeries(liqCumSeriesRef.current); } catch { /* disposed */ }
        liqCumSeriesRef.current = null;
      }
      return;
    }
    if (!liqCumSeriesRef.current) {
      liqCumSeriesRef.current = chart.addLineSeries({
        color: "#f472b6",
        lineWidth: 2,
        priceScaleId: "liqcum",
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        title: "Cumulative liq Δ",
      });
      chart.priceScale("liqcum").applyOptions({ scaleMargins: { top: 0.08, bottom: 0.72 } });
    }
    try {
      liqCumSeriesRef.current.setData(
        analysis.liquidationDelta.series.map((d) => ({
          time: d.time as UTCTimestamp,
          value: d.cumulative,
        }))
      );
    } catch {
      /* disposed */
    }
  }, [ready, analysis, overlays.liquidationCumulative]);

  // --- Markers: structure, sweeps, patterns, order-flow events ---
  const markers = useMemo<SeriesMarker<Time>[]>(() => {
    if (!analysis) return [];
    const out: SeriesMarker<Time>[] = [];
    if (overlays.structure) {
      for (const ev of analysis.structure.events.slice(-14)) {
        out.push({
          time: ev.time as UTCTimestamp,
          position: ev.direction === "bullish" ? "belowBar" : "aboveBar",
          color: ev.type === "CHOCH" ? "#a78bfa" : ev.direction === "bullish" ? BULL : BEAR,
          shape: ev.direction === "bullish" ? "arrowUp" : "arrowDown",
          text: `${ev.scope === "internal" ? "i" : ""}${ev.type}`,
          size: ev.type === "CHOCH" ? 2 : 1,
        });
      }
    }
    if (overlays.liquidity) {
      for (const sw of analysis.liquidity.sweeps.slice(-6)) {
        out.push({
          time: sw.time as UTCTimestamp,
          position: sw.direction === "above" ? "aboveBar" : "belowBar",
          color: "#fbbf24",
          shape: "circle",
          text: "SWEEP",
          size: 1,
        });
      }
    }
    if (overlays.patterns) {
      for (const p of analysis.patterns.filter((x) => x.strength >= 60).slice(-8)) {
        out.push({
          time: p.time as UTCTimestamp,
          position: p.direction === "bullish" ? "belowBar" : "aboveBar",
          color: p.direction === "bullish" ? "rgba(0,229,160,0.8)" : p.direction === "bearish" ? "rgba(255,77,109,0.8)" : "#8b93a7",
          shape: "square",
          text: p.name.split(" ").map((w) => w[0]).join(""),
          size: 0,
        });
      }
    }
    if (overlays.orderFlowEvents) {
      for (const a of analysis.orderFlowEvents.absorptions.slice(-4)) {
        out.push({
          time: a.time as UTCTimestamp,
          position: a.side === "buy" ? "belowBar" : "aboveBar",
          color: "#22d3ee",
          shape: "circle",
          text: `ABS${a.atKeyLevel ? "★" : ""}`,
          size: a.atKeyLevel ? 2 : 1,
        });
      }
      for (const e of analysis.orderFlowEvents.exhaustions.slice(-2)) {
        out.push({
          time: e.time as UTCTimestamp,
          position: e.side === "buy" ? "aboveBar" : "belowBar",
          color: "#fb923c",
          shape: "square",
          text: "EXH",
          size: 1,
        });
      }
      for (const t of analysis.orderFlowEvents.trapped.slice(-4)) {
        out.push({
          time: t.time as UTCTimestamp,
          position: t.side === "buyers" ? "aboveBar" : "belowBar",
          color: "#f472b6",
          shape: t.side === "buyers" ? "arrowDown" : "arrowUp",
          text: "TRAP",
          size: 2,
        });
      }
    }
    return out.sort((a, b) => Number(a.time) - Number(b.time));
  }, [analysis, overlays]);

  useEffect(() => {
    if (!ready || disposedRef.current || !candleSeriesRef.current) return;
    try { candleSeriesRef.current.setMarkers(markers); } catch { /* disposed */ }
  }, [ready, markers]);

  // --- Price lines: S/R, liquidity, trade levels, POC/VA, delta spikes ---
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!ready || !series || !analysis || disposedRef.current) return;
    for (const pl of priceLinesRef.current) {
      try { series.removePriceLine(pl); } catch { /* disposed */ }
    }
    priceLinesRef.current = [];

    const add = (price: number, color: string, title: string, style = LineStyle.Dashed, width: 1 | 2 = 1) => {
      if (!Number.isFinite(price)) return;
      try {
        priceLinesRef.current.push(
          series.createPriceLine({ price, color, title, lineStyle: style, lineWidth: width, axisLabelVisible: true })
        );
      } catch {
        /* disposed */
      }
    };

    if (overlays.supportResistance) {
      for (const l of analysis.srLevels.slice(0, 6)) {
        add(
          l.price,
          l.kind === "support" ? "rgba(0,229,160,0.5)" : "rgba(255,77,109,0.5)",
          `${l.kind === "support" ? "S" : "R"} ${l.strength}`,
          LineStyle.Dashed
        );
      }
    }
    if (overlays.liquidity) {
      const unswept = analysis.liquidity.levels.filter((l) => !l.swept);
      for (const l of unswept.slice(0, 6)) {
        const isBuySide = l.kind === "buy_side" || l.kind === "equal_highs" || l.kind === "swing_high";
        add(l.price, "rgba(251,191,36,0.55)", isBuySide ? "BSL" : "SSL", LineStyle.Dotted);
      }
    }
    if (overlays.volumeProfile) {
      add(analysis.volumeProfile.poc, "#facc15", "POC", LineStyle.Solid, 2);
      add(analysis.volumeProfile.vah, "rgba(250,204,21,0.45)", "VAH", LineStyle.Dashed);
      add(analysis.volumeProfile.val, "rgba(250,204,21,0.45)", "VAL", LineStyle.Dashed);
      for (const lvn of analysis.volumeProfile.lvns.slice(0, 3)) {
        add(lvn.price, "rgba(167,139,250,0.5)", "LVN", LineStyle.Dotted);
      }
    }
    if (overlays.orderFlowEvents) {
      for (const d of analysis.orderFlowEvents.deltaSpikeLevels.slice(-4)) {
        add(
          d.price,
          d.side === "buy" ? "rgba(0,229,160,0.35)" : "rgba(255,77,109,0.35)",
          `Δ spike`,
          LineStyle.Dotted
        );
      }
    }
    if (overlays.tradeLevels && analysis.setup) {
      const s = analysis.setup;
      add(s.entry, "#22d3ee", `ENTRY ${s.side}`, LineStyle.Solid, 2);
      add(s.stopLoss, BEAR, "SL", LineStyle.Solid, 2);
      add(s.tp1, BULL, "TP1", LineStyle.LargeDashed);
      add(s.tp2, BULL, "TP2", LineStyle.LargeDashed);
      add(s.tp3, BULL, "TP3", LineStyle.LargeDashed);
    }

    return () => {
      if (!disposedRef.current) {
        for (const pl of priceLinesRef.current) {
          try { series.removePriceLine(pl); } catch { /* series disposed */ }
        }
      }
      priceLinesRef.current = [];
    };
  }, [ready, analysis, overlays]);

  // --- Price lines: resting order-book walls ---
  // Separate effect, separate line array: the book updates on its own poll and
  // must not be tied to the analysis refresh, or walls would sit stale for
  // seconds at a time while the depth behind them had already moved.
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!ready || !series || disposedRef.current) return;

    for (const pl of wallLinesRef.current) {
      try { series.removePriceLine(pl); } catch { /* disposed */ }
    }
    wallLinesRef.current = [];

    if (walls) {
      const add = (price: number, color: string, title: string) => {
        if (!Number.isFinite(price)) return;
        try {
          wallLinesRef.current.push(
            series.createPriceLine({
              price,
              color,
              title,
              lineStyle: LineStyle.Solid,
              lineWidth: 2,
              axisLabelVisible: true,
            })
          );
        } catch {
          /* disposed */
        }
      };
      // Line opacity tracks how far the cluster stands above the average level
      // size, so a 20× wall reads differently at a glance from a 4× one.
      const alpha = (multiple: number) => Math.min(0.9, 0.35 + multiple / 25);
      if (overlays.buyWalls) {
        for (const w of walls.bids) {
          add(w.price, `rgba(0,229,160,${alpha(w.multiple).toFixed(2)})`, `BID ${w.multiple.toFixed(1)}×`);
        }
      }
      if (overlays.sellWalls) {
        for (const w of walls.asks) {
          add(w.price, `rgba(255,77,109,${alpha(w.multiple).toFixed(2)})`, `ASK ${w.multiple.toFixed(1)}×`);
        }
      }
    }

    return () => {
      if (!disposedRef.current) {
        for (const pl of wallLinesRef.current) {
          try { series.removePriceLine(pl); } catch { /* series disposed */ }
        }
      }
      wallLinesRef.current = [];
    };
  }, [ready, walls, overlays.buyWalls, overlays.sellWalls]);

  // --- Overlay canvas: zones, profile, fib, equal levels, numeric rows ---
  useEffect(() => {
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    const canvas = overlayRef.current;
    const el = containerRef.current;
    if (!ready || !chart || !series || !canvas || !el || disposedRef.current) return;

    const draw = () => {
      // The chart can be torn down between a scheduled frame and its
      // execution; every coordinate call below would then throw.
      if (disposedRef.current || !chartRef.current || !candleSeriesRef.current) return;
      const dpr = window.devicePixelRatio || 1;
      const w = el.clientWidth;
      const h = el.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (!analysis) return;

      const ts = chart.timeScale();
      const xOf = (t: number) => ts.timeToCoordinate(t as UTCTimestamp);
      const yOf = (p: number) => series.priceToCoordinate(p);
      const rightEdge = w - 62; // keep the price axis clear
      const barWidth = estimateBarWidth(ts, candles);

      const drawZone = (
        top: number, bottom: number, startTime: number, endTime: number | undefined,
        fill: string, stroke: string, label: string
      ) => {
        const y1 = yOf(top);
        const y2 = yOf(bottom);
        if (y1 == null || y2 == null) return;
        const x1raw = xOf(startTime);
        const x1n = Math.max(0, Number(x1raw ?? 0));
        const x2 = endTime ? xOf(endTime) ?? rightEdge : rightEdge;
        const width = Math.max(0, Number(x2) - x1n);
        if (width <= 0 || y2 - y1 < 1) return;
        ctx.fillStyle = fill;
        ctx.fillRect(x1n, y1, width, y2 - y1);
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1;
        ctx.strokeRect(x1n, y1, width, y2 - y1);
        ctx.fillStyle = stroke;
        ctx.font = "9px ui-monospace, monospace";
        ctx.fillText(label, x1n + 4, Math.max(10, y1 + 10));
      };

      /* ---------------- SMC zones ---------------- */
      if (overlays.orderBlocks) {
        for (const ob of analysis.orderBlocks.filter((z) => z.status !== "mitigated").slice(-6)) {
          const bull = ob.direction === "bullish";
          drawZone(
            ob.top, ob.bottom, ob.startTime, ob.endTime,
            bull ? "rgba(0,229,160,0.08)" : "rgba(255,77,109,0.08)",
            bull ? "rgba(0,229,160,0.45)" : "rgba(255,77,109,0.45)",
            `OB ${ob.status === "respected" ? "✓" : ""}`
          );
        }
      }
      if (overlays.fvg) {
        for (const f of analysis.fvgs.filter((z) => z.status !== "filled").slice(-6)) {
          const bull = f.direction === "bullish";
          drawZone(
            f.top, f.bottom, f.startTime, f.endTime,
            bull ? "rgba(34,211,238,0.07)" : "rgba(167,139,250,0.07)",
            bull ? "rgba(34,211,238,0.4)" : "rgba(167,139,250,0.4)",
            `FVG${f.status === "partial" ? " ½" : ""}`
          );
        }
      }
      if (overlays.supplyDemand) {
        for (const z of analysis.supplyDemand.slice(-6)) {
          const bull = z.direction === "bullish";
          drawZone(
            z.top, z.bottom, z.startTime, z.endTime,
            bull ? "rgba(0,229,160,0.06)" : "rgba(255,77,109,0.06)",
            bull ? "rgba(0,229,160,0.3)" : "rgba(255,77,109,0.3)",
            z.type === "breaker_block" ? "BRK" : bull ? "DEM" : "SUP"
          );
        }
      }
      if (overlays.premiumDiscount) {
        const pd = analysis.premiumDiscount;
        const firstTime = candles[Math.max(0, candles.length - 120)]?.time;
        if (firstTime) {
          drawZone(pd.rangeHigh, pd.equilibrium, firstTime, undefined, "rgba(255,77,109,0.04)", "rgba(255,77,109,0.18)", "PREMIUM");
          drawZone(pd.equilibrium, pd.rangeLow, firstTime, undefined, "rgba(0,229,160,0.04)", "rgba(0,229,160,0.18)", "DISCOUNT");
          const eqY = yOf(pd.equilibrium);
          if (eqY != null) {
            ctx.strokeStyle = "rgba(139,147,167,0.5)";
            ctx.setLineDash([6, 4]);
            ctx.beginPath();
            ctx.moveTo(0, eqY);
            ctx.lineTo(rightEdge, eqY);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = "rgba(139,147,167,0.9)";
            ctx.fillText("EQ 50%", rightEdge - 46, eqY - 4);
          }
        }
      }

      /* ---------------- Volume profile (horizontal histogram) ---------------- */
      if (overlays.volumeProfile) {
        const vp = analysis.volumeProfile;
        const maxVol = Math.max(...vp.rows.map((r) => r.volume), 1e-9);
        const profileWidth = Math.min(150, w * 0.18);
        const originX = rightEdge;
        for (const row of vp.rows) {
          const y = yOf(row.price);
          if (y == null) continue;
          const barW = (row.volume / maxVol) * profileWidth;
          if (barW < 0.5) continue;
          const inValue = row.price >= vp.val && row.price <= vp.vah;
          // Split each row into its buy/sell components.
          const buyShare = row.volume > 0 ? row.buyVolume / row.volume : 0.5;
          const rowH = Math.max(1.5, Math.abs((yOf(vp.rows[1]?.price ?? row.price) ?? y) - (yOf(vp.rows[0]?.price ?? row.price) ?? y)) - 0.5);
          ctx.fillStyle = inValue ? "rgba(250,204,21,0.16)" : "rgba(139,147,167,0.12)";
          ctx.fillRect(originX - barW, y - rowH / 2, barW, rowH);
          ctx.fillStyle = inValue ? "rgba(0,229,160,0.22)" : "rgba(0,229,160,0.12)";
          ctx.fillRect(originX - barW, y - rowH / 2, barW * buyShare, rowH);
        }
        // POC row highlighted.
        const pocY = yOf(vp.poc);
        if (pocY != null) {
          ctx.fillStyle = "rgba(250,204,21,0.85)";
          ctx.fillRect(originX - profileWidth, pocY - 1, profileWidth, 2);
        }
      }

      /* ---------------- Fibonacci ---------------- */
      if (overlays.fibonacci) {
        const fib = analysis.fibonacci;
        const startX = Math.max(0, Number(xOf(Math.min(fib.swingHighTime, fib.swingLowTime)) ?? 0));
        for (const lvl of fib.levels) {
          const y = yOf(lvl.price);
          if (y == null) continue;
          const golden = lvl.isGoldenPocket;
          ctx.strokeStyle = golden
            ? "rgba(250,204,21,0.75)"
            : lvl.kind === "extension"
              ? "rgba(167,139,250,0.35)"
              : "rgba(139,147,167,0.35)";
          ctx.lineWidth = golden ? 1.5 : 1;
          ctx.setLineDash(golden ? [] : [4, 4]);
          ctx.beginPath();
          ctx.moveTo(startX, y);
          ctx.lineTo(rightEdge, y);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = golden ? "rgba(250,204,21,0.95)" : "rgba(139,147,167,0.8)";
          ctx.font = "9px ui-monospace, monospace";
          ctx.fillText(`${lvl.label} ${lvl.price.toFixed(pricePrecision)}`, rightEdge - 92, y - 3);
        }
      }

      /* ---------------- Equal highs / lows connecting lines ---------------- */
      if (overlays.equalLevels) {
        for (const lvl of analysis.equalLevels) {
          const y = yOf(lvl.price);
          if (y == null) continue;
          const x1 = Math.max(0, Number(xOf(lvl.startTime) ?? 0));
          const x2 = Number(xOf(lvl.endTime) ?? rightEdge);
          const color = lvl.swept
            ? "rgba(139,147,167,0.4)"
            : lvl.kind === "EQH"
              ? "rgba(255,77,109,0.85)"
              : "rgba(0,229,160,0.85)";
          ctx.strokeStyle = color;
          ctx.lineWidth = lvl.swept ? 1 : 1.8;
          ctx.setLineDash(lvl.swept ? [3, 3] : []);
          ctx.beginPath();
          ctx.moveTo(x1, y);
          ctx.lineTo(Math.max(x1 + 6, x2), y);
          ctx.stroke();
          ctx.setLineDash([]);
          // End caps mark the touches being connected.
          if (!lvl.swept) {
            ctx.fillStyle = color;
            ctx.fillRect(x1 - 1.5, y - 3, 3, 6);
            ctx.fillRect(Math.max(x1 + 6, x2) - 1.5, y - 3, 3, 6);
          }
          ctx.fillStyle = color;
          ctx.font = "9px ui-monospace, monospace";
          ctx.fillText(`${lvl.kind}${lvl.swept ? " swept" : ` ×${lvl.touches}`}`, x1 + 4, y - 4);
        }
      }

      /* ---------------- Big trade bubbles ---------------- */
      if (overlays.bigTrades) {
        for (const bt of analysis.orderFlowEvents.bigTrades.slice(-14)) {
          const x = xOf(bt.time);
          const y = yOf(bt.price);
          if (x == null || y == null) continue;
          const r = Math.min(11, 3 + bt.multiple * 1.4);
          ctx.beginPath();
          ctx.arc(Number(x), y, r, 0, Math.PI * 2);
          ctx.fillStyle = bt.side === "buy" ? "rgba(0,229,160,0.22)" : "rgba(255,77,109,0.22)";
          ctx.fill();
          ctx.strokeStyle = bt.side === "buy" ? "rgba(0,229,160,0.7)" : "rgba(255,77,109,0.7)";
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }

      /* ---------------- Numeric rows (volume / delta / liq delta) ---------------- */
      const rowsToDraw: {
        label: string;
        valueOf: (c: Candle, i: number) => number | null;
        colorOf: (v: number) => string;
        /** custom number formatting (defaults to compact notation) */
        format?: (v: number) => string;
        /** draw a background intensity band behind each value */
        ribbon?: boolean;
      }[] = [];

      if (overlays.volumeNumbers) {
        rowsToDraw.push({
          label: "VOL",
          valueOf: (c) => c.volume,
          colorOf: () => "rgba(203,213,225,0.9)",
        });
      }
      if (overlays.deltaNumbers) {
        const deltaByTime = new Map(analysis.delta.series.map((d) => [d.time, d.delta]));
        rowsToDraw.push({
          label: "Δ",
          valueOf: (c) => {
            const d = deltaByTime.get(c.time);
            if (d != null) return d;
            const buy = c.takerBuyVolume ?? c.volume / 2;
            return buy - (c.volume - buy);
          },
          colorOf: (v) => (v >= 0 ? "rgba(0,229,160,0.95)" : "rgba(255,77,109,0.95)"),
        });
      }
      if (overlays.liquidationDelta) {
        const liqByTime = new Map(analysis.liquidationDelta.series.map((d) => [d.time, d.delta]));
        rowsToDraw.push({
          label: "LIQΔ",
          valueOf: (c) => liqByTime.get(c.time) ?? 0,
          colorOf: (v) => (v > 0 ? "rgba(0,229,160,0.95)" : v < 0 ? "rgba(255,77,109,0.95)" : "rgba(100,116,139,0.7)"),
        });
      }
      if (overlays.pressure) {
        // Buy-side share of each bar's taker flow, printed as a percentage.
        rowsToDraw.push({
          label: "BUY%",
          valueOf: (c) => {
            const buy = c.takerBuyVolume ?? c.volume / 2;
            return c.volume > 0 ? (buy / c.volume) * 100 : 50;
          },
          colorOf: (v) => (v >= 55 ? "rgba(0,229,160,0.95)" : v <= 45 ? "rgba(255,77,109,0.95)" : "rgba(148,163,184,0.85)"),
          format: (v) => `${v.toFixed(0)}`,
          ribbon: true,
        });
      }

      if (rowsToDraw.length > 0) {
        const baseY = h - 26;
        ctx.font = "9px ui-monospace, monospace";
        ctx.textAlign = "center";

        rowsToDraw.forEach((row, rowIdx) => {
          const y = baseY - (rowsToDraw.length - 1 - rowIdx) * ROW_H;
          // Row background + label gutter.
          ctx.fillStyle = "rgba(9,12,21,0.72)";
          ctx.fillRect(0, y - ROW_H / 2, rightEdge, ROW_H);
          ctx.strokeStyle = "rgba(255,255,255,0.05)";
          ctx.beginPath();
          ctx.moveTo(0, y - ROW_H / 2);
          ctx.lineTo(rightEdge, y - ROW_H / 2);
          ctx.stroke();
          ctx.textAlign = "left";
          ctx.fillStyle = "rgba(139,147,167,0.9)";
          ctx.fillText(row.label, 4, y + 3);
          ctx.textAlign = "center";

          // Only print numbers when bars are wide enough to read them.
          const showEvery = barWidth >= 34 ? 1 : barWidth >= 18 ? 2 : barWidth >= 10 ? 4 : 0;
          if (showEvery === 0) return;

          for (let i = 0; i < candles.length; i++) {
            if (i % showEvery !== 0) continue;
            const c = candles[i];
            const x = xOf(c.time);
            if (x == null) continue;
            const xn = Number(x);
            if (xn < 20 || xn > rightEdge - 4) continue;
            const v = row.valueOf(c, i);
            if (v == null) continue;
            if (row.ribbon) {
              // Shade the cell by how far the value leans from neutral.
              const lean = Math.min(1, Math.abs(v - 50) / 30);
              ctx.fillStyle =
                v >= 50 ? `rgba(0,229,160,${0.05 + lean * 0.22})` : `rgba(255,77,109,${0.05 + lean * 0.22})`;
              ctx.fillRect(xn - barWidth / 2, y - ROW_H / 2 + 1, Math.max(2, barWidth - 1), ROW_H - 2);
            }
            ctx.fillStyle = row.colorOf(v);
            ctx.fillText(row.format ? row.format(v) : compact(v), xn, y + 3);
          }
        });
        ctx.textAlign = "left";
      }
    };

    // Every draw entry point is wrapped so a disposal race can never
    // surface as an uncaught "Object is disposed".
    const safeDraw = () => {
      try {
        draw();
      } catch (err) {
        if (process.env.NODE_ENV !== "production") console.warn("overlay draw skipped", err);
      }
    };

    // Expose the latest draw so live ticks can refresh overlays too.
    drawRef.current = safeDraw;
    safeDraw();
    const ts = chart.timeScale();
    ts.subscribeVisibleTimeRangeChange(safeDraw);
    const ro = new ResizeObserver(safeDraw);
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (drawRef.current === safeDraw) drawRef.current = null;
      if (disposedRef.current) return;
      try { ts.unsubscribeVisibleTimeRangeChange(safeDraw); } catch { /* disposed */ }
    };
  }, [ready, analysis, overlays, candles, pricePrecision]);

  // Keep the badge anchored when the price scale shifts without a new tick.
  useEffect(() => {
    if (!ready || livePrice == null || disposedRef.current || !candleSeriesRef.current) return;
    try {
      setBadgeY(candleSeriesRef.current.priceToCoordinate(livePrice) ?? null);
    } catch {
      /* disposed */
    }
  }, [ready, livePrice, candles]);

  const bullishBar =
    liveKline != null ? liveKline.close >= liveKline.open : true;

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      <canvas ref={overlayRef} className="pointer-events-none absolute inset-0" />

      {overlays.candleInspector && inspectorStats && (
        <CandleInspector
          live={hoveredTime == null}
          stats={inspectorStats}
          pricePrecision={pricePrecision}
        />
      )}

      {/* Live price + candle countdown, pinned to the right price axis */}
      {countdown && badgeY != null && (
        <div
          className="pointer-events-none absolute right-0 z-10 flex -translate-y-1/2 flex-col items-end gap-[2px]"
          style={{ top: badgeY }}
        >
          {livePrice != null && (
            <span
              className={`rounded-sm px-1.5 py-[1px] font-mono text-[10px] font-bold text-base-950 ${
                bullishBar ? "bg-bull" : "bg-bear"
              }`}
            >
              {livePrice.toFixed(pricePrecision)}
            </span>
          )}
          <span
            className={`rounded-sm px-1.5 py-[1px] font-mono text-[10px] font-semibold tabular-nums ${
              bullishBar ? "bg-bull/20 text-bull" : "bg-bear/20 text-bear"
            }`}
            title="Time remaining until the current candle closes"
          >
            {countdown}
          </span>
        </div>
      )}
    </div>
  );
}

/** Pixel width of one bar, used to decide whether numbers can be printed. */
function estimateBarWidth(ts: ReturnType<IChartApi["timeScale"]>, candles: Candle[]): number {
  if (candles.length < 2) return 0;
  const mid = Math.floor(candles.length / 2);
  const a = ts.timeToCoordinate(candles[mid - 1].time as UTCTimestamp);
  const b = ts.timeToCoordinate(candles[mid].time as UTCTimestamp);
  if (a == null || b == null) return 0;
  return Math.abs(Number(b) - Number(a));
}

/** Compact number formatting so values fit inside one bar width. */
function compact(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  if (abs >= 1) return `${sign}${abs.toFixed(0)}`;
  if (abs === 0) return "0";
  return `${sign}${abs.toFixed(2)}`;
}
