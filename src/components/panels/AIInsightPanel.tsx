"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Candle, FullAnalysis, Insight } from "@/engines/types";
import { BiasBadge, GlassCard, ProbabilityBar, timeAgo } from "@/components/ui/primitives";
import { detectAnomalies, Anomaly } from "@/engines/anomalies";
import { buildMarketStory, StoryEvent, StoryPhase } from "@/engines/marketStory";
import { readSessionIntel, SessionPattern, SessionStats } from "@/engines/sessionIntel";
import type { FundingReport } from "@/engines/fundingRates";

/**
 * The analyst, as four views of one thing.
 *
 * The panel used to be a single ranked feed of observations. A feed answers
 * "what is true now" and nothing else — it cannot say what happened *before*
 * what is true now, and a market read is a sequence rather than a snapshot.
 * Selling, then forced selling, then selling that stopped working, then
 * buying: each step only means something because of the one before it.
 *
 * So there are four tabs over the same moment:
 *
 *  - **Story** — the phases, in order, with what the arc adds up to.
 *  - **Feed** — every observation with the clock on it, oldest to newest.
 *  - **Unusual** — conditions far from this symbol's own distribution.
 *  - **Sessions** — Asia, London and New York, and the patterns between them.
 *
 * The original insight feed is not gone; it is the Feed tab, merged with the
 * story's own dated events into one chronology.
 *
 * ## Every line carries a time
 *
 * "Buyers are aggressive" has no timestamp and no antecedent — it could have
 * been true for four bars or forty. "21:47:13 — aggressive buy delta 3.2σ
 * above normal" can be checked against the chart. That is the difference
 * between a claim and an observation, and it is why the clock is on every row
 * in every tab.
 */

type Tab = "story" | "feed" | "unusual" | "sessions";

const TABS: { key: Tab; label: string; title: string }[] = [
  { key: "story", label: "Story", title: "The phases in order, and what the sequence adds up to." },
  { key: "feed", label: "Feed", title: "Every observation with the time it happened, oldest first." },
  {
    key: "unusual",
    label: "Unusual",
    title:
      "Conditions far from this symbol's own recent distribution. An anomaly says where to look, not what to do.",
  },
  {
    key: "sessions",
    label: "Sessions",
    title: "Asia, London and New York measured separately, plus the two patterns between them.",
  },
];

