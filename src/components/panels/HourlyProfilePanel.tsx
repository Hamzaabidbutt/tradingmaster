"use client";

import { useMemo, useState } from "react";
import { HourlyProfile, HourStats, hourLabel } from "@/engines/hourlyProfile";
import { GlassCard } from "@/components/ui/primitives";

/**
 * When this market is busy, and what price does then.
 *
 * Shown in **both** UTC and the reader's own clock. Every exchange figure is
 * UTC and every trader thinks in local time, and the gap between the two is
 * where "the 13:00 hour" stops meaning anything to the person reading it.
 *
 * Sorted by the clock rather than by volume by default, because the shape of
 * the day is the finding — two or three peaks with dead ground between them —
 * and a table sorted by volume hides exactly that.
 */

/** The reader's local hour for a given UTC hour, on an arbitrary date. */
function localHourFor(utcHour: number): number {
  return new Date(Date.UTC(2025, 0, 15, utcHour)).getHours();
}

/** Short name of the reader's zone, e.g. "GMT+5". */
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

export default function HourlyProfilePanel({
  profile,
  loading,
  error,
  symbol,
}: {
  profile: HourlyProfile | null;
  loading: boolean;
  error: string | null;
  symbol: string;
}) {
  const [byVolume, setByVolume] = useState(false);
  const zone = useMemo(zoneLabel, []);

  const rows = useMemo(() => {
    if (!profile) return [];
    const withLocal = profile.hours
      .filter((h) => h.samples > 0)
      .map((h) => ({ ...h, local: localHourFor(h.hour) }));
    return byVolume
      ? [...withLocal].sort((a, b) => b.volumeMultiple - a.volumeMultiple)
      : [...withLocal].sort((a, b) => a.local - b.local);
  }, [profile, byVolume]);

  const peak = useMemo(
    () => Math.max(...rows.map((r) => r.volumeMultiple), 1),
    [rows]
  );

  return (
    <GlassCard
      title={
        <span className="flex items-center gap-2">
          Hour of Day
          <span className="font-mono text-[9px] normal-case tracking-normal text-slate-600">
            {symbol}
            {profile ? ` · ${profile.days}d` : ""}
          </span>
        </span>
      }
      action={
        profile ? (
          <button
            onClick={() => setByVolume((v) => !v)}
            className="rounded-md border border-white/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-slate-400 transition-colors hover:border-neon-cyan/40 hover:text-neon-cyan"
          >
            {byVolume ? "By clock" : "By volume"}
          </button>
        ) : null
      }
      className="h-full"
    >
      <div className="h-full overflow-y-auto p-3">
        {loading && !profile ? (
          <p className="p-4 text-center text-xs text-slate-500">
            Reading ~90 days of hourly bars…
          </p>
        ) : error ? (
          <p className="p-4 text-center text-xs leading-relaxed text-bear/80">{error}</p>
        ) : !profile || rows.length === 0 ? (
          <p className="p-4 text-center text-xs text-slate-500">
            Not enough hourly history to profile the clock for this contract.
          </p>
        ) : (
          <div className="space-y-3">
            <ul className="space-y-1.5">
              {profile.summary.map((line, i) => (
                <li key={i} className="text-[11px] leading-relaxed text-slate-300">
                  {line}
                </li>
              ))}
            </ul>

            <div>
              <div className="mb-1 grid grid-cols-[52px_36px_1fr_44px_44px] gap-2 px-1 text-[8px] uppercase tracking-[0.12em] text-slate-600">
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
                  <Row key={r.hour} row={r} peak={peak} zone={zone} />
                ))}
              </ul>
            </div>

            <p className="text-[9px] leading-relaxed text-slate-600">{profile.note}</p>
          </div>
        )}
      </div>
    </GlassCard>
  );
}

function Row({
  row,
  peak,
  zone,
}: {
  row: HourStats & { local: number };
  peak: number;
  zone: string;
}) {
  const width = Math.max(2, (row.volumeMultiple / peak) * 100);
  const tone =
    row.activity === "busy"
      ? "bg-neon-cyan/60"
      : row.activity === "quiet"
        ? "bg-slate-700"
        : "bg-slate-600";

  return (
    <li
      className="grid grid-cols-[52px_36px_1fr_44px_44px] items-center gap-2 px-1 font-mono text-[10px]"
      title={
        `${hourLabel(row.hour)} UTC — ${row.samples} bars. ` +
        `Volume ${row.volumeMultiple.toFixed(2)}× normal (${row.volumeSharePct.toFixed(1)}% of the day). ` +
        `Range ${row.rangePct.toFixed(2)}% of price, ${row.rangeMultiple.toFixed(2)}× the average bar. ` +
        (row.takerBuySharePct != null ? `Taker buying ${row.takerBuySharePct.toFixed(0)}% of volume. ` : "") +
        (row.upSharePct != null ? `Closed up ${row.upSharePct.toFixed(0)}% of the time. ` : "") +
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
