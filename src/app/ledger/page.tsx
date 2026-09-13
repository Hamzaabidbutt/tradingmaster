"use client";

import { useCallback, useEffect, useState } from "react";
import AppShell from "@/components/layout/AppShell";
import { GlassCard } from "@/components/ui/primitives";
import { EmptyNote } from "@/components/dashboard/shared";

interface Row {
  scanner: string;
  timeframe: string;
  state: string;
  observed: number;
  scored: number;
  target: number;
  stopped: number;
  neither: number;
  hitRate: number | null;
  medianFavourableAtr: number;
  medianAdverseAtr: number;
  edgeAtr: number | null;
}

interface Scorecard {
  rows: Row[];
  totalObserved: number;
  totalScored: number;
  since: number | null;
  minSample: number;
  windowBars: number;
  targetAtr: number;
  stopAtr: number;
  error?: string;
}

/**
 * What each scanner has actually produced.
 *
 * The page exists to make one question answerable that previously was not:
 * which of these scanners is worth keeping. Every rate here is measured from
 * rows the app wrote about itself *before* the outcome existed, so unlike a
 * backtest it cannot have been tuned to agree with anybody.
 *
 * It will be empty for a while, and then thin for a while after that. Both are
 * the honest state of the evidence rather than a fault, and the page says so
 * rather than filling the gap with a number.
 */
