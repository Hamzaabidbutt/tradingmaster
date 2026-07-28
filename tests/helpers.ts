import { Candle } from "@/engines/types";

/** Build a candle quickly. */
export function candle(
  time: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume = 1000,
  takerBuyVolume?: number
): Candle {
  return { time, open, high, low, close, volume, takerBuyVolume: takerBuyVolume ?? volume / 2 };
}

/**
 * Deterministic synthetic series: sine trend + pseudo-random noise.
 * Enough realism for engines to find swings, gaps and levels.
 */
export function syntheticCandles(count: number, seed = 42, base = 100): Candle[] {
  let state = seed;
  const rand = () => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state / 2 ** 31;
  };
  const out: Candle[] = [];
  let price = base;
  for (let i = 0; i < count; i++) {
    const drift = Math.sin(i / 25) * 0.4;
    const noise = (rand() - 0.5) * 1.2;
    const open = price;
    const close = Math.max(1, open + drift + noise);
    const high = Math.max(open, close) + rand() * 0.6;
    const low = Math.min(open, close) - rand() * 0.6;
    const volume = 800 + rand() * 600;
    out.push({
      time: 1_700_000_000 + i * 3600,
      open,
      high,
      low,
      close,
      volume,
      takerBuyVolume: volume * (0.35 + rand() * 0.3),
    });
    price = close;
  }
  return out;
}
