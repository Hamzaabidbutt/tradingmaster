"use client";

import { SideBadge, fmtPct, fmtPrice, fmtVolume, useOpenInTerminal } from "./shared";
import type {
  InstitutionalFunding,
  InstitutionalHistory,
  InstitutionalRange,
  InstitutionalSetup,
} from "@/engines/types";

export interface InstitutionalCardEntry {
  symbol: string;
  label: string;
  timeframe: string;
  quoteVolume: number;
  priceChangePercent: number | null;
  setup: InstitutionalSetup;
}

/**
 * One institutional footprint, rendered in the same shape as a dashboard setup.
 *
 *   UNI/USDT — LONG · Score 81 · Entry / Stop / TP1 / TP2 / TP3 / R:R
 *   Supporting Analysis
 *     ✓ Selling absorbed — …
 *     – Unfilled demand gap — not present
 *   Both sides · Range · Funding · Historical record
 *
 * Two rules carried over from `SetupCard`, for the same reasons:
 *
 *  * **What was *not* found is shown, not hidden.** A card listing only the
 *    six items that fired would make a 6-of-11 read look like an 11-of-11 one.
 *    The misses are printed with their reasons underneath the hits.
 *  * **The opposing case is rendered.** The supply score sits next to the
 *    demand score on every card, because a demand read is worth far less when
 *    supply reads nearly as strong — and a score that quietly absorbed that
 *    context tells you less than two numbers side by side.
 *
 * A card without `setup.trade` is a read, not a signal. It still shows every
 * level and all the evidence; it just has no entry, because the geometry did
 * not justify one and inventing a price would be inventing a conclusion.
 */
