import { Candle, TapeBar, TapeResolution, TapeSpeedResult } from "./types";

export type { TapeBar, TapeResolution, TapeSpeedResult };

/**
 * How fast the tape is running.
 *
 * Volume tells you how much traded. Speed tells you how *urgently* — the same
 * size spread evenly across fifteen minutes and crammed into forty seconds are
 * different events, and only the second one is somebody who has decided they
 * must be done now. Order-flow terminals put this on screen because a burst is
 * usually the first visible sign of a stop run, a liquidation cascade or a
 * large participant arriving, and it shows up before the bar that contains it
 * has closed.
 *
 * Two readings, kept separate because they answer different questions:
 *
 *  - **Volume per second** — how much size is crossing. Sensitive to one large
 *    order and blind to a hundred small ones.
 *  - **Trades per second** — how many decisions are crossing. Sensitive to a
 *    crowd and blind to size. A cascade shows here first, because forced
 *    closes arrive as many small fills rather than one block.
 *
 * When they disagree they are telling you something: size without count is one
 * participant, count without size is the retail crowd or a liquidation engine.
 *
 * ## Resolution
 *
 * Bar-level speed is always available, since volume and duration are both
 * published. Lower-timeframe candles add the *peak* inside each bar, which is
 * the number that matters — a burst that occupies twenty seconds of a fifteen
 * minute bar is invisible in that bar's average and obvious in its peak. The
 * result says which resolution it had.
 */

/** Bars of context for the baseline. */
const CONTEXT = 40;
/** Bars needed before a baseline means anything. */
const MIN_BARS = 12;
/** Multiple of the baseline that counts as a burst. */
const BURST_X = 2.5;
/** ...and above this, as violent. */
const EXTREME_X = 5;

const EMPTY: TapeSpeedResult = {
  resolution: "bar",
  bars: [],
  current: null,
  baselineVolumePerSecond: 0,
  baselineTradesPerSecond: null,
  bursts: [],
  headline: "Not enough history to measure tape speed.",
  note: "",
  caveats: [],
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Measure the tape.
 *
 * Pure and synchronous. Falls back to bar resolution — never to nothing —
 * when no sub-series is supplied, because the bar average is a real
 * measurement rather than an estimate; it is simply coarser.
 */
export function analyzeTapeSpeed(
  candles: Candle[],
  subCandles: Candle[] | null,
  opts: { count?: number } = {}
): TapeSpeedResult {
  if (candles.length < MIN_BARS) return EMPTY;

  const barSeconds = medianGap(candles.map((c) => c.time));
  if (barSeconds <= 0) return { ...EMPTY, headline: "Bar interval unreadable — cannot measure speed." };

  const resolution: TapeResolution = subCandles && subCandles.length > 0 ? "sub_bar" : "bar";
  const subs = resolution === "sub_bar" ? [...(subCandles as Candle[])].sort((a, b) => a.time - b.time) : [];
  const subSeconds = resolution === "sub_bar" ? medianGap(subs.map((s) => s.time)) : 0;

  const count = opts.count ?? CONTEXT;
  const start = Math.max(0, candles.length - count);

  const bars: TapeBar[] = [];
  for (let i = start; i < candles.length; i++) {
    const c = candles[i];
    const next = candles[i + 1];
    const volumePerSecond = c.volume / barSeconds;
    const tradesPerSecond = c.trades != null && c.trades > 0 ? c.trades / barSeconds : null;

    let peak = volumePerSecond;
    if (resolution === "sub_bar" && subSeconds > 0) {
      const inside = subs.filter((s) => s.time >= c.time && (!next || s.time < next.time));
      for (const s of inside) {
        const rate = s.volume / subSeconds;
        if (rate > peak) peak = rate;
      }
    }

    bars.push({
      time: c.time,
      index: i,
      volumePerSecond: Number(volumePerSecond.toFixed(4)),
      tradesPerSecond: tradesPerSecond == null ? null : Number(tradesPerSecond.toFixed(4)),
      peakVolumePerSecond: Number(peak.toFixed(4)),
      multiple: 0,
      burst: false,
      extreme: false,
    });
  }

  const baselineVolumePerSecond = median(bars.map((b) => b.volumePerSecond));
  const tradeRates = bars.map((b) => b.tradesPerSecond).filter((v): v is number => v != null);
  const baselineTradesPerSecond = tradeRates.length >= MIN_BARS ? median(tradeRates) : null;

  if (baselineVolumePerSecond > 0) {
    for (const b of bars) {
      b.multiple = Number((b.peakVolumePerSecond / baselineVolumePerSecond).toFixed(2));
      b.burst = b.multiple >= BURST_X;
      b.extreme = b.multiple >= EXTREME_X;
    }
  }

  const bursts = bars.filter((b) => b.burst);
  const current = bars.length > 0 ? bars[bars.length - 1] : null;

  /* Size and count can disagree, and the disagreement is the read. Saying
     only "the tape sped up" throws away which of the two did it. */
  let note = "";
  if (current && baselineTradesPerSecond != null && current.tradesPerSecond != null) {
    const volX = baselineVolumePerSecond > 0 ? current.volumePerSecond / baselineVolumePerSecond : 1;
    const cntX = current.tradesPerSecond / baselineTradesPerSecond;
    if (volX >= 1.5 && cntX < 1.2) {
      note =
        "Size is up but the number of trades is not: fewer, larger orders. That is one participant working, not a crowd arriving.";
    } else if (cntX >= 1.5 && volX < 1.2) {
      note =
        "Trade count is up but size is not: many small fills. That is the shape of a liquidation engine or a retail crowd, not a large discretionary order.";
    } else if (volX >= 1.5 && cntX >= 1.5) {
      note = "Both size and trade count are up — broad participation rather than one order.";
    } else {
      note = "Size and trade count are both near normal.";
    }
  }

  const headline =
    current == null
      ? "No bars measured."
      : current.extreme
        ? `Tape running ${current.multiple.toFixed(1)}× its normal rate — violent.`
        : current.burst
          ? `Tape running ${current.multiple.toFixed(1)}× its normal rate.`
          : bursts.length > 0
            ? `Tape at ${current.multiple.toFixed(1)}× normal; ${bursts.length} burst${bursts.length === 1 ? "" : "s"} in the last ${bars.length} bars.`
            : `Tape at ${current.multiple.toFixed(1)}× normal — no bursts in the last ${bars.length} bars.`;

  const caveats: string[] = [
    "Speed is measured against this market's own recent rate, not an absolute one, so a quiet session's burst and a busy session's burst are both reported as bursts.",
  ];
  if (resolution === "bar") {
    caveats.push(
      "No lower-timeframe series supplied, so the peak is the bar average. A burst that occupied twenty seconds of the bar is diluted across the whole of it and may not register at all."
    );
  }
  if (baselineTradesPerSecond == null) {
    caveats.push("Trade counts unavailable in this feed — only size is being measured, so a crowd of small fills looks quiet.");
  }

  return {
    resolution,
    bars,
    current,
    baselineVolumePerSecond: Number(baselineVolumePerSecond.toFixed(4)),
    baselineTradesPerSecond:
      baselineTradesPerSecond == null ? null : Number(baselineTradesPerSecond.toFixed(4)),
    bursts,
    headline,
    note,
    caveats,
  };
}

/** Median gap between consecutive timestamps; 0 when there is no measurable one. */
function medianGap(times: number[]): number {
  if (times.length < 2) return 0;
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    if (gap > 0) gaps.push(gap);
  }
  return median(gaps);
}
