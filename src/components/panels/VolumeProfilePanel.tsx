"use client";

import { FullAnalysis } from "@/engines/types";
import { GlassCard } from "@/components/ui/primitives";

const SHAPE_LABEL: Record<string, string> = {
  D: "D — balanced",
  P: "P — short covering",
  b: "b — long liquidation",
  B: "B — double distribution",
};

/** Volume profile + auction theory read (POC / value area / HVN / LVN). */
export default function VolumeProfilePanel({ analysis }: { analysis: FullAnalysis | null }) {
  const vp = analysis?.volumeProfile;

  return (
    <GlassCard title="Volume Profile & Auction" className="h-full">
      {!vp || !analysis ? (
        <div className="p-4 text-xs text-slate-500">Building profile…</div>
      ) : (
        <div className="flex h-full flex-col">
          <div className="shrink-0 space-y-3 p-3">
            <div className="flex flex-wrap gap-1.5">
              <Tag
                text={vp.auctionState === "balance" ? "Balanced" : "Imbalanced"}
                tone={vp.auctionState === "balance" ? "cyan" : "amber"}
              />
              <Tag
                text={vp.acceptance.replace(/_/g, " ")}
                tone={vp.acceptance === "above_value" ? "bull" : vp.acceptance === "below_value" ? "bear" : "slate"}
              />
              <Tag text={SHAPE_LABEL[vp.shape] ?? vp.shape} tone="violet" />
            </div>

            {/* Value area ladder */}
            <div className="space-y-1 font-mono text-[11px]">
              <Row label="VAH" value={vp.vah} tone="text-bear" note="value area high" />
              <Row label="POC" value={vp.poc} tone="text-neon-amber" note="point of control" bold />
              <Row label="VAL" value={vp.val} tone="text-bull" note="value area low" />
            </div>

            {/* Mini horizontal profile */}
            <MiniProfile vp={vp} price={analysis.price} />

            {vp.lvns.length > 0 && (
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
                  Low Volume Nodes — price rejects here
                </div>
                <div className="flex flex-wrap gap-1">
                  {vp.lvns.slice(0, 4).map((n) => (
                    <span key={n.price} className="rounded-md bg-neon-violet/10 px-1.5 py-0.5 font-mono text-[10px] text-neon-violet">
                      {n.price.toFixed(4)}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {vp.hvns.length > 0 && (
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
                  High Volume Nodes — price accepted here
                </div>
                <div className="flex flex-wrap gap-1">
                  {vp.hvns.slice(0, 4).map((n) => (
                    <span key={n.price} className="rounded-md bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-slate-300">
                      {n.price.toFixed(4)}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto border-t border-white/5 px-3 py-2">
            {vp.summary.map((s, i) => (
              <p key={i} className="text-[10px] leading-relaxed text-slate-400">• {s}</p>
            ))}
          </div>
        </div>
      )}
    </GlassCard>
  );
}

function Row({ label, value, tone, note, bold }: { label: string; value: number; tone: string; note: string; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between rounded-md bg-white/[0.03] px-2 py-1">
      <span className={`${tone} ${bold ? "font-bold" : ""}`}>{label}</span>
      <span className="text-slate-500">{note}</span>
      <span className={`${tone} ${bold ? "font-bold" : ""}`}>{value.toFixed(4)}</span>
    </div>
  );
}

function MiniProfile({ vp, price }: { vp: NonNullable<FullAnalysis["volumeProfile"]>; price: number }) {
  const maxVol = Math.max(...vp.rows.map((r) => r.volume), 1e-9);
  // Render top-down (highest price first).
  const rows = [...vp.rows].reverse();
  return (
    <div className="rounded-lg bg-black/20 p-1.5" aria-label="Volume profile histogram">
      {rows.map((r, i) => {
        const w = (r.volume / maxVol) * 100;
        const inValue = r.price >= vp.val && r.price <= vp.vah;
        const isPoc = Math.abs(r.price - vp.poc) < 1e-9;
        const atPrice = Math.abs(r.price - price) / price < 0.002;
        const buyShare = r.volume > 0 ? r.buyVolume / r.volume : 0.5;
        return (
          <div key={i} className="flex h-[3px] items-center gap-0.5">
            <div className="relative h-full flex-1">
              <div
                className={`absolute right-0 h-full ${isPoc ? "bg-neon-amber" : inValue ? "bg-slate-400/40" : "bg-slate-600/30"}`}
                style={{ width: `${w}%` }}
              />
              <div
                className="absolute right-0 h-full bg-bull/40"
                style={{ width: `${w * buyShare}%` }}
              />
            </div>
            {atPrice && <span className="h-full w-1 shrink-0 bg-neon-cyan" title="current price" />}
          </div>
        );
      })}
    </div>
  );
}

function Tag({ text, tone }: { text: string; tone: "bull" | "bear" | "cyan" | "amber" | "violet" | "slate" }) {
  const color =
    tone === "bull" ? "border-bull/30 text-bull"
      : tone === "bear" ? "border-bear/30 text-bear"
      : tone === "amber" ? "border-neon-amber/30 text-neon-amber"
      : tone === "violet" ? "border-neon-violet/30 text-neon-violet"
      : tone === "cyan" ? "border-neon-cyan/30 text-neon-cyan"
      : "border-slate-500/30 text-slate-400";
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${color}`}>
      {text}
    </span>
  );
}