export default function InstitutionalSetupCard({
  entry,
  rank,
  compact = false,
}: {
  entry: InstitutionalCardEntry;
  rank?: number;
  compact?: boolean;
}) {
  const open = useOpenInTerminal();
  const s = entry.setup;
  const distribution = s.supply.score > s.demand.score;
  const lead = distribution ? s.supply : s.demand;
  const other = distribution ? s.demand : s.supply;
  const side = distribution ? "SHORT" : "LONG";
  const isLong = !distribution;
  const trade = s.trade;

  const found = lead.evidence.filter((e) => e.found);
  const missing = lead.evidence.filter((e) => !e.found);

  return (
    <article
      className={`rounded-xl border bg-white/[0.02] transition-colors hover:bg-white/[0.045] ${
        isLong ? "border-bull/20" : "border-bear/20"
      }`}
    >
      <button
        onClick={() => open(entry.symbol, entry.timeframe)}
        className="w-full px-3 py-2.5 text-left"
        aria-label={`Open ${entry.label} in the terminal`}
      >
        <header className="flex flex-wrap items-center gap-2">
          {rank !== undefined && (
            <span className="font-mono text-[10px] text-slate-600">#{rank}</span>
          )}
          <span className="text-sm font-bold text-slate-100">{entry.label}</span>
          <SideBadge side={side} />
          <span
            className={`font-mono text-sm font-bold ${isLong ? "text-bull" : "text-bear"}`}
            title="Conviction that size was worked here — not a probability of profit"
          >
            {s.score}
          </span>
          <span className="text-[10px] uppercase tracking-wider text-slate-500">
            {s.grade}
            {!s.qualified && " · unqualified"}
          </span>
          <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[9px] text-slate-400">
            {found.length}/{lead.evidence.length} items
          </span>
          {s.zone && (
            <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[9px] text-neon-cyan">
              {s.zone.confluence} kinds converging
            </span>
          )}
          <span className="ml-auto flex items-center gap-2 font-mono text-[10px] text-slate-600">
            <span>{entry.timeframe}</span>
            <span>{fmtVolume(entry.quoteVolume)}</span>
            <span
              className={
                entry.priceChangePercent === null
                  ? "text-slate-600"
                  : entry.priceChangePercent >= 0
                    ? "text-bull/70"
                    : "text-bear/70"
              }
            >
              {fmtPct(entry.priceChangePercent)}
            </span>
          </span>
        </header>

        {/* Levels. The trade row when there is one, the read's own levels when
            there is not — a footprint without tradable geometry still has an
            area, a confirmation and an invalidation. */}
        {trade ? (
          <div className="mt-2 grid grid-cols-3 gap-x-4 gap-y-1 font-mono text-[11px] sm:grid-cols-6">
            <Level label="Entry" value={trade.entry} />
            <Level label="Stop" value={trade.stopLoss} tone="bear" />
            <Level label="TP1" value={trade.tp1} tone={isLong ? "bull" : "bear"} />
            <Level label="TP2" value={trade.tp2} tone={isLong ? "bull" : "bear"} />
            <Level label="TP3" value={trade.tp3} tone={isLong ? "bull" : "bear"} />
            <Level label="R:R" value={trade.riskReward} raw />
          </div>
        ) : (
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px] sm:grid-cols-4">
            <Level label="Price" value={s.price} />
            <Level label="Area" value={s.zone ? s.zone.mid : null} />
            <Level
              label={distribution ? "Confirm below" : "Confirm above"}
              value={s.confirmLevel}
              tone={isLong ? "bull" : "bear"}
            />
            <Level
              label={distribution ? "Invalidate above" : "Invalidate below"}
              value={s.invalidateLevel}
              tone={isLong ? "bear" : "bull"}
            />
          </div>
        )}

        <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">{s.headline}</p>
      </button>

      {!compact && (
        <div className="space-y-2 border-t border-white/5 px-3 py-2.5">
          {!trade && (
            <p className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-[11px] leading-relaxed text-slate-400">
              No trade taken from this read. The levels above stand — the geometry between them
              does not justify an entry, and putting an entry price on it anyway would be inventing
              a conclusion the engine declined to draw.
            </p>
          )}

          <h5 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            Supporting Analysis
          </h5>
          <ul className="space-y-1.5">
            {found.map((e) => (
              <li key={e.key} className="flex gap-2 text-[11px] leading-relaxed">
                <span className={isLong ? "text-bull" : "text-bear"}>✓</span>
                <span className="text-slate-400">
                  <span className="font-semibold text-slate-300">{e.label}</span>{" "}
                  <span className="text-slate-600">
                    ({e.score.toFixed(0)}/{e.weight}
                    {e.price != null ? ` at ${fmtPrice(e.price)}` : ""})
                  </span>{" "}
                  — {e.detail}
                </span>
              </li>
            ))}
            {missing.map((e) => (
              <li key={`miss-${e.key}`} className="flex gap-2 text-[11px] leading-relaxed">
                <span className="text-slate-600">–</span>
                <span className="text-slate-600">
                  <span className="font-semibold">{e.label}</span> — {e.detail}
                </span>
              </li>
            ))}
          </ul>

          {/* The opposing side, always. */}
          <div
            className={`rounded-lg border px-2.5 py-1.5 text-[11px] leading-relaxed ${
              other.score >= lead.score - 8
                ? "border-neon-amber/25 bg-neon-amber/[0.06] text-neon-amber/90"
                : "border-white/5 bg-white/[0.02] text-slate-400"
            }`}
          >
            {other.score >= lead.score - 8 ? (
              <>
                Both sides read close — {isLong ? "demand" : "supply"} {lead.score} on {lead.kinds}{" "}
                items against {isLong ? "supply" : "demand"} {other.score} on {other.kinds}. That is
                not a footprint on either side; it is a market leaving marks in both directions,
                which is what a contested area looks like.
              </>
            ) : (
              <>
                The other side is weaker — {isLong ? "supply" : "demand"} scores {other.score} on{" "}
                {other.kinds} items against this side&apos;s {lead.score} on {lead.kinds}. The
                asymmetry is the point: one-sided evidence is what separates a worked order from
                ordinary two-way trade.
              </>
            )}
          </div>

          <RangeLine range={s.range} />
          <FundingLine funding={s.funding} wantsPayer={isLong ? "shorts" : "longs"} />
          <HistoryLine history={s.history} />

          <details className="group">
            <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-slate-500 hover:text-neon-cyan">
              Why this read ▾
            </summary>
            <ul className="mt-1.5 space-y-1">
              {s.explanation.map((line, i) => (
                <li key={i} className="flex gap-2 text-[11px] leading-relaxed text-slate-400">
                  <span className="text-neon-cyan">›</span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
            {s.zones.length > 1 && (
              <div className="mt-1.5">
                <div className="pb-1 text-[9px] uppercase tracking-wider text-slate-600">
                  Other areas with converging evidence
                </div>
                {s.zones.slice(1, 5).map((z, i) => (
                  <div key={i} className="font-mono text-[10px] text-slate-500">
                    {fmtPrice(z.low)}–{fmtPrice(z.high)} · {z.distancePct >= 0 ? "+" : ""}
                    {z.distancePct.toFixed(2)}% · {z.confluence} kinds ({z.sources.join(", ")})
                  </div>
                ))}
              </div>
            )}
          </details>
        </div>
      )}
    </article>
  );
}

function RangeLine({ range }: { range: InstitutionalRange | null }) {
  if (!range) {
    return (
      <p className="text-[11px] leading-relaxed text-slate-500">
        <span className="font-semibold text-slate-400">Range</span> — none. The market is trending,
        so range position scores nothing rather than inventing a boundary out of a lookback high
        and low.
      </p>
    );
  }
  return (
    <p className="text-[11px] leading-relaxed text-slate-400">
      <span className="font-semibold text-slate-300">Range</span> {fmtPrice(range.low)}–
      {fmtPrice(range.high)} over {range.bars} bars, price at{" "}
      <span className="text-neon-cyan">{(range.position * 100).toFixed(0)}%</span>. Low touched{" "}
      {range.touchesLow}×, high {range.touchesHigh}× — the checklist is located against boundaries
      the market has actually defended.
    </p>
  );
}

function FundingLine({
  funding,
  wantsPayer,
}: {
  funding: InstitutionalFunding | null;
  wantsPayer: "longs" | "shorts";
}) {
  if (!funding) {
    return (
      <p className="text-[11px] leading-relaxed text-slate-500">
        <span className="font-semibold text-slate-400">Funding</span> — unavailable for this
        symbol, so who is paying to hold the other side cannot be read.
      </p>
    );
  }
  const supports = funding.payer === wantsPayer;
  return (
    <p className="text-[11px] leading-relaxed text-slate-400">
      <span className="font-semibold text-slate-300">Funding</span>{" "}
      <span className={funding.payer === "shorts" ? "text-bull" : funding.payer === "longs" ? "text-bear" : "text-slate-400"}>
        {funding.payer === "balanced" ? "flat" : `${funding.payer} pay`}
      </span>{" "}
      {funding.avgRatePct >= 0 ? "+" : ""}
      {funding.avgRatePct.toFixed(4)}% average over {funding.samples} settlements (
      {(funding.consistency * 100).toFixed(0)}% consistent, {funding.cumulativePct.toFixed(3)}%
      cumulative).{" "}
      {funding.payer === "balanced"
        ? "Nobody is paying meaningfully to hold either side, so there is no crowded cohort here."
        : supports
          ? "The crowd on the other side is being charged to stay there, which is the positioning half of this read."
          : "The paying side is the same one this read points, so funding argues against the footprint rather than for it."}
    </p>
  );
}

function HistoryLine({ history }: { history: InstitutionalHistory }) {
  return (
    <p className="text-[11px] leading-relaxed text-slate-400">
      <span className="font-semibold text-slate-300">Record</span>{" "}
      {history.holdRatePct != null ? (
        <>
          <span className="text-neon-cyan">{history.holdRatePct.toFixed(0)}% held</span> across{" "}
          {history.samples} comparable areas earlier in this series ({history.held} held,{" "}
          {history.broke} broke)
          {history.medianFavourablePct != null && (
            <>
              , median +{history.medianFavourablePct.toFixed(2)}% in favour against{" "}
              {history.medianAdversePct?.toFixed(2)}% adverse
            </>
          )}
          . Measured on this symbol, this timeframe, this window — a record, not an edge.
        </>
      ) : (
        <>
          {history.samples} resolved case{history.samples === 1 ? "" : "s"} — too few to quote a
          rate. At this sample size one outcome moves the percentage by ten points, so the number
          is withheld rather than shown.
        </>
      )}
    </p>
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
