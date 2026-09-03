"use client";

import { useMemo, useState } from "react";
import type { SeasonalityReport } from "@/app/api/analysis/seasonality/route";
import { HourStats, hourLabel } from "@/engines/hourlyProfile";
import { WeekBucket, WeekCell, WEEKDAYS } from "@/engines/weekProfile";
import { GlassCard } from "@/components/ui/primitives";

/**
 * When this market is busy, and whether any of the folklore about it is true.
 *
 * Four views over one report:
 *
 *  - **Hours** — the shape of the day, in the reader's clock and in UTC.
 *  - **Days** — weekday and session, where the weekend gap lives.
 *  - **Grid** — the full 7×24 heatmap. This is the "Friday night" view.
 *  - **Patterns** — the directional claims that survived being checked, which
 *    is usually none, and the panel says so rather than hiding an empty
 *    result behind an empty list.
 *
 * Volume is coloured; direction is not. That is deliberate — a heatmap of mean
 * returns invites the eye to find shapes in what is mostly noise, and the eye
 * always obliges.
 */

type View = "hours" | "days" | "grid" | "patterns";

const VIEWS: { key: View; label: string }[] = [
  { key: "hours", label: "Hours" },
  { key: "days", label: "Days" },
  { key: "grid", label: "Grid" },
  { key: "patterns", label: "Patterns" },
];

/** The reader's local hour for a UTC hour, on an arbitrary date. */
function localHourFor(utcHour: number): number {
  return new Date(Date.UTC(2025, 0, 15, utcHour)).getHours();
}

function zoneLabel(): string {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(
      new Date()
    );
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "local";
  } catch {
    return "local";
  }
}

export default function SeasonalityPanel({
  report,
  loading,
  error,
  symbol,
}: {
  report: SeasonalityReport | null;
  loading: boolean;
  error: string | null;
  symbol: string;
}) {
  const [view, setView] = useState<View>("hours");
  const zone = useMemo(zoneLabel, []);

  return (
    <GlassCard
      title={
        <span className="flex items-center gap-2">
          Time &amp; Seasonality
          <span className="font-mono text-[9px] normal-case tracking-normal text-slate-600">
            {symbol}
            {report ? ` · ${report.week.days || report.hourly.days}d` : ""}
          </span>
        </span>
      }
      action={
        report ? (
          <div className="flex gap-0.5 rounded-lg bg-white/5 p-0.5">
            {VIEWS.map((v) => (
              <button
                key={v.key}
                onClick={() => setView(v.key)}
                aria-pressed={view === v.key}
                className={`rounded-md px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider transition-colors ${
                  view === v.key
                    ? "bg-neon-cyan/15 text-neon-cyan"
                    : "text-slate-500 hover:text-slate-300"
                }`}
              >
                {v.label}
                {v.key === "patterns" && report.week.recurring.length > 0 && (
                  <span className="ml-1 font-mono text-neon-amber">
                    {report.week.recurring.length}
                  </span>
                )}
              </button>
            ))}
          </div>
        ) : null
      }
      className="h-full"
    >
      <div className="h-full overflow-y-auto p-3">
        {loading && !report ? (
          <p className="p-4 text-center text-xs text-slate-500">
            Reading a year of hourly bars…
          </p>
        ) : error ? (
          <p className="p-4 text-center text-xs leading-relaxed text-bear/80">{error}</p>
        ) : !report ? (
          <p className="p-4 text-center text-xs text-slate-500">
            Not enough hourly history to profile the clock for this contract.
          </p>
        ) : view === "hours" ? (
          <Hours report={report} zone={zone} />
        ) : view === "days" ? (
          <Days report={report} />
        ) : view === "grid" ? (
          <Grid report={report} zone={zone} />
        ) : (
          <Patterns report={report} />
        )}
      </div>
    </GlassCard>
  );
}

/* ------------------------------------------------------------------ */

