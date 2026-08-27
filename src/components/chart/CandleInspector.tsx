"use client";

import { useCallback, useEffect, useRef } from "react";
import { CandleStats } from "@/engines/candleStats";
// One definition, in the layer that persists it — a second copy here would be
// free to drift from what is actually written to storage.
import type { InspectorPosition } from "@/stores/marketStore";

/** Where the card sits before anyone drags it — the old fixed corner. */
export const DEFAULT_INSPECTOR_POSITION: InspectorPosition = { x: 8, y: 8 };

/** Keep a position inside its container, so a resize cannot strand the card. */
function clamp(pos: InspectorPosition, card: HTMLElement): InspectorPosition {
  const parent = card.offsetParent as HTMLElement | null;
  if (!parent) return pos;
  const maxX = Math.max(0, parent.clientWidth - card.offsetWidth);
  const maxY = Math.max(0, parent.clientHeight - card.offsetHeight);
  return {
    x: Math.min(Math.max(0, pos.x), maxX),
    y: Math.min(Math.max(0, pos.y), maxY),
  };
}

/**
 * Detail card for the candle under the cursor.
 *
 * Rendered as an overlay inside the chart rather than a separate panel so the
 * numbers sit next to the bar they describe. Values the analysis window does
 * not cover render as "—" instead of zero, because zero forced flow and *no
 * data about* forced flow mean very different things.
 *
 * Two layouts, chosen by the pointer rather than by the viewport width:
 *
 *  * **Card** (mouse) — the full breakdown, parked in the top-left corner.
 *    There is a cursor to move it out from under, so it can afford the space.
 *  * **Strip** (touch) — one wrapping line pinned across the top. A phone has
 *    no cursor to move away, so the card would sit permanently over the chart
 *    with nothing the user could do about it. The strip carries the same
 *    figures in a band the candles can be read around.
 */
