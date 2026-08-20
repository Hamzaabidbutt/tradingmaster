"use client";

import { FullAnalysis } from "@/engines/types";
import { GlassCard, BiasBadge, timeAgo } from "@/components/ui/primitives";

/**
 * Range trading — but only when there is actually a range.
 *
 * The validation gates are rendered whether they pass or fail, because a
 * rejected range is the most useful output this module produces: it is what
 * stops you buying a "range low" that is really just the last step of a
 * downtrend. When a decisive close has broken the structure the panel says
 * so explicitly and withdraws the mean-reversion setup.
 */
export default function RangeTradingPanel({
  analysis,
  pricePrecision,
}: {
  analysis: FullAnalysis | null;
  pricePrecision: number;
}) {
  const rt = analysis?.rangeTrading;
  const p = (v: number) => v.toFixed(pricePrecision);
  const price = analysis?.price ?? 0;

  const setupTone =
    rt?.rangeSetup === "Long"
      ? "text-bull"
      : rt?.rangeSetup === "Short"
        ? "text-bear"
        : rt?.rangeSetup === "Breakout"
          ? "text-neon-amber"
          : "text-slate-400";

  const hasRange = !!rt && rt.rangeHigh !== null && rt.rangeLow !== null;
  // Where price sits between the boundaries, for the visual rail.
  const pos =
    hasRange && rt.rangeHigh !== rt.rangeLow
      ? Math.max(0, Math.min(100, ((price - rt.rangeLow!) / (rt.rangeHigh! - rt.rangeLow!)) * 100))
      : 50;

  return (
    <GlassCard
      title={
        <span className="flex items-center gap-2">
          Range Trading
          {rt && (
            <span
              className={`rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
                rt.marketCondition === "Ranging"
                  ? "border-neon-cyan/30 text-neon-cyan"
                  : rt.marketCondition === "Trending"
                    ? "border-neon-amber/40 text-neon-amber"
                    : "border-slate-500/30 text-slate-400"
              }`}
            >
              {rt.marketCondition}
            </span>
          )}
          {rt && rt.rangeSetup !== "No Trade" && (
            <span className={`font-mono text-[10px] font-bold uppercase ${setupTone}`}>{rt.rangeSetup}</span>
          )}
        </span>
      }
      className="h-full"
    >
      {!rt ? (
        <div className="p-4 text-xs text-slate-500">Looking for range structure…</div>
      ) : (
        <div className="flex h-full flex-col">
          {/* ---- Range map ---- */}
          <div
            className={`border-b border-white/5 px-3 py-2.5 ${
              rt.rangeSetup === "Long"
                ? "bg-bull/5"
                : rt.rangeSetup === "Short"
                  ? "bg-bear/5"
                  : rt.rangeSetup === "Breakout"
                    ? "bg-neon-amber/5"
                    : "bg-white/[0.02]"
            }`}
          >
            {!hasRange ? (
              <p className="text-[11px] leading-relaxed text-slate-400">
                No range candidate held up to the evidence gates — see below for which ones failed.
              </p>
            ) : (
              <>
                <div className="mb-1.5 flex items-baseline justify-between gap-2">
                  <span className="text-[10px] uppercase tracking-[0.14em] text-slate-500">
                    {rt.currentPosition} · {rt.rangeBars} bars
                  </span>
                  <span className="font-mono text-[9px] text-slate-500">
                    width {rt.rangeWidthPct === null ? "—" : `${rt.rangeWidthPct.toFixed(2)}%`}
                  </span>
                </div>

                {/* Vertical-ish rail: high at top, low at bottom, price marker */}
                <div className="space-y-1">
                  <Boundary
                    label="Range High"
                    value={p(rt.rangeHigh!)}
                    touches={rt.highTouches}
                    tone="bear"
                    active={rt.currentPosition === "Near High"}
                  />
                  <div className="relative h-6">
                    <div className="absolute inset-x-0 top-1/2 h-px bg-white/10" />
                    <div className="absolute inset-x-0 top-1/2 flex -translate-y-1/2 justify-center">
                      <span className="rounded bg-base-850 px-1.5 font-mono text-[9px] text-slate-500">
                        mid {rt.rangeMidpoint === null ? "—" : p(rt.rangeMidpoint)}
                      </span>
                    </div>
                    <div
                      className="absolute top-1/2 h-2.5 w-2.5 -translate-y-1/2 -translate-x-1/2 rotate-45 border border-neon-cyan bg-neon-cyan/40"
                      style={{ left: `${pos}%` }}
                      title={`price ${p(price)}`}
                    />
                  </div>
                  <Boundary
                    label="Range Low"
                    value={p(rt.rangeLow!)}
                    touches={rt.lowTouches}
                    tone="bull"
                    active={rt.currentPosition === "Near Low"}
                  />
                </div>

                <div className="mt-2 flex items-center justify-between gap-2">
                  <BiasBadge bias={rt.bias} />
                  <span className="font-mono text-[10px] text-slate-400">
                    <span
                      className={`font-bold ${
                        rt.confidence >= 65 ? "text-bull" : rt.confidence >= 45 ? "text-neon-amber" : "text-slate-400"
                      }`}
                    >
                      {rt.confidence}%
                    </span>{" "}
                    {rt.confidenceLabel}
                  </span>
                </div>
              </>
            )}
          </div>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
            {/* ---- The setup ---- */}
            <Section title="Range setup" hint={rt.rangeSetup === "No Trade" ? "nothing worth taking" : "levels to work with"}>
              <div className="mb-1.5 flex items-center justify-between rounded-lg bg-white/[0.03] px-2.5 py-2">
                <span className="text-[10px] uppercase tracking-wider text-slate-500">Setup</span>
                <span className={`font-mono text-[11px] font-bold uppercase ${setupTone}`}>{rt.rangeSetup}</span>
              </div>
              <div className="grid grid-cols-2 gap-1 font-mono text-[9px] sm:grid-cols-4">
                <Mini label="Entry" value={rt.potentialEntry === null ? "—" : p(rt.potentialEntry)} tone="slate" />
                <Mini
                  label="Target 1 (mid)"
                  value={rt.target1 === null ? "—" : p(rt.target1)}
                  tone={rt.bias === "bearish" ? "bear" : "bull"}
                />
                <Mini
                  label="Target 2"
                  value={rt.target2 === null ? "—" : p(rt.target2)}
                  tone={rt.bias === "bearish" ? "bear" : "bull"}
                />
                <Mini label="Invalidation" value={rt.invalidation === null ? "—" : p(rt.invalidation)} tone="amber" />
              </div>
              <div className="mt-1.5 grid grid-cols-3 gap-1 font-mono text-[9px]">
                <Mini
                  label="High tests"
                  value={String(rt.highTouches)}
                  tone={rt.highTouches >= 2 ? "bull" : "slate"}
                />
                <Mini label="Low tests" value={String(rt.lowTouches)} tone={rt.lowTouches >= 2 ? "bull" : "slate"} />
                <Mini
                  label="Contained"
                  value={`${(rt.containment * 100).toFixed(0)}%`}
                  tone={rt.containment >= 0.75 ? "bull" : "bear"}
                />
              </div>
            </Section>

            {/* ---- Breakout state ---- */}
            {rt.breakout.stage !== "none" && (
              <Section title="Breakout state" hint="is the range ending?">
                <div
                  className={`rounded-lg border p-2 ${
                    rt.breakout.stage === "false_breakout"
                      ? "border-bear/25 bg-bear/[0.04]"
                      : rt.breakout.stage === "confirmed"
                        ? "border-neon-amber/30 bg-neon-amber/[0.05]"
                        : "border-white/10 bg-white/[0.02]"
                  }`}
                >
                  <div className="flex items-center justify-between font-mono text-[10px]">
                    <span
                      className={`font-bold uppercase ${
                        rt.breakout.stage === "false_breakout"
                          ? "text-bear"
                          : rt.breakout.stage === "confirmed"
                            ? "text-neon-amber"
                            : "text-slate-300"
                      }`}
                    >
                      {rt.breakout.stage.replace("_", " ")}
                      {rt.breakout.direction && (rt.breakout.direction === "up" ? " ▲" : " ▼")}
                    </span>
                    <span className="text-slate-500">{rt.breakout.active ? "active" : "resolved"}</span>
                  </div>
                  <p className="mt-1 text-[10px] leading-relaxed text-slate-400">{rt.breakout.note}</p>
                </div>
              </Section>
            )}

            {/* ---- Validation gates ---- */}
            <Section
              title="Range validation"
              hint={`${rt.validation.filter((v) => v.passed).length}/${rt.validation.length} gates passed`}
            >
              <div className="space-y-1">
                {rt.validation.map((v, i) => (
                  <div key={i} className="flex gap-1.5 rounded-md bg-white/[0.03] px-2 py-1.5">
                    <span
                      className={`shrink-0 font-mono text-[10px] font-bold ${v.passed ? "text-bull" : "text-bear"}`}
                    >
                      {v.passed ? "✓" : "✗"}
                    </span>
                    <div className="min-w-0">
                      <div className={`text-[10px] font-semibold ${v.passed ? "text-slate-300" : "text-slate-500"}`}>
                        {v.label}
                      </div>
                      <div className="text-[10px] leading-relaxed text-slate-500">{v.detail}</div>
                    </div>
                  </div>
                ))}
              </div>
              <p className="mt-1.5 text-[9px] leading-relaxed text-slate-600">
                A horizontal shape is not a range until price has repeatedly respected both boundaries. Every gate here
                must hold before a mean-reversion setup is offered.
              </p>
            </Section>

            {/* ---- Boundary reactions ---- */}
            {rt.boundaryReactions.length > 0 && (
              <Section title="Boundary reactions" hint="how price behaved at the edges">
                <div className="space-y-1">
                  {rt.boundaryReactions.slice(-6).reverse().map((b, i) => (
                    <div key={i} className="rounded-md bg-white/[0.03] px-2 py-1.5">
                      <div className="flex items-center justify-between font-mono text-[10px]">
                        <span
                          className={`font-semibold ${
                            b.kind === "decisive_close_outside"
                              ? "text-neon-amber"
                              : b.boundary === "high"
                                ? "text-bear"
                                : "text-bull"
                          }`}
                        >
                          {b.boundary === "high" ? "▲ high" : "▼ low"} · {b.kind.replace(/_/g, " ")}
                        </span>
                        <span className="text-slate-500">
                          {p(b.price)} · {timeAgo(b.time)}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[10px] leading-relaxed text-slate-400">{b.note}</p>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* ---- Reason ---- */}
            <Section title="Reason" hint="the read in words">
              <div className="space-y-1">
                {rt.reason.map((r, i) => (
                  <p
                    key={i}
                    className={`text-[10px] leading-relaxed ${i === 0 ? `font-semibold ${setupTone}` : "text-slate-400"}`}
                  >
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

function Boundary({
  label,
  value,
  touches,
  tone,
  active,
}: {
  label: string;
  value: string;
  touches: number;
  tone: "bull" | "bear";
  active: boolean;
}) {
  const color = tone === "bull" ? "text-bull" : "text-bear";
  const border = tone === "bull" ? "border-bull/30" : "border-bear/30";
  return (
    <div
      className={`flex items-center justify-between rounded border px-2 py-1 ${border} ${
        active ? (tone === "bull" ? "bg-bull/10" : "bg-bear/10") : "bg-white/[0.02]"
      }`}
    >
      <span className="text-[9px] uppercase tracking-wider text-slate-500">
        {label}
        {active && <span className={`ml-1 font-bold ${color}`}>← price here</span>}
      </span>
      <span className={`font-mono text-[11px] font-bold ${color}`}>
        {value}
        <span className="ml-1.5 font-normal text-slate-500">{touches}×</span>
      </span>
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
