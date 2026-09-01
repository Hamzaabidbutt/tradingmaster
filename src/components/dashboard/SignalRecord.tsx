"use client";

import { useCallback, useEffect, useState } from "react";
import { EmptyNote, fmtPrice, outcomeLabel, useOpenInTerminal } from "./shared";
import { OutcomeBucket } from "@/engines/outcomeBuckets";

interface RecordRow {
  id: string;
  symbol: string;
  timeframe: string;
  side: "BUY" | "SELL";
  status: string;
  confidence: number;
  confidenceLabel: string;
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp3: number;
  riskReward: number;
  expectedMovePct: number;
  reasoning: string[];
  invalidation: string[];
  resultPnlPct: number | null;
  closedPrice: number | null;
  outcomeReason: string | null;
  bucket: OutcomeBucket;
  createdAt: string;
  closedAt: string | null;
}

interface RecordReport {
  source: string | null;
  counts: Record<OutcomeBucket, number>;
  resolved: number;
  accuracyPct: number | null;
  minSample: number;
  avgPnlPct: number | null;
  signals: RecordRow[];
  note: string;
  error?: string;
}

const BUCKET_STYLE: Record<OutcomeBucket, string> = {
  active: "bg-white/5 text-slate-400",
  successful: "bg-bull/15 text-bull",
  partial: "bg-neon-amber/15 text-neon-amber",
  failed: "bg-bear/15 text-bear",
};

const BUCKET_LABEL: Record<OutcomeBucket, string> = {
  active: "Running",
  successful: "Successful",
  partial: "Partial",
  failed: "Failed",
};

/**
 * The track record for one signal source.
 *
 * Reads the same signals collection and the same bucket rule as Signal History
 * and Analytics, so a scanner page can never quietly disagree with the rest of
 * the app about what counts as a success.
 *
 * Two deliberate refusals: the accuracy figure is withheld below the sample
 * floor, and a partial counts as half rather than as a win. Both make the
 * number look worse than the alternatives would, which is the point — this is
 * a record, and the value of a record is that it can be disappointing.
 */
