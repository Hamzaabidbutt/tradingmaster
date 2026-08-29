"use client";

import { FullAnalysis } from "@/engines/types";
import { GlassCard, timeAgo } from "@/components/ui/primitives";

/**
 * Absorption / exhaustion / trapped traders / CVD divergence — the
 * confirmation layer. Order flow is never a standalone strategy; it is the
 * trigger that turns a level you already had into a high-probability one.
 */
export default function OrderFlowEventsPanel({ analysis }: { analysis: FullAnalysis | null }) {
  const ev = analysis?.orderFlowEvents;
  const delta = analysis?.delta;
  /**
   * Timestamp of the newest bar the analysis covers.
   *
   * Printed beside the CVD figure so "is this panel live?" is answerable at a
   * glance. Order-flow events are genuinely intermittent — a quiet stretch and
   * a stalled panel look identical without a clock somewhere on it.
   */
  const lastBar = delta?.series[delta.series.length - 1]?.time ?? null;

  return (
    <GlassCard title="Absorption · Exhaustion · Traps" className="h-full">
      {!ev || !delta ? (
        <div className="p-4 text-xs text-slate-500">Scanning order flow…</div>
      ) : (
        <div className="flex h-full flex-col">
          {/* CVD strip */}
          <div className="border-b border-white/5 px-3 py-2">
            <div className="mb-1 flex items-center justify-between text-[10px]">
              <span className="uppercase tracking-wider text-slate-500">
                Cumulative delta
                {lastBar != null && (
                  <span className="ml-1.5 font-mono normal-case tracking-normal text-slate-600">
                    · to {new Date(lastBar * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                )}
              </span>
              <span className={`font-mono font-semibold ${delta.cvd >= 0 ? "text-bull" : "text-bear"}`}>
                {delta.cvd >= 0 ? "+" : ""}{fmt(delta.cvd)} · {delta.cvdTrend}
              </span>
            </div>
            <CvdSpark series={delta.series} />
          </div>

          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
            {/*
              One chronological list rather than five fixed-size slices in
              engine order. Sliced per-kind, a busy absorption run could push
              a fresh divergence off the panel entirely while older events of
              another kind stayed pinned — the panel looked static precisely
              when the tape was busiest.
            */}
            {mergeEvents(ev, delta).map((e) => (
              <Card
                key={`${e.kind}-${e.time}-${e.label}`}
                tone={e.tone}
                label={e.label}
                time={e.time}
                strength={e.strength}
                text={e.text}
              />
            ))}
            {ev.absorptions.length === 0 &&
              ev.exhaustions.length === 0 &&
              ev.trapped.length === 0 &&
              delta.divergences.length === 0 && (
                <p className="py-4 text-center text-[11px] text-slate-500">
                  No absorption, exhaustion or trap signatures in the current window. Order flow is confirmation —
                  wait for it to line up with a level rather than forcing a trade.
                </p>
              )}
          </div>

          {ev.deltaSpikeLevels.length > 0 && (
            <div className="border-t border-white/5 px-3 py-2">
              <div className="mb-1 text-[9px] uppercase tracking-wider text-slate-500">
                Delta spike levels (act as future S/R)
              </div>
              <div className="flex flex-wrap gap-1">
                {ev.deltaSpikeLevels.slice(-6).map((d, i) => (
                  <span
                    key={i}
                    className={`rounded px-1.5 py-0.5 font-mono text-[9px] ${
                      d.side === "buy" ? "bg-bull/10 text-bull" : "bg-bear/10 text-bear"
                    }`}
                  >
                    {d.price.toFixed(4)}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </GlassCard>
  );
}

function Card({
  tone,
  label,
  time,
  strength,
  text,
}: {
  tone: "bull" | "bear";
  label: string;
  time: number;
  strength?: number;
  text: string;
}) {
  const color = tone === "bull" ? "border-bull/25 text-bull" : "border-bear/25 text-bear";
  return (
    <article className={`animate-fade-in rounded-lg border bg-white/[0.02] p-2 ${color}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wider">{label}</span>
        <span className="shrink-0 font-mono text-[9px] text-slate-600">
          {strength != null && `${strength} · `}
          {timeAgo(time)}
        </span>
      </div>
      <p className="mt-1 text-[10px] leading-relaxed text-slate-400">{text}</p>
    </article>
  );
}

function CvdSpark({ series }: { series: { time: number; cvd: number }[] }) {
  if (series.length < 2) return null;
  const w = 300;
  const h = 28;
  const vals = series.map((s) => s.cvd);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = Math.max(max - min, 1e-9);
  const pts = series
    .map((s, i) => `${(i / (series.length - 1)) * w},${h - ((s.cvd - min) / span) * h}`)
    .join(" ");
  const up = vals[vals.length - 1] >= vals[0];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-7 w-full" preserveAspectRatio="none" role="img" aria-label="Cumulative delta">
      <polyline points={pts} fill="none" stroke={up ? "#00e5a0" : "#ff4d6d"} strokeWidth="1.5" />
    </svg>
  );
}

function fmt(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${abs.toFixed(0)}`;
}


interface MergedEvent {
  kind: string;
  time: number;
  tone: "bull" | "bear";
  label: string;
  strength?: number;
  text: string;
}

/** Every order-flow event in one list, newest first. */
function mergeEvents(
  ev: NonNullable<FullAnalysis["orderFlowEvents"]>,
  delta: NonNullable<FullAnalysis["delta"]>
): MergedEvent[] {
  const out: MergedEvent[] = [];

  for (const d of delta.divergences) {
    out.push({
      kind: "div",
      time: d.time,
      tone: d.kind.includes("bullish") ? "bull" : "bear",
      label: d.kind.replace(/_/g, " "),
      strength: d.strength,
      text: d.explanation,
    });
  }
  for (const a of ev.absorptions) {
    out.push({
      kind: "abs",
      time: a.time,
      tone: a.side === "buy" ? "bull" : "bear",
      label: `${a.side} absorption${a.atKeyLevel ? " ★ at key level" : " (mid-range)"}`,
      strength: a.strength,
      text: a.explanation,
    });
  }
  for (const e of ev.exhaustions) {
    out.push({
      kind: "exh",
      time: e.time,
      // Buyer exhaustion is bearish for what follows, and vice versa.
      tone: e.side === "buy" ? "bear" : "bull",
      label: `${e.side === "buy" ? "buyer" : "seller"} exhaustion · ${e.stage}`,
      strength: e.strength,
      text: e.explanation,
    });
  }
  for (const t of ev.trapped) {
    out.push({
      kind: "trap",
      time: t.time,
      tone: t.side === "buyers" ? "bear" : "bull",
      label: `trapped ${t.side}`,
      strength: t.strength,
      text: t.explanation,
    });
  }
  for (const t of delta.trapBars) {
    out.push({
      kind: "tb",
      time: t.time,
      tone: t.deltaDirection === "bullish" ? "bull" : "bear",
      label: "trap bar",
      text: `Candle closed ${t.candleDirection} while delta printed ${t.deltaDirection} (${t.delta >= 0 ? "+" : ""}${fmt(t.delta)}) at ${t.price.toFixed(4)} — the aggressive side was absorbed.`,
    });
  }

  return out.sort((a, b) => b.time - a.time).slice(0, 24);
}
