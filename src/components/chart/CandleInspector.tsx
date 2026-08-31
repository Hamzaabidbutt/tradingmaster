"use client";

import { MutableRefObject, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
 * The card is `position: fixed` *and portalled to `document.body`*, so it can
 * be dragged anywhere on screen — over the sidebar, over the panels below,
 * wherever it is out of the way. Clamping it to the chart would have made
 * "drag it out of the way" mean "drag it to a different part of the thing you
 * are trying to see".
 *
 * The portal is not decoration. `position: fixed` resolves against the nearest
 * ancestor with a transform, filter or **backdrop-filter** rather than the
 * viewport, and every panel in this app is a `.glass` card carrying
 * `backdrop-filter: blur(14px)`. Left in the chart's DOM the card was pinned
 * inside that card's box and clipped by its `overflow: hidden`, so no amount
 * of `fixed` would let it reach the navigation. Rendering into `body` is the
 * only reliable way out of both.
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
  minimized = false,
  onToggleMinimize,
  onPointerOverCard,
  rootRef,
}: {
  stats: CandleStats;
  pricePrecision: number;
  /** true when nothing is hovered and this is the newest bar */
  live?: boolean;
  /** the bar's narrative, from `buildCandleStory` */
  story?: StoryLine[];
  /** where the card sits, in viewport px */
  position?: InspectorPosition | null;
  /** called as the card is dragged, and with null on a reset */
  onMove?: (pos: InspectorPosition | null) => void;
  /** collapsed to a single strip */
  minimized?: boolean;
  onToggleMinimize?: () => void;
  /**
   * Called as the pointer enters and leaves the card's interactive regions.
   *
   * The chart needs this because those regions take pointer events, which
   * makes the crosshair report "no bar" and the container report a leave —
   * both indistinguishable from the user actually leaving the chart. Without
   * it the panel snaps back to the live bar the moment the cursor touches its
   * header, which reads as the inspector refusing to track that candle.
   */
  onPointerOverCard?: (over: boolean) => void;
  /** so the chart can tell "moved onto the card" from "left the chart" */
  rootRef?: MutableRefObject<HTMLElement | null>;
}) {
  const p = (v: number) => v.toFixed(pricePrecision);
  const when = new Date(stats.time * 1000);

  const cardRef = useRef<HTMLDivElement>(null);
  const grabRef = useRef<InspectorPosition | null>(null);
  const [storyOpen, setStoryOpen] = useState(true);
  const pos = position ?? DEFAULT_INSPECTOR_POSITION;

  // The portal target only exists in the browser, so the first render must
  // match the server's (nothing) and the portal opens on mount.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Publish the card's root so the chart can test `relatedTarget` against it,
  // and make sure an unmount never leaves the chart believing the pointer is
  // still parked over a card that no longer exists.
  useEffect(() => {
    if (rootRef) rootRef.current = cardRef.current;
    return () => {
      if (rootRef) rootRef.current = null;
      onPointerOverCard?.(false);
    };
  }, [rootRef, onPointerOverCard, mounted]);

  const enter = useCallback(() => onPointerOverCard?.(true), [onPointerOverCard]);
  const leave = useCallback(() => onPointerOverCard?.(false), [onPointerOverCard]);

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
    // Run once on the spot as well as on resize: collapsing changes the card's
    // height, and a card parked against the bottom edge would otherwise keep
    // the taller box's coordinates and float free of it.
    reclamp();
    window.addEventListener("resize", reclamp);
    return () => window.removeEventListener("resize", reclamp);
  }, [pos, onMove, minimized]);

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

  const endDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      grabRef.current = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      // Pointer capture swallows the leave event, so a drag that ends with the
      // cursor off the card would otherwise leave the chart believing the
      // pointer is still parked on it — and the inspector would never return
      // to the live bar. Settle the flag from the actual geometry instead.
      const rect = cardRef.current?.getBoundingClientRect();
      const inside =
        rect != null &&
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom;
      onPointerOverCard?.(inside);
    },
    [onPointerOverCard]
  );

  if (!mounted) return null;

  const card = (
    // pointer-events-none throughout: the card sits over the candles, and a
    // solid block would swallow the crosshair that drives it — the readings
    // would freeze exactly where the card is.
    //
    // z-50 clears the mobile bottom nav (z-40) and the desktop sidebar, which
    // is in normal flow; dragging the card over either leaves it readable.
    <div
      ref={cardRef}
      className={`pointer-events-none fixed z-50 max-w-[calc(100vw-1.5rem)] rounded-xl border border-white/10 bg-base-900/95 shadow-glass backdrop-blur-xl ${
        minimized ? "w-auto p-1.5" : "w-[268px] p-2.5"
      }`}
      style={{ left: pos.x, top: pos.y }}
    >
      <div
        className={`-m-1 flex items-center justify-between gap-2 rounded-lg p-1 ${
          minimized ? "" : "mb-1.5"
        } ${
          onMove ? "pointer-events-auto cursor-move touch-none select-none hover:bg-white/[0.06]" : ""
        }`}
        onPointerEnter={enter}
        onPointerLeave={leave}
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
          {onToggleMinimize && (
            // pointer-events-auto and a stopped propagation: this sits on the
            // drag handle, and without it a tap would start a drag instead of
            // toggling. Sized for a finger, not just a cursor.
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleMinimize();
              }}
              onPointerDown={(e) => e.stopPropagation()}
              className="pointer-events-auto rounded px-1.5 py-0.5 text-[11px] leading-none text-slate-400 hover:bg-white/10 hover:text-slate-100"
              aria-expanded={!minimized}
              aria-label={minimized ? "Expand candle inspector" : "Minimize candle inspector"}
              title={minimized ? "Expand" : "Minimize — keeps the header strip only"}
            >
              {minimized ? "▣" : "▁"}
            </button>
          )}
          {onMove && (
            <span aria-hidden className="text-[11px] leading-none text-slate-600">
              ⠿
            </span>
          )}
        </span>
      </div>

      {/*
        Minimized: one strip with the three readings worth glancing at while
        the card is out of the way — how big the bar is, who was aggressive,
        and the net. Everything else is a click away rather than gone.
      */}
      {minimized && (
        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 px-0.5 font-mono text-[10px]">
          <Pair label="RNG" value={`${stats.rangePct.toFixed(2)}%`} />
          <Pair
            label="BUY"
            value={`${stats.buyPct.toFixed(0)}%`}
            tone={stats.buyPct >= 55 ? "bull" : stats.buyPct <= 45 ? "bear" : "plain"}
          />
          <Pair
            label="Δ"
            value={`${stats.deltaVolume >= 0 ? "+" : ""}${fmt(stats.deltaVolume)}`}
            tone={stats.deltaVolume >= 0 ? "bull" : "bear"}
          />
        </div>
      )}

      {!minimized && (
      <>
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
            onPointerEnter={enter}
            onPointerLeave={leave}
            className="pointer-events-auto flex w-full items-center justify-between text-[9px] uppercase tracking-[0.14em] text-slate-500 hover:text-slate-300"
          >
            Story of this candle
            <span aria-hidden>{storyOpen ? "▲" : "▼"}</span>
          </button>
          {storyOpen && (
            // Capped and scrollable: the narrative runs to a dozen lines on an
            // eventful bar, and a card that grows past the chart is worse than
            // one you scroll.
            <div
              onPointerEnter={enter}
              onPointerLeave={leave}
              className="pointer-events-auto mt-1 max-h-[260px] space-y-1.5 overflow-y-auto pr-0.5"
            >
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
      </>
      )}
    </div>
  );

  return createPortal(card, document.body);
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