function Hours({ report, zone }: { report: SeasonalityReport; zone: string }) {
  const rows = useMemo(
    () =>
      report.hourly.hours
        .filter((h) => h.samples > 0)
        .map((h) => ({ ...h, local: localHourFor(h.hour) }))
        .sort((a, b) => a.local - b.local),
    [report]
  );
  const peak = Math.max(...rows.map((r) => r.volumeMultiple), 1);
  if (rows.length === 0) return <Empty />;

  return (
    <div className="space-y-3">
      <Lines lines={report.hourly.summary} />
      <div>
        <div className="mb-1 grid grid-cols-[52px_32px_1fr_44px_44px] gap-2 px-1 text-[8px] uppercase tracking-[0.12em] text-slate-600">
          <span title={`Your clock (${zone})`}>{zone}</span>
          <span title="Exchange time — every Binance figure is UTC">UTC</span>
          <span>Volume vs normal</span>
          <span title="Mean bar range against the average bar">Range</span>
          <span title="Share of decisive moves in this hour that the next hour extended. Withheld below 20 decisive bars.">
            Follow
          </span>
        </div>
        <ul className="space-y-[2px]">
          {rows.map((r) => (
            <HourRow key={r.hour} row={r} peak={peak} />
          ))}
        </ul>
      </div>
      <Note text={report.hourly.note} />
    </div>
  );
}

function HourRow({ row, peak }: { row: HourStats & { local: number }; peak: number }) {
  const width = Math.max(2, (row.volumeMultiple / peak) * 100);
  const tone =
    row.activity === "busy"
      ? "bg-neon-cyan/60"
      : row.activity === "quiet"
        ? "bg-slate-700"
        : "bg-slate-600";
  return (
    <li
      className="grid grid-cols-[52px_32px_1fr_44px_44px] items-center gap-2 px-1 font-mono text-[10px]"
      title={
        `${hourLabel(row.hour)} UTC — ${row.samples} bars. ` +
        `Volume ${row.volumeMultiple.toFixed(2)}× normal (${row.volumeSharePct.toFixed(1)}% of the day). ` +
        `Range ${row.rangePct.toFixed(2)}% of price. ` +
        (row.takerBuySharePct != null ? `Taker buying ${row.takerBuySharePct.toFixed(0)}%. ` : "") +
        (row.followThroughPct != null
          ? `${row.followThroughPct.toFixed(0)}% of its ${row.decisiveSamples} decisive moves were extended by the next hour.`
          : "Too few decisive moves to quote a follow-through rate.")
      }
    >
      <span className={row.activity === "busy" ? "text-neon-cyan" : "text-slate-400"}>
        {hourLabel(row.local)}
      </span>
      <span className="text-slate-600">{String(row.hour).padStart(2, "0")}</span>
      <span className="flex items-center gap-1.5">
        <span className="h-2 flex-1 overflow-hidden rounded-sm bg-white/5">
          <span className={`block h-full rounded-sm ${tone}`} style={{ width: `${width}%` }} />
        </span>
        <span
          className={`w-9 shrink-0 text-right ${row.activity === "busy" ? "text-neon-cyan" : "text-slate-500"}`}
        >
          {row.volumeMultiple.toFixed(2)}×
        </span>
      </span>
      <span className={row.rangeMultiple >= 1.15 ? "text-neon-amber" : "text-slate-500"}>
        {row.rangeMultiple.toFixed(2)}×
      </span>
      <span
        className={
          row.followThroughPct == null
            ? "text-slate-700"
            : row.followThroughPct >= 55
              ? "text-bull"
              : row.followThroughPct <= 45
                ? "text-bear"
                : "text-slate-500"
        }
      >
        {row.followThroughPct == null ? "—" : `${row.followThroughPct.toFixed(0)}%`}
      </span>
    </li>
  );
}

/* ------------------------------------------------------------------ */

