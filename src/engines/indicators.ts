import {
  Bias,
  Candle,
  EqualLevelLine,
  FibLevel,
  FibonacciResult,
  MovingAverage,
  MovingAverageResult,
  SwingPoint,
  VwapResult,
} from "./types";

/* ------------------------------------------------------------------ *
 * Key moving averages
 * ------------------------------------------------------------------ */

interface MaSpec {
  key: string;
  label: string;
  type: "EMA" | "SMA";
  period: number;
  color: string;
}

/** The stack institutions and algos actually watch. */
export const MA_SPECS: MaSpec[] = [
  { key: "ema9", label: "EMA 9", type: "EMA", period: 9, color: "#22d3ee" },
  { key: "ema21", label: "EMA 21", type: "EMA", period: 21, color: "#a78bfa" },
  { key: "ema50", label: "EMA 50", type: "EMA", period: 50, color: "#fbbf24" },
  { key: "sma100", label: "SMA 100", type: "SMA", period: 100, color: "#94a3b8" },
  { key: "sma200", label: "SMA 200", type: "SMA", period: 200, color: "#f472b6" },
];

export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function computeMovingAverages(candles: Candle[]): MovingAverageResult {
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  const averages: MovingAverage[] = [];

  for (const spec of MA_SPECS) {
    if (candles.length < spec.period) continue;
    const raw = spec.type === "EMA" ? ema(closes, spec.period) : sma(closes, spec.period);
    const values: { time: number; value: number }[] = [];
    for (let i = 0; i < candles.length; i++) {
      const v = raw[i];
      if (v != null) values.push({ time: candles[i].time, value: v });
    }
    if (values.length === 0) continue;
    const current = values[values.length - 1].value;
    averages.push({
      key: spec.key,
      label: spec.label,
      type: spec.type,
      period: spec.period,
      color: spec.color,
      values,
      current,
      position: price >= current ? "above" : "below",
    });
  }

  const above = averages.filter((a) => a.position === "above").length;
  const alignment: Bias =
    averages.length === 0
      ? "neutral"
      : above === averages.length
        ? "bullish"
        : above === 0
          ? "bearish"
          : above / averages.length > 0.6
            ? "bullish"
            : above / averages.length < 0.4
              ? "bearish"
              : "neutral";

  // Golden / death cross on the 50 vs 200.
  const ma50 = averages.find((a) => a.key === "ema50");
  const ma200 = averages.find((a) => a.key === "sma200");
  let goldenCross = false;
  let deathCross = false;
  if (ma50 && ma200 && ma50.values.length > 3 && ma200.values.length > 3) {
    const f = ma50.values[ma50.values.length - 1].value;
    const s = ma200.values[ma200.values.length - 1].value;
    const fPrev = ma50.values[ma50.values.length - 4].value;
    const sPrev = ma200.values[ma200.values.length - 4].value;
    goldenCross = fPrev <= sPrev && f > s;
    deathCross = fPrev >= sPrev && f < s;
  }

  const summary: string[] = [];
  if (averages.length > 0) {
    summary.push(
      `Price is above ${above} of ${averages.length} key moving averages — ${alignment} alignment.`
    );
    const nearest = [...averages].sort(
      (a, b) => Math.abs(price - a.current) - Math.abs(price - b.current)
    )[0];
    summary.push(
      `Nearest MA is the ${nearest.label} at ${nearest.current.toFixed(4)} (${(((price - nearest.current) / nearest.current) * 100).toFixed(2)}% away) — the most likely dynamic reaction level.`
    );
  }
  if (goldenCross) summary.push("Golden cross: the EMA 50 has crossed above the SMA 200 — a long-horizon trend signal.");
  if (deathCross) summary.push("Death cross: the EMA 50 has crossed below the SMA 200 — a long-horizon trend signal.");

  return { averages, alignment, goldenCross, deathCross, summary };
}

/* ------------------------------------------------------------------ *
 * VWAP (volume weighted average price)
 * ------------------------------------------------------------------ */

/**
 * VWAP is not a moving average — it is the volume-weighted fair price of
 * the session, which is exactly why institutional execution algorithms are
 * benchmarked against it and why price reacts there so reliably.
 * Standard-deviation bands mark statistically stretched prices.
 */
