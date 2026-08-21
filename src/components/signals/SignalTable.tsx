"use client";

import { Fragment } from "react";
import { AnalystKey, OutcomeAnalysis } from "@/engines/types";
import { SignalRow, stringsOf, verdictsOf } from "@/hooks/useDashboard";
import {
  ANALYST_LABEL,
  basesLabel,
  fmtPct,
  fmtPrice,
  fmtVolume,
  gateReason,
  opponentsOf,
  outcomeLabel,
  supportersOf,
  useOpenInTerminal,
} from "@/components/dashboard/shared";

/**
 * The Signal History table.
 *
 * One row per signal with everything the record is supposed to carry, and an
 * expandable panel holding the parts that do not fit a cell: the explanation
 * generated at signal time, each analyst's verdict *as it stood then*, the
 * invalidation conditions, and the outcome analysis.
 *
 * Status and Result are separate columns on purpose. Status is the lifecycle
 * bucket — Active / Successful / Failed / Expired, decided by the sign of the
 * realised P/L exactly as the API filters and the performance dashboard decide
 * it. Result is the raw mechanical ending (TP3 hit, stopped, expired). A signal
 * that tagged TP2 and then reversed into a net loss is `Failed` with a result
 * of `Stopped`, and collapsing the two columns would hide that.
 */

const ACTIVE_STATUSES = new Set(["ACTIVE", "TP1_HIT", "TP2_HIT"]);

type Bucket = "active" | "successful" | "failed" | "expired";

function bucketOf(s: SignalRow): Bucket {
  if (ACTIVE_STATUSES.has(s.status)) return "active";
  const pnl = s.resultPnlPct ?? 0;
  if (pnl > 0) return "successful";
  if (s.status === "EXPIRED") return "expired";
  return "failed";
}

const BUCKET_STYLE: Record<Bucket, string> = {
  active: "border-neon-cyan/30 bg-neon-cyan/10 text-neon-cyan",
  successful: "border-bull/35 bg-bull/10 text-bull",
  failed: "border-bear/35 bg-bear/10 text-bear",
  expired: "border-slate-500/30 bg-slate-500/10 text-slate-400",
};

const RESULT_LABEL: Record<string, string> = {
  ACTIVE: "Running",
  TP1_HIT: "TP1 tagged, running",
  TP2_HIT: "TP2 tagged, running",
  TP3_HIT: "Full target",
  STOPPED: "Stopped out",
  EXPIRED: "Expired",
};

/**
 * Market conditions at signal time, from `marketSnapshot`.
 *
 * Two shapes exist — the composite engine stores bias/trend/flow, the
 * confluence scanner stores the two directional confidences and the
 * independence count. Both are summarised rather than one being privileged,
 * because a legacy row is still a row someone wants to read.
 */
function conditionLines(snapshot: unknown): string[] {
  if (!snapshot || typeof snapshot !== "object") return [];
  const s = snapshot as Record<string, unknown>;
  const out: string[] = [];
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

  if (typeof s.bias === "string") out.push(`bias ${s.bias}`);
  const bp = num(s.bullishProbability);
  if (bp !== null) out.push(`${bp.toFixed(0)}% bullish`);
  if (typeof s.trend === "string") out.push(`trend ${s.trend}`);
  const vr = num(s.volumeRelative);
  if (vr !== null) out.push(`vol ×${vr.toFixed(2)}`);
  const cd = num(s.cumulativeDelta);
  if (cd !== null) out.push(`CVD ${cd >= 0 ? "+" : ""}${cd.toFixed(0)}`);

  if (typeof s.confluenceVerdict === "string") out.push(`${s.confluenceVerdict} confluence`);
  const bases = num(s.independentBases);
  if (bases !== null) out.push(basesLabel(bases));
  const lc = num(s.longConfidence);
  const sc = num(s.shortConfidence);
  if (lc !== null && sc !== null) out.push(`L ${lc.toFixed(0)} / S ${sc.toFixed(0)}`);
  if (s.disagreement === true) out.push("analysts disagreed");
  const qv = num(s.quoteVolume);
  if (qv !== null) out.push(`24h ${fmtVolume(qv)}`);
  const pc = num(s.priceChangePercent);
  if (pc !== null) out.push(`24h ${fmtPct(pc)}`);

  return out;
}

