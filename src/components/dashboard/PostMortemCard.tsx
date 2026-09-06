"use client";

import { useEffect, useState } from "react";
import type { Finding, PostMortemReport, Slice } from "@/engines/postMortem";
import { GlassCard } from "@/components/ui/primitives";

/**
 * The post-mortem: what separates the winners from the losers, and what to
 * change because of it.
 *
 * Laid out in the order the questions matter. Findings first, because those
 * are the only part with an action attached. Then the two studies that decide
 * how much of the loss column is bad reads versus bad geometry — stop
 * placement and target reachability. Then the raw slices, then what cannot be
 * answered yet.
 *
 * That last section is not filler. On a young record it will be most of the
 * page, and saying so is the difference between a tool that reports what it
 * knows and one that manufactures conclusions to fill space.
 */
export default function PostMortemCard() {
  const [data, setData] = useState<(PostMortemReport & { error?: string }) | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let stop = false;
    fetch("/api/signals/postmortem", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (!stop) setData(j);
      })
      .catch(() => {})
      .finally(() => {
        if (!stop) setLoading(false);
      });
    return () => {
      stop = true;
    };
  }, []);

  return (
    <GlassCard
      title="Signal Post-Mortem"
      action={
        data ? (
          <span className="font-mono text-[10px] text-slate-500">
            {data.decided} decided · {data.totalClosed} closed
          </span>
        ) : null
      }
      className="h-full"
    >
      <div className="h-full overflow-y-auto p-3">
        {loading && !data ? (
          <p className="p-4 text-center text-xs text-slate-500">Reading the record…</p>
        ) : !data ? (
          <p className="p-4 text-center text-xs text-slate-500">The record is unavailable.</p>
        ) : (
          <div className="space-y-3">
            {data.error && (
              <p className="rounded border border-bear/25 bg-bear/5 p-2 text-[10px] text-bear/80">
                {data.error}
              </p>
            )}

            <Headline s={data.overall} />

            {data.findings.length > 0 && (
              <Section title="What the record actually shows">
                <ul className="space-y-2">
                  {data.findings.map((f, i) => (
                    <FindingRow key={i} f={f} />
                  ))}
                </ul>
              </Section>
            )}

            <Section title="Are the stops in the right place?">
              <Study
                headline={
                  data.stops.samples > 0
                    ? `${data.stops.samples} winners · median drawdown ${data.stops.medianAdverseR ?? "—"}R · worst tenth ${data.stops.p90AdverseR ?? "—"}R`
                    : "No winners with excursion data yet"
                }
                verdict={data.stops.verdict}
              />
            </Section>

            <Section title="Are the targets reachable?">
              <Study
                headline={
                  data.targets.samples > 0
                    ? `${data.targets.samples} losers · median ${data.targets.medianProgressPct ?? "—"}% of the way to TP1 · ${data.targets.nearMissPct ?? "—"}% got past 80%`
                    : "No losers with progress data yet"
                }
                verdict={data.targets.verdict}
              />
            </Section>

            {data.failureReasons.length > 0 && (
              <Section title="How the losses actually failed">
                <ul className="space-y-[2px]">
                  {data.failureReasons.map((f) => (
                    <li
                      key={f.reason}
                      className="flex items-center gap-2 font-mono text-[10px] text-slate-400"
                    >
                      <span className="w-40 shrink-0 truncate">{f.reason.replace(/_/g, " ")}</span>
                      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/5">
                        <span
                          className="block h-full rounded-full bg-bear/60"
                          style={{ width: `${f.sharePct}%` }}
                        />
                      </span>
                      <span className="w-20 shrink-0 whitespace-nowrap text-right text-slate-500">
                        {f.count} · {f.sharePct}%
                      </span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            <Section title="Taken against shadow">
              <SliceRow s={data.taken} />
              <SliceRow s={data.shadow} muted />
              <p className="mt-1 text-[9px] leading-relaxed text-slate-600">
                Shadow signals were produced but never taken because a slot was occupied. If they
                perform as well as taken ones, the slot allocator is adding arbitrariness; if they
                do better, the engine is systematically taking the worse trade of each cluster.
              </p>
            </Section>

            {[
              ["By confidence", data.byConfidence],
              ["By source", data.bySource],
              ["By BTC regime", data.byRegime],
              ["By timeframe", data.byTimeframe],
              ["By exit path", data.byExitReason],
            ].map(([title, slices]) =>
              (slices as Slice[]).length > 0 ? (
                <Section key={title as string} title={title as string}>
                  {(slices as Slice[]).map((s) => (
                    <SliceRow key={s.key} s={s} />
                  ))}
                </Section>
              ) : null
            )}

            {data.openQuestions.length > 0 && (
              <Section title="What cannot be answered yet">
                <ul className="space-y-1.5">
                  {data.openQuestions.map((q, i) => (
                    <li key={i} className="text-[10px] leading-relaxed text-slate-400">
                      {q}
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            <p className="text-[9px] leading-relaxed text-slate-600">{data.note}</p>
          </div>
        )}
      </div>
    </GlassCard>
  );
}

function Headline({ s }: { s: Slice }) {
  return (
    <div className="grid grid-cols-4 gap-1.5">
      <Tile label="Win rate" value={s.winRatePct == null ? "—" : `${s.winRatePct}%`} tone="cyan" />
      <Tile
        label="Expectancy"
        value={s.expectancyR == null ? "—" : `${s.expectancyR >= 0 ? "+" : ""}${s.expectancyR}R`}
        tone={s.expectancyR == null ? "muted" : s.expectancyR >= 0 ? "bull" : "bear"}
      />
      <Tile label="Avg win" value={s.avgWinR == null ? "—" : `+${s.avgWinR}R`} tone="bull" />
      <Tile label="Avg loss" value={s.avgLossR == null ? "—" : `${s.avgLossR}R`} tone="bear" />
    </div>
  );
}

function Tile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "bull" | "bear" | "cyan" | "muted";
}) {
  const colour =
    tone === "bull"
      ? "text-bull"
      : tone === "bear"
        ? "text-bear"
        : tone === "cyan"
          ? "text-neon-cyan"
          : "text-slate-500";
  return (
    <div className="rounded-lg border border-white/5 bg-white/[0.02] px-2 py-1.5">
      <div className="text-[8px] uppercase tracking-[0.12em] text-slate-500">{label}</div>
      <div className={`font-mono text-sm font-bold ${colour}`}>{value}</div>
    </div>
  );
}

function FindingRow({ f }: { f: Finding }) {
  return (
    <li className="rounded-lg border border-neon-cyan/20 bg-neon-cyan/[0.04] p-2.5">
      <div className="flex items-baseline gap-2">
        <span className="rounded bg-white/5 px-1.5 py-0.5 text-[8px] uppercase tracking-wider text-slate-400">
          {f.dimension}
        </span>
        <span className="text-[11px] font-semibold text-slate-200">{f.headline}</span>
      </div>
      <p className="mt-1 text-[10px] leading-relaxed text-slate-400">{f.detail}</p>
      <p className="mt-1 text-[10px] leading-relaxed text-neon-cyan">→ {f.recommendation}</p>
    </li>
  );
}

function Study({ headline, verdict }: { headline: string; verdict: string }) {
  return (
    <div className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
      <div className="font-mono text-[10px] text-slate-300">{headline}</div>
      <p className="mt-1 text-[10px] leading-relaxed text-slate-400">{verdict}</p>
    </div>
  );
}

function SliceRow({ s, muted }: { s: Slice; muted?: boolean }) {
  return (
    <div
      className={`flex flex-wrap items-baseline gap-x-2 px-1 py-[3px] font-mono text-[10px] ${muted ? "opacity-70" : ""}`}
      title={`${s.wins} won, ${s.losses} lost, ${s.breakEvens} break-even`}
    >
      <span className="min-w-[150px] text-slate-400">{s.label}</span>
      {s.winRatePct == null ? (
        <span className="text-slate-600">rate withheld ({s.decided} decided)</span>
      ) : (
        <>
          <span className="text-neon-cyan">{s.winRatePct}%</span>
          <span className="text-slate-600">of {s.decided}</span>
        </>
      )}
      {s.expectancyR != null && (
        <span className={s.expectancyR >= 0 ? "text-bull" : "text-bear"}>
          {s.expectancyR >= 0 ? "+" : ""}
          {s.expectancyR}R
        </span>
      )}
      {s.breakEvens > 0 && <span className="text-neon-amber">{s.breakEvens} BE</span>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[8px] uppercase tracking-[0.14em] text-slate-600">{title}</div>
      {children}
    </div>
  );
}
