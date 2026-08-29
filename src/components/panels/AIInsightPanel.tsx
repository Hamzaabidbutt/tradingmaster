"use client";

import { useEffect, useRef, useState } from "react";
import { FullAnalysis, Insight } from "@/engines/types";
import { BiasBadge, GlassCard, ProbabilityBar, timeAgo } from "@/components/ui/primitives";

/**
 * The continuously updating AI market analyst.
 *
 * Every entry answers two separate questions, and the panel keeps them
 * separate. **Candle** is the bar the observation is about — that is the number
 * you match against the chart, and on a 4h interval it can be hours away from
 * the moment the reading was produced. **Read** is when the system said it,
 * which only tells you how stale the line is. Collapsing the two, as a single
 * timestamp does, makes a four-bar-old absorption event look like it happened
 * just now.
 *
 * The feed arrives pre-ranked by severity and conviction, so it is rendered in
 * the order given rather than re-sorted here.
 */
export default function AIInsightPanel({ analysis }: { analysis: FullAnalysis | null }) {
  const [feed, setFeed] = useState<(Insight & { id: string })[]>([]);
  const seen = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!analysis) return;
    const fresh: (Insight & { id: string })[] = [];
    for (const ins of analysis.insights) {
      // Keyed by the bar as well as the headline: the same observation on a
      // new candle is a new event, and suppressing it would freeze the feed
      // while the market moved.
      const key = `${ins.category}:${ins.headline}:${ins.barTime}`;
      if (seen.current.has(key)) continue;
      seen.current.add(key);
      fresh.push({ ...ins, id: `${key}:${ins.time}` });
    }
    if (fresh.length > 0) {
      setFeed((prev) => [...fresh.reverse(), ...prev].slice(0, 40));
    }
    // Allow headlines to reappear after 3 minutes so evolving conditions re-surface.
    const t = setTimeout(() => {
      for (const f of fresh) seen.current.delete(`${f.category}:${f.headline}:${f.barTime}`);
    }, 180_000);
    return () => clearTimeout(t);
  }, [analysis]);

  // Reset the feed when the market context changes.
  useEffect(() => {
    setFeed([]);
    seen.current.clear();
  }, [analysis?.symbol, analysis?.timeframe]);

  const severityDot = (s: Insight["severity"]) =>
    s === "critical" ? "bg-bear" : s === "warning" ? "bg-neon-amber" : "bg-neon-cyan";

  return (
    <GlassCard
      title={
        <span className="flex items-center gap-2">
          <span className="pulse-dot inline-block h-2 w-2 rounded-full bg-neon-cyan" />
          AI Market Intelligence
        </span>
      }
      className="h-full"
    >
      <div className="flex h-full flex-col">
        {analysis && (
          <div className="border-b border-white/5 px-4 py-3">
            <div className="mb-2 flex items-center justify-between">
              <BiasBadge bias={analysis.bias} label={`${analysis.bias} bias`} />
              <span className="font-mono text-[10px] text-slate-500">
                {analysis.symbol} · {analysis.timeframe}
              </span>
            </div>
            <ProbabilityBar bullish={analysis.bullishProbability} />
          </div>
        )}
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
          {feed.length === 0 && (
            <p className="p-4 text-center text-xs text-slate-500">Analyst warming up — insights arrive within seconds…</p>
          )}
          {feed.map((ins) => (
            <article key={ins.id} className="animate-slide-up rounded-lg border border-white/5 bg-white/[0.02] p-3">
              <div className="mb-1 flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className={`mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full ${severityDot(ins.severity)}`} />
                  <h4
                    className={`text-xs font-semibold leading-snug ${
                      ins.bias === "bullish" ? "text-bull" : ins.bias === "bearish" ? "text-bear" : "text-slate-200"
                    }`}
                  >
                    {ins.headline}
                  </h4>
                </div>
                <time
                  dateTime={new Date(ins.barTime * 1000).toISOString()}
                  className="shrink-0 text-right font-mono text-[9px] leading-tight text-slate-500"
                  title={`Observed on the ${ins.barTimeframe} candle opening ${localDateTime(ins.barTime)} · read produced ${clockTime(ins.time)}`}
                >
                  <span className="block text-neon-cyan/80">🕒 {clockTime(ins.barTime)}</span>
                  <span className="block text-slate-600">
                    {ins.barsAgo === 0 ? "live bar" : `${ins.barsAgo} ${ins.barTimeframe} bar${ins.barsAgo === 1 ? "" : "s"} ago`}
                  </span>
                </time>
              </div>
              <p className="pl-3.5 text-[11px] leading-relaxed text-slate-400">{ins.detail}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 pl-3.5 font-mono text-[9px] text-slate-600">
                <span className="uppercase tracking-wider">{ins.category.replace(/_/g, " ")}</span>
                <span
                  className={
                    ins.confidence >= 75
                      ? "text-neon-cyan"
                      : ins.confidence >= 60
                        ? "text-slate-400"
                        : "text-slate-600"
                  }
                  title="Conviction that this observation is real — not the odds a trade works."
                >
                  conviction {ins.confidence}
                </span>
                <span className="ml-auto">read {timeAgo(ins.time)}</span>
              </div>
            </article>
          ))}
        </div>
      </div>
    </GlassCard>
  );
}

/** Local wall-clock time of an event, to the second. */
function clockTime(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function localDateTime(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}
