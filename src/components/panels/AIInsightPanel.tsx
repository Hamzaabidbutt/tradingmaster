"use client";

import { useEffect, useRef, useState } from "react";
import { FullAnalysis, Insight } from "@/engines/types";
import { BiasBadge, GlassCard, ProbabilityBar, timeAgo } from "@/components/ui/primitives";

/**
 * The continuously updating AI market analyst. New insights stream in with
 * each analysis refresh; each entry carries the evidence behind the call —
 * behaving like an institutional desk analyst, never a bare BUY/SELL label.
 */
export default function AIInsightPanel({ analysis }: { analysis: FullAnalysis | null }) {
  const [feed, setFeed] = useState<(Insight & { id: string })[]>([]);
  const seen = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!analysis) return;
    const fresh: (Insight & { id: string })[] = [];
    for (const ins of analysis.insights) {
      const key = `${ins.category}:${ins.headline}`;
      if (seen.current.has(key)) continue;
      seen.current.add(key);
      fresh.push({ ...ins, id: `${key}:${ins.time}` });
    }
    if (fresh.length > 0) {
      setFeed((prev) => [...fresh.reverse(), ...prev].slice(0, 40));
    }
    // Allow headlines to reappear after 3 minutes so evolving conditions re-surface.
    const t = setTimeout(() => {
      for (const f of fresh) seen.current.delete(`${f.category}:${f.headline}`);
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
                {/* Clock time first: "14:32:07" is what you match against the
                    chart; "3m ago" only says how stale the line is. */}
                <time
                  dateTime={new Date(ins.time * 1000).toISOString()}
                  className="shrink-0 text-right font-mono text-[9px] leading-tight text-slate-500"
                >
                  <span className="block text-neon-cyan/70">{clockTime(ins.time)}</span>
                  <span className="block text-slate-600">{timeAgo(ins.time)}</span>
                </time>
              </div>
              <p className="pl-3.5 text-[11px] leading-relaxed text-slate-400">{ins.detail}</p>
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
