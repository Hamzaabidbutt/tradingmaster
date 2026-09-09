import { findCvdDivergences } from "./cvdDivergence";
import { Candle, DeltaAnalysis, LiquidationDeltaPoint } from "./types";

/**
 * Conditions that are statistically unusual for *this* market.
 *
 * An anomaly is not a signal, and the distinction is the whole point of the
 * engine. It says a reading is far from what this symbol normally does — which
 * is a fact about the distribution, not a claim about direction. Unusual
 * things happen constantly in markets and most of them resolve into nothing.
 *
 * What anomalies are good for is *attention*: they say where to look, and the
 * story engine downstream uses them to build a chronology. Treating them as
 * entries is the failure mode this doc exists to warn about, and every
 * anomaly carries its own note saying what it does and does not imply.
 *
 * ## Measured, never asserted
 *
 * Everything here is scored against a trailing baseline from the same series —
 * a z-score or a multiple of the trailing mean — rather than against a fixed
 * threshold. A fixed "volume over 10M is abnormal" rule is wrong for every
 * symbol except the one it was tuned on. Each anomaly reports the baseline it
 * was measured against and how many samples went into it, so a reading taken
 * from twelve bars is visibly weaker than one taken from a hundred.
 */

/** Bars of trailing context for every baseline. */
const BASELINE = 60;
/** Minimum samples before a baseline is trustworthy enough to call anything unusual. */
const MIN_SAMPLES = 30;
/** Z-score at which a reading is unusual. */
const Z_UNUSUAL = 2.5;
/** ...and at which it is extreme. */
const Z_EXTREME = 4;

export type AnomalyKind =
  | "extreme_delta"
  | "extreme_liquidation"
  | "abnormal_volume"
  | "oi_jump"
  | "funding_anomaly"
  | "price_oi_divergence"
  | "cvd_divergence"
  | "liquidation_cascade"
  | "volatility_expansion";

export type AnomalySeverity = "notable" | "unusual" | "extreme";

export interface Anomaly {
  kind: AnomalyKind;
  severity: AnomalySeverity;
  /** when it happened, unix seconds — every anomaly is a dated event */
  time: number;
  label: string;
  /** the measured value, in whatever unit the kind uses */
  value: number;
  /** how far from normal, in standard deviations where applicable */
  z: number | null;
  /** how many samples the baseline used */
  samples: number;
  /** which way this leans, when it leans at all */
  direction: "up" | "down" | "neither";
  headline: string;
  detail: string;
}

export interface AnomalyInputs {
  candles: Candle[];
  delta: DeltaAnalysis | null;
  liquidations: LiquidationDeltaPoint[];
  openInterest: { time: number; openInterest: number }[];
  funding: {
    currentRatePct: number | null;
    annualisedPct: number | null;
    excessAnnualisedPct: number | null;
  } | null;
}

export interface AnomalyReport {
  anomalies: Anomaly[];
  /** the most severe, for a headline */
  top: Anomaly | null;
  scanned: string[];
  /** checks that could not run, and why */
  unavailable: { kind: AnomalyKind; why: string }[];
  note: string;
}

/**
 * Floor on the spread, as a share of the mean.
 *
 * A perfectly steady baseline has a standard deviation of zero, and dividing
 * by it is undefined — so a detector guarding on `sd > 0` silently stops
 * working exactly when the market is quiet, which is when a spike is most
 * informative. Flooring the denominator at 2% of the mean keeps the z-score
 * finite and large in that case instead of absent.
 */
const MIN_SPREAD_SHARE = 0.02;