export function computeVwap(candles: Candle[], sessionBars = 96): VwapResult {
  const window = candles.slice(-Math.min(sessionBars * 3, candles.length));
  const values: VwapResult["values"] = [];
  const bands: VwapResult["bands"] = [];

  let cumPV = 0;
  let cumV = 0;
  let cumPV2 = 0;

  for (const c of window) {
    const typical = (c.high + c.low + c.close) / 3;
    cumPV += typical * c.volume;
    cumPV2 += typical * typical * c.volume;
    cumV += c.volume;
    const vwap = cumV > 0 ? cumPV / cumV : typical;
    const variance = cumV > 0 ? Math.max(0, cumPV2 / cumV - vwap * vwap) : 0;
    const sd = Math.sqrt(variance);
    values.push({ time: c.time, value: vwap });
    bands.push({
      time: c.time,
      upper1: vwap + sd,
      lower1: vwap - sd,
      upper2: vwap + sd * 2,
      lower2: vwap - sd * 2,
    });
  }

  const current = values[values.length - 1]?.value ?? 0;
  const lastBand = bands[bands.length - 1];
  const price = window[window.length - 1]?.close ?? current;
  const distancePct = current > 0 ? ((price - current) / current) * 100 : 0;

  const summary: string[] = [];
  summary.push(
    `Price is ${distancePct >= 0 ? "above" : "below"} session VWAP (${current.toFixed(4)}) by ${Math.abs(distancePct).toFixed(2)}% — ${
      distancePct >= 0
        ? "buyers hold the advantage against the volume-weighted fair price."
        : "sellers hold the advantage against the volume-weighted fair price."
    }`
  );
  if (lastBand) {
    if (price > lastBand.upper2) summary.push("Price is beyond the +2σ VWAP band — statistically stretched; mean reversion risk is elevated.");
    else if (price < lastBand.lower2) summary.push("Price is beyond the −2σ VWAP band — statistically stretched; bounce risk is elevated.");
  }

  return {
    values,
    current,
    upperBand1: lastBand?.upper1 ?? current,
    lowerBand1: lastBand?.lower1 ?? current,
    upperBand2: lastBand?.upper2 ?? current,
    lowerBand2: lastBand?.lower2 ?? current,
    bands,
    position: price >= current ? "above" : "below",
    distancePct: Number(distancePct.toFixed(2)),
    summary,
  };
}

/* ------------------------------------------------------------------ *
 * Fibonacci
 * ------------------------------------------------------------------ */

const RETRACEMENTS = [
  { ratio: 0, label: "0%" },
  { ratio: 0.236, label: "23.6%" },
  { ratio: 0.382, label: "38.2%" },
  { ratio: 0.5, label: "50%" },
  { ratio: 0.618, label: "61.8%" },
  { ratio: 0.65, label: "65%" },
  { ratio: 0.786, label: "78.6%" },
  { ratio: 1, label: "100%" },
];

const EXTENSIONS = [
  { ratio: 1.272, label: "127.2%" },
  { ratio: 1.618, label: "161.8%" },
  { ratio: 2.618, label: "261.8%" },
];

/**
 * Auto-Fibonacci drawn from the most recent significant swing leg. The
 * 0.618–0.65 band is highlighted as the "golden pocket", where the
 * deepest-discount entries in a trend typically fill.
 */