export default function LedgerPage() {
  const [data, setData] = useState<Scorecard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/ledger/scorecard", { cache: "no-store" });
      const json = (await res.json()) as Scorecard;
      setData(json);
      if (json.error) setError(json.error);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const days =
    data?.since != null
      ? Math.max(1, Math.round((Date.now() / 1000 - data.since) / 86_400))
      : 0;

  return (
    <AppShell>
      <div className="space-y-3 p-3 md:p-4">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-lg font-bold tracking-tight text-slate-100">
            Scanner <span className="text-neon-cyan">Scorecard</span>
          </h1>
          <p className="text-[11px] text-slate-500">
            What each scanner claimed, and what price did next. Recorded automatically.
          </p>
        </header>

        <GlassCard
          title={
            <span className="flex items-center gap-2">
              📒 Forward ledger
              {data && (
                <span className="font-mono text-[10px] font-normal text-slate-500">
                  {data.totalObserved} recorded · {data.totalScored} scored
                  {days > 0 && ` · ${days}d`}
                </span>
              )}
            </span>
          }
        >
          <div className="p-3">
            <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
              Every scanner pass writes one row per setup it surfaces, keyed on the bar it read —
              so a setup that persists across six passes is one row, not six. Once{" "}
              {data?.windowBars ?? 20} bars of that row&apos;s own timeframe have closed, a scorer
              walks them and records what happened: <strong className="text-bull">target</strong>{" "}
              if it ran {data?.targetAtr ?? 2} ATR in the setup&apos;s favour,{" "}
              <strong className="text-bear">stopped</strong> if it went {data?.stopAtr ?? 1} ATR
              against it first, <strong>neither</strong> if it did nothing.
            </p>
            <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
              Measured from the close of the bar the scan read, for every scanner alike — not from
              whatever entry each one proposes, which would need a fill model and is how this app
              once recorded phantom fills. Which threshold came <em>first</em> decides the outcome:
              a setup that runs 4 ATR in your favour after a 1 ATR move against you is a loss,
              because nobody was still in it.
            </p>
            <p className="mb-2 rounded-lg border border-neon-amber/25 bg-neon-amber/5 px-2 py-1.5 text-[10px] leading-relaxed text-neon-amber">
              These are measured frequencies over the rows that have accumulated, not edges and not
              forecasts. A rate is withheld entirely below {data?.minSample ?? 20} scored rows, and
              every rate shown carries its denominator. The ledger also cannot see what the
              scanners never surfaced — the claim is &ldquo;setups this scanner shows do X&rdquo;,
              never &ldquo;setups like this do X&rdquo;.
            </p>

            {error && (
              <p className="mt-2 rounded-lg border border-bear/30 bg-bear/5 px-2 py-1.5 text-[10px] text-bear">
                {error}
              </p>
            )}

            {loading && <EmptyNote>Reading the ledger…</EmptyNote>}

            {!loading && data && data.rows.length === 0 && (
              /* Shown alongside an error rather than instead of it. An empty
                 ledger and an unreachable database look identical to a reader,
                 and the useful thing to say — that nothing here needs entering
                 by hand — is true in both cases. */
              <EmptyNote>
                Nothing recorded yet. The hourly job fills this by itself — there is nothing to
                enter by hand. Expect the first rows within an hour of the workflow running, and
                expect them to stay below the sample floor for a week or two.
                {error === "database unavailable" && (
                  <>
                    {" "}
                    The ledger needs <code className="text-neon-cyan">DATABASE_URL</code> set on the
                    host before it can store anything; until then every pass runs and writes
                    nothing.
                  </>
                )}
              </EmptyNote>
            )}

            {!loading && data && data.rows.length > 0 && (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[760px] text-[10px]">
                  <thead>
                    <tr className="text-left text-slate-500">
                      <th className="pb-1 pr-2 font-semibold uppercase tracking-wider">Scanner</th>
                      <th className="pb-1 pr-2 font-semibold uppercase tracking-wider">TF</th>
                      <th className="pb-1 pr-2 font-semibold uppercase tracking-wider">State</th>
                      <th className="pb-1 pr-2 text-right font-semibold uppercase tracking-wider">Rows</th>
                      <th className="pb-1 pr-2 text-right font-semibold uppercase tracking-wider">Scored</th>
                      <th className="pb-1 pr-2 text-right font-semibold uppercase tracking-wider">Hit</th>
                      <th className="pb-1 pr-2 text-right font-semibold uppercase tracking-wider">T/S/N</th>
                      <th className="pb-1 pr-2 text-right font-semibold uppercase tracking-wider">Med +ATR</th>
                      <th className="pb-1 pr-2 text-right font-semibold uppercase tracking-wider">Med −ATR</th>
                      <th className="pb-1 text-right font-semibold uppercase tracking-wider">Edge</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r) => (
                      <tr
                        key={`${r.scanner}-${r.timeframe}-${r.state}`}
                        className="border-t border-white/5"
                      >
                        <td className="py-1 pr-2 font-semibold text-slate-200">{r.scanner}</td>
                        <td className="py-1 pr-2 font-mono text-slate-400">{r.timeframe}</td>
                        <td className="py-1 pr-2 text-slate-400">{r.state}</td>
                        <td className="py-1 pr-2 text-right font-mono text-slate-400">{r.observed}</td>
                        <td className="py-1 pr-2 text-right font-mono text-slate-400">{r.scored}</td>
                        <td className="py-1 pr-2 text-right font-mono">
                          {r.hitRate == null ? (
                            <span
                              className="text-slate-600"
                              title={`Fewer than ${data.minSample} scored rows — too few for a rate to mean anything.`}
                            >
                              —
                            </span>
                          ) : (
                            <span className={r.hitRate >= 0.5 ? "text-bull" : "text-slate-300"}>
                              {Math.round(r.hitRate * 100)}%
                            </span>
                          )}
                        </td>
                        <td className="py-1 pr-2 text-right font-mono text-slate-500">
                          {r.target}/{r.stopped}/{r.neither}
                        </td>
                        <td className="py-1 pr-2 text-right font-mono text-slate-400">
                          {r.medianFavourableAtr.toFixed(1)}
                        </td>
                        <td className="py-1 pr-2 text-right font-mono text-slate-400">
                          {r.medianAdverseAtr.toFixed(1)}
                        </td>
                        <td className="py-1 text-right font-mono">
                          {r.edgeAtr == null ? (
                            <span className="text-slate-600">—</span>
                          ) : (
                            <span className={r.edgeAtr > 0 ? "text-bull" : "text-bear"}>
                              {r.edgeAtr > 0 ? "+" : ""}
                              {r.edgeAtr.toFixed(2)}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <p className="mt-2 text-[10px] leading-relaxed text-slate-600">
                  <strong>T/S/N</strong> is target / stopped / neither. <strong>Edge</strong> is the
                  mean of (favourable − adverse) in ATR, which is a crude expectancy and ignores
                  both fees and the fact that you would not hold every row for the full window.
                  Rows are ordered by how much evidence they carry, never by how good the number
                  looks — sorting by hit rate would put a 3-of-4 at the top of a page whose whole
                  purpose is to stop small samples reading as findings.
                </p>
              </div>
            )}
          </div>
        </GlassCard>
      </div>
    </AppShell>
  );
}
