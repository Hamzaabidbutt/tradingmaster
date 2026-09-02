"use client";

import { useState } from "react";
import { InstitutionalSetup } from "@/engines/types";

/**
 * The buying checklist, on the chart.
 *
 * The scanner page already prints this as prose. What it could not do is put
 * the ticks next to the bars they came from — and a checklist you cannot check
 * is just a claim. So the marks are drawn on the candles and this card is the
 * key to them: every item, found or not, in the same order and with the same
 * wording as the engine, and the price levels that follow from them.
 *
 * ## Why the supply score is here
 *
 * Because a demand read means very little on its own. Eight items on the
 * buying side while the selling side reads seven is not accumulation — it is a
 * contested area leaving marks in both directions. Showing only the side the
 * user asked about would make every chart look like somebody was buying, which
 * is exactly the failure the two-sided engine was built to avoid.
 */
export default function BuyingChecklistCard({
  setup,
  loading,
  precision,
}: {
  setup: InstitutionalSetup | null;
  loading: boolean;
  precision: number;
}) {
  /*
    Open on a desktop chart, collapsed on a phone.

    The card is 208px wide, which is over half a 390px chart — expanded by
    default there it hides the candles it exists to annotate. On a wide chart
    it costs a corner and saves a round trip to the scanner page, so it starts
    open. Safe to read `window` in the initialiser: the chart this lives in is
    loaded with `ssr: false`, so there is no server render to mismatch.
  */
  const [open, setOpen] = useState(
    () => typeof window === "undefined" || window.innerWidth >= 1024
  );

  if (loading && !setup) {
    return (
      <Shell open={false} onToggle={() => {}} title="Buying checklist" subtitle="reading…" />
    );
  }
  if (!setup) return null;

  const demand = setup.demand;
  const supply = setup.supply;
  const found = demand.evidence.filter((e) => e.found).length;
  const total = demand.evidence.length;
  const fmt = (v: number) => v.toFixed(precision);

  // The honest headline. "Qualified" is the engine's own bar; anything below
  // it is marks rather than a footprint, and the card says which.
  const verdict = demand.qualified
    ? `Qualified · ${setup.grade}`
    : found >= total * 0.5
      ? "Forming — not qualified"
      : "Marks only";

  return (
    <Shell
      open={open}
      onToggle={() => setOpen((o) => !o)}
      title="Buying checklist"
      subtitle={`${found}/${total} · demand ${demand.score}`}
    >
      <div className="space-y-2 px-2.5 pb-2.5">
        <div className="flex items-center justify-between gap-2 text-[9px]">
          <span
            className={`rounded px-1.5 py-0.5 font-semibold uppercase tracking-wider ${
              demand.qualified
                ? "bg-emerald-400/15 text-emerald-300"
                : "bg-white/5 text-slate-400"
            }`}
          >
            {verdict}
          </span>
          <span
            className="font-mono text-slate-500"
            title="The selling side of the same checklist. Close scores mean a contested area, not accumulation."
          >
            supply {supply.score} · {supply.kinds}/{total}
          </span>
        </div>

        <ul className="space-y-[3px]">
          {demand.evidence.map((e) => (
            <li
              key={e.key}
              title={e.detail}
              className={`flex items-start gap-1.5 text-[10px] leading-tight ${
                e.found ? "text-slate-200" : "text-slate-600"
              }`}
            >
              <span className={e.found ? "text-emerald-400" : "text-slate-700"}>
                {e.found ? "✓" : "✗"}
              </span>
              <span className="min-w-0 flex-1 truncate">{e.label}</span>
              <span className="shrink-0 font-mono text-[9px] text-slate-600">
                {round1(e.score)}/{e.weight}
              </span>
            </li>
          ))}
        </ul>

        {demand.zone && (
          <div className="rounded border border-emerald-400/20 bg-emerald-400/5 px-2 py-1.5 font-mono text-[9px] leading-relaxed text-emerald-200/90">
            AREA {fmt(demand.zone.low)}–{fmt(demand.zone.high)}
            <span className="text-emerald-200/50">
              {" "}
              · {demand.zone.confluence} kind{demand.zone.confluence === 1 ? "" : "s"} ·{" "}
              {Math.abs(demand.zone.distancePct).toFixed(2)}%{" "}
              {demand.zone.distancePct < 0 ? "below" : "above"}
            </span>
          </div>
        )}

        <dl className="space-y-[3px] font-mono text-[9px]">
          <Level label="Confirm" value={setup.confirmLevel} fmt={fmt} tone="text-emerald-300" />
          <Level label="Invalid" value={setup.invalidateLevel} fmt={fmt} tone="text-bear" />
          <Level label="Objective" value={setup.objective} fmt={fmt} tone="text-slate-400" />
        </dl>

        {setup.history.samples > 0 && (
          <p
            className="text-[9px] leading-relaxed text-slate-500"
            title={setup.history.note}
          >
            {setup.history.holdRatePct != null
              ? `${setup.history.held}/${setup.history.samples} comparable areas held in this window.`
              : `${setup.history.samples} comparable area${setup.history.samples === 1 ? "" : "s"} — too few to quote a rate.`}
          </p>
        )}

        <p className="text-[9px] leading-relaxed text-slate-600">
          Levels follow from the evidence. Whether price reaches them does not — nothing here
          estimates the odds of it.
        </p>
      </div>
    </Shell>
  );
}

/**
 * One decimal at most, trailing zero dropped.
 *
 * Some items score on a continuous scale — funding is weighted by how
 * expensive the position actually is — so the raw value arrives as
 * 9.399999999999999. Rounding here rather than in the engine keeps the score
 * arithmetic exact and confines the tidying to the place it is read.
 */
function round1(v: number): string {
  return String(Math.round(v * 10) / 10);
}

function Level({
  label,
  value,
  fmt,
  tone,
}: {
  label: string;
  value: number | null;
  fmt: (v: number) => string;
  tone: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-slate-600">{label}</dt>
      <dd className={value == null ? "text-slate-700" : tone}>{value == null ? "—" : fmt(value)}</dd>
    </div>
  );
}

/**
 * The card frame.
 *
 * `pointer-events-auto` on the frame alone: the chart's overlay layer disables
 * them wholesale, and a checklist you cannot collapse would sit permanently
 * over the left-hand candles.
 */
function Shell({
  open,
  onToggle,
  title,
  subtitle,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  title: string;
  subtitle: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="pointer-events-auto absolute left-2 top-2 z-20 w-[208px] overflow-hidden rounded-lg border border-emerald-400/25 bg-base-950/85 backdrop-blur-sm">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left transition-colors hover:bg-white/5"
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
        <span className="text-[10px] font-semibold text-slate-200">{title}</span>
        <span className="ml-auto font-mono text-[9px] text-slate-500">{subtitle}</span>
        <span className="text-[8px] text-slate-600">{open ? "▲" : "▼"}</span>
      </button>
      {open && children}
    </div>
  );
}
