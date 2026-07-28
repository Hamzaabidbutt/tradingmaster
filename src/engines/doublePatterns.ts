import { Candle, DoublePattern, SwingPoint } from "./types";

/**
 * Double/triple top & bottom detection from major swing points.
 * Measured target = neckline ± pattern height (classical projection).
 */
export function detectDoublePatterns(
  candles: Candle[],
  swings: SwingPoint[],
  tolerance = 0.006
): DoublePattern[] {
  const patterns: DoublePattern[] = [];
  const majors = swings.filter((s) => s.degree === "major");
  const highs = majors.filter((s) => s.kind === "high").slice(-8);
  const lows = majors.filter((s) => s.kind === "low").slice(-8);
  const lastClose = candles[candles.length - 1]?.close ?? 0;

  const scan = (points: SwingPoint[], kind: "top" | "bottom") => {
    for (let i = 0; i < points.length - 1; i++) {
      const matches = [points[i]];
      for (let j = i + 1; j < points.length; j++) {
        if (Math.abs(points[j].price - points[i].price) / points[i].price <= tolerance) {
          matches.push(points[j]);
        }
      }
      if (matches.length < 2) continue;

      const between = majors.filter(
        (s) =>
          s.kind === (kind === "top" ? "low" : "high") &&
          s.index > matches[0].index &&
          s.index < matches[matches.length - 1].index
      );
      if (between.length === 0) continue;
      const neckline =
        kind === "top"
          ? Math.min(...between.map((s) => s.price))
          : Math.max(...between.map((s) => s.price));

      const extreme = kind === "top"
        ? Math.max(...matches.map((m) => m.price))
        : Math.min(...matches.map((m) => m.price));
      const height = Math.abs(extreme - neckline);
      const measuredTarget = kind === "top" ? neckline - height : neckline + height;
      const confirmed = kind === "top" ? lastClose < neckline : lastClose > neckline;

      // Volume on second test vs first: fading volume on retest supports the pattern.
      const firstIdx = matches[0].index;
      const lastIdx = matches[matches.length - 1].index;
      const v1 = candles[firstIdx]?.volume ?? 0;
      const v2 = candles[lastIdx]?.volume ?? 0;
      const fadingRetest = v2 < v1 * 0.85;

      const breakoutProbability = Math.min(
        85,
        45 + (matches.length - 2) * 10 + (fadingRetest ? 15 : 0) + (confirmed ? 15 : 0)
      );

      patterns.push({
        type:
          matches.length >= 3
            ? kind === "top" ? "triple_top" : "triple_bottom"
            : kind === "top" ? "double_top" : "double_bottom",
        points: matches.map((m) => ({ time: m.time, price: m.price })),
        neckline,
        breakoutProbability,
        fakeBreakoutProbability: 100 - breakoutProbability,
        measuredTarget,
        confirmationLevel: neckline,
        confirmed,
      });
      break; // one pattern per side is enough
    }
  };

  scan(highs, "top");
  scan(lows, "bottom");
  return patterns;
}