export default function AIInsightPanel({
  analysis,
  candles = [],
  openInterest = [],
  funding = null,
}: {
  analysis: FullAnalysis | null;
  candles?: Candle[];
  openInterest?: { time: number; openInterest: number }[];
  funding?: FundingReport | null;
}) {
  const [tab, setTab] = useState<Tab>("story");
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

  const anomalies = useMemo(() => {
    if (!analysis || candles.length === 0) return null;
    return detectAnomalies({
      candles,
      delta: analysis.delta,
      liquidations: analysis.liquidationDelta.series,
      openInterest,
      funding: funding
        ? {
            currentRatePct: funding.currentRatePct,
            annualisedPct: funding.annualisedPct,
            excessAnnualisedPct: funding.excessAnnualisedPct,
          }
        : null,
    });
  }, [analysis, candles, openInterest, funding]);

  const story = useMemo(() => {
    if (!analysis || candles.length === 0) return null;
    return buildMarketStory({
      candles,
      delta: analysis.delta,
      liquidations: analysis.liquidationDelta.series,
      vwap: analysis.vwap,
      openInterest,
      anomalies,
    });
  }, [analysis, candles, openInterest, anomalies]);

  const sessions = useMemo(
    () => (candles.length > 0 ? readSessionIntel(candles) : null),
    [candles]
  );

  /* The Feed tab merges the analyst's own insights with the story's dated
     events into one chronology. Two separate time-ordered lists on the same
     screen is two things to reconcile by hand, which is the work the panel is
     supposed to be doing. */
  const merged = useMemo(() => {
    const out: { time: number; text: string; tone: StoryEvent["tone"]; source: string }[] = [];
    for (const e of story?.events ?? []) {
      out.push({ time: e.time, text: e.text, tone: e.tone, source: e.kind });
    }
    for (const ins of feed) {
      out.push({
        time: ins.barTime,
        text: `${ins.headline} — ${ins.detail}`,
        tone: ins.bias === "bullish" ? "bull" : ins.bias === "bearish" ? "bear" : "neutral",
        source: ins.category,
      });
    }
    return out.sort((a, b) => a.time - b.time).slice(-60);
  }, [story, feed]);

  const unusualCount = anomalies?.anomalies.length ?? 0;

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

        <div className="flex gap-0.5 border-b border-white/5 px-2 py-1.5">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              aria-pressed={tab === t.key}
              title={t.title}
              className={`rounded-md px-2 py-1 text-[10px] font-semibold transition-colors ${
                tab === t.key
                  ? "bg-neon-cyan/15 text-neon-cyan"
                  : "text-slate-500 hover:text-slate-300"
              }`}
            >
              {t.label}
              {t.key === "unusual" && unusualCount > 0 && (
                <span className="ml-1 rounded-full bg-neon-amber/20 px-1 font-mono text-[8px] text-neon-amber">
                  {unusualCount}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {tab === "story" && <StoryView story={story} />}
          {tab === "feed" && <FeedView rows={merged} />}
          {tab === "unusual" && <UnusualView anomalies={anomalies} />}
          {tab === "sessions" && <SessionsView intel={sessions} />}
        </div>
      </div>
    </GlassCard>
  );
}

/* ------------------------------------------------------------------ */

function StoryView({ story }: { story: ReturnType<typeof buildMarketStory> | null }) {
  if (!story) return <Empty>Waiting on the analysis pass…</Empty>;
  if (story.phases.length === 0) return <Empty>{story.interpretation}</Empty>;

  return (
    <div className="space-y-2">
      {story.phases.map((p, idx) => (
        <div key={`${p.kind}-${p.from}`}>
          <PhaseCard phase={p} index={idx + 1} />
          {idx < story.phases.length - 1 && (
            <div className="py-0.5 text-center text-[10px] leading-none text-slate-700">↓</div>
          )}
        </div>
      ))}

      <div className="mt-2 rounded-lg border border-neon-cyan/25 bg-neon-cyan/[0.05] px-2.5 py-2">
        <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-neon-cyan">
          Current interpretation
        </div>
        <p className="mt-0.5 text-[11px] leading-relaxed text-slate-200">{story.interpretation}</p>
        <div className="mt-1.5 flex items-center gap-2">
          <span className="text-[9px] uppercase tracking-wider text-slate-500">Coherence</span>
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/10">
            <div className="h-full bg-neon-cyan/70" style={{ width: `${story.coherence}%` }} />
          </div>
          <span className="font-mono text-[10px] text-neon-cyan">{story.coherence}/100</span>
        </div>
      </div>

      <p className="text-[10px] leading-relaxed text-slate-500">{story.note}</p>
    </div>
  );
}

function PhaseCard({ phase, index }: { phase: StoryPhase; index: number }) {
  const tone =
    phase.tone === "bull"
      ? "border-bull/30 bg-bull/[0.06]"
      : phase.tone === "bear"
        ? "border-bear/30 bg-bear/[0.06]"
        : "border-white/8 bg-white/[0.02]";
  const text =
    phase.tone === "bull" ? "text-bull" : phase.tone === "bear" ? "text-bear" : "text-slate-300";

  return (
    <div className={`rounded-lg border px-2.5 py-2 ${tone}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className={`text-[11px] font-semibold ${text}`}>
          Phase {index} — {phase.label}
        </span>
        <span className="shrink-0 font-mono text-[9px] text-slate-500" title={fullStamp(phase.from)}>
          {clockTime(phase.from)} · {phase.bars}b
        </span>
      </div>
      <p className="mt-0.5 text-[10px] leading-relaxed text-slate-400">{phase.summary}</p>
    </div>
  );
}

function FeedView({
  rows,
}: {
  rows: { time: number; text: string; tone: StoryEvent["tone"]; source: string }[];
}) {
  if (rows.length === 0) return <Empty>Analyst warming up — observations arrive within seconds…</Empty>;
  return (
    <div className="space-y-1.5">
      {rows.map((r, i) => (
        <div key={`${r.time}-${i}`} className="flex gap-2">
          <time
            dateTime={new Date(r.time * 1000).toISOString()}
            className="shrink-0 font-mono text-[10px] text-neon-cyan/80"
            title={fullStamp(r.time)}
          >
            {clockTime(r.time)}
          </time>
          <span
            className={`text-[10px] leading-relaxed ${
              r.tone === "bull" ? "text-bull" : r.tone === "bear" ? "text-bear" : "text-slate-400"
            }`}
          >
            {r.text}
          </span>
        </div>
      ))}
      <p className="border-t border-white/5 pt-2 text-[10px] leading-relaxed text-slate-500">
        Times are the bar each observation is about, in your own clock — not when the system read it.
        On a slow timeframe those are hours apart.
      </p>
    </div>
  );
}

function UnusualView({ anomalies }: { anomalies: ReturnType<typeof detectAnomalies> | null }) {
  if (!anomalies) return <Empty>Waiting on the analysis pass…</Empty>;

  return (
    <div className="space-y-2">
      {anomalies.anomalies.map((a) => (
        <AnomalyCard key={`${a.kind}-${a.time}`} anomaly={a} />
      ))}

      {anomalies.anomalies.length === 0 && (
        <p className="rounded-lg border border-white/5 bg-white/[0.02] px-2.5 py-2 text-[10px] leading-relaxed text-slate-400">
          {anomalies.note}
        </p>
      )}

      {/* Detectors that could not run are listed, so an empty list is never
          ambiguous between "nothing unusual" and "nothing measured". */}
      {anomalies.unavailable.length > 0 && (
        <div className="border-t border-white/5 pt-2">
          <div className="mb-1 text-[9px] uppercase tracking-[0.14em] text-slate-600">
            Not measured
          </div>
          {anomalies.unavailable.map((u) => (
            <p key={u.kind} className="text-[10px] leading-relaxed text-slate-600">
              <span className="mr-1">·</span>
              {u.kind.replace(/_/g, " ")} — {u.why}
            </p>
          ))}
        </div>
      )}

      {anomalies.anomalies.length > 0 && (
        <p className="border-t border-white/5 pt-2 text-[10px] leading-relaxed text-slate-500">
          {anomalies.note}
        </p>
      )}
    </div>
  );
}

function AnomalyCard({ anomaly: a }: { anomaly: Anomaly }) {
  const tone =
    a.severity === "extreme"
      ? "border-bear/35 bg-bear/[0.07]"
      : a.severity === "unusual"
        ? "border-neon-amber/30 bg-neon-amber/[0.05]"
        : "border-white/8 bg-white/[0.02]";
  const dot =
    a.direction === "up" ? "text-bull" : a.direction === "down" ? "text-bear" : "text-slate-400";

  return (
    <div className={`rounded-lg border px-2.5 py-2 ${tone}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold text-slate-200">{a.label}</span>
        <span className="flex shrink-0 items-center gap-1.5">
          <span className={`font-mono text-[9px] ${dot}`}>
            {a.direction === "up" ? "↑" : a.direction === "down" ? "↓" : "·"}
          </span>
          <time className="font-mono text-[9px] text-neon-cyan/80" title={fullStamp(a.time)}>
            {clockTime(a.time)}
          </time>
        </span>
      </div>
      <p className="mt-0.5 font-mono text-[10px] text-slate-300">{a.headline}</p>
      <p className="mt-1 text-[10px] leading-relaxed text-slate-500">{a.detail}</p>
      <div className="mt-1 flex flex-wrap gap-2 font-mono text-[9px] text-slate-600">
        <span className="uppercase tracking-wider">{a.severity}</span>
        {a.z != null && <span title="Standard deviations from this symbol's own baseline">{a.z}σ</span>}
        <span title="Samples in the baseline this was measured against">n={a.samples}</span>
      </div>
    </div>
  );
}

function SessionsView({ intel }: { intel: ReturnType<typeof readSessionIntel> | null }) {
  if (!intel) return <Empty>Waiting on candles…</Empty>;
  if (intel.sessions.length === 0) return <Empty>{intel.note}</Empty>;

  return (
    <div className="space-y-2">
      {intel.sessions.map((s) => (
        <SessionCard key={s.key} session={s} live={intel.current === s.key} />
      ))}

      <div className="border-t border-white/5 pt-2">
        {intel.patterns.map((p) => (
          <PatternCard key={p.kind} pattern={p} />
        ))}
      </div>

      <p className="text-[10px] leading-relaxed text-slate-500">{intel.note}</p>
    </div>
  );
}

function SessionCard({ session: s, live }: { session: SessionStats; live: boolean }) {
  const tone =
    s.direction === "up" ? "text-bull" : s.direction === "down" ? "text-bear" : "text-slate-400";
  return (
    <div className="rounded-lg border border-white/8 bg-white/[0.02] px-2.5 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold text-slate-200">
          {s.label}
          {live && (
            <span className="ml-1.5 rounded bg-neon-cyan/15 px-1 font-mono text-[8px] text-neon-cyan">
              live
            </span>
          )}
        </span>
        <span className={`font-mono text-[10px] ${tone}`}>
          {s.changePct >= 0 ? "+" : ""}
          {s.changePct}%
        </span>
      </div>
      <div className="mt-1 grid grid-cols-3 gap-1 font-mono text-[9px]">
        <Stat label="High" value={trim(s.high)} />
        <Stat label="Low" value={trim(s.low)} />
        <Stat label="Range" value={`${s.rangePct}%`} />
        <Stat label="VWAP" value={trim(s.vwap)} />
        <Stat label="Vol" value={fmt(s.volume)} />
        <Stat
          label="Δ"
          value={s.delta == null ? "—" : `${s.delta >= 0 ? "+" : ""}${fmt(s.delta)}`}
          tone={s.delta == null ? "" : s.delta >= 0 ? "text-bull" : "text-bear"}
        />
      </div>
      <div className="mt-1 font-mono text-[9px] text-slate-600" title={fullStamp(s.from)}>
        {clockTime(s.from)} → {clockTime(s.to)} · {s.bars} bars · vol {s.volatilityPct}%/bar
      </div>
    </div>
  );
}

function PatternCard({ pattern: p }: { pattern: SessionPattern }) {
  return (
    <div className="mb-1.5 rounded-lg border border-white/5 bg-white/[0.02] px-2.5 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-semibold text-slate-300">{p.label}</span>
        <span
          className={`rounded px-1.5 py-0.5 font-mono text-[8px] font-semibold uppercase ${
            p.found ? "bg-bull/15 text-bull" : "bg-white/5 text-slate-600"
          }`}
        >
          {p.found ? "found" : "no"}
        </span>
      </div>
      {p.headline && <p className="mt-0.5 text-[10px] leading-relaxed text-slate-400">{p.headline}</p>}
      {/* Every condition, so a near-miss reads as a near-miss rather than as a
          non-event. Two of three is not the pattern. */}
      {p.conditions.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {p.conditions.map((c, i) => (
            <li key={i} className="flex gap-1.5 text-[10px] leading-relaxed">
              <span className={c.met ? "text-bull" : "text-slate-600"}>{c.met ? "✓" : "✗"}</span>
              <span className="text-slate-500">
                <span className={c.met ? "text-slate-400" : ""}>{c.label}</span> — {c.detail}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1 text-[10px] leading-relaxed text-slate-600">{p.note}</p>
    </div>
  );
}

function Stat({ label, value, tone = "" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded bg-white/[0.03] px-1.5 py-1">
      <div className="text-[8px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={tone || "text-slate-200"}>{value}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="p-4 text-center text-xs leading-relaxed text-slate-500">{children}</p>;
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

function fullStamp(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()} (your local time)`;
}

function trim(v: number): string {
  return v.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function fmt(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${abs.toFixed(abs < 10 ? 2 : 0)}`;
}