export function computeFibonacci(candles: Candle[], swings: SwingPoint[]): FibonacciResult {
  const majors = swings.filter((s) => s.degree === "major");
  const lastHigh = [...majors].reverse().find((s) => s.kind === "high");
  const lastLow = [...majors].reverse().find((s) => s.kind === "low");

  const fallbackHigh = Math.max(...candles.slice(-80).map((c) => c.high));
  const fallbackLow = Math.min(...candles.slice(-80).map((c) => c.low));
  const swingHigh = lastHigh?.price ?? fallbackHigh;
  const swingLow = lastLow?.price ?? fallbackLow;
  const swingHighTime = lastHigh?.time ?? candles[Math.max(0, candles.length - 80)].time;
  const swingLowTime = lastLow?.time ?? candles[Math.max(0, candles.length - 80)].time;

  // Direction of the leg: whichever extreme printed most recently is the end.
  const direction: "up" | "down" = swingHighTime >= swingLowTime ? "up" : "down";
  const span = Math.abs(swingHigh - swingLow);
  const price = candles[candles.length - 1].close;

  const levels: FibLevel[] = [];
  for (const r of RETRACEMENTS) {
    // Retracements measure back from the end of the leg toward its start.
    const p = direction === "up" ? swingHigh - span * r.ratio : swingLow + span * r.ratio;
    levels.push({
      ratio: r.ratio,
      label: r.label,
      price: p,
      kind: "retracement",
      isGoldenPocket: r.ratio === 0.618 || r.ratio === 0.65,
    });
  }
  for (const e of EXTENSIONS) {
    const p = direction === "up" ? swingHigh + span * (e.ratio - 1) : swingLow - span * (e.ratio - 1);
    levels.push({
      ratio: e.ratio,
      label: e.label,
      price: p,
      kind: "extension",
      isGoldenPocket: false,
    });
  }

  const activeLevel =
    levels
      .filter((l) => l.kind === "retracement")
      .find((l) => Math.abs(price - l.price) / Math.max(price, 1e-9) < 0.004) ?? null;

  const summary: string[] = [];
  summary.push(
    `Fibonacci drawn on the ${direction === "up" ? "rally" : "decline"} from ${(direction === "up" ? swingLow : swingHigh).toFixed(4)} to ${(direction === "up" ? swingHigh : swingLow).toFixed(4)}.`
  );
  const golden = levels.filter((l) => l.isGoldenPocket);
  if (golden.length === 2) {
    const lo = Math.min(golden[0].price, golden[1].price);
    const hi = Math.max(golden[0].price, golden[1].price);
    summary.push(
      `Golden pocket sits at ${lo.toFixed(4)} – ${hi.toFixed(4)} — the highest-probability retracement entry zone if the trend resumes.`
    );
  }
  if (activeLevel) {
    summary.push(
      `Price is reacting at the ${activeLevel.label} retracement (${activeLevel.price.toFixed(4)}) right now.`
    );
  }

  return {
    direction,
    swingHigh,
    swingLow,
    swingHighTime,
    swingLowTime,
    levels,
    activeLevel,
    summary,
  };
}

/* ------------------------------------------------------------------ *
 * Equal highs / lows — drawn as connecting lines
 * ------------------------------------------------------------------ */

/**
 * Cluster swing highs (and lows) that print at effectively the same price
 * and connect them with a horizontal line. Equal highs/lows are where
 * retail stops pile up, which is precisely why the market so often runs
 * them before reversing — the line makes that resting liquidity visible.
 */
export function detectEqualLevels(
  candles: Candle[],
  swings: SwingPoint[],
  tolerance = 0.0018
): EqualLevelLine[] {
  const out: EqualLevelLine[] = [];
  const majors = swings.filter((s) => s.degree === "major");
  const lastPrice = candles[candles.length - 1].close;
  const lastTime = candles[candles.length - 1].time;

  const cluster = (kind: "EQH" | "EQL") => {
    const pts = majors
      .filter((s) => (kind === "EQH" ? s.kind === "high" : s.kind === "low"))
      .slice(-10);
    const used = new Set<number>();

    for (let i = 0; i < pts.length; i++) {
      if (used.has(i)) continue;
      const group = [pts[i]];
      for (let j = i + 1; j < pts.length; j++) {
        if (used.has(j)) continue;
        if (Math.abs(pts[j].price - pts[i].price) / Math.max(pts[i].price, 1e-9) <= tolerance) {
          group.push(pts[j]);
          used.add(j);
        }
      }
      if (group.length < 2) continue;
      used.add(i);

      const price = group.reduce((s, g) => s + g.price, 0) / group.length;
      const startTime = Math.min(...group.map((g) => g.time));
      const endTime = Math.max(...group.map((g) => g.time));

      // Swept once price traded decisively beyond the level after forming.
      const after = candles.filter((c) => c.time > endTime);
      const swept =
        kind === "EQH"
          ? after.some((c) => c.high > price * (1 + tolerance))
          : after.some((c) => c.low < price * (1 - tolerance));

      out.push({
        id: `${kind}-${price.toFixed(6)}`,
        kind,
        price,
        startTime,
        endTime: swept ? endTime : lastTime,
        touches: group.length,
        swept,
        strength: Math.min(100, 45 + group.length * 16 + (swept ? -20 : 15)),
        note: swept
          ? `${kind === "EQH" ? "Equal highs" : "Equal lows"} at ${price.toFixed(4)} have already been swept — the resting stops there are gone.`
          : `${group.length} ${kind === "EQH" ? "equal highs" : "equal lows"} at ${price.toFixed(4)} — unswept ${kind === "EQH" ? "buy-side" : "sell-side"} liquidity sitting ${(((kind === "EQH" ? price - lastPrice : lastPrice - price) / lastPrice) * 100).toFixed(2)}% away. This is a magnet for price.`,
      });
    }
  };

  cluster("EQH");
  cluster("EQL");
  return out.sort((a, b) => b.strength - a.strength).slice(0, 8);
}
