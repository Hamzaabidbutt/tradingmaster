"use client";

import { useEffect, useState } from "react";
import type { AlignmentReport, TimeframeRead } from "@/engines/timeframeAlignment";

/**
 * Four clocks, one strip.
 *
 * Sits in the chart header because that is where the question comes up: the
 * moment a setup looks good on the chart in front of you is the moment worth
 * knowing whether a higher timeframe disagrees. A check that costs a timeframe
 * switch and a scroll is a check that does not happen.
 *
 * Each cell shows both facts rather than one arrow. Structure and the slow
 * average disagree often, and that disagreement is the informative state —
 * collapsing them would report a confident direction for a chart that does not
 * have one.
 */
export default function MtfRibbon({ symbol }: { symbol: string }) {
  const [report, setReport] = useState<AlignmentReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/market/alignment?symbol=${encodeURIComponent(symbol)}`, {
          cache: "no-store",
        });
        const json = await res.json();
        if (stop) return;
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        setReport(json as AlignmentReport);
        setError(null);
      } catch (err) {
        if (!stop) setError(String(err));
      }
    };
    setReport(null);
    setError(null);
    load();
    // Slow: these are 15m to 1d reads, and nothing on them changes in a minute.
    const t = setInterval(load, 120_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [symbol]);

  if (error) {
    return (
      <span className="font-mono text-[9px] text-slate-600" title={error}>
        MTF unavailable
      </span>
    );
  }
  if (!report) {
    return <span className="font-mono text-[9px] text-slate-600">MTF…</span>;
  }

  return (
    <span className="flex flex-wrap items-center gap-1" title={`${report.headline} ${report.note}`}>
      <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">MTF</span>
      {report.reads.map((r) => (
        <Cell key={r.timeframe} read={r} />
      ))}
      {report.bullish > 0 && report.bearish > 0 && (
        <span
          className="rounded bg-neon-amber/15 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-neon-amber"
          title={report.note}
        >
          split
        </span>
      )}
    </span>
  );
}

function Cell({ read: r }: { read: TimeframeRead }) {
  /* Colour only when both facts agree. A timeframe mid-transition is drawn
     neutral on purpose — it genuinely has no direction to report, and tinting
     it by whichever fact moved first would be picking the answer. */
  const tone = !r.aligned
    ? "border-white/10 text-slate-500"
    : r.structure === "bullish"
      ? "border-bull/40 bg-bull/10 text-bull"
      : "border-bear/40 bg-bear/10 text-bear";

  const arrow = !r.aligned ? "·" : r.structure === "bullish" ? "▲" : "▼";

  return (
    <span
      className={`flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[9px] ${tone}`}
      title={`${r.timeframe}: ${r.note} Price is ${r.distancePct >= 0 ? "+" : ""}${r.distancePct}% from the 50-period average, over ${r.bars} bars.`}
    >
      <span className="font-semibold">{r.timeframe}</span>
      <span>{arrow}</span>
    </span>
  );
}
