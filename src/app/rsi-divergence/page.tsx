"use client";

import AppShell from "@/components/layout/AppShell";
import DivergenceScanner from "@/components/divergence/DivergenceScanner";

/**
 * RSI divergence across the universe.
 *
 * Its own page rather than a tab beside CVD, because the two answer different
 * questions and a reader is usually asking one of them. RSI is about how
 * one-sided recent *closes* have been; CVD is about who crossed the spread.
 */
export default function RsiDivergencePage() {
  return (
    <AppShell>
      <div className="space-y-3 p-3 md:p-4">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-lg font-bold tracking-tight text-slate-100">
            RSI <span className="text-neon-cyan">Divergence</span>
          </h1>
          <p className="text-[11px] text-slate-500">
            Price disagreeing with RSI(14), newest first, on your clock.
          </p>
        </header>

        <DivergenceScanner
          source="rsi"
          icon="📉"
          cardTitle="RSI divergence scanner"
          accent="cyan"
          emptyNote="No RSI divergence on any scanned symbol at this timeframe. On a trending session that is the normal answer — RSI agreeing with price is what a healthy trend looks like."
          intro={
            <>
              <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
                RSI is the ratio of average gain to average loss over the lookback — a measure of
                how one-sided recent closes have been. A higher high on lower RSI means the second
                push covered more ground with less conviction behind it. Wilder&apos;s smoothing,
                period 14 by default, so the numbers match what your charting package draws.
              </p>
              <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
                <strong className="text-slate-400">Regular</strong> divergence is the reversal
                reading. <strong className="text-slate-400">Hidden</strong> divergence is the
                opposite shape read the opposite way — a shallower pullback in price than in
                momentum, which is the ordinary form of a trend correction rather than a warning.
                They are labelled separately because merging them would give a list where half the
                rows mean the reverse of the other half.
              </p>
              <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
                Only the last two pivots on each side are compared. Reaching further back for a
                pair that happens to disagree is how a divergence scanner ends up finding one on
                literally every chart — with enough pivots, some pair always diverges.
              </p>
              <p className="mb-2 rounded-lg border border-neon-amber/25 bg-neon-amber/5 px-2 py-1.5 text-[10px] leading-relaxed text-neon-amber">
                RSI divergence is the most over-traded pattern in technical analysis, because it
                looks predictive while being among the least reliable things on a chart. Markets
                make higher highs on falling RSI for weeks, and many divergences end by ceasing to
                diverge rather than by turning. Treat a row as a reason to demand more evidence,
                never as a reason to take the other side.
              </p>
            </>
          }
        />
      </div>
    </AppShell>
  );
}
