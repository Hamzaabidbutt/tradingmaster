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
import { Candle, FullAnalysis } from "@/engines/types";
import { OverlayToggles } from "@/stores/marketStore";
import { LiveKline } from "@/hooks/useLiveMarket";

interface Props {
  candles: Candle[];
  liveKline: LiveKline | null;
  analysis: FullAnalysis | null;
  overlays: OverlayToggles;
  pricePrecision: number;
}

const BULL = "#00e5a0";
const BEAR = "#ff4d6d";

/**
 * TradingView-style chart (lightweight-charts) with a custom overlay canvas
 * that draws SMC zones — order blocks, FVGs, supply/demand, premium/discount,
 * liquidation clusters — plus markers for BOS/CHOCH/sweeps/patterns and
 * price lines for S/R and the active trade setup. Overlays re-render on
 * pan/zoom so the drawings stay glued to price/time coordinates.
 */
export default function TradingChart({ candles, liveKline, analysis, overlays, pricePrecision }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const [ready, setReady] = useState(false);

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
      autoSize: true,
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
    setReady(true);

    return () => {
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pricePrecision]);

  // --- Data feed ---
  useEffect(() => {
    if (!ready || !candleSeriesRef.current || candles.length === 0) return;
    candleSeriesRef.current.setData(
      candles.map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })) as CandlestickData[]
    );
    volumeSeriesRef.current?.setData(
      candles.map((c) => {
        const buy = c.takerBuyVolume ?? c.volume / 2;
        const bullBar = buy >= c.volume - buy;
        return {
          time: c.time as UTCTimestamp,
          value: c.volume,
          color: bullBar ? "rgba(0,229,160,0.35)" : "rgba(255,77,109,0.35)",
        };
      }) as HistogramData[]
    );
    chartRef.current?.timeScale().scrollToRealTime();
  }, [ready, candles]);

  // --- Live tick ---
  useEffect(() => {
    if (!ready || !liveKline || !candleSeriesRef.current) return;
    const lastTime = candles[candles.length - 1]?.time ?? 0;
    if (liveKline.time < lastTime) return;
    candleSeriesRef.current.update({
      time: liveKline.time as UTCTimestamp,
      open: liveKline.open,
      high: liveKline.high,
      low: liveKline.low,
      close: liveKline.close,
    });
    const buy = liveKline.takerBuyVolume ?? liveKline.volume / 2;
    volumeSeriesRef.current?.update({
      time: liveKline.time as UTCTimestamp,
      value: liveKline.volume,
      color: buy >= liveKline.volume - buy ? "rgba(0,229,160,0.35)" : "rgba(255,77,109,0.35)",
    });
  }, [ready, liveKline, candles]);

  // --- Markers: structure events, sweeps, patterns ---
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
    return out.sort((a, b) => Number(a.time) - Number(b.time));
  }, [analysis, overlays]);

  useEffect(() => {
    if (!ready || !candleSeriesRef.current) return;
    candleSeriesRef.current.setMarkers(markers);
  }, [ready, markers]);

  // --- Price lines: S/R + trade levels + liquidity ---
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!ready || !series || !analysis) return;
    for (const pl of priceLinesRef.current) series.removePriceLine(pl);
    priceLinesRef.current = [];

    const add = (price: number, color: string, title: string, style = LineStyle.Dashed, width: 1 | 2 = 1) => {
      priceLinesRef.current.push(
        series.createPriceLine({ price, color, title, lineStyle: style, lineWidth: width, axisLabelVisible: true })
      );
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
    if (overlays.tradeLevels && analysis.setup) {
      const s = analysis.setup;
      add(s.entry, "#22d3ee", `ENTRY ${s.side}`, LineStyle.Solid, 2);
      add(s.stopLoss, BEAR, "SL", LineStyle.Solid, 2);
      add(s.tp1, BULL, "TP1", LineStyle.LargeDashed);
      add(s.tp2, BULL, "TP2", LineStyle.LargeDashed);
      add(s.tp3, BULL, "TP3", LineStyle.LargeDashed);
    }

    return () => {
      for (const pl of priceLinesRef.current) {
        try { series.removePriceLine(pl); } catch { /* series disposed */ }
      }
      priceLinesRef.current = [];
    };
  }, [ready, analysis, overlays]);

  // --- Zone overlay canvas (order blocks, FVG, supply/demand, premium/discount) ---
  useEffect(() => {
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    const canvas = overlayRef.current;
    const el = containerRef.current;
    if (!ready || !chart || !series || !canvas || !el) return;

    const draw = () => {
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
      const rightEdge = w - 62; // leave the price axis clear

      const drawZone = (
        top: number, bottom: number, startTime: number, endTime: number | undefined,
        fill: string, stroke: string, label: string
      ) => {
        const y1 = yOf(top);
        const y2 = yOf(bottom);
        if (y1 == null || y2 == null) return;
        let x1 = xOf(startTime);
        if (x1 == null) x1 = 0 as never;
        const x2 = endTime ? xOf(endTime) ?? rightEdge : rightEdge;
        const x1n = Math.max(0, Number(x1));
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
    };

    draw();
    const ts = chart.timeScale();
    ts.subscribeVisibleTimeRangeChange(draw);
    const ro = new ResizeObserver(draw);
    ro.observe(el);
    return () => {
      ts.unsubscribeVisibleTimeRangeChange(draw);
      ro.disconnect();
    };
  }, [ready, analysis, overlays, candles]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      <canvas ref={overlayRef} className="pointer-events-none absolute inset-0" />
    </div>
  );
}
