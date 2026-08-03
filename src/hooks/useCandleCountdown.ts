"use client";

import { useEffect, useState } from "react";
import { TIMEFRAME_MINUTES, Timeframe } from "@/lib/config";

/**
 * Ticks once per second and reports how long the current candle has left,
 * the way TradingView shows it beside the price axis.
 *
 * The boundary is derived from wall-clock time rather than from the last
 * candle's open time, so the countdown stays correct even if the websocket
 * stalls or a poll is late. Monthly candles are the one exception — their
 * length varies, so the true candle open time is used when available.
 */
export function useCandleCountdown(timeframe: Timeframe, lastCandleTime?: number) {
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  useEffect(() => {
    const periodSec = (TIMEFRAME_MINUTES[timeframe] ?? 60) * 60;

    const compute = () => {
      const nowSec = Date.now() / 1000;
      if (timeframe === "1M" && lastCandleTime) {
        // Calendar months differ in length — roll from the actual open.
        const open = new Date(lastCandleTime * 1000);
        const next = Date.UTC(open.getUTCFullYear(), open.getUTCMonth() + 1, 1) / 1000;
        return Math.max(0, next - nowSec);
      }
      if (timeframe === "1w") {
        // Binance weekly candles open on Monday 00:00 UTC.
        const next = Math.ceil((nowSec - 345600) / periodSec) * periodSec + 345600;
        return Math.max(0, next - nowSec);
      }
      const next = Math.ceil(nowSec / periodSec) * periodSec;
      return Math.max(0, next - nowSec);
    };

    setSecondsLeft(compute());
    const id = setInterval(() => setSecondsLeft(compute()), 1000);
    return () => clearInterval(id);
  }, [timeframe, lastCandleTime]);

  return { secondsLeft, formatted: secondsLeft == null ? "--:--" : formatCountdown(secondsLeft) };
}

/** h:mm:ss for long candles, mm:ss for short ones. */
export function formatCountdown(totalSeconds: number): string {
  const s = Math.floor(totalSeconds);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (days > 0) return `${days}d ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${pad(minutes)}:${pad(seconds)}`;
}
