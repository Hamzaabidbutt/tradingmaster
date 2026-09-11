"use client";

import { GlassCard, localTime } from "@/components/ui/primitives";
import { BarExcursion, FullAnalysis } from "@/engines/types";

/**
 * How the tape is being traded, rather than what it produced.
 *
 * Two readings that a candle chart cannot show, side by side:
 *
 *  - **Speed.** The same size spread across fifteen minutes and crammed into
 *    forty seconds are different events, and only the second one is somebody
 *    who has decided they must be done now. Size and trade count are shown
 *    apart because when they disagree the disagreement is the read: size
 *    without count is one participant, count without size is a liquidation
 *    engine or a crowd.
 *
 *  - **The delta path.** A bar's closing delta is a net figure, and netting
 *    destroys the interesting part. +200 held all the way through and +5,000
 *    handed back are the same closing number and opposite facts about who is
 *    in control. The second is absorption, and it is the one thing here worth
 *    building a trade around.
 *
 * The path reading needs lower-timeframe candles and says so plainly when it
 * does not have them, rather than modelling a path — a modelled path would be
 * a picture of the model's assumptions about intrabar order, which is exactly
 * what absorption would be invented out of.
 */
export default function TapePanel({ analysis }: { analysis: FullAnalysis | null }) {
  const speed = analysis?.tapeSpeed ?? null;
  const path = analysis?.deltaExcursion ?? null;
  const recent = path?.available ? path.bars.slice(-14) : [];

  return (
    <GlassCard
      title={
        <span className="flex items-center gap-2">
          Tape
          <span className="font-mono text-[9px] normal-case tracking-normal text-slate-600">
            speed &amp; delta path
          </span>
        </span>
      }
      className="h-full"
    >
      <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
        {/* ---------------- speed ---------------- */}
        <section>
          <div className="mb-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            Speed of tape
          </div>
          {!speed || speed.bars.length === 0 ? (
            <p className="text-[10px] text-slate-500">{speed?.headline ?? "Waiting for the analysis poll."}</p>
          ) : (
            <>
              <div
                className={`font-mono text-[11px] ${
                  speed.current?.extreme
                    ? "text-bear"
                    : speed.current?.burst
                      ? "text-neon-cyan"
                      : "text-slate-300"
                }`}
              >
                {speed.headline}
              </div>
              {speed.note && (
                <p className="mt-1 text-[10px] leading-relaxed text-slate-400">{speed.note}</p>
              )}

              {/* Rate against the market's own baseline, bar by bar. A bar sits
                  at half height when it is running at the normal rate, so a
                  burst reads as a spike rather than as "taller than its
                  neighbour". */}
              <div className="mt-2 flex h-10 items-end gap-[2px]">
                {speed.bars.slice(-40).map((b) => (
                  <div
                    key={b.time}
                    title={`${localTime(b.time)} · ${b.multiple.toFixed(1)}× normal${
                      b.tradesPerSecond != null ? ` · ${b.tradesPerSecond.toFixed(1)} trades/s` : ""
                    }`}
                    className={`flex-1 rounded-sm ${
                      b.extreme ? "bg-bear/80" : b.burst ? "bg-neon-cyan/70" : "bg-white/10"
                    }`}
                    style={{ height: `${Math.min(100, (b.multiple / 2) * 50)}%` }}
                  />
                ))}
              </div>
              <div className="mt-1 flex justify-between font-mono text-[9px] text-slate-600">
                <span>
                  baseline {speed.baselineVolumePerSecond.toFixed(2)}/s
                  {speed.baselineTradesPerSecond != null
                    ? ` · ${speed.baselineTradesPerSecond.toFixed(1)} trades/s`
                    : ""}
                </span>
                <span>{speed.resolution === "sub_bar" ? "sub-bar peaks" : "bar averages"}</span>
              </div>
            </>
          )}
        </section>

        {/* ---------------- delta path ---------------- */}
        <section className="border-t border-white/5 pt-2">
          <div className="mb-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            Intrabar delta path
          </div>
          {!path ? (
            <p className="text-[10px] text-slate-500">Waiting for the analysis poll.</p>
          ) : !path.available ? (
            <p className="text-[10px] leading-relaxed text-slate-500">{path.headline}</p>
          ) : (
            <>
              <div
                className={`font-mono text-[11px] ${
                  path.latestAbsorption ? "text-neon-amber" : "text-slate-300"
                }`}
              >
                {path.headline}
              </div>
              <ul className="mt-2 space-y-1">
                {recent
                  .slice()
                  .reverse()
                  .map((b) => (
                    <ExcursionRow key={b.time} bar={b} />
                  ))}
              </ul>
            </>
          )}
        </section>

        {/* ---------------- what to distrust ---------------- */}
        <ul className="mt-auto space-y-1 border-t border-white/5 pt-2">
          {[...(speed?.caveats ?? []), ...(path?.caveats ?? [])].map((c) => (
            <li key={c} className="text-[9px] leading-relaxed text-slate-600">
              {c}
            </li>
          ))}
        </ul>
      </div>
    </GlassCard>
  );
}

const VERDICT_LABEL: Record<BarExcursion["verdict"], string> = {
  clean_buying: "clean buying",
  clean_selling: "clean selling",
  absorbed_buying: "buying absorbed",
  absorbed_selling: "selling absorbed",
  two_sided: "two-sided",
};

const VERDICT_TONE: Record<BarExcursion["verdict"], string> = {
  clean_buying: "text-bull",
  clean_selling: "text-bear",
  absorbed_buying: "text-neon-amber",
  absorbed_selling: "text-neon-amber",
  two_sided: "text-slate-500",
};

function ExcursionRow({ bar }: { bar: BarExcursion }) {
  return (
    <li
      title={bar.note}
      className="flex items-center justify-between gap-2 rounded-md border border-white/5 bg-white/[0.02] px-2 py-1"
    >
      <span className="font-mono text-[10px] text-slate-500">{localTime(bar.time)}</span>
      <span className={`text-[9px] font-semibold uppercase tracking-[0.1em] ${VERDICT_TONE[bar.verdict]}`}>
        {VERDICT_LABEL[bar.verdict]}
      </span>
      {/* Peak, trough and close together, because the gap between them is the
          entire point — the close alone is the number that hides it. */}
      <span className="font-mono text-[9px] text-slate-600">
        <span className="text-bull/70">+{bar.maxDelta.toFixed(0)}</span>
        {" / "}
        <span className="text-bear/70">{bar.minDelta.toFixed(0)}</span>
        {" → "}
        <span className="text-slate-300">
          {bar.closeDelta >= 0 ? "+" : ""}
          {bar.closeDelta.toFixed(0)}
        </span>
      </span>
    </li>
  );
}
