"use client";

import { ConfluenceBadge, SideBadge, basesLabel, fmtPct, fmtPrice, fmtVolume, gateReason, useOpenInTerminal } from "./shared";
import type { ScanEntryDto } from "@/hooks/useDashboard";

/**
 * One setup, rendered in the requested format:
 *
 *   BTC/USDT — LONG · Confidence 91% · Entry / SL / Target
 *   Supporting Analysis
 *     • Chart Analyst — …
 *     • Candle Close Expansion — …
 *   Overall Confluence: Strong
 *
 * Two rules this component exists to hold:
 *
 *  * **Abstentions are shown, not hidden.** An analyst that declined to vote is
 *    listed with its gate text. A card that only showed supporters would make
 *    a 1-of-3 setup look like a 3-of-3 one.
 *  * **Disagreement is rendered.** When the opposing case had a qualified
 *    analyst, the note and the points deducted are printed on the card. A
 *    confidence number that quietly absorbed a penalty tells you less than a
 *    lower number that says why.
 */
export default function SetupCard({
  entry,
  rank,
  compact = false,
}: {
  entry: ScanEntryDto;
  rank?: number;
  compact?: boolean;
}) {
  const open = useOpenInTerminal();
  const { setup } = entry;
  const side = setup.decision === "SHORT" ? "SHORT" : "LONG";
  const supporters = side === "LONG" ? setup.long.supporters : setup.short.supporters;
  const abstained = setup.verdicts.filter((v) => !v.qualified);
  const opposed = setup.verdicts.filter(
    (v) => v.qualified && v.direction !== (side === "LONG" ? "long" : "short")
  );
  const isLong = side === "LONG";

  return (
    <article
      className={`rounded-xl border bg-white/[0.02] transition-colors hover:bg-white/[0.045] ${
        isLong ? "border-bull/20" : "border-bear/20"
      }`}
    >
      <button
        onClick={() => open(entry.symbol, entry.timeframe)}
        className="w-full px-3 py-2.5 text-left"
        aria-label={`Open ${entry.label} in the terminal`}
      >
        <header className="flex flex-wrap items-center gap-2">
          {rank !== undefined && (
            <span className="font-mono text-[10px] text-slate-600">#{rank}</span>
          )}
          <span className="text-sm font-bold text-slate-100">{entry.label}</span>
          <SideBadge side={side} />
          <span
            className={`font-mono text-sm font-bold ${isLong ? "text-bull" : "text-bear"}`}
            title="Confluence confidence"
          >
            {setup.confidence.toFixed(0)}%
          </span>
          <span className="text-[10px] uppercase tracking-wider text-slate-500">
            {setup.confidenceLabel}
          </span>
          <span className="ml-auto flex items-center gap-2 font-mono text-[10px] text-slate-600">
            <span>{entry.timeframe}</span>
            <span>{fmtVolume(entry.quoteVolume)}</span>
            <span
              className={
                entry.priceChangePercent === null
                  ? "text-slate-600"
                  : entry.priceChangePercent >= 0
                    ? "text-bull/70"
                    : "text-bear/70"
              }
            >
              {fmtPct(entry.priceChangePercent)}
            </span>
          </span>
        </header>

        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px] sm:grid-cols-5">
          <Level label="Entry" value={setup.entry} />
          <Level label="Stop" value={setup.stopLoss} tone="bear" />
          <Level label="Target 1" value={setup.target1} tone="bull" />
          <Level label="Target 2" value={setup.target2} tone="bull" />
          <Level label="R:R" value={setup.riskReward} raw />
        </div>
      </button>

      {!compact && (
        <div className="space-y-2 border-t border-white/5 px-3 py-2.5">
          <h5 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            Supporting Analysis
          </h5>
          <ul className="space-y-1.5">
            {supporters.map((v) => (
              <li key={v.analyst} className="flex gap-2 text-[11px] leading-relaxed">
                <span className={isLong ? "text-bull" : "text-bear"}>✓</span>
                <span className="text-slate-400">
                  <span className="font-semibold text-slate-300">{v.name}</span>{" "}
                  <span className="text-slate-600">({v.confidence.toFixed(0)}%)</span> — {v.evidence}
                </span>
              </li>
            ))}
            {opposed.map((v) => (
              <li key={`opp-${v.analyst}`} className="flex gap-2 text-[11px] leading-relaxed">
                <span className="text-neon-amber">✕</span>
                <span className="text-slate-400">
                  <span className="font-semibold text-neon-amber">{v.name}</span> argues{" "}
                  {v.direction} — {v.evidence}
                </span>
              </li>
            ))}
            {abstained.map((v) => (
              <li key={`abs-${v.analyst}`} className="flex gap-2 text-[11px] leading-relaxed">
                <span className="text-slate-600">–</span>
                <span className="text-slate-600">
                  <span className="font-semibold">{v.name}</span> abstained — {gateReason(v.gate)}
                </span>
              </li>
            ))}
          </ul>

          {setup.disagreement.present && (
            <p className="rounded-lg border border-neon-amber/25 bg-neon-amber/[0.06] px-2.5 py-1.5 text-[11px] leading-relaxed text-neon-amber/90">
              Disagreement — {setup.disagreement.note} Confidence reduced by{" "}
              {setup.disagreement.penaltyApplied.toFixed(1)} points.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t border-white/5 pt-2">
            <ConfluenceBadge verdict={setup.confluenceVerdict} />
            <span className="font-mono text-[10px] text-slate-600">
              {basesLabel((isLong ? setup.long : setup.short).independentBases)} · ×
              {(isLong ? setup.long : setup.short).independenceMultiplier.toFixed(2)} independence
            </span>
            <span className="ml-auto font-mono text-[10px] text-slate-600">
              L {setup.long.confidence.toFixed(0)} / S {setup.short.confidence.toFixed(0)}
            </span>
          </div>

          {setup.explanation.length > 0 && (
            <details className="group">
              <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-slate-500 hover:text-neon-cyan">
                Why this signal ▾
              </summary>
              <ul className="mt-1.5 space-y-1">
                {setup.explanation.map((line, i) => (
                  <li key={i} className="flex gap-2 text-[11px] leading-relaxed text-slate-400">
                    <span className="text-neon-cyan">›</span>
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
              {setup.invalidation.length > 0 && (
                <ul className="mt-1.5 space-y-1">
                  {setup.invalidation.map((line, i) => (
                    <li key={i} className="flex gap-2 text-[11px] leading-relaxed text-bear/80">
                      <span>✕</span>
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
              )}
            </details>
          )}
        </div>
      )}
    </article>
  );
}

function Level({
  label,
  value,
  tone,
  raw = false,
}: {
  label: string;
  value: number | null;
  tone?: "bull" | "bear";
  raw?: boolean;
}) {
  const color = tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : "text-slate-200";
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wider text-slate-600">{label}</div>
      <div className={color}>{value === null ? "—" : raw ? value.toFixed(2) : fmtPrice(value)}</div>
    </div>
  );
}
