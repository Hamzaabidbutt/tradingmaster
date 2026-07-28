"use client";

import { FullAnalysis } from "@/engines/types";
import { GlassCard } from "@/components/ui/primitives";

/** Support/resistance table + candlestick pattern feed. */
export default function LevelsPanel({ analysis }: { analysis: FullAnalysis | null }) {
  return (
    <GlassCard title="Key Levels & Patterns" className="h-full">
      {!analysis ? (
        <div className="p-4 text-xs text-slate-500">Scanning levels…</div>
      ) : (
        <div className="flex h-full flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <table className="w-full text-[10px]">
              <thead>
                <tr className="text-left uppercase tracking-wider text-slate-600">
                  <th className="pb-1 font-medium">Level</th>
                  <th className="pb-1 text-right font-medium">Strength</th>
                  <th className="pb-1 text-right font-medium">Touches</th>
                  <th className="pb-1 text-right font-medium">Bounce</th>
                  <th className="pb-1 text-right font-medium">Break</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {analysis.srLevels.map((l) => (
                  <tr key={l.id} className="border-t border-white/5">
                    <td className={`py-1 ${l.kind === "support" ? "text-bull" : "text-bear"}`}>
                      {l.kind === "support" ? "S" : "R"} {l.price.toFixed(4)}
                      {l.volumeConfirmed && <span className="ml-1 text-neon-amber" title="Volume confirmed">◆</span>}
                    </td>
                    <td className="py-1 text-right">
                      <span className="inline-block w-8 rounded bg-white/5 text-center">{l.strength}</span>
                    </td>
                    <td className="py-1 text-right text-slate-400">{l.touches}</td>
                    <td className="py-1 text-right text-bull">{l.bounceProbability}%</td>
                    <td className="py-1 text-right text-bear">{l.breakProbability}%</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="mt-3 border-t border-white/5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Recent candle patterns
            </div>
            <div className="mt-2 space-y-1.5">
              {analysis.patterns.slice(-6).reverse().map((p, i) => (
                <div key={i} className="flex items-center justify-between rounded-md bg-white/[0.02] px-2 py-1.5">
                  <div>
                    <span
                      className={`text-[11px] font-semibold ${
                        p.direction === "bullish" ? "text-bull" : p.direction === "bearish" ? "text-bear" : "text-slate-300"
                      }`}
                    >
                      {p.name}
                    </span>
                    <p className="text-[9px] text-slate-500">{p.context}</p>
                  </div>
                  <div className="shrink-0 text-right font-mono text-[9px] text-slate-400">
                    <div>str {p.strength}</div>
                    <div>p {p.probability}%</div>
                  </div>
                </div>
              ))}
              {analysis.patterns.length === 0 && (
                <p className="text-center text-[10px] text-slate-600">No significant patterns in the recent window.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </GlassCard>
  );
}