/**
 * Which strategy generated this signal, and which analysts stood behind it.
 *
 * Agreement is direction-checked, not merely "qualified" — see `supportersOf`.
 * A COMPOSITE signal records all three verdicts whatever they said, so an
 * analyst can be on record opposing the very trade it is listed against.
 */
function strategyOf(s: SignalRow): { generator: string; analysts: string[]; against: string[] } {
  const verdicts = verdictsOf(s.analystVerdicts);
  const name = (v: { analyst: string; name: string }) =>
    ANALYST_LABEL[v.analyst as AnalystKey] ?? v.name;
  return {
    generator: s.source === "CONFLUENCE" ? "Confluence" : s.source === "COMPOSITE" ? "Composite" : "Legacy",
    analysts: supportersOf(verdicts, s.side).map(name),
    against: opponentsOf(verdicts, s.side).map(name),
  };
}

const TH = "px-2 py-1.5 text-left text-[9px] font-semibold uppercase tracking-wider text-slate-500";
const TD = "px-2 py-1.5 align-top";

export default function SignalTable({
  signals,
  loading,
  error,
  expanded,
  onExpand,
}: {
  signals: SignalRow[];
  loading: boolean;
  error: string | null;
  expanded: string | null;
  onExpand: (id: string | null) => void;
}) {
  const open = useOpenInTerminal();

  if (signals.length === 0) {
    return (
      <div className="glass p-8 text-center">
        <p className="text-sm leading-relaxed text-slate-400">
          {loading
            ? "Loading signals…"
            : error
              ? `Signals unavailable — ${error}.`
              : "No signals match these filters. Signals persist automatically whenever the engine finds qualifying confluence — keep the terminal open or start the background worker."}
        </p>
      </div>
    );
  }

  return (
    <div className="glass overflow-x-auto">
      <table className="w-full min-w-[1100px] border-collapse font-mono text-[11px]">
        <thead className="border-b border-white/10 bg-white/[0.02]">
          <tr>
            <th className={TH}>Coin</th>
            <th className={TH}>Type</th>
            <th className={TH}>Strategy / analyst</th>
            <th className={TH}>Entry</th>
            <th className={TH}>Stop</th>
            <th className={TH}>Targets</th>
            <th className={TH}>Signal time</th>
            <th className={TH}>TF</th>
            <th className={TH}>Confidence</th>
            <th className={TH}>Market conditions</th>
            <th className={TH}>Status</th>
            <th className={TH}>Result</th>
            <th className={TH}>P/L %</th>
            <th className={TH}>Reason</th>
          </tr>
        </thead>
        <tbody>
          {signals.map((s) => {
            const bucket = bucketOf(s);
            const strat = strategyOf(s);
            const conditions = conditionLines(s.marketSnapshot);
            const isOpen = expanded === s.id;
            return (
              <Fragment key={s.id}>
                <tr
                  onClick={() => onExpand(isOpen ? null : s.id)}
                  className={`cursor-pointer border-b border-white/5 transition-colors hover:bg-white/[0.04] ${
                    isOpen ? "bg-white/[0.04]" : ""
                  }`}
                >
                  <td className={`${TD} font-semibold text-slate-200`}>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        open(s.symbol, s.timeframe);
                      }}
                      className="hover:text-neon-cyan"
                      title="Open in terminal"
                    >
                      {s.symbol.replace(/USDT$/, "")}
                    </button>
                  </td>
                  <td className={TD}>
                    <span className={s.side === "BUY" ? "text-bull" : "text-bear"}>
                      {s.side === "BUY" ? "▲ LONG" : "▼ SHORT"}
                    </span>
                  </td>
                  <td className={`${TD} max-w-[10rem] text-slate-400`}>
                    <span className="text-slate-300">{strat.generator}</span>
                    {strat.analysts.length > 0 && (
                      <span className="block text-[10px] text-slate-600">
                        {strat.analysts.join(", ")}
                      </span>
                    )}
                    {strat.against.length > 0 && (
                      <span className="block text-[10px] text-neon-amber/70">
                        against {strat.against.join(", ")}
                      </span>
                    )}
                  </td>
                  <td className={`${TD} text-slate-300`}>{fmtPrice(s.entry)}</td>
                  <td className={`${TD} text-bear/90`}>{fmtPrice(s.stopLoss)}</td>
                  <td className={`${TD} text-bull/90`}>
                    {fmtPrice(s.tp1)}
                    <span className="block text-[10px] text-bull/60">
                      {fmtPrice(s.tp2)} / {fmtPrice(s.tp3)}
                    </span>
                  </td>
                  <td className={`${TD} text-slate-500`}>
                    {new Date(s.createdAt).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </td>
                  <td className={`${TD} text-slate-400`}>{s.timeframe}</td>
                  <td className={TD}>
                    <span className="text-neon-cyan">{s.confidence.toFixed(0)}%</span>
                    <span className="block text-[10px] text-slate-600">{s.confidenceLabel}</span>
                  </td>
                  <td className={`${TD} max-w-[12rem] text-[10px] leading-relaxed text-slate-500`}>
                    {conditions.length > 0 ? conditions.slice(0, 3).join(" · ") : "—"}
                  </td>
                  <td className={TD}>
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${BUCKET_STYLE[bucket]}`}
                    >
                      {bucket}
                    </span>
                  </td>
                  <td className={`${TD} text-slate-400`}>{RESULT_LABEL[s.status] ?? s.status}</td>
                  <td className={TD}>
                    {s.resultPnlPct === null ? (
                      <span className="text-slate-600">—</span>
                    ) : (
                      <span
                        className={`font-bold ${s.resultPnlPct >= 0 ? "text-bull" : "text-bear"}`}
                      >
                        {fmtPct(s.resultPnlPct)}
                      </span>
                    )}
                  </td>
                  <td className={`${TD} max-w-[10rem] text-[10px] leading-relaxed text-slate-400`}>
                    {outcomeLabel(s.outcomeReason)}
                  </td>
                </tr>
                {isOpen && (
                  <tr className="border-b border-white/10 bg-base-900/60">
                    <td colSpan={14} className="p-0">
                      <ExpandedRow signal={s} conditions={conditions} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ExpandedRow({ signal, conditions }: { signal: SignalRow; conditions: string[] }) {
  const verdicts = verdictsOf(signal.analystVerdicts);
  const analysis = signal.outcomeAnalysis as OutcomeAnalysis | null;
  const reasoning = stringsOf(signal.reasoning);
  const invalidation = stringsOf(signal.invalidation);

  return (
    <div className="grid gap-4 p-4 font-sans lg:grid-cols-3">
      <section>
        <Heading>Why this signal was generated</Heading>
        {reasoning.length === 0 ? (
          <p className="text-[11px] text-slate-600">No explanation stored for this signal.</p>
        ) : (
          <ul className="space-y-1">
            {reasoning.map((r, i) => (
              <li key={i} className="flex gap-1.5 text-[11px] leading-relaxed text-slate-300">
                <span className="text-neon-cyan">›</span>
                <span>{r}</span>
              </li>
            ))}
          </ul>
        )}

        {invalidation.length > 0 && (
          <>
            <Heading className="mt-3">Invalidation</Heading>
            <ul className="space-y-1">
              {invalidation.map((r, i) => (
                <li key={i} className="flex gap-1.5 text-[11px] leading-relaxed text-bear/85">
                  <span>✕</span>
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section>
        <Heading>Each analyst, at signal time</Heading>
        {verdicts.length === 0 ? (
          <p className="text-[11px] leading-relaxed text-slate-600">
            This signal predates analyst attribution, so there is no per-analyst record for it. It is
            counted in the totals but not in any analyst&apos;s win rate.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {verdicts.map((v) => {
              const want = signal.side === "BUY" ? "long" : "short";
              // Three stances, not two. A qualified verdict pointing the other
              // way is on record *against* this trade, and a ✓ would misread it
              // as agreement.
              const stance = !v.qualified ? "abstained" : v.direction === want ? "agreed" : "opposed";
              return (
                <li key={v.analyst} className="text-[11px] leading-relaxed">
                  <div className="flex items-center gap-1.5">
                    <span
                      className={
                        stance === "agreed"
                          ? "text-bull"
                          : stance === "opposed"
                            ? "text-neon-amber"
                            : "text-slate-600"
                      }
                    >
                      {stance === "agreed" ? "✓" : stance === "opposed" ? "✕" : "–"}
                    </span>
                    <span className="font-semibold text-slate-300">{v.name}</span>
                    <span className="font-mono text-[10px] text-slate-500">
                      {v.qualified
                        ? `${v.direction} · ${v.confidence.toFixed(0)}%${stance === "opposed" ? " · disagreed" : ""}`
                        : "abstained"}
                    </span>
                  </div>
                  <p className="ml-4 text-slate-500">
                    {v.qualified ? v.evidence : gateReason(v.gate)}
                  </p>
                </li>
              );
            })}
          </ul>
        )}

        {conditions.length > 0 && (
          <>
            <Heading className="mt-3">Market conditions</Heading>
            <p className="font-mono text-[11px] leading-relaxed text-slate-500">
              {conditions.join(" · ")}
            </p>
          </>
        )}
      </section>

      <section>
        <Heading>Outcome analysis</Heading>
        {!analysis ? (
          <p className="text-[11px] leading-relaxed text-slate-600">
            {signal.resultPnlPct === null
              ? "Still running — the outcome is classified when the signal closes."
              : "This signal closed before outcome classification existed."}
          </p>
        ) : (
          <div className="space-y-1.5 text-[11px] leading-relaxed">
            <p className={analysis.win ? "text-bull" : "text-bear"}>
              {analysis.reasonLabel}
            </p>
            {analysis.detail.map((d, i) => (
              <p key={i} className="text-slate-400">
                {d}
              </p>
            ))}
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 pt-1 font-mono text-[10px]">
              {analysis.workingConfirmation && (
                <Detail label="Confirmation that worked" value={analysis.workingConfirmation} />
              )}
              {analysis.topContributor && (
                <Detail
                  label="Top contributor"
                  value={ANALYST_LABEL[analysis.topContributor] ?? analysis.topContributor}
                />
              )}
              {analysis.analystsRight.length > 0 && (
                <Detail
                  label="Right"
                  value={analysis.analystsRight.map((a) => ANALYST_LABEL[a] ?? a).join(", ")}
                />
              )}
              {analysis.analystsWrong.length > 0 && (
                <Detail
                  label="Wrong"
                  value={analysis.analystsWrong.map((a) => ANALYST_LABEL[a] ?? a).join(", ")}
                />
              )}
              {analysis.analystsAbstained.length > 0 && (
                <Detail
                  label="Vindicated abstentions"
                  value={analysis.analystsAbstained.map((a) => ANALYST_LABEL[a] ?? a).join(", ")}
                />
              )}
              <Detail
                label="Post-entry movement"
                value={`+${analysis.excursion.maxFavourableR.toFixed(2)}R / −${analysis.excursion.maxAdverseR.toFixed(2)}R over ${analysis.excursion.bars} bars`}
              />
              <Detail
                label="Best / worst price"
                value={`${fmtPct(analysis.excursion.maxFavourablePct)} / ${fmtPct(-Math.abs(analysis.excursion.maxAdversePct))}`}
              />
            </dl>
          </div>
        )}

        <p className="mt-3 font-mono text-[10px] text-slate-600">
          R:R 1:{signal.riskReward.toFixed(2)} · created{" "}
          {new Date(signal.createdAt).toLocaleString()}
          {signal.closedAt && ` · closed ${new Date(signal.closedAt).toLocaleString()}`}
        </p>
      </section>
    </div>
  );
}

function Heading({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <h4 className={`mb-1.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500 ${className}`}>
      {children}
    </h4>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[9px] uppercase tracking-wider text-slate-600">{label}</dt>
      <dd className="text-slate-400">{value}</dd>
    </div>
  );
}