function Days({ report }: { report: SeasonalityReport }) {
  const w = report.week;
  if (w.weekdays.length === 0) return <Empty />;
  const peakDay = Math.max(...w.weekdays.map((d) => d.volumeMultiple), 1);
  const peakSlot = Math.max(...w.slots.map((s) => s.volumeMultiple), 1);
  const topSlots = [...w.slots]
    .filter((s) => s.samples > 0)
    .sort((a, b) => b.volumeMultiple - a.volumeMultiple)
    .slice(0, 8);

  return (
    <div className="space-y-3">
      <Lines lines={w.summary} />

      <Section title="By weekday (UTC)">
        <ul className="space-y-[2px]">
          {w.weekdays.map((d) => (
            <BucketRow key={d.key} bucket={d} peak={peakDay} width={92} />
          ))}
        </ul>
      </Section>

      <Section title="By session">
        <ul className="space-y-[2px]">
          {w.sessions.map((s) => (
            <BucketRow key={s.key} bucket={s} peak={peakDay} width={92} />
          ))}
        </ul>
      </Section>

      <Section title="Busiest weekday × session slots">
        <ul className="space-y-[2px]">
          {topSlots.map((s) => (
            <BucketRow key={s.key} bucket={s} peak={peakSlot} width={124} />
          ))}
        </ul>
      </Section>

      <Note text={w.note} />
    </div>
  );
}

