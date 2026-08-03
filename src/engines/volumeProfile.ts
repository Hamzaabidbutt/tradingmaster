import {
  Candle,
  ProfileRow,
  ProfileShape,
  VolumeNode,
  VolumeProfileResult,
} from "./types";

/**
 * Volume Profile & Auction Theory engine.
 *
 * A normal volume histogram only answers "how much traded in this bar".
 * The profile answers the far more useful question: "at WHICH PRICE did
 * the volume trade" — which is where institutional business actually got
 * done.
 *
 *  POC  (Point of Control) — the single price with the most traded volume.
 *                            Acts as a magnet and as support/resistance.
 *  VA   (Value Area)       — the price band containing 70% of volume,
 *                            bounded by VAH (high) and VAL (low). This is
 *                            the market's agreed "fair price".
 *  HVN  (High Volume Node) — accepted price; price moves slowly here.
 *  LVN  (Low Volume Node)  — rejected price; price rips through it, which
 *                            is exactly why LVNs make better trade
 *                            locations than HVNs.
 *
 * Auction theory: price oscillates between BALANCE (inside value, fair,
 * range behaviour) and IMBALANCE (outside value, seeking new value,
 * impulsive behaviour). Knowing which regime you're in decides whether to
 * fade extremes or trade continuation.
 */

export interface VolumeProfileOptions {
  /** number of horizontal price buckets */
  bins?: number;
  /** value-area target share (classically 0.70) */
  valueAreaShare?: number;
  scope?: VolumeProfileResult["scope"];
}

export function buildVolumeProfile(
  candles: Candle[],
  opts: VolumeProfileOptions = {}
): VolumeProfileResult {
  const bins = opts.bins ?? 60;
  const targetShare = opts.valueAreaShare ?? 0.7;
  const scope = opts.scope ?? "visible";

  const high = Math.max(...candles.map((c) => c.high));
  const low = Math.min(...candles.map((c) => c.low));
  const span = Math.max(high - low, 1e-9);
  const binSize = span / bins;

  const rows: ProfileRow[] = Array.from({ length: bins }, (_, i) => ({
    price: low + binSize * (i + 0.5),
    volume: 0,
    buyVolume: 0,
    sellVolume: 0,
    delta: 0,
  }));

  // Distribute each candle's volume across the price levels it traded
  // through. Uniform distribution across the candle range is the standard
  // approximation when tick data isn't available.
  for (const c of candles) {
    const cLow = Math.max(low, c.low);
    const cHigh = Math.min(high, c.high);
    const startBin = Math.max(0, Math.floor((cLow - low) / binSize));
    const endBin = Math.min(bins - 1, Math.floor((cHigh - low) / binSize));
    const touched = endBin - startBin + 1;
    if (touched <= 0) continue;

    const buy = c.takerBuyVolume ?? c.volume / 2;
    const sell = c.volume - buy;
    const volPer = c.volume / touched;
    const buyPer = buy / touched;
    const sellPer = sell / touched;

    for (let b = startBin; b <= endBin; b++) {
      rows[b].volume += volPer;
      rows[b].buyVolume += buyPer;
      rows[b].sellVolume += sellPer;
      rows[b].delta += buyPer - sellPer;
    }
  }

  const totalVolume = rows.reduce((s, r) => s + r.volume, 0);

  // --- POC: the highest-volume price level ---
  let pocIdx = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].volume > rows[pocIdx].volume) pocIdx = i;
  }
  const poc = rows[pocIdx].price;

  // --- Value area: expand out from the POC, always taking the richer
  // neighbouring side, until 70% of volume is enclosed. ---
  let vaVolume = rows[pocIdx].volume;
  let lowIdx = pocIdx;
  let highIdx = pocIdx;
  const target = totalVolume * targetShare;
  while (vaVolume < target && (lowIdx > 0 || highIdx < rows.length - 1)) {
    const below = lowIdx > 0 ? rows[lowIdx - 1].volume : -1;
    const above = highIdx < rows.length - 1 ? rows[highIdx + 1].volume : -1;
    if (above >= below && above >= 0) {
      highIdx++;
      vaVolume += rows[highIdx].volume;
    } else if (below >= 0) {
      lowIdx--;
      vaVolume += rows[lowIdx].volume;
    } else break;
  }
  const vah = rows[highIdx].price;
  const val = rows[lowIdx].price;

  // --- HVN / LVN detection ---
  const avgVol = totalVolume / Math.max(rows.length, 1);
  const hvns: VolumeNode[] = [];
  const lvns: VolumeNode[] = [];
  for (let i = 1; i < rows.length - 1; i++) {
    const r = rows[i];
    const isLocalMax = r.volume > rows[i - 1].volume && r.volume > rows[i + 1].volume;
    const isLocalMin = r.volume < rows[i - 1].volume && r.volume < rows[i + 1].volume;
    const share = totalVolume > 0 ? r.volume / totalVolume : 0;

    if (isLocalMax && r.volume > avgVol * 1.4) {
      hvns.push({
        price: r.price,
        priceHigh: r.price + binSize / 2,
        priceLow: r.price - binSize / 2,
        volume: r.volume,
        share,
        kind: "HVN",
        note: "High Volume Node — price was accepted here, expect slow two-sided trade and magnetism.",
      });
    }
    if (isLocalMin && r.volume < avgVol * 0.55 && r.volume > 0) {
      lvns.push({
        price: r.price,
        priceHigh: r.price + binSize / 2,
        priceLow: r.price - binSize / 2,
        volume: r.volume,
        share,
        kind: "LVN",
        note: "Low Volume Node — price was rejected here previously and tends to move through it fast; a high-quality reaction level.",
      });
    }
  }

  const lastPrice = candles[candles.length - 1].close;
  const acceptance: VolumeProfileResult["acceptance"] =
    lastPrice > vah ? "above_value" : lastPrice < val ? "below_value" : "inside_value";
  const auctionState: VolumeProfileResult["auctionState"] =
    acceptance === "inside_value" ? "balance" : "imbalance";

  const shape = classifyShape(rows, pocIdx, lowIdx, highIdx);

  const summary: string[] = [];
  summary.push(
    `Point of Control at ${poc.toFixed(4)} — the price where the most business was done; algorithms are heavily programmed around it.`
  );
  summary.push(
    `Value area ${val.toFixed(4)} – ${vah.toFixed(4)} holds ${(
      (vaVolume / Math.max(totalVolume, 1e-9)) * 100
    ).toFixed(0)}% of traded volume.`
  );
  if (acceptance === "above_value") {
    summary.push("Price is trading ABOVE value — accepted higher prices favour continuation; failure to hold sends it back to the POC.");
  } else if (acceptance === "below_value") {
    summary.push("Price is trading BELOW value — the market considers these prices cheap but has not yet accepted them; rotation back to the POC is the default path.");
  } else {
    summary.push("Price is INSIDE value — balanced auction, fade the extremes rather than chase breakouts.");
  }
  summary.push(shapeExplanation(shape));
  if (lvns.length > 0) {
    const nearest = [...lvns].sort(
      (a, b) => Math.abs(a.price - lastPrice) - Math.abs(b.price - lastPrice)
    )[0];
    summary.push(
      `Nearest Low Volume Node at ${nearest.price.toFixed(4)} — price historically refused to trade here, making it a high-quality rejection level.`
    );
  }

  return {
    scope,
    rows,
    poc,
    vah,
    val,
    totalVolume,
    valueAreaShare: totalVolume > 0 ? vaVolume / totalVolume : 0,
    hvns: hvns.sort((a, b) => b.volume - a.volume).slice(0, 6),
    lvns: lvns.sort((a, b) => a.volume - b.volume).slice(0, 6),
    shape,
    acceptance,
    auctionState,
    summary,
  };
}

