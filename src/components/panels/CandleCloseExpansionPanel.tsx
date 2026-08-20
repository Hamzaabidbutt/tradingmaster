"use client";

import { FullAnalysis } from "@/engines/types";
import { GlassCard, timeAgo } from "@/components/ui/primitives";

/**
 * Levels, and whether a candle actually *closed* through one.
 *
 * The whole point of this panel is the distinction the engine enforces: a
 * candle crossing a level is not a breakout. What matters is a decisive
 * close beyond a level that price had been respecting — so the decisiveness
 * checks are shown in full, including the ones that failed, and the level's
 * own false-break history is printed next to the probability it suppresses.
 */
export default function CandleCloseExpansionPanel({
  analysis,
  pricePrecision,
}: {
  analysis: FullAnalysis | null;
  pricePrecision: number;
}) {
  const cce = analysis?.candleCloseExpansion;
  const p = (v: number) => v.toFixed(pricePrecision);

  const probTone =
    cce?.expansionProbability === "High"
      ? "text-neon-amber"
      : cce?.expansionProbability === "Medium"
        ? "text-slate-200"
        : "text-slate-500";
  const dir = cce?.expectedDirection ?? "uncertain";
  const dirColor = dir === "up" ? "text-bull" : dir === "down" ? "text-bear" : "text-slate-300";

  return (
    <GlassCard
      title={
        <span className="flex items-center gap-2">
          Candle Close Expansion
          {cce && (
            <span
              className={`rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
                cce.breakoutDirection === "bullish"
                  ? "border-bull/30 text-bull"
                  : cce.breakoutDirection === "bearish"
                    ? "border-bear/30 text-bear"
                    : "border-slate-500/30 text-slate-400"
              }`}
            >
              {cce.breakoutDirection === "none" ? "no breakout" : `${cce.breakoutDirection} break`}
            </span>
          )}
        </span>
      }
      className="h-full"
    >
      {!cce ? (
        <div className="p-4 text-xs text-slate-500">Watching candle closes…</div>
      ) : !cce.keyLevel ? (
        <div className="p-4 text-xs leading-relaxed text-slate-500">
          No well-established horizontal level near price. Without a level that price has actually been respecting,
          there is nothing for a close to break — so no expansion call is made.
        </div>
      ) : (
        <div className="flex h-full flex-col">
          {/* ---- Verdict header ---- */}
          <div
            className={`border-b border-white/5 px-3 py-2.5 ${
              cce.breakoutDirection === "bullish"
                ? "bg-bull/5"
                : cce.breakoutDirection === "bearish"
                  ? "bg-bear/5"
                  : "bg-white/[0.02]"
            }`}
          >
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <span className="text-[10px] uppercase tracking-[0.14em] text-slate-500">
                Key level · {cce.keyLevel.kind}
              </span>
              <span className="font-mono text-[9px] text-slate-500">
                close {timeAgo(cce.closeTime)}
              </span>
            </div>

            <div className="flex items-baseline gap-2">
              <span className="font-mono text-xl font-bold text-neon-cyan">{p(cce.keyLevel.price)}</span>
              <span
                className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase ${
                  cce.candleClose === "above"
                    ? "bg-bull/10 text-bull"
                    : cce.candleClose === "below"
                      ? "bg-bear/10 text-bear"
                      : "bg-white/5 text-slate-400"
                }`}
              >
                closed {cce.candleClose}
              </span>
              <span className="ml-auto font-mono text-[11px] text-slate-300">{p(cce.closePrice)}</span>
            </div>

            <div className="mt-2 grid grid-cols-3 gap-1.5 font-mono text-[10px]">
              <Mini
                label="Expansion"
                value={`${cce.expansionProbability} · ${cce.expansionScore}`}
                tone={cce.expansionProbability === "High" ? "amber" : "slate"}
              />
              <Mini
                label="Direction"
                value={dir === "up" ? "▲ Up" : dir === "down" ? "▼ Down" : "◆ Uncertain"}
                tone={dir === "up" ? "bull" : dir === "down" ? "bear" : "slate"}
              />
              <Mini
                label="Invalidation"
                value={cce.invalidationLevel === null ? "—" : p(cce.invalidationLevel)}
                tone="slate"
              />
            </div>

            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/5">
              <div
                className={`h-full rounded-full transition-all duration-700 ${
                  cce.expansionProbability === "High"
                    ? "bg-neon-amber"
                    : cce.expansionProbability === "Medium"
                      ? "bg-neon-cyan"
                      : "bg-slate-600"
                }`}
                style={{ width: `${cce.expansionScore}%` }}
              />
            </div>

            <p className={`mt-2 text-[11px] font-semibold leading-relaxed ${dirColor}`}>{cce.summary}</p>
          </div>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
            {/* ---- Level track record ---- */}
            <Section title="Level track record" hint="how much this level has earned its weight">
              <div className="grid grid-cols-3 gap-1.5 font-mono text-[10px]">
                <Mini label="Touches" value={String(cce.keyLevel.touches)} tone="slate" />
                <Mini
                  label="Respected"
                  value={String(cce.keyLevel.respects)}
                  tone={cce.keyLevel.respects >= 3 ? "bull" : "slate"}
                />
                <Mini
                  label="False breaks"
                  value={`${(cce.keyLevel.historicalFalseBreakRate * 100).toFixed(0)}%`}
                  tone={cce.keyLevel.historicalFalseBreakRate > 0.4 ? "bear" : "slate"}
                />
              </div>
              <p className="mt-1.5 text-[10px] leading-relaxed text-slate-400">{cce.keyLevel.note}</p>
            </Section>

            {/* ---- Decisiveness ---- */}
            <Section
              title="Is the close decisive?"
              hint="a crossing is not a breakout"
            >
              <div className="mb-1.5 flex items-center justify-between rounded-lg bg-white/[0.03] px-2.5 py-2">
                <span className="text-[10px] uppercase tracking-wider text-slate-500">Verdict</span>
                <span
                  className={`font-mono text-[11px] font-bold uppercase ${
                    cce.decisiveness.verdict === "decisive"
                      ? "text-bull"
                      : cce.decisiveness.verdict === "marginal"
                        ? "text-neon-amber"
                        : "text-bear"
                  }`}
                >
                  {cce.decisiveness.verdict} · {cce.decisiveness.score}/100
                </span>
              </div>

              <div className="mb-1.5 grid grid-cols-3 gap-1 font-mono text-[9px]">
                <Mini
                  label="Penetration"
                  value={`${cce.decisiveness.penetrationAtr.toFixed(2)} ATR`}
                  tone={cce.decisiveness.penetrationAtr >= 0.5 ? "bull" : "slate"}
                />
                <Mini
                  label="Body"
                  value={`${(cce.decisiveness.bodyRatio * 100).toFixed(0)}%`}
                  tone={cce.decisiveness.bodyRatio >= 0.5 ? "bull" : "slate"}
                />
                <Mini
                  label="Close at"
                  value={`${(cce.decisiveness.closeLocation * 100).toFixed(0)}%`}
                  tone={cce.decisiveness.closeLocation >= 0.7 ? "bull" : "slate"}
                />
                <Mini
                  label="Volume"
                  value={`${cce.decisiveness.volumeMultiple.toFixed(2)}×`}
                  tone={cce.decisiveness.volumeMultiple >= 1.3 ? "amber" : "slate"}
                />
                <Mini
                  label="Follow-through"
                  value={`${cce.decisiveness.followThroughBars} bars`}
                  tone={cce.decisiveness.followThroughBars >= 2 ? "bull" : "slate"}
                />
                <Mini
                  label="Target"
                  value={cce.expansionTarget === null ? "—" : p(cce.expansionTarget)}
                  tone={dir === "down" ? "bear" : "bull"}
                />
              </div>

              <div className="space-y-1">
                {cce.decisiveness.checks.map((c, i) => (
                  <div key={i} className="flex gap-1.5 rounded-md bg-white/[0.03] px-2 py-1.5">
                    <span
                      className={`shrink-0 font-mono text-[10px] font-bold ${c.passed ? "text-bull" : "text-slate-600"}`}
                    >
                      {c.passed ? "✓" : "✗"}
                    </span>
                    <div className="min-w-0">
                      <div
                        className={`text-[10px] font-semibold ${c.passed ? "text-slate-300" : "text-slate-500"}`}
                      >
                        {c.label}
                      </div>
                      <div className="text-[10px] leading-relaxed text-slate-500">{c.detail}</div>
                    </div>
                  </div>
                ))}
              </div>
            </Section>

            {/* ---- Historical precedents ---- */}
            <Section
              title="Previous closes through this level"
              hint={
                cce.historicalPrecedents.length > 0
                  ? `${cce.historicalPrecedents.length} on record`
                  : "no prior breaks"
              }
            >
              {cce.historicalPrecedents.length === 0 ? (
                <p className="text-[10px] leading-relaxed text-slate-500">
                  Price has not closed through this level before in the searched history. An untested level has no
                  false-break record to lean on either way.
                </p>
              ) : (
                <div className="space-y-1">
                  {cce.historicalPrecedents.map((h, i) => (
                    <div
                      key={i}
                      className={`rounded-lg border p-2 ${
                        h.failed
                          ? "border-bear/25 bg-bear/[0.04]"
                          : h.decisive
                            ? "border-bull/25 bg-bull/[0.04]"
                            : "border-white/10 bg-white/[0.02]"
                      }`}
                    >
                      <div className="flex items-center justify-between font-mono text-[10px]">
                        <span className={h.direction === "above" ? "font-bold text-bull" : "font-bold text-bear"}>
                          {h.direction === "above" ? "▲ closed above" : "▼ closed below"}
                          <span className="ml-1 font-normal text-slate-500">
                            {h.decisive ? "· decisive" : "· marginal"}
                          </span>
                        </span>
                        <span className={h.failed ? "text-bear" : "text-slate-400"}>
                          {h.failed ? "FAILED · " : ""}
                          {h.followThroughPct >= 0 ? "+" : ""}
                          {h.followThroughPct.toFixed(2)}%
                        </span>
                      </div>
                      <p className="mt-1 text-[10px] leading-relaxed text-slate-400">{h.note}</p>
                    </div>
                  ))}
                </div>
              )}
            </Section>

            {/* ---- Reason ---- */}
            <Section title="Reason" hint="the read in words">
              <div className="space-y-1">
                {cce.reason.map((r, i) => (
                  <p key={i} className={`text-[10px] leading-relaxed ${i === 0 ? probTone : "text-slate-400"}`}>
                    {i === 0 ? "" : "• "}
                    {r}
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