export default function CandleInspector({
  stats,
  pricePrecision,
  live,
  compact,
  position,
  onMove,
}: {
  stats: CandleStats;
  pricePrecision: number;
  /** true when the cursor is off the chart and this is the newest bar */
  live?: boolean;
  /** render the touch-friendly strip instead of the full card */
  compact?: boolean;
  /** where the card sits, in px from the chart's top-left */
  position?: InspectorPosition | null;
  /** called as the card is dragged, and with null on a reset */
  onMove?: (pos: InspectorPosition | null) => void;
}) {
  const p = (v: number) => v.toFixed(pricePrecision);
  const when = new Date(stats.time * 1000);

  const cardRef = useRef<HTMLDivElement>(null);
  /** Cursor offset within the card when the drag began. */
  const grabRef = useRef<{ dx: number; dy: number } | null>(null);
  const pos = position ?? DEFAULT_INSPECTOR_POSITION;

  /**
   * Re-clamp when the chart resizes.
   *
   * A card dragged to the right edge of a wide window would otherwise sit
   * outside a narrow one — visible in the DOM, invisible on screen, and with
   * no way to drag it back.
   */
  useEffect(() => {
    const card = cardRef.current;
    const parent = card?.offsetParent as HTMLElement | null;
    if (!card || !parent || !onMove) return;
    const observer = new ResizeObserver(() => {
      const next = clamp(pos, card);
      if (next.x !== pos.x || next.y !== pos.y) onMove(next);
    });
    observer.observe(parent);
    return () => observer.disconnect();
  }, [pos, onMove]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const card = cardRef.current;
    if (!card || e.button !== 0) return;
    const rect = card.getBoundingClientRect();
    grabRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    // Capture on the handle so the drag survives the cursor outrunning the
    // card, and so releasing outside the chart still ends it.
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const card = cardRef.current;
      const grab = grabRef.current;
      const parent = card?.offsetParent as HTMLElement | null;
      if (!card || !grab || !parent || !onMove) return;
      const parentRect = parent.getBoundingClientRect();
      onMove(
        clamp(
          { x: e.clientX - parentRect.left - grab.dx, y: e.clientY - parentRect.top - grab.dy },
          card
        )
      );
    },
    [onMove]
  );

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    grabRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  if (compact) {
    return (
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 border-b border-white/5 bg-base-900/85 px-2 py-1 font-mono text-[9px] backdrop-blur-md">
        <span className={`font-bold ${stats.bullish ? "text-bull" : "text-bear"}`}>
          {stats.bullish ? "▲" : "▼"} {stats.changePct >= 0 ? "+" : ""}
          {stats.changePct.toFixed(2)}%
        </span>
        {live && <span className="text-[8px] uppercase tracking-wider text-neon-cyan">live</span>}
        <span className="text-slate-500">
          {when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </span>

        <Pair label="O" value={p(stats.open)} />
        <Pair label="H" value={p(stats.high)} />
        <Pair label="L" value={p(stats.low)} />
        <Pair label="C" value={p(stats.close)} />
        <Pair
          label="V"
          value={fmt(stats.volume)}
          sub={stats.volumeMultiple != null ? `${stats.volumeMultiple}×` : undefined}
          tone={stats.volumeMultiple != null && stats.volumeMultiple > 1.5 ? "amber" : "plain"}
        />
        <Pair
          label="Δ"
          value={`${stats.deltaVolume >= 0 ? "+" : ""}${fmt(stats.deltaVolume)}`}
          sub={`${stats.buyPct.toFixed(0)}%`}
          tone={stats.deltaVolume >= 0 ? "bull" : "bear"}
        />
        {stats.liquidationDelta != null && (
          <Pair
            label="LIQΔ"
            value={`${stats.liquidationDelta >= 0 ? "+" : ""}${fmt(stats.liquidationDelta)}`}
            tone={stats.liquidationDelta >= 0 ? "bull" : "bear"}
          />
        )}
        {stats.cvd != null && (
          <Pair
            label="CVD"
            value={`${stats.cvd >= 0 ? "+" : ""}${fmt(stats.cvd)}`}
            tone={stats.cvd >= 0 ? "bull" : "bear"}
          />
        )}
      </div>
    );
  }

  return (
    // The card itself stays transparent to the mouse: anything interactive
    // here sits over the candles, and a solid 248px block would kill the
    // crosshair — and with it the very readings the card exists to show —
    // wherever it happened to be parked. Only the handle takes events.
    <div
      ref={cardRef}
      className="pointer-events-none absolute z-20 w-[248px] rounded-xl border border-white/10 bg-base-900/95 p-2.5 shadow-glass backdrop-blur-xl"
      style={{ left: pos.x, top: pos.y }}
    >
      <div
        className={`mb-2 flex items-center justify-between gap-2 ${
          onMove ? "pointer-events-auto cursor-move select-none" : ""
        }`}
        onPointerDown={onMove ? onPointerDown : undefined}
        onPointerMove={onMove ? onPointerMove : undefined}
        onPointerUp={onMove ? endDrag : undefined}
        onPointerCancel={onMove ? endDrag : undefined}
        onDoubleClick={onMove ? () => onMove(null) : undefined}
        title={onMove ? "Drag to move · double-click to reset" : undefined}
      >
        <div>
          <div
            className={`font-mono text-[11px] font-bold ${stats.bullish ? "text-bull" : "text-bear"}`}
          >
            {stats.bullish ? "▲" : "▼"} {stats.changePct >= 0 ? "+" : ""}
            {stats.changePct.toFixed(2)}%
          </div>
          <div className="font-mono text-[9px] text-slate-500">
            {when.toLocaleDateString()} {when.toLocaleTimeString()}
          </div>
        </div>
        {live && (
          <span
            className="rounded bg-neon-cyan/10 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider text-neon-cyan"
            title="No candle hovered — showing the most recent bar"
          >
            live
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-1">
        <Row label="High" value={p(stats.high)} />
        <Row label="Low" value={p(stats.low)} />
        <Row label="Open" value={p(stats.open)} />
        <Row label="Close" value={p(stats.close)} />
        <Row
          label="Range"
          value={`${p(stats.range)}`}
          sub={`${stats.rangePct.toFixed(2)}%`}
          span
        />
      </div>

      <Divider />

      <div className="grid grid-cols-2 gap-1">
        <Row
          label="Volume"
          value={fmt(stats.volume)}
          sub={stats.volumeMultiple != null ? `${stats.volumeMultiple}× avg` : undefined}
          tone={stats.volumeMultiple != null && stats.volumeMultiple > 1.5 ? "amber" : "plain"}
          span
        />
        <Row label="Buy vol" value={fmt(stats.buyVolume)} tone="bull" />
        <Row label="Sell vol" value={fmt(stats.sellVolume)} tone="bear" />
        <Row
          label="Delta vol"
          value={`${stats.deltaVolume >= 0 ? "+" : ""}${fmt(stats.deltaVolume)}`}
          tone={stats.deltaVolume >= 0 ? "bull" : "bear"}
        />
        <Row
          label="Buy %"
          value={`${stats.buyPct.toFixed(1)}%`}
          tone={stats.buyPct >= 55 ? "bull" : stats.buyPct <= 45 ? "bear" : "plain"}
        />
      </div>

      {/* Buy/sell split bar — the ratio is easier to read than two numbers. */}
      <div className="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-white/5">
        <div className="bg-bull" style={{ width: `${stats.buyPct}%` }} />
        <div className="bg-bear" style={{ width: `${100 - stats.buyPct}%` }} />
      </div>

      <Divider />

      <div className="grid grid-cols-2 gap-1">
        <Row
          label="Liq Δ"
          value={
            stats.liquidationDelta == null
              ? "—"
              : `${stats.liquidationDelta >= 0 ? "+" : ""}${fmt(stats.liquidationDelta)}`
          }
          tone={
            stats.liquidationDelta == null
              ? "plain"
              : stats.liquidationDelta > 0
                ? "bull"
                : stats.liquidationDelta < 0
                  ? "bear"
                  : "plain"
          }
        />
        <Row
          label="Σ Liq Δ"
          value={
            stats.liquidationCumulative == null
              ? "—"
              : `${stats.liquidationCumulative >= 0 ? "+" : ""}${fmt(stats.liquidationCumulative)}`
          }
          tone={
            stats.liquidationCumulative == null
              ? "plain"
              : stats.liquidationCumulative >= 0
                ? "bull"
                : "bear"
          }
        />
        <Row
          label="CVD"
          value={stats.cvd == null ? "—" : `${stats.cvd >= 0 ? "+" : ""}${fmt(stats.cvd)}`}
          tone={stats.cvd == null ? "plain" : stats.cvd >= 0 ? "bull" : "bear"}
          span
        />
      </div>

      {stats.liquidationDelta == null && (
        <p className="mt-1.5 text-[9px] leading-relaxed text-slate-600">
          Forced-flow and CVD figures cover the analysed window only — this bar sits outside it.
        </p>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  sub,
  tone = "plain",
  span,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "bull" | "bear" | "amber" | "plain";
  span?: boolean;
}) {
  const color =
    tone === "bull"
      ? "text-bull"
      : tone === "bear"
        ? "text-bear"
        : tone === "amber"
          ? "text-neon-amber"
          : "text-slate-200";
  return (
    <div className={`rounded bg-white/[0.03] px-1.5 py-1 ${span ? "col-span-2" : ""}`}>
      <div className="text-[8px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`font-mono text-[10px] font-semibold ${color}`}>
        {value}
        {sub && <span className="ml-1 font-normal text-slate-500">{sub}</span>}
      </div>
    </div>
  );
}

/** One `LABEL value` pair for the compact strip. */
function Pair({
  label,
  value,
  sub,
  tone = "plain",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "bull" | "bear" | "amber" | "plain";
}) {
  const color =
    tone === "bull"
      ? "text-bull"
      : tone === "bear"
        ? "text-bear"
        : tone === "amber"
          ? "text-neon-amber"
          : "text-slate-200";
  return (
    <span className="whitespace-nowrap">
      <span className="text-slate-500">{label}</span>{" "}
      <span className={`font-semibold ${color}`}>{value}</span>
      {sub && <span className="ml-0.5 text-slate-500">{sub}</span>}
    </span>
  );
}

function Divider() {
  return <div className="my-1.5 border-t border-white/5" />;
}

function fmt(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${abs.toFixed(abs < 10 ? 2 : 0)}`;
}
