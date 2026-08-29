"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CandleStats } from "@/engines/candleStats";
import { StoryLine } from "@/engines/candleStory";
import type { InspectorPosition } from "@/stores/marketStore";
import { clampPosition, nextPosition, samePosition } from "./dragGeometry";

/**
 * Where the card sits before anyone drags it, in viewport pixels.
 *
 * Below the ticker strip rather than hard against the corner, so the default
 * position does not sit on top of the navigation.
 */
export const DEFAULT_INSPECTOR_POSITION: InspectorPosition = { x: 16, y: 96 };

/**
 * Measure the card against the **viewport**, not the chart.
 *
 * The card is `position: fixed`, so it can be dragged anywhere on screen —
 * onto a second monitor's worth of page, over the panels below, wherever it is
 * out of the way. Clamping it to the chart would have made "drag it out of the
 * way" mean "drag it to a different part of the thing you are trying to see".
 */
function measure(card: HTMLElement) {
  const cardRect = card.getBoundingClientRect();
  return {
    card: { width: cardRect.width, height: cardRect.height },
    container: { width: window.innerWidth, height: window.innerHeight },
    // Fixed positioning is already viewport-relative, so there is no offset
    // to subtract.
    origin: { x: 0, y: 0 },
  };
}

const TONE_CLASS: Record<StoryLine["tone"], string> = {
  bull: "text-bull",
  bear: "text-bear",
  warn: "text-neon-amber",
  neutral: "text-slate-400",
};

const SECTION_LABEL: Record<StoryLine["section"], string> = {
  aggression: "Who was aggressive",
  wick: "The wicks",
  stops: "Stop hunt",
  absorption: "Absorption & traps",
  divergence: "Divergence",
  forced: "Forced flow",
  context: "Location",
  next: "What to watch",
};

/**
 * Detail card for the candle under the cursor.
 *
 * Rendered as an overlay inside the chart rather than a separate panel so the
 * numbers sit next to the bar they describe. Values the analysis window does
 * not cover render as "—" instead of zero, because zero forced flow and *no
 * data about* forced flow mean very different things.
 *
 * The panel stays on screen rather than appearing only on hover, and is moved
 * out of the way by dragging its header instead. Those two decisions belong
 * together: a panel that comes and goes needs no drag handle, and a permanent
 * one is unusable without it. It falls back to the newest bar when nothing is
 * hovered, so it is never blank while the market moves.
 *
 * The same card is used on touch. Pointer events cover mouse, pen and finger
 * alike, so the handle drags identically — `touch-none` is what stops the
 * browser claiming the gesture for a scroll first.
 */
export default function CandleInspector({
  stats,
  pricePrecision,
  story,
  live,
  position,
  onMove,
}: {
  stats: CandleStats;
  pricePrecision: number;
  /** true when nothing is hovered and this is the newest bar */
  live?: boolean;
  /** the bar's narrative, from `buildCandleStory` */
  story?: StoryLine[];
  /** where the card sits, in px from the chart's top-left */
  position?: InspectorPosition | null;
  /** called as the card is dragged, and with null on a reset */
  onMove?: (pos: InspectorPosition | null) => void;
}) {
  const p = (v: number) => v.toFixed(pricePrecision);
  const when = new Date(stats.time * 1000);

  const cardRef = useRef<HTMLDivElement>(null);
  const grabRef = useRef<InspectorPosition | null>(null);
  const [storyOpen, setStoryOpen] = useState(true);
  const pos = position ?? DEFAULT_INSPECTOR_POSITION;

  // Re-clamp when the window resizes, so a card parked at the edge of a wide
  // window is not stranded off-screen in a narrow one with no way back.
  useEffect(() => {
    const card = cardRef.current;
    if (!card || !onMove) return;
    const reclamp = () => {
      const m = measure(card);
      const next = clampPosition(pos, m.card, m.container);
      if (!samePosition(next, pos)) onMove(next);
    };
    window.addEventListener("resize", reclamp);
    return () => window.removeEventListener("resize", reclamp);
  }, [pos, onMove]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const card = cardRef.current;
    if (!card || e.button !== 0) return;
    const rect = card.getBoundingClientRect();
    grabRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
    // Keeps the browser from turning the gesture into a selection or a scroll,
    // and the chart underneath from reading it as a pan.
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const card = cardRef.current;
      const grab = grabRef.current;
      if (!card || !grab || !onMove) return;
      const m = measure(card);
      onMove(nextPosition({ x: e.clientX, y: e.clientY }, grab, m.origin, m.card, m.container));
      e.preventDefault();
      e.stopPropagation();
    },
    [onMove]
  );

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    grabRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  return (
    // pointer-events-none throughout: the card sits over the candles, and a
    // solid block would swallow the crosshair that drives it — the readings
    // would freeze exactly where the card is.
    <div
      ref={cardRef}
      className="pointer-events-none fixed z-50 w-[268px] max-w-[calc(100vw-1.5rem)] rounded-xl border border-white/10 bg-base-900/95 p-2.5 shadow-glass backdrop-blur-xl"
      style={{ left: pos.x, top: pos.y }}
    >
      <div
        className={`-m-1 mb-1.5 flex items-center justify-between gap-2 rounded-lg p-1 ${
          onMove ? "pointer-events-auto cursor-move touch-none select-none hover:bg-white/[0.06]" : ""
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
        <span className="flex items-center gap-1.5">
          {live && (
            <span
              className="rounded bg-neon-cyan/10 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider text-neon-cyan"
              title="Nothing hovered — showing the newest bar"
            >
              live
            </span>
          )}
          {onMove && (
            <span aria-hidden className="text-[11px] leading-none text-slate-600">
              ⠿
            </span>
          )}
        </span>
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

      {story && story.length > 0 && (
        <>
          <Divider />
          <button
            onClick={() => setStoryOpen((v) => !v)}
            className="pointer-events-auto flex w-full items-center justify-between text-[9px] uppercase tracking-[0.14em] text-slate-500 hover:text-slate-300"
          >
            Story of this candle
            <span aria-hidden>{storyOpen ? "▲" : "▼"}</span>
          </button>
          {storyOpen && (
            // Capped and scrollable: the narrative runs to a dozen lines on an
            // eventful bar, and a card that grows past the chart is worse than
            // one you scroll.
            <div className="pointer-events-auto mt-1 max-h-[260px] space-y-1.5 overflow-y-auto pr-0.5">
              {groupStory(story).map(([section, lines]) => (
                <div key={section}>
                  <div className="text-[8px] uppercase tracking-wider text-slate-600">
                    {SECTION_LABEL[section]}
                  </div>
                  {lines.map((l, i) => (
                    <p key={i} className={`text-[10px] leading-relaxed ${TONE_CLASS[l.tone]}`}>
                      {l.text}
                    </p>
                  ))}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Group story lines by section, preserving the order they were written in. */
function groupStory(story: StoryLine[]): [StoryLine["section"], StoryLine[]][] {
  const order: StoryLine["section"][] = [];
  const bySection = new Map<StoryLine["section"], StoryLine[]>();
  for (const line of story) {
    if (!bySection.has(line.section)) {
      bySection.set(line.section, []);
      order.push(line.section);
    }
    bySection.get(line.section)!.push(line);
  }
  return order.map((s) => [s, bySection.get(s)!]);
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
