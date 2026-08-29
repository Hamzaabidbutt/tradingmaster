"use client";

import { FullAnalysis } from "@/engines/types";

/**
 * A one-line tape of divergences and absorption bars, above the chart.
 *
 * These events already appear in the order-flow panel further down the page,
 * but by the time you have scrolled to them you are no longer looking at the
 * chart. They belong at the top for the same reason a headline does: the
 * question "has anything happened recently?" should be answerable without
 * moving your eyes off price.
 *
 * Times are the *event's* clock time in the reader's timezone, not an age.
 * "14:35" lines up against the chart's own axis; "20m ago" has to be converted
 * before it can be used, and converted again a minute later.
 */

type TapeKind = "divergence" | "absorption" | "exhaustion" | "trap";

interface TapeEvent {
  time: number;
  kind: TapeKind;
  tone: "bull" | "bear";
  label: string;
  detail: string;
}

const KIND_ICON: Record<TapeKind, string> = {
  divergence: "⑂",
  absorption: "⊟",
  exhaustion: "◔",
  trap: "⚑",
};

function localTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Flatten the engines' event lists into one chronological tape. */
export function buildTape(analysis: FullAnalysis | null, limit = 12): TapeEvent[] {
  if (!analysis) return [];
  const events: TapeEvent[] = [];

  for (const d of analysis.delta?.divergences ?? []) {
    events.push({
      time: d.time,
      kind: "divergence",
      tone: d.kind.includes("bullish") ? "bull" : "bear",
      label: d.kind.replace(/_/g, " "),
      detail: d.explanation,
    });
  }
  for (const a of analysis.orderFlowEvents?.absorptions ?? []) {
    events.push({
      time: a.time,
      kind: "absorption",
      tone: a.side === "buy" ? "bull" : "bear",
      label: `${a.side} absorption${a.atKeyLevel ? " ★" : ""}`,
      detail: a.explanation,
    });
  }
  for (const e of analysis.orderFlowEvents?.exhaustions ?? []) {
    events.push({
      time: e.time,
      kind: "exhaustion",
      // Buyer exhaustion is bearish for what follows, and vice versa.
      tone: e.side === "buy" ? "bear" : "bull",
      label: `${e.side === "buy" ? "buyer" : "seller"} exhaustion`,
      detail: e.explanation,
    });
  }
  for (const t of analysis.orderFlowEvents?.trapped ?? []) {
    events.push({
      time: t.time,
      kind: "trap",
      tone: t.side === "buyers" ? "bear" : "bull",
      label: `trapped ${t.side}`,
      detail: t.explanation,
    });
  }

  // Newest first: the tape is read left to right and the useful end is "now".
  return events.sort((a, b) => b.time - a.time).slice(0, limit);
}

export default function EventTape({ analysis }: { analysis: FullAnalysis | null }) {
  const events = buildTape(analysis);
  if (!analysis) return null;

  return (
    <div className="mb-2 flex items-center gap-2 overflow-x-auto rounded-lg border border-white/5 bg-white/[0.02] px-2 py-1">
      <span className="shrink-0 text-[9px] uppercase tracking-[0.14em] text-slate-600">
        Flow events
      </span>
      {events.length === 0 ? (
        <span className="text-[10px] text-slate-500">
          No divergence, absorption or trap detected in the analysed window.
        </span>
      ) : (
        events.map((e) => (
          <span
            key={`${e.kind}-${e.time}-${e.label}`}
            title={`${localTime(e.time)} — ${e.detail}`}
            className={`flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[10px] ${
              e.tone === "bull" ? "bg-bull/10 text-bull" : "bg-bear/10 text-bear"
            }`}
          >
            <span aria-hidden className="opacity-70">
              {KIND_ICON[e.kind]}
            </span>
            <span className="text-slate-400">{localTime(e.time)}</span>
            {e.label}
          </span>
        ))
      )}
    </div>
  );
}
