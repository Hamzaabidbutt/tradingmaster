import { describe, expect, it } from "vitest";
import { detectFVGs } from "@/engines/fvg";
import { candle } from "./helpers";

describe("fair value gap engine", () => {
  it("detects a bullish FVG (gap between candle[i-2].high and candle[i].low)", () => {
    const candles = [
      candle(1, 100, 101, 99, 100.5),
      candle(2, 100.5, 106, 100.4, 105.5), // impulsive middle candle
      candle(3, 105.5, 107, 103, 106), // low (103) > first high (101) => gap 101..103
    ];
    const fvgs = detectFVGs(candles);
    expect(fvgs.length).toBe(1);
    expect(fvgs[0].direction).toBe("bullish");
    expect(fvgs[0].bottom).toBe(101);
    expect(fvgs[0].top).toBe(103);
    expect(fvgs[0].status).toBe("fresh");
  });

  it("marks the gap filled when price trades back through it", () => {
    const candles = [
      candle(1, 100, 101, 99, 100.5),
      candle(2, 100.5, 106, 100.4, 105.5),
      candle(3, 105.5, 107, 103, 106),
      candle(4, 106, 106.5, 100.5, 101), // trades down through the whole gap
    ];
    const fvgs = detectFVGs(candles);
    expect(fvgs[0].status).toBe("filled");
  });

  it("detects a bearish FVG", () => {
    const candles = [
      candle(1, 100, 101, 99, 99.5),
      candle(2, 99.5, 99.4, 94, 94.5),
      candle(3, 94.5, 96, 93, 95), // high (96) < first low (99) => gap 96..99
    ];
    const fvgs = detectFVGs(candles);
    expect(fvgs.length).toBe(1);
    expect(fvgs[0].direction).toBe("bearish");
    expect(fvgs[0].top).toBe(99);
    expect(fvgs[0].bottom).toBe(96);
  });
});