/** Mean and sample standard deviation. */
function stats(values: number[]): { mean: number; sd: number } {
  if (values.length === 0) return { mean: 0, sd: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  if (values.length < 2) return { mean, sd: 0 };
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return { mean, sd: Math.sqrt(variance) };
}

/**
 * Z-score with a floored denominator, and a defined answer for a flat baseline.
 *
 * Two degenerate cases have to be handled rather than skipped, because both
 * arise from the data rather than from a bug:
 *
 *  1. A steady baseline gives a tiny standard deviation and an absurd z. The
 *     spread is floored at a share of the mean to keep it finite.
 *  2. A baseline centred on *zero* — percentage changes, deltas — gets no help
 *     from that floor, because a share of zero is zero. Guarding on
 *     `spread > 0` there makes the detector blind on its clearest case: forty
 *     periods of no change followed by a thirty-percent jump.
 *
 * So a perfectly flat baseline reports any departure as off the scale rather
 * than as unmeasurable. Capped at the extreme threshold, because "infinitely
 * unusual" is not a number and the severity bands only need to know it cleared
 * the top one.
 */
function zOf(value: number, mean: number, sd: number): number | null {
  const spread = Math.max(sd, Math.abs(mean) * MIN_SPREAD_SHARE);
  if (spread > 0) return (value - mean) / spread;
  if (value === mean) return 0;
  return value > mean ? Z_EXTREME : -Z_EXTREME;
}

function severityOf(z: number): AnomalySeverity | null {
  const a = Math.abs(z);
  if (a >= Z_EXTREME) return "extreme";
  if (a >= Z_UNUSUAL) return "unusual";
  if (a >= 2) return "notable";
  return null;
}

/**
 * Sweep for unusual conditions.
 *
 * Pure and synchronous. Each detector is independent and self-gating: one
 * missing input never suppresses the others, and a detector that cannot run
 * appears in `unavailable` with a reason rather than silently contributing
 * nothing — an empty anomaly list must not be ambiguous between "nothing
 * unusual" and "nothing was measured".
 */
export function detectAnomalies(i: AnomalyInputs): AnomalyReport {
  const anomalies: Anomaly[] = [];
  const unavailable: { kind: AnomalyKind; why: string }[] = [];
  const scanned: string[] = [];

  const bars = i.candles;
  const last = bars[bars.length - 1];

  /* ---- 1. Abnormal volume ---- */
  scanned.push("abnormal_volume");
  if (bars.length < MIN_SAMPLES + 1) {
    unavailable.push({ kind: "abnormal_volume", why: "Fewer than 30 bars of history for a baseline." });
  } else {
    const window = bars.slice(-BASELINE - 1, -1);
    const { mean, sd } = stats(window.map((c) => c.volume));
    const z = zOf(last.volume, mean, sd);
    if (z != null) {
      const sev = severityOf(z);
      if (sev && z > 0) {
        anomalies.push({
          kind: "abnormal_volume",
          severity: sev,
          time: last.time,
          label: "Abnormal volume",
          value: last.volume,
          z: Number(z.toFixed(2)),
          samples: window.length,
          direction: "neither",
          headline: `Volume ${(last.volume / mean).toFixed(1)}× the ${window.length}-bar average.`,
          detail:
            "Unusual participation. Volume has no direction of its own — it says the bar mattered to more people than usual, not which of them won.",
        });
      }
    }
  }

  /* ---- 2. Extreme delta ---- */
  scanned.push("extreme_delta");
  if (!i.delta || i.delta.series.length < MIN_SAMPLES + 1) {
    unavailable.push({ kind: "extreme_delta", why: "No delta series long enough to build a baseline." });
  } else {
    const series = i.delta.series;
    const point = series[series.length - 1];
    const window = series.slice(-BASELINE - 1, -1);
    const { mean, sd } = stats(window.map((p) => p.delta));
    const z = zOf(point.delta, mean, sd);
    if (z != null) {
      const sev = severityOf(z);
      if (sev) {
        anomalies.push({
          kind: "extreme_delta",
          severity: sev,
          time: point.time,
          label: "Extreme delta",
          value: point.delta,
          z: Number(z.toFixed(2)),
          samples: window.length,
          direction: point.delta > 0 ? "up" : "down",
          headline: `Net taker delta ${point.delta > 0 ? "+" : ""}${point.delta.toFixed(0)}, ${Math.abs(z).toFixed(1)}σ from normal.`,
          detail:
            point.delta > 0
              ? "One-sided aggressive buying. It says who was in a hurry, not who was right — buyers paying up into supply that holds is how a trap starts."
              : "One-sided aggressive selling, with the same caveat in reverse.",
        });
      }
    }
  }

  /* ---- 3. Extreme liquidation, and 4. cascade ---- */
  scanned.push("extreme_liquidation", "liquidation_cascade");
  if (i.liquidations.length < MIN_SAMPLES + 1) {
    unavailable.push({ kind: "extreme_liquidation", why: "No liquidation series long enough to build a baseline." });
    unavailable.push({ kind: "liquidation_cascade", why: "No liquidation series long enough to build a baseline." });
  } else {
    const liq = i.liquidations;
    const point = liq[liq.length - 1];
    const window = liq.slice(-BASELINE - 1, -1);
    const totals = window.map((p) => p.longLiquidated + p.shortLiquidated);
    const { mean, sd } = stats(totals);
    const total = point.longLiquidated + point.shortLiquidated;
    const z = zOf(total, mean, sd);
    if (z != null) {
      const sev = severityOf(z);
      if (sev && z > 0) {
        const longSide = point.longLiquidated > point.shortLiquidated;
        anomalies.push({
          kind: "extreme_liquidation",
          severity: sev,
          time: point.time,
          label: "Extreme liquidation",
          value: total,
          z: Number(z.toFixed(2)),
          samples: window.length,
          direction: longSide ? "down" : "up",
          headline: `Forced flow ${(total / Math.max(mean, 1e-9)).toFixed(1)}× normal, mostly ${longSide ? "longs" : "shorts"}.`,
          detail:
            "Positions closed by the exchange, not by choice. Forced flow is real volume with no opinion behind it, which is why it overshoots and why the level it overshoots to is often given back.",
        });
      }
    }

    /* A cascade is consecutive bars of elevated forced flow on the same side —
       liquidations feeding liquidations. One big bar is an event; three in a
       row is a mechanism. */
    const recent = liq.slice(-4);
    if (recent.length === 4 && mean > 0) {
      const elevated = recent.filter((p) => p.longLiquidated + p.shortLiquidated > mean * 2);
      const sameSide =
        elevated.length >= 3 &&
        (elevated.every((p) => p.longLiquidated > p.shortLiquidated) ||
          elevated.every((p) => p.shortLiquidated > p.longLiquidated));
      if (sameSide) {
        const longs = elevated[0].longLiquidated > elevated[0].shortLiquidated;
        anomalies.push({
          kind: "liquidation_cascade",
          severity: "extreme",
          time: recent[recent.length - 1].time,
          label: "Liquidation cascade",
          value: elevated.reduce((s, p) => s + p.longLiquidated + p.shortLiquidated, 0),
          z: null,
          samples: window.length,
          direction: longs ? "down" : "up",
          headline: `${elevated.length} consecutive bars of heavy ${longs ? "long" : "short"} liquidation.`,
          detail:
            "Forced closes are triggering more forced closes. A cascade moves price further than the underlying flow justifies, and the overshoot is frequently retraced once the stack is empty — but nothing says where the stack ends.",
        });
      }
    }
  }

  /* ---- 5. Sudden open-interest change, 6. price/OI divergence ---- */
  scanned.push("oi_jump", "price_oi_divergence");
  if (i.openInterest.length < 12) {
    unavailable.push({ kind: "oi_jump", why: "Open-interest history too short — Binance publishes none for some contracts." });
    unavailable.push({ kind: "price_oi_divergence", why: "Open-interest history too short to compare against price." });
  } else {
    const oi = [...i.openInterest].sort((a, b) => a.time - b.time);
    const changes: number[] = [];
    for (let k = 1; k < oi.length; k++) {
      const prev = oi[k - 1].openInterest;
      if (prev > 0) changes.push(((oi[k].openInterest - prev) / prev) * 100);
    }
    const latestChange = changes[changes.length - 1] ?? 0;
    const { mean, sd } = stats(changes.slice(0, -1));
    const z = changes.length >= 10 ? zOf(latestChange, mean, sd) : null;
    if (z != null) {
      const sev = severityOf(z);
      if (sev) {
        anomalies.push({
          kind: "oi_jump",
          severity: sev,
          time: oi[oi.length - 1].time,
          label: "Sudden open-interest change",
          value: Number(latestChange.toFixed(3)),
          z: Number(z.toFixed(2)),
          samples: changes.length - 1,
          direction: "neither",
          headline: `Open interest moved ${latestChange >= 0 ? "+" : ""}${latestChange.toFixed(2)}% in one period, ${Math.abs(z).toFixed(1)}σ from normal.`,
          detail:
            latestChange > 0
              ? "Positions opened fast. New money committing — which also means new stops to run."
              : "Positions closed fast. Either voluntary unwinding or forced, and the liquidation reads separate those.",
        });
      }
    }

    // Price and open interest disagreeing over the same window.
    if (bars.length >= 12) {
      const oiFirst = oi[0].openInterest;
      const oiLast = oi[oi.length - 1].openInterest;
      const oiPct = oiFirst > 0 ? ((oiLast - oiFirst) / oiFirst) * 100 : 0;
      const spanStart = bars.find((c) => c.time >= oi[0].time) ?? bars[0];
      const pricePct =
        spanStart.close !== 0 ? ((last.close - spanStart.close) / spanStart.close) * 100 : 0;
      if (Math.abs(pricePct) >= 0.5 && Math.abs(oiPct) >= 0.5 && pricePct * oiPct < 0) {
        const up = pricePct > 0;
        anomalies.push({
          kind: "price_oi_divergence",
          severity: "unusual",
          time: last.time,
          label: "Price / open-interest divergence",
          value: Number(oiPct.toFixed(2)),
          z: null,
          samples: oi.length,
          direction: up ? "down" : "up",
          headline: `Price ${pricePct >= 0 ? "+" : ""}${pricePct.toFixed(2)}% while open interest ${oiPct >= 0 ? "+" : ""}${oiPct.toFixed(2)}%.`,
          detail: up
            ? "Price rising on falling open interest: the buying is shorts closing, not new longs arriving. That bid is finite — it ends when the shorts are out, and nothing obliges anyone to buy above it."
            : "Price falling on rising open interest: new shorts are committing rather than longs merely leaving. Real selling, and simultaneously the fuel for a squeeze.",
        });
      }
    }
  }

  /* ---- 7. Funding anomaly ---- */
  scanned.push("funding_anomaly");
  if (!i.funding || i.funding.excessAnnualisedPct == null) {
    unavailable.push({ kind: "funding_anomaly", why: "No funding report loaded for this contract." });
  } else {
    const excess = i.funding.excessAnnualisedPct;
    // Measured against the interest anchor, not against zero: a rate sitting
    // on its own floor is not a crowded position.
    if (Math.abs(excess) >= 30) {
      anomalies.push({
        kind: "funding_anomaly",
        severity: Math.abs(excess) >= 80 ? "extreme" : "unusual",
        time: last.time,
        label: "Funding anomaly",
        value: Number(excess.toFixed(1)),
        z: null,
        samples: 1,
        direction: excess > 0 ? "down" : "up",
        headline: `Funding is ${Math.abs(excess).toFixed(0)}% annualised ${excess > 0 ? "above" : "below"} the interest anchor.`,
        detail:
          excess > 0
            ? "Longs are paying heavily to hold. That is a crowded side being charged for it — expensive to carry and densely stacked, which is the condition a long squeeze needs. Whether it fires depends on price reaching those stops, not on the funding."
            : "Shorts are paying heavily to hold, with the same reasoning reversed.",
      });
    }
  }

  /* ---- 8. CVD divergence ---- */
  scanned.push("cvd_divergence");
  if (!i.delta || i.delta.series.length < 20) {
    unavailable.push({ kind: "cvd_divergence", why: "No cumulative delta series to compare against price." });
  } else {
    const divs = findCvdDivergences(
      bars,
      i.delta.series.map((d) => ({ time: d.time, cvd: d.cvd }))
    );
    for (const d of divs) {
      anomalies.push({
        kind: "cvd_divergence",
        severity: d.strength >= 70 ? "unusual" : "notable",
        time: d.to.time,
        label: "CVD divergence",
        value: d.strength,
        z: null,
        samples: d.barsApart,
        direction: d.kind === "bearish" ? "down" : "up",
        headline: `${d.label} over ${d.barsApart} bars.`,
        detail: d.note,
      });
    }
  }

  /* ---- 9. Volatility expansion ---- */
  scanned.push("volatility_expansion");
  if (bars.length < MIN_SAMPLES + 2) {
    unavailable.push({ kind: "volatility_expansion", why: "Fewer than 30 bars for a range baseline." });
  } else {
    const ranges = bars.slice(-BASELINE - 1, -1).map((c) => c.high - c.low);
    const { mean, sd } = stats(ranges);
    const range = last.high - last.low;
    const z = zOf(range, mean, sd);
    if (z != null) {
      const sev = severityOf(z);
      if (sev && z > 0) {
        anomalies.push({
          kind: "volatility_expansion",
          severity: sev,
          time: last.time,
          label: "Volatility expansion",
          value: Number(range.toFixed(8)),
          z: Number(z.toFixed(2)),
          samples: ranges.length,
          direction: "neither",
          headline: `Bar range ${(range / Math.max(mean, 1e-9)).toFixed(1)}× the ${ranges.length}-bar average.`,
          detail:
            "Range expanded sharply. Expansion tends to cluster — the bar after a violent one is more often violent than calm — which matters for position size before it matters for direction.",
        });
      }
    }
  }

  const order: Record<AnomalySeverity, number> = { extreme: 3, unusual: 2, notable: 1 };
  anomalies.sort((a, b) => order[b.severity] - order[a.severity] || b.time - a.time);

  return {
    anomalies,
    top: anomalies[0] ?? null,
    scanned,
    unavailable,
    note:
      anomalies.length === 0
        ? unavailable.length === scanned.length
          ? "Nothing could be measured — every detector is missing its inputs."
          : "Nothing unusual against this symbol's own recent distribution. That is the ordinary state and is not itself informative."
        : "An anomaly is a statement about the distribution, not about direction. Unusual conditions occur constantly and most resolve into nothing — these say where to look, not what to do.",
  };
}