/**
 * Classify the profile silhouette.
 *  P-shape: volume concentrated at the TOP with a thin tail below —
 *           short covering. Printed at a high it warns of a hollow rally.
 *  b-shape: volume concentrated at the BOTTOM with a thin tail above —
 *           long liquidation. Printed at a low it warns of capitulation.
 *  B-shape: two separate distributions — the market is transitioning.
 *  D-shape: symmetric, balanced — classic range.
 */
function classifyShape(
  rows: ProfileRow[],
  pocIdx: number,
  vaLowIdx: number,
  vaHighIdx: number
): ProfileShape {
  const n = rows.length;
  const pocPosition = pocIdx / Math.max(n - 1, 1);

  // Double distribution: a pronounced volume valley separating two peaks.
  const maxVol = Math.max(...rows.map((r) => r.volume));
  const peaks: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (
      rows[i].volume > rows[i - 1].volume &&
      rows[i].volume > rows[i + 1].volume &&
      rows[i].volume > maxVol * 0.65
    ) {
      peaks.push(i);
    }
  }
  if (peaks.length >= 2) {
    const gap = Math.abs(peaks[peaks.length - 1] - peaks[0]);
    if (gap > n * 0.25) {
      const between = rows.slice(Math.min(...peaks), Math.max(...peaks));
      const valley = Math.min(...between.map((r) => r.volume));
      if (valley < maxVol * 0.4) return "B";
    }
  }

  if (pocPosition > 0.62) return "P";
  if (pocPosition < 0.38) return "b";
  return "D";
}

function shapeExplanation(shape: ProfileShape): string {
  switch (shape) {
    case "P":
      return "P-shaped profile: volume stacked at the highs over a thin tail below — short-covering signature. If this prints at the top of a move the rally lacks fresh buyers and is vulnerable.";
    case "b":
      return "b-shaped profile: volume stacked at the lows over a thin tail above — long-liquidation signature. If this prints at the bottom of a move the selling is forced rather than fresh, and reversal odds rise.";
    case "B":
      return "B-shaped (double distribution) profile: two separate value areas with a hollow between them — the market is transitioning between regimes; the empty middle is a fast-travel zone.";
    default:
      return "D-shaped profile: symmetric and balanced — the auction has found fair value, so extremes are for fading rather than chasing.";
  }
}

/**
 * Session-scoped profiles. Crypto trades 24/7 but volume still arrives in
 * the traditional Asian / London / New York blocks, and the New York cash
 * session is by far the most liquid — its profile carries the most weight.
 */
export function sessionOf(unixSec: number): "asian" | "london" | "newyork" {
  const hourUtc = new Date(unixSec * 1000).getUTCHours();
  if (hourUtc >= 0 && hourUtc < 7) return "asian";
  if (hourUtc >= 7 && hourUtc < 13) return "london";
  return "newyork";
}

/** Build the profile for the most recent N days/weeks worth of candles. */
export function buildScopedProfile(
  candles: Candle[],
  scope: "daily" | "weekly" | "session",
  bins = 48
): VolumeProfileResult {
  const now = candles[candles.length - 1].time;
  let cutoff: number;
  if (scope === "weekly") cutoff = now - 7 * 86400;
  else if (scope === "daily") cutoff = now - 86400;
  else cutoff = now - 8 * 3600;

  const slice = candles.filter((c) => c.time >= cutoff);
  // Fall back to a tail of the series when the timeframe is too coarse to
  // fill the window (e.g. a weekly chart asked for a daily profile).
  const use = slice.length >= 10 ? slice : candles.slice(-Math.min(60, candles.length));
  return buildVolumeProfile(use, { bins, scope });
}
