"use client";

import { useMemo, useState } from "react";
import { GlassCard, localTime } from "@/components/ui/primitives";
import { CLUSTER_PRESETS, searchClusters } from "@/engines/clusterSearch";
import { FullAnalysis } from "@/engines/types";

/**
 * Cluster Search — asking the footprint a question instead of reading it.
 *
 * Everything on screen here is already inside the footprint grid two panels
 * up. The difference is direction: the grid presents thirty bars × twelve
 * levels and leaves the reader to find the cells that matter, which is a
 * search problem the eye is bad at and gives up on. This states the property
 * first and returns the levels that have it.
 *
 * Presets rather than a filter form. A blank form asks the reader to already
 * know which numbers matter, which is the thing they opened the panel to find
 * out — and every preset here is written in multiples of the window's own
 * average cluster, so the same question works on any symbol without retuning.
 *
 * The unfinished-auction list sits alongside because it answers the same kind
 * of question — which price levels are worth marking — from the opposite
 * direction: not where the most business was done, but where business was left
 * undone.
 */
export default function ClusterSearchPanel({
  analysis,
  pricePrecision,
}: {
  analysis: FullAnalysis | null;
  pricePrecision: number;
}) {
  const [presetId, setPresetId] = useState(CLUSTER_PRESETS[0].id);
  const preset = CLUSTER_PRESETS.find((p) => p.id === presetId) ?? CLUSTER_PRESETS[0];

  /* Run in the browser, over the footprint the analysis already shipped. The
     search is a filter across ~360 cells, so a round trip to the server would
     cost more than the work and make switching presets feel like loading. */
  const result = useMemo(
    () => (analysis ? searchClusters(analysis.footprint, { ...preset.query, limit: 24 }) : null),
    [analysis, preset]
  );

  const open = useMemo(
    () => (analysis?.unfinishedAuctions ?? []).filter((u) => !u.filled).slice(-6).reverse(),
    [analysis]
  );

  const p = (v: number) => v.toFixed(pricePrecision);

  return (
    <GlassCard
      title={
        <span className="flex items-center gap-2">
          Cluster Search
          <span className="font-mono text-[9px] normal-case tracking-normal text-slate-600">
            {analysis
              ? analysis.footprint.fidelity === "sub_candle"
                ? "reconstructed"
                : "modelled — shortlist only"
              : ""}
          </span>
        </span>
      }
      className="h-full"
    >
      <div className="flex h-full flex-col gap-2 overflow-y-auto p-3">
        {/* ---- the question ---- */}
        <div className="flex flex-wrap gap-1">
          {CLUSTER_PRESETS.map((item) => (
            <button
              key={item.id}
              onClick={() => setPresetId(item.id)}
              title={item.description}
              aria-pressed={item.id === presetId}
              className={`rounded-md border px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.1em] transition-colors ${
                item.id === presetId
                  ? "border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan"
                  : "border-white/5 bg-white/[0.02] text-slate-500 hover:border-white/15 hover:text-slate-300"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <p className="text-[10px] leading-relaxed text-slate-400">{preset.description}</p>

        {!analysis ? (
          <p className="text-[10px] text-slate-500">Waiting for the analysis poll.</p>
        ) : (
          <>
            <div className="font-mono text-[10px] text-slate-300">{result?.headline}</div>

            {/* ---- hits ---- */}
            {result && result.hits.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[420px] border-collapse text-[10px]">
                  <thead>
                    <tr className="text-[9px] uppercase tracking-[0.12em] text-slate-600">
                      <th className="px-1 py-1 text-left font-semibold">Time</th>
                      <th className="px-1 py-1 text-right font-semibold">Price</th>
                      <th className="px-1 py-1 text-right font-semibold">Size</th>
                      <th className="px-1 py-1 text-right font-semibold">Δ share</th>
                      <th className="px-1 py-1 text-left font-semibold">Where</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {result.hits.map((h) => (
                      <tr
                        key={`${h.time}:${h.price}`}
                        title={h.reason}
                        className="border-t border-white/5"
                      >
                        <td className="px-1 py-1 text-slate-500">{localTime(h.time)}</td>
                        <td className="px-1 py-1 text-right text-slate-200">{p(h.price)}</td>
                        <td className="px-1 py-1 text-right text-neon-cyan">{h.volumeX.toFixed(1)}×</td>
                        <td
                          className={`px-1 py-1 text-right ${
                            h.deltaPercent >= 0 ? "text-bull" : "text-bear"
                          }`}
                        >
                          {h.deltaPercent >= 0 ? "+" : ""}
                          {h.deltaPercent.toFixed(0)}%
                        </td>
                        <td className="px-1 py-1 text-[9px] uppercase tracking-[0.08em] text-slate-500">
                          {[
                            h.isPoc ? "bar POC" : null,
                            h.atExtreme ? `at ${h.atExtreme}` : null,
                            h.imbalance ? `${h.imbalance} ${h.imbalanceRatio.toFixed(0)}×` : null,
                          ]
                            .filter(Boolean)
                            .join(" · ") || "mid-bar"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* ---- unfinished auctions ---- */}
            <div className="mt-1 border-t border-white/5 pt-2">
              <div className="mb-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                Unfinished auctions · still open
              </div>
              {open.length === 0 ? (
                <p className="text-[10px] leading-relaxed text-slate-500">
                  No open extremes in the window. Every bar high and low was either tested cleanly —
                  one side absent, nothing left to settle — or has since been traded through.
                </p>
              ) : (
                <ul className="space-y-1">
                  {open.map((u) => (
                    <li
                      key={`${u.time}:${u.side}`}
                      title={u.note}
                      className="flex items-center justify-between gap-2 rounded-md border border-white/5 bg-white/[0.02] px-2 py-1"
                    >
                      <span className="font-mono text-[10px] text-slate-500">{localTime(u.time)}</span>
                      <span
                        className={`text-[9px] font-semibold uppercase tracking-[0.1em] ${
                          u.side === "high" ? "text-bull" : "text-bear"
                        }`}
                      >
                        {u.side === "high" ? "open high" : "open low"}
                      </span>
                      <span className="font-mono text-[10px] text-slate-200">{p(u.price)}</span>
                      <span className="font-mono text-[9px] text-slate-600">
                        {(u.balance * 100).toFixed(0)}% split
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-1 text-[9px] leading-relaxed text-slate-600">
                Both sides were still trading at these extremes when the bar closed, so nothing was
                settled there. Open levels act as magnets — a tendency, not a schedule; some are
                never revisited.
              </p>
            </div>

            {/* ---- what to distrust ---- */}
            {result && result.caveats.length > 0 && (
              <ul className="mt-1 space-y-1 border-t border-white/5 pt-2">
                {result.caveats.map((c) => (
                  <li key={c} className="text-[9px] leading-relaxed text-slate-600">
                    {c}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </GlassCard>
  );
}