export default function SignalRecord({
  source,
  title,
  blurb,
}: {
  source: "COMPOSITE" | "CONFLUENCE" | "INSTITUTIONAL";
  title: string;
  blurb?: string;
}) {
  const [data, setData] = useState<RecordReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/signals/record?source=${source}`, { cache: "no-store" });
      setData((await res.json()) as RecordReport);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [source]);

  useEffect(() => {
    load();
  }, [load]);

  const counts = data?.counts;

  return (
    <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-300">
          {title}
        </h3>
        {data?.accuracyPct != null && (
          <span className="font-mono text-[11px] text-neon-cyan">{data.accuracyPct}% accuracy</span>
        )}
        {data && data.avgPnlPct != null && (
          <span
            className={`font-mono text-[10px] ${data.avgPnlPct >= 0 ? "text-bull" : "text-bear"}`}
          >
            avg {data.avgPnlPct >= 0 ? "+" : ""}
            {data.avgPnlPct}%
          </span>
        )}
        <button
          onClick={load}
          className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-slate-500 hover:bg-white/5 hover:text-slate-300"
        >
          {loading ? "…" : "refresh"}
        </button>
      </div>

      {blurb && <p className="mb-2 text-[10px] leading-relaxed text-slate-500">{blurb}</p>}

      {loading && !data && <EmptyNote>Loading the record…</EmptyNote>}

      {counts && (
        <>
          <div className="grid grid-cols-4 gap-1.5">
            <Tile label="Successful" value={counts.successful} tone="successful" />
            <Tile label="Partial" value={counts.partial} tone="partial" />
            <Tile label="Failed" value={counts.failed} tone="failed" />
            <Tile label="Running" value={counts.active} tone="active" />
          </div>

          {/* Proportional bar over resolved signals only — running positions
              are not an outcome and must not pad the denominator. */}
          {data!.resolved > 0 && (
            <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-white/5">
              <div
                className="bg-bull"
                style={{ width: `${(counts.successful / data!.resolved) * 100}%` }}
              />
              <div
                className="bg-neon-amber"
                style={{ width: `${(counts.partial / data!.resolved) * 100}%` }}
              />
              <div
                className="bg-bear"
                style={{ width: `${(counts.failed / data!.resolved) * 100}%` }}
              />
            </div>
          )}

          <p className="mt-2 text-[10px] leading-relaxed text-slate-500">{data!.note}</p>

          {data!.signals.length > 0 && (
            <>
              <button
                onClick={() => setOpen((v) => !v)}
                className="mt-2 flex w-full items-center justify-between text-[9px] uppercase tracking-[0.14em] text-slate-600 hover:text-slate-400"
              >
                Every signal on the record ({data!.signals.length})
                <span aria-hidden>{open ? "▲" : "▼"}</span>
              </button>
              {open && (
                <div className="mt-1.5 max-h-[560px] space-y-2 overflow-y-auto pr-0.5">
                  {data!.signals.map((s) => (
                    <SignalDetail key={s.id} signal={s} />
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}

      {data && data.signals.length === 0 && !loading && (
        <EmptyNote>
          No signals from this source yet. The record fills as the scanner finds qualifying setups
          and they resolve — which for a positional read can take days.
        </EmptyNote>
      )}
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: number; tone: OutcomeBucket }) {
  return (
    <div className={`rounded px-1.5 py-1 text-center ${BUCKET_STYLE[tone]}`}>
      <div className="font-mono text-sm font-bold leading-none">{value}</div>
      <div className="mt-0.5 text-[8px] uppercase tracking-wider opacity-80">{label}</div>
    </div>
  );
}

/**
 * One recorded signal, with everything it was opened on.
 *
 * The compact one-line form this replaces could tell you a signal failed but
 * not what it had actually proposed — and without the levels and the reasoning
 * there is no way to tell a bad read from a good read stopped in the wrong
 * place. Those are different problems with different fixes, so the record has
 * to carry enough to separate them.
 */
function SignalDetail({ signal: s }: { signal: RecordRow }) {
  const open = useOpenInTerminal();
  const [showWhy, setShowWhy] = useState(false);
  const isLong = s.side === "BUY";

  return (
    <article
      className={`rounded-xl border bg-white/[0.02] ${
        isLong ? "border-bull/20" : "border-bear/20"
      }`}
    >
      <button
        onClick={() => open(s.symbol, s.timeframe)}
        className="w-full px-3 py-2 text-left"
        aria-label={`Open ${s.symbol} in the terminal`}
      >
        <header className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-bold text-slate-100">
            {s.symbol.replace(/USDT$/, "/USDT")}
          </span>
          <span
            className={`rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
              isLong ? "border-bull/30 bg-bull/10 text-bull" : "border-bear/30 bg-bear/10 text-bear"
            }`}
          >
            {isLong ? "▲" : "▼"} {isLong ? "LONG" : "SHORT"}
          </span>
          <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${BUCKET_STYLE[s.bucket]}`}>
            {BUCKET_LABEL[s.bucket]}
          </span>
          <span className="font-mono text-[11px] text-neon-cyan">{s.confidence.toFixed(0)}</span>
          <span className="text-[10px] uppercase tracking-wider text-slate-500">
            {s.confidenceLabel}
          </span>
          {s.resultPnlPct != null && (
            <span
              className={`font-mono text-xs font-bold ${s.resultPnlPct >= 0 ? "text-bull" : "text-bear"}`}
            >
              {s.resultPnlPct >= 0 ? "+" : ""}
              {s.resultPnlPct.toFixed(2)}%
            </span>
          )}
          <span className="ml-auto flex items-center gap-2 font-mono text-[10px] text-slate-600">
            <span>{s.timeframe}</span>
            <span>{new Date(s.createdAt).toLocaleDateString()}</span>
          </span>
        </header>

        <div className="mt-2 grid grid-cols-3 gap-x-4 gap-y-1 font-mono text-[11px] sm:grid-cols-6">
          <Level label="Entry" value={s.entry} />
          <Level label="Stop" value={s.stopLoss} tone="bear" />
          <Level label="TP1" value={s.tp1} tone={isLong ? "bull" : "bear"} />
          <Level label="TP2" value={s.tp2} tone={isLong ? "bull" : "bear"} />
          <Level label="TP3" value={s.tp3} tone={isLong ? "bull" : "bear"} />
          <Level label="R:R" value={s.riskReward} raw />
        </div>
      </button>

      <div className="space-y-1.5 border-t border-white/5 px-3 py-2">
        <div className="flex flex-wrap items-baseline gap-x-3 font-mono text-[10px] text-slate-500">
          <span>status {s.status}</span>
          {s.closedPrice != null && <span>closed at {fmtPrice(s.closedPrice)}</span>}
          {s.closedAt && <span>{new Date(s.closedAt).toLocaleString()}</span>}
          {s.outcomeReason && (
            <span className="text-slate-400">{outcomeLabel(s.outcomeReason)}</span>
          )}
          <span className="ml-auto">
            expected {s.expectedMovePct >= 0 ? "+" : ""}
            {s.expectedMovePct.toFixed(2)}%
          </span>
        </div>

        {(s.reasoning.length > 0 || s.invalidation.length > 0) && (
          <>
            <button
              onClick={() => setShowWhy((v) => !v)}
              className="text-[10px] uppercase tracking-wider text-slate-500 hover:text-neon-cyan"
              aria-expanded={showWhy}
            >
              Why this signal {showWhy ? "▴" : "▾"}
            </button>
            {showWhy && (
              <>
                <ul className="space-y-1">
                  {s.reasoning.map((line, i) => (
                    <li key={i} className="flex gap-2 text-[11px] leading-relaxed text-slate-400">
                      <span className="text-neon-cyan">›</span>
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
                {s.invalidation.length > 0 && (
                  <ul className="space-y-1">
                    {s.invalidation.map((line, i) => (
                      <li key={i} className="flex gap-2 text-[11px] leading-relaxed text-bear/80">
                        <span>✕</span>
                        <span>{line}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </>
        )}
      </div>
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