function BucketRow({
  bucket,
  peak,
  width,
}: {
  bucket: WeekBucket;
  peak: number;
  width: number;
}) {
  const pct = Math.max(2, (bucket.volumeMultiple / peak) * 100);
  return (
    <li
      className="flex items-center gap-2 px-1 font-mono text-[10px]"
      title={
        `${bucket.label} — ${bucket.samples} bars. ` +
        `Volume ${bucket.volumeMultiple.toFixed(2)}× the average hour, range ${bucket.rangeMultiple.toFixed(2)}×. ` +
        (bucket.upSharePct != null
          ? `Closed up ${bucket.upSharePct.toFixed(0)}% of the time (first half ${bucket.firstHalfUpPct ?? "—"}%, second half ${bucket.secondHalfUpPct ?? "—"}%). `
          : "Too few bars for a directional figure. ") +
        (bucket.recurring
          ? "This one survived correction and repeated across both halves."
          : "Not a verified pattern.")
      }
    >
      <span
        className="shrink-0 truncate text-slate-400"
        style={{ width }}
      >
        {bucket.label}
      </span>
      <span className="h-2 flex-1 overflow-hidden rounded-sm bg-white/5">
        <span
          className={`block h-full rounded-sm ${bucket.volumeMultiple >= 1.15 ? "bg-neon-cyan/60" : "bg-slate-600"}`}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span
        className={`w-9 shrink-0 text-right ${bucket.volumeMultiple >= 1.15 ? "text-neon-cyan" : "text-slate-500"}`}
      >
        {bucket.volumeMultiple.toFixed(2)}×
      </span>
      <span className="w-9 shrink-0 text-right text-slate-600" title="Range vs the average bar">
        {bucket.rangeMultiple.toFixed(2)}×
      </span>
      {bucket.recurring && (
        <span className="shrink-0 text-neon-amber" title="Survived correction and repeated">
          ★
        </span>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ */

/**
 * The 7×24 grid, shaded by volume only.
 *
 * Not by return, deliberately: a heatmap of mean returns over cells this small
 * is a picture of noise, and the eye will find a pattern in it every time.
 * Direction is in the tooltip as a number, where it has to be read rather than
 * glanced at, and the Patterns view is the only place a directional claim is
 * actually made.
 */
function Grid({ report, zone }: { report: SeasonalityReport; zone: string }) {
  const cells = report.week.cells;
  const byDay = useMemo(() => {
    const m: WeekCell[][] = Array.from({ length: 7 }, () => []);
    for (const c of cells) m[c.weekday].push(c);
    for (const row of m) row.sort((a, b) => a.hour - b.hour);
    return m;
  }, [cells]);
  /*
    Shading is stretched between the 5th and 95th percentile rather than
    between zero and the maximum. Anchoring at zero wastes most of the range on
    values that never occur — every cell lands somewhere between 0.4× and 2×
    normal — and flattens the grid into one shade of blue. Clipping the tails
    keeps a single freak hour from washing out the other 167.
  */
  const scale = useMemo(() => {
    const vals = cells
      .filter((c) => c.samples > 0)
      .map((c) => c.volumeMultiple)
      .sort((a, b) => a - b);
    if (vals.length === 0) return { lo: 0, hi: 1 };
    const lo = vals[Math.floor(vals.length * 0.05)];
    const hi = vals[Math.floor(vals.length * 0.95)];
    return { lo, hi: hi > lo ? hi : lo + 1 };
  }, [cells]);
  const shade = (v: number) => Math.max(0, Math.min(1, (v - scale.lo) / (scale.hi - scale.lo)));
  const recurringKeys = new Set(report.week.recurring.map((r) => r.key));
  /* The grid shows the shape; these name it. Reading "Friday 13–21 UTC" off a
     heatmap means counting columns, which nobody does. */
  const ranked = useMemo(
    () =>
      [...report.week.slots]
        .filter((s) => s.samples > 0)
        .sort((a, b) => b.volumeMultiple - a.volumeMultiple),
    [report]
  );
  const busiest = ranked.slice(0, 3);
  const deadest = ranked.slice(-2);

  if (cells.length === 0) return <Empty />;

  return (
    <div className="space-y-3">
      <p className="text-[11px] leading-relaxed text-slate-300">
        Volume by weekday and UTC hour, as a multiple of this symbol&apos;s average hour. Brighter is
        busier. Hover any cell for its bars, range and up-share.
      </p>
      <div className="overflow-x-auto">
        <div className="min-w-[560px]">
          <div className="mb-1 flex gap-[2px] pl-[62px]">
            {Array.from({ length: 24 }, (_, h) => (
              <span
                key={h}
                className="flex-1 text-center font-mono text-[7px] text-slate-600"
                title={`${hourLabel(h)} UTC · ${hourLabel(localHourFor(h))} ${zone}`}
              >
                {h % 3 === 0 ? String(h).padStart(2, "0") : ""}
              </span>
            ))}
          </div>
          {byDay.map((row, wd) => (
            <div key={wd} className="mb-[2px] flex items-center gap-[2px]">
              <span className="w-[60px] shrink-0 font-mono text-[9px] text-slate-500">
                {WEEKDAYS[wd].slice(0, 3)}
              </span>
              {row.map((c) => {
                const share = shade(c.volumeMultiple);
                const starred = recurringKeys.has(`${c.weekday}-h${c.hour}`);
                return (
                  <span
                    key={c.hour}
                    className={`h-6 flex-1 rounded-[2px] ${starred ? "ring-1 ring-neon-amber" : ""}`}
                    style={{
                      backgroundColor: `rgba(34,211,238,${(0.03 + share * 0.82).toFixed(3)})`,
                    }}
                    title={
                      `${WEEKDAYS[wd]} ${hourLabel(c.hour)} UTC (${hourLabel(localHourFor(c.hour))} ${zone}) — ${c.samples} bars. ` +
                      `Volume ${c.volumeMultiple.toFixed(2)}× normal, range ${c.rangeMultiple.toFixed(2)}×. ` +
                      (c.upSharePct != null
                        ? `Closed up ${c.upSharePct.toFixed(0)}% of the time, mean ${c.meanReturnPct! >= 0 ? "+" : ""}${c.meanReturnPct!.toFixed(3)}%. ` +
                          "One cell out of 168 — read it as a number, not as a signal."
                        : "Too few bars for a directional figure.")
                    }
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2 font-mono text-[9px] text-slate-500">
        <span>{scale.lo.toFixed(2)}×</span>
        <span className="flex h-2 flex-1 overflow-hidden rounded-sm">
          {Array.from({ length: 20 }, (_, i) => (
            <span
              key={i}
              className="flex-1"
              style={{ backgroundColor: `rgba(34,211,238,${(0.03 + (i / 19) * 0.82).toFixed(3)})` }}
            />
          ))}
        </span>
        <span>{scale.hi.toFixed(2)}× and above</span>
      </div>

      <Section title="Busiest and deadest slots">
        <ul className="space-y-[2px]">
          {busiest.map((s) => (
            <BucketRow key={s.key} bucket={s} peak={busiest[0]?.volumeMultiple ?? 1} width={124} />
          ))}
          {deadest.map((s) => (
            <BucketRow key={s.key} bucket={s} peak={busiest[0]?.volumeMultiple ?? 1} width={124} />
          ))}
        </ul>
      </Section>

      <p className="text-[9px] leading-relaxed text-slate-600">
        Shaded by volume only, stretched between the 5th and 95th percentile so a single freak hour
        does not wash out the other 167. A grid shaded by <em>return</em> would be a picture of
        noise at this cell size — 168 cells guarantee several look striking by chance — so
        directional figures stay in the tooltip, where they have to be read rather than glanced at,
        and only a pattern that survived the Patterns check is ringed in amber.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Patterns({ report }: { report: SeasonalityReport }) {
  const w = report.week;
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
        <div className="mb-1 flex items-baseline gap-2">
          <span className="font-mono text-2xl font-bold leading-none text-slate-200">
            {w.recurring.length}
          </span>
          <span className="text-[10px] text-slate-400">
            verified out of {w.candidatesTested} candidates tested
          </span>
        </div>
        <p className="text-[10px] leading-relaxed text-slate-500">
          Chance alone would be expected to produce {w.expectedByChance.toFixed(2)} at this
          threshold. To count, a candidate must clear a significance bar corrected for how many
          were examined <em>and</em> lean the same way in both halves of the window.
        </p>
      </div>

      {w.recurring.length === 0 ? (
        <p className="rounded-lg border border-white/5 bg-white/[0.02] p-3 text-[11px] leading-relaxed text-slate-300">
          {w.patternNote}
        </p>
      ) : (
        <>
          <ul className="space-y-1.5">
            {w.recurring.map((b) => (
              <li
                key={b.key}
                className="rounded-lg border border-neon-amber/25 bg-neon-amber/5 p-2.5"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[11px] font-semibold text-neon-amber">{b.label}</span>
                  <span className="font-mono text-[10px] text-slate-400">
                    {b.upSharePct!.toFixed(0)}% up · {b.samples} bars
                  </span>
                </div>
                <div className="mt-1 grid grid-cols-3 gap-2 font-mono text-[9px] text-slate-400">
                  <span title="Up-share over the first half of the window">
                    1st half {b.firstHalfUpPct!.toFixed(0)}%
                  </span>
                  <span title="Up-share over the second half">
                    2nd half {b.secondHalfUpPct!.toFixed(0)}%
                  </span>
                  <span title="Standard errors from a coin flip">z {b.z!.toFixed(2)}</span>
                </div>
                <p className="mt-1 font-mono text-[9px] text-slate-500">
                  mean {b.meanReturnPct! >= 0 ? "+" : ""}
                  {b.meanReturnPct!.toFixed(3)}% per bar · volume{" "}
                  {b.volumeMultiple.toFixed(2)}× · range {b.rangeMultiple.toFixed(2)}×
                </p>
              </li>
            ))}
          </ul>
          <p className="text-[10px] leading-relaxed text-slate-500">{w.patternNote}</p>
        </>
      )}

      <Note text={w.note} />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[8px] uppercase tracking-[0.14em] text-slate-600">{title}</div>
      {children}
    </div>
  );
}

function Lines({ lines }: { lines: string[] }) {
  return (
    <ul className="space-y-1.5">
      {lines.map((l, i) => (
        <li key={i} className="text-[11px] leading-relaxed text-slate-300">
          {l}
        </li>
      ))}
    </ul>
  );
}

function Note({ text }: { text: string }) {
  return <p className="text-[9px] leading-relaxed text-slate-600">{text}</p>;
}

function Empty() {
  return (
    <p className="p-4 text-center text-xs text-slate-500">
      Not enough hourly history for this view.
    </p>
  );
}
