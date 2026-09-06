"use client";

import { ReactNode } from "react";
import { Bias } from "@/engines/types";

export function GlassCard({
  children,
  className = "",
  title,
  action,
}: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className={`glass glass-hover flex flex-col overflow-hidden ${className}`}>
      {(title || action) && (
        <header className="flex items-center justify-between border-b border-white/5 px-4 py-2.5">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">{title}</h3>
          {action}
        </header>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </section>
  );
}

export function BiasBadge({ bias, label }: { bias: Bias; label?: string }) {
  const styles =
    bias === "bullish"
      ? "bg-bull/10 text-bull border-bull/30"
      : bias === "bearish"
        ? "bg-bear/10 text-bear border-bear/30"
        : "bg-slate-500/10 text-slate-400 border-slate-500/30";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${styles}`}>
      {label ?? bias}
    </span>
  );
}

/** Accessible dual-color probability meter (never color-only: % is printed). */
export function ProbabilityBar({ bullish, className = "" }: { bullish: number; className?: string }) {
  return (
    <div className={className}>
      <div className="mb-1 flex justify-between font-mono text-[11px]">
        <span className="text-bull">▲ {bullish}% bullish</span>
        <span className="text-bear">{100 - bullish}% bearish ▼</span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-bear/60"
        role="meter"
        aria-valuenow={bullish}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Bullish probability ${bullish} percent`}
      >
        <div className="h-full rounded-full bg-bull transition-all duration-700" style={{ width: `${bullish}%` }} />
      </div>
    </div>
  );
}

export function StatChip({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  tone?: "bull" | "bear" | "neutral" | "cyan" | "amber";
}) {
  const color =
    tone === "bull"
      ? "text-bull"
      : tone === "bear"
        ? "text-bear"
        : tone === "cyan"
          ? "text-neon-cyan"
          : tone === "amber"
            ? "text-neon-amber"
            : "text-slate-200";
  return (
    <div className="rounded-lg bg-white/[0.03] px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`font-mono text-sm font-semibold ${color}`}>{value}</div>
    </div>
  );
}

export function Gauge({ value, label, tone }: { value: number; label: string; tone: "bull" | "bear" | "cyan" }) {
  const color = tone === "bull" ? "#00e5a0" : tone === "bear" ? "#ff4d6d" : "#22d3ee";
  return (
    <div className="flex items-center gap-3">
      <div className="relative h-12 w-12 shrink-0">
        <svg viewBox="0 0 36 36" className="h-12 w-12 -rotate-90">
          <circle cx="18" cy="18" r="15.5" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="3.5" />
          <circle
            cx="18" cy="18" r="15.5" fill="none" stroke={color} strokeWidth="3.5"
            strokeDasharray={`${(value / 100) * 97.4} 97.4`}
            strokeLinecap="round"
            className="transition-all duration-700"
          />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center font-mono text-[11px] font-bold" style={{ color }}>
          {Math.round(value)}
        </span>
      </div>
      <span className="text-xs text-slate-400">{label}</span>
    </div>
  );
}

export function timeAgo(unixSec: number): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - unixSec);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/**
 * Wall-clock time in the reader's own zone.
 *
 * "4m ago" answers freshness; it does not answer *when*, and those are
 * different questions. A scanner result that says only "12m ago" cannot be
 * lined up against a chart, a funding settlement or a session boundary — all
 * of which the reader thinks about in their own clock, while every exchange
 * figure in the app is UTC.
 */
export function localTime(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Local date and time, for anything that may not be from today. */
export function localStamp(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

/** The reader's timezone abbreviation, e.g. "GMT+5". */
export function localZone(): string {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(
      new Date()
    );
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "local";
  } catch {
    return "local";
  }
}

/**
 * The local time of the bar a scanner row was read from.
 *
 * Distinct from the scan timestamp in the header: that says when the sweep
 * ran, this says how old the data under *this row* is, and the two differ
 * whenever a symbol sits on a slow timeframe. A 4h read taken thirty seconds
 * ago can still be built on a bar that opened three hours back.
 */
export function BarClock({ at, timeframe }: { at?: number; timeframe?: string }) {
  if (!at) return null;
  return (
    <span
      className="font-mono text-[9px] text-slate-600"
      title={`Last closed ${timeframe ?? ""} bar opened ${localStamp(at)} (${localZone()})`}
    >
      {localTime(at)}
    </span>
  );
}

/**
 * When a scan ran, both ways: how long ago, and at what time on the reader's
 * own clock. Used in every scanner header so the two never drift apart.
 */
export function ScanTimestamp({ at, label = "scanned" }: { at: number; label?: string }) {
  if (!at) return null;
  return (
    <span title={`${label} at ${localStamp(at)} (${localZone()})`}>
      {timeAgo(at)}
      <span className="ml-1 font-mono text-slate-500">· {localTime(at)}</span>
    </span>
  );
}
