"use client";

import AppShell from "@/components/layout/AppShell";
import DivergenceScanner from "@/components/divergence/DivergenceScanner";

/**
 * Cumulative-delta divergence across the universe.
 *
 * Separate from the RSI page because the two are not versions of one another.
 * RSI can only see closes; CVD sees which side actually crossed the spread, so
 * a move can lose momentum without losing aggression, or the reverse.
 */
export default function CvdDivergencePage() {
  return (
    <AppShell>
      <div className="space-y-3 p-3 md:p-4">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-lg font-bold tracking-tight text-slate-100">
            CVD <span className="text-neon-violet">Divergence</span>
          </h1>
          <p className="text-[11px] text-slate-500">
            Price disagreeing with cumulative delta, newest first, on your clock.
          </p>
        </header>

        <DivergenceScanner
          source="cvd"
          icon="🌊"
          cardTitle="Cumulative delta divergence scanner"
          accent="violet"
          emptyNote="No CVD divergence on any scanned symbol at this timeframe. Rarer than an empty RSI sweep, because delta and price part company easily."
          intro={
            <>
              <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
                Cumulative volume delta is the running total of who crossed the spread. When price
                makes a higher high and CVD makes a lower one, the second push was achieved on{" "}
                <em>less net buying</em> than the first — buyers are doing more work for less, and
                someone is selling into it passively. The mirror, a lower low on rising CVD, is
                accumulation.
              </p>
              <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
                This is the same reading the chart&apos;s CVD divergence overlay draws, swept
                across the universe. Delta is reconstructed from each candle&apos;s taker-buy
                split, which is what the exchange publishes — it is a good proxy for aggression and
                not a tick-by-tick record of it.
              </p>
              <p className="mb-2 rounded-lg border border-neon-amber/25 bg-neon-amber/5 px-2 py-1.5 text-[10px] leading-relaxed text-neon-amber">
                CVD diverges far more readily than RSI — on a typical hourly sweep it fires on most
                of the universe. That frequency is the honest characteristic of the reading, not a
                fault in the scan, and it is the reason these rows feed the scorecard: whether they
                are worth anything is a question for measurement rather than for either of us to
                assume.
              </p>
            </>
          }
        />
      </div>
    </AppShell>
  );
}
