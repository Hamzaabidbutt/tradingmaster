"use client";

import { ReactNode } from "react";
import { useMarketStore } from "@/stores/marketStore";

/**
 * A panel the user can fold away, remembered across visits.
 *
 * Seventeen boxes stacked down a page is not seventeen boxes of information —
 * past the first screen it is one box of information and a lot of scrolling,
 * because nothing below the fold gets read in the moment it would be useful.
 * Folding is the cheapest fix that does not remove anything: every panel is
 * still there, still one click away, and the ones a given user never reads
 * stop costing them the scroll.
 *
 * Owns the height rather than delegating it, which is the whole reason this
 * wraps the panel instead of living inside `GlassCard`. Collapsing a card's
 * body while its parent still reserves 560 pixels leaves a hole exactly as
 * tall as the panel it hid.
 */
export default function Foldable({
  id,
  label,
  height,
  children,
  className = "",
}: {
  /** stable key for the persisted collapsed state — never reuse one */
  id: string;
  /** shown on the collapsed strip, since the panel's own header is hidden */
  label: string;
  height: number;
  children: ReactNode;
  className?: string;
}) {
  const collapsed = useMarketStore((s) => s.collapsedPanels[id] ?? false);
  const togglePanel = useMarketStore((s) => s.togglePanel);

  if (collapsed) {
    return (
      <button
        onClick={() => togglePanel(id)}
        aria-expanded={false}
        // The visible text is the label, but the strip is the control, so it
        // gets an explicit name rather than leaning on "▼ show".
        aria-label={`Show ${label}`}
        title={`Show ${label}`}
        className={`glass flex w-full items-center justify-between px-4 py-2 text-left transition-colors hover:border-neon-cyan/30 ${className}`}
      >
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          {label}
        </span>
        <span className="font-mono text-[10px] text-slate-600">▼ show</span>
      </button>
    );
  }

  return (
    <div className={`relative ${className}`} style={{ height }}>
      {children}
      {/* Sits over the panel's own header rather than inside it, so no panel
          needs to know it is foldable and none of them had to change. */}
      <button
        onClick={() => togglePanel(id)}
        aria-expanded
        /* Without this the accessible name of the control is the glyph "▲",
           which tells a screen reader nothing about which panel it folds. */
        aria-label={`Hide ${label}`}
        title={`Hide ${label}`}
        className="absolute right-2 top-1.5 z-20 rounded px-1.5 py-0.5 font-mono text-[10px] text-slate-600 transition-colors hover:bg-white/5 hover:text-neon-cyan"
      >
        ▲
      </button>
    </div>
  );
}
