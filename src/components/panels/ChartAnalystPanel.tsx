"use client";

import { useState } from "react";
import { FullAnalysis, ChartShape, HistoricalAnalogue } from "@/engines/types";
import { GlassCard, ProbabilityBar } from "@/components/ui/primitives";

/**
 * The chart read on its own terms.
 *
 * This panel deliberately shows nothing but what the chart itself says:
 * candlestick formations, geometric shapes, price action, and what happened
 * the last time the chart looked like this. No indicators, no order book, no
 * funding — the engine behind it is handed candles and nothing else, so
 * everything here is derived from shape alone. Read it as a second opinion
 * that cannot have been contaminated by the other panels.
 */
export default function ChartAnalystPanel({
  analysis,
  pricePrecision,
}: {
  analysis: FullAnalysis | null;
  pricePrecision: number;
}) {
  const ca = analysis?.chartAnalyst;
  const [openMatch, setOpenMatch] = useState<number | null>(null);

  const p = (v: number) => v.toFixed(pricePrecision);
  const dir = ca?.expectedNextMove.direction ?? "neutral";
  const dirColor = dir === "bullish" ? "text-bull" : dir === "bearish" ? "text-bear" : "text-slate-300";

  return (
    <GlassCard
      title={
        <span className="flex items-center gap-2">
          Chart Analyst
          <span
            className="rounded-full border border-neon-cyan/25 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-neon-cyan/80"
            title="Price action and pattern recognition only — no indicators, order book, liquidity, funding or news"
          >
            chart only
          </span>
          {ca && ca.confidence > 0 && (
            <span
              className={`rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
                dir === "bullish"
                  ? "border-bull/30 text-bull"
                  : dir === "bearish"
                    ? "border-bear/30 text-bear"
                    : "border-slate-500/30 text-slate-400"
              }`}
            >
              {ca.confidence}% · {ca.confidenceLabel}
            </span>
          )}
        </span>
      }
      className="h-full"
    >
      {!ca ? (
        <div className="p-4 text-xs text-slate-500">Reading the chart…</div>
      ) : (
        <div className="flex h-full flex-col">
          {/* ---- Expected next move ---- */}
          <div
            className={`border-b border-white/5 px-3 py-2.5 ${
              dir === "bullish" ? "bg-bull/5" : dir === "bearish" ? "bg-bear/5" : "bg-white/[0.02]"
            }`}
          >
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <span className="text-[10px] uppercase tracking-[0.14em] text-slate-500">Expected next move</span>
              <span className="font-mono text-[9px] text-slate-500">
                {ca.windowBars} bar shape · {ca.historyBars} bars searched
              </span>
            </div>

            <p className={`text-[11px] font-semibold leading-relaxed ${dirColor}`}>
              {dir === "bullish" ? "▲ " : dir === "bearish" ? "▼ " : "◆ "}
              {ca.currentPattern.headline}
            </p>

            <div className="mt-2 grid grid-cols-3 gap-1.5 font-mono text-[10px]">
              <Mini
                label="Median move"
                value={`${ca.expectedNextMove.magnitudePct >= 0 ? "+" : ""}${ca.expectedNextMove.magnitudePct.toFixed(2)}%`}
                tone={ca.expectedNextMove.magnitudePct >= 0 ? "bull" : "bear"}
              />
              <Mini
                label="Target"
                value={ca.expectedNextMove.target === null ? "—" : p(ca.expectedNextMove.target)}
                tone={ca.expectedNextMove.target === null ? "slate" : dir === "bearish" ? "bear" : "bull"}
              />
              <Mini
                label="Invalidation"
                value={ca.expectedNextMove.invalidation === null ? "—" : p(ca.expectedNextMove.invalidation)}
                tone="slate"
              />
            </div>
            <p className="mt-1.5 text-[9px] text-slate-600">
              Projected over the next {ca.expectedNextMove.horizonBars} bars — the median outcome of the closest
              historical analogues, not a promise.
            </p>
          </div>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
            {/* ---- Current pattern ---- */}
            <Section title="Current pattern" hint="what the chart is drawing right now">
              {ca.currentPattern.shapes.length === 0 ? (
                <p className="text-[10px] leading-relaxed text-slate-500">
                  No clean geometric formation over the last {ca.windowBars} bars — the structure is too irregular to
                  name a shape, which is itself information: there is no pattern to trade here.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {ca.currentPattern.shapes.map((s, i) => (
                    <ShapeRow key={i} shape={s} p={p} lead={i === 0} />
                  ))}
                </div>
              )}

              {ca.currentPattern.candlestick.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {ca.currentPattern.candlestick.slice(-6).reverse().map((c, i) => (
                    <span
                      key={i}
                      title={c.context}
                      className={`rounded border px-1.5 py-0.5 font-mono text-[9px] font-semibold ${
                        c.direction === "bullish"
                          ? "border-bull/25 bg-bull/[0.06] text-bull"
                          : c.direction === "bearish"
                            ? "border-bear/25 bg-bear/[0.06] text-bear"
                            : "border-slate-500/25 bg-white/[0.03] text-slate-400"
                      }`}
                    >
                      {c.name} {c.strength}
                    </span>
                  ))}
                </div>
              )}

              {ca.currentPattern.priceAction.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {ca.currentPattern.priceAction.map((t, i) => (
                    <li key={i} className="flex gap-1.5 text-[10px] leading-relaxed text-slate-400">
                      <span className="text-neon-cyan">›</span>
                      {t}
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            {/* ---- Historical match ---- */}
            <Section
              title="Historical match"
              hint={
                ca.historicalMatches.length > 0
                  ? `${ca.historicalMatches.length} closest analogues`
                  : "no precedent found"
              }
            >
              {ca.historicalMatches.length === 0 ? (
                <p className="text-[10px] leading-relaxed text-slate-500">
                  Nothing in the searched history resembles the current shape closely enough to count as a precedent.
                  Without analogues there is no historical read, so treat the expected move as unsupported.
                </p>
              ) : (
                <div className="space-y-1">
                  {ca.historicalMatches.map((m, i) => (
                    <MatchRow
                      key={m.startIndex}
                      m={m}
                      open={openMatch === m.startIndex}
                      onToggle={() => setOpenMatch(openMatch === m.startIndex ? null : m.startIndex)}
                      rank={i + 1}
                    />
                  ))}
                </div>
              )}
            </Section>

            {/* ---- Scenarios ---- */}
            <Section title="Scenarios" hint="both sides, with the odds the analogues imply">
              <ProbabilityBar bullish={ca.bullishScenario.probability} />
              <div className="mt-2 space-y-1.5">
                <ScenarioCard
                  tone="bull"
                  title="Bullish scenario"
                  trigger={ca.bullishScenario.trigger}
                  target={p(ca.bullishScenario.target)}
                  probability={ca.bullishScenario.probability}
                  note={ca.bullishScenario.note}
                />
                <ScenarioCard
                  tone="bear"
                  title="Bearish scenario"
                  trigger={ca.bearishScenario.trigger}
                  target={p(ca.bearishScenario.target)}
                  probability={ca.bearishScenario.probability}
                  note={ca.bearishScenario.note}
                />
              </div>
            </Section>

            {/* ---- Confidence ---- */}
            <Section title="Confidence level" hint="how closely the present matches the past">
              <div className="rounded-lg bg-white/[0.03] px-2.5 py-2">
                <div className="flex items-baseline justify-between">
                  <span className={`font-mono text-lg font-bold ${dirColor}`}>{ca.confidence}%</span>
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                    {ca.confidenceLabel}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-white/5">
                  <div
                    className={`h-full rounded-full transition-all duration-700 ${
                      dir === "bullish" ? "bg-bull" : dir === "bearish" ? "bg-bear" : "bg-slate-500"
                    }`}
                    style={{ width: `${ca.confidence}%` }}
                  />
                </div>
                {ca.expectedNextMove.rationale.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {ca.expectedNextMove.rationale.map((r, i) => (
                      <li key={i} className="text-[10px] leading-relaxed text-slate-400">
                        • {r}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Section>

            {/* ---- Pattern explanation ---- */}
            <Section title="Pattern explanation" hint="why this shape means what it means">
              <div className="space-y-1.5">
                {ca.patternExplanation.map((t, i) => (
                  <p key={i} className="text-[10px] leading-relaxed text-slate-400">
                    {t}
                  </p>
                ))}
              </div>
            </Section>
          </div>
        </div>
      )}
    </GlassCard>
  );
}

function ShapeRow({ shape, p, lead }: { shape: ChartShape; p: (v: number) => string; lead: boolean }) {
  const color =
    shape.direction === "bullish" ? "text-bull" : shape.direction === "bearish" ? "text-bear" : "text-slate-300";
  const border =
    shape.direction === "bullish"
      ? "border-bull/25 bg-bull/[0.04]"
      : shape.direction === "bearish"
        ? "border-bear/25 bg-bear/[0.04]"
        : "border-white/10 bg-white/[0.02]";
  return (
    <div className={`rounded-lg border p-2 ${border}`}>
      <div className="flex items-center justify-between gap-2">
        <span className={`text-[11px] font-bold ${color}`}>
          {lead && <span className="mr-1 text-[9px] text-neon-amber">★</span>}
          {shape.name}
        </span>
        <span className="shrink-0 font-mono text-[9px] text-slate-500">
          {shape.maturity}% formed · str {shape.strength}
        </span>
      </div>
      <div className="mt-1 grid grid-cols-3 gap-1 font-mono text-[9px]">
        <Mini label="Upper" value={p(shape.upperBoundary)} tone="slate" />
        <Mini label="Lower" value={p(shape.lowerBoundary)} tone="slate" />
        <Mini
          label="Measured"
          value={p(shape.measuredTarget)}
          tone={shape.direction === "bearish" ? "bear" : "bull"}
        />
      </div>
      <p className="mt-1 text-[10px] leading-relaxed text-slate-400">{shape.note}</p>
    </div>
  );
}

function MatchRow({
  m,
  open,
  onToggle,
  rank,
}: {
  m: HistoricalAnalogue;
  open: boolean;
  onToggle: () => void;
  rank: number;
}) {
  const color =
    m.forwardDirection === "bullish" ? "text-bull" : m.forwardDirection === "bearish" ? "text-bear" : "text-slate-400";
  return (
    <div className="rounded-lg bg-white/[0.02] transition-colors hover:bg-white/[0.04]">
      <button onClick={onToggle} className="w-full px-2 py-1.5 text-left" aria-expanded={open}>
        <div className="flex items-center gap-2">
          <span className="w-4 shrink-0 text-center font-mono text-[9px] text-slate-600">{rank}</span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/5">
            <div
              className="h-full rounded-full bg-gradient-to-r from-neon-cyan/50 to-neon-cyan"
              style={{ width: `${m.similarity}%` }}
            />
          </div>
          <span className="w-9 shrink-0 text-right font-mono text-[10px] font-semibold text-neon-cyan">
            {m.similarity}%
          </span>
          <span className={`w-14 shrink-0 text-right font-mono text-[10px] font-bold ${color}`}>
            {m.forwardReturnPct >= 0 ? "+" : ""}
            {m.forwardReturnPct.toFixed(2)}%
          </span>
          <span className="w-3 shrink-0 text-center text-[9px] text-slate-600">{open ? "▲" : "▼"}</span>
        </div>
      </button>
      {open && (
        <div className="animate-slide-up border-t border-white/5 px-2 py-2">
          <div className="grid grid-cols-3 gap-1 font-mono text-[9px]">
            <Mini label="Max up" value={`+${m.maxUpPct.toFixed(2)}%`} tone="bull" />
            <Mini label="Max down" value={`${m.maxDownPct.toFixed(2)}%`} tone="bear" />
            <Mini label="Occurred" value={dateOf(m.startTime)} tone="slate" />
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-slate-400">{m.note}</p>
        </div>
      )}
    </div>
  );
}

function ScenarioCard({
  tone,
  title,
  trigger,
  target,
  probability,
  note,
}: {
  tone: "bull" | "bear";
  title: string;
  trigger: string;
  target: string;
  probability: number;
  note: string;
}) {
  return (
    <div
      className={`rounded-lg border p-2 ${
        tone === "bull" ? "border-bull/25 bg-bull/[0.04]" : "border-bear/25 bg-bear/[0.04]"
      }`}
    >
      <div className="flex items-center justify-between">
        <span className={`text-[10px] font-bold uppercase tracking-wider ${tone === "bull" ? "text-bull" : "text-bear"}`}>
          {tone === "bull" ? "▲ " : "▼ "}
          {title}
        </span>
        <span className={`font-mono text-[11px] font-bold ${tone === "bull" ? "text-bull" : "text-bear"}`}>
          {probability}%
        </span>
      </div>
      <div className="mt-1 flex items-baseline justify-between font-mono text-[10px]">
        <span className="text-slate-400">{trigger}</span>
        <span className={tone === "bull" ? "text-bull" : "text-bear"}>→ {target}</span>
      </div>
      <p className="mt-1 text-[10px] leading-relaxed text-slate-400">{note}</p>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="mb-1.5 flex items-baseline gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">{title}</span>
        {hint && <span className="text-[9px] text-slate-600">— {hint}</span>}
      </h4>
      {children}
    </section>
  );
}

function Mini({ label, value, tone }: { label: string; value: string; tone: "bull" | "bear" | "amber" | "slate" }) {
  const color =
    tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : tone === "amber" ? "text-neon-amber" : "text-slate-300";
  return (
    <div className="rounded bg-white/[0.03] px-1.5 py-1">
      <div className="text-[8px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`font-semibold ${color}`}>{value}</div>
    </div>
  );
}

function dateOf(unixSec: number): string {
  if (!unixSec) return "—";
  const d = new Date(unixSec * 1000);
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${String(d.getUTCFullYear()).slice(2)}`;
}
