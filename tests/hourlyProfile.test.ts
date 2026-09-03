import { describe, expect, it } from "vitest";
import { buildHourlyProfile, hourLabel } from "@/engines/hourlyProfile";
import { Candle } from "@/engines/types";

/**
 * The profile makes one strong claim and one weak one, and the tests exist to
 * keep them apart: volume and range by hour are stable and are stated plainly;
 * direction is noisy and must stay hedged and sample-gated.
 */

const HOUR = 3600;
/** A Thursday 00:00 UTC, so hour 0 of the series really is UTC hour 0. */
const START = Date.UTC(2025, 0, 2, 0, 0, 0) / 1000;

interface Shape {
  /** volume multiplier applied to the hour of day */
  volume?: (hour: number) => number;
  /** close-open move, in price units, for the hour of day */
  body?: (hour: number, day: number) => number;
  /** high-low range in price units */
  range?: (hour: number) => number;
  takerShare?: (hour: number) => number;
}

/** `days` days of hourly bars, shaped per hour of day. */
function build(days: number, shape: Shape = {}): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  for (let d = 0; d < days; d++) {
    for (let h = 0; h < 24; h++) {
      const time = START + (d * 24 + h) * HOUR;
      const body = shape.body?.(h, d) ?? 0;
      const range = shape.range?.(h) ?? 1;
      const open = price;
      const close = open + body;
      const volume = 1000 * (shape.volume?.(h) ?? 1);
      out.push({
        time,
        open,
        close,
        high: Math.max(open, close) + range / 2,
        low: Math.min(open, close) - range / 2,
        volume,
        takerBuyVolume: volume * (shape.takerShare?.(h) ?? 0.5),
      });
      price = close;
    }
  }
  return out;
}

describe("buildHourlyProfile", () => {
  it("declines to profile a series too short to mean anything", () => {
    const p = buildHourlyProfile("UNIUSDT", build(3));
    expect(p.hours).toEqual([]);
    expect(p.busiest).toEqual([]);
    expect(p.note).toMatch(/not enough/i);
  });

  it("buckets by UTC hour of day, not by position in the series", () => {
    const p = buildHourlyProfile("UNIUSDT", build(30));
    expect(p.hours).toHaveLength(24);
    for (const h of p.hours) {
      expect(h.hour).toBeGreaterThanOrEqual(0);
      expect(h.hour).toBeLessThan(24);
      expect(h.samples).toBe(30);
    }
  });

  it("finds the hours where volume actually concentrates", () => {
    // 13:00 and 14:00 carry triple volume; everything else is flat.
    const p = buildHourlyProfile(
      "UNIUSDT",
      build(60, { volume: (h) => (h === 13 || h === 14 ? 3 : 1) })
    );
    expect(p.busiest.slice(0, 2).sort()).toEqual([13, 14]);
    const busy = p.hours.find((h) => h.hour === 13)!;
    expect(busy.activity).toBe("busy");
    expect(busy.volumeMultiple).toBeGreaterThan(2);
    // Two hours at 3x among 22 at 1x: 6/28 of all volume.
    expect(busy.volumeSharePct).toBeCloseTo((3 / 28) * 100, 1);
  });

  it("keeps the volume shares summing to the whole day", () => {
    const p = buildHourlyProfile("UNIUSDT", build(45, { volume: (h) => 1 + (h % 5) }));
    const total = p.hours.reduce((s, h) => s + h.volumeSharePct, 0);
    expect(total).toBeCloseTo(100, 1);
  });

  it("separates a busy hour from a wide one", () => {
    // 08:00 trades heavily in a tight range — absorption on a clock. 20:00
    // ranges widely on ordinary volume — a thin book, not conviction.
    const p = buildHourlyProfile(
      "UNIUSDT",
      build(60, {
        volume: (h) => (h === 8 ? 3 : 1),
        range: (h) => (h === 20 ? 4 : 1),
      })
    );
    const heavy = p.hours.find((h) => h.hour === 8)!;
    const wide = p.hours.find((h) => h.hour === 20)!;
    expect(heavy.volumeMultiple).toBeGreaterThan(wide.volumeMultiple);
    expect(wide.rangeMultiple).toBeGreaterThan(heavy.rangeMultiple);
    expect(p.summary.join(" ")).toMatch(/absorption|does not move price/i);
  });

  it("withholds a directional read below the sample floor", () => {
    // 30 days is enough for volume, not for a mean return.
    const p = buildHourlyProfile("UNIUSDT", build(30));
    for (const h of p.hours) {
      expect(h.meanReturnPct).toBeNull();
      expect(h.upSharePct).toBeNull();
      // Volume is still reported — it converges far faster.
      expect(h.volumeMultiple).toBeGreaterThan(0);
    }
  });

  it("quotes a directional read once the sample supports it", () => {
    const p = buildHourlyProfile("UNIUSDT", build(60, { body: (h) => (h === 9 ? 0.5 : 0) }));
    const nine = p.hours.find((h) => h.hour === 9)!;
    expect(nine.meanReturnPct).not.toBeNull();
    expect(nine.meanReturnPct!).toBeGreaterThan(0);
    expect(nine.upSharePct).toBe(100);
  });

  it("measures follow-through only on bars that actually moved", () => {
    // Every 16:00 bar makes a decisive move that the next hour extends.
    const p = buildHourlyProfile(
      "UNIUSDT",
      build(60, { body: (h) => (h === 16 || h === 17 ? 3 : 0), range: () => 1 })
    );
    const sixteen = p.hours.find((h) => h.hour === 16)!;
    expect(sixteen.decisiveSamples).toBeGreaterThanOrEqual(20);
    expect(sixteen.followThroughPct).toBe(100);
    // A flat hour has no decisive bars, so no rate is invented for it.
    const flat = p.hours.find((h) => h.hour === 3)!;
    expect(flat.decisiveSamples).toBe(0);
    expect(flat.followThroughPct).toBeNull();
  });

  it("reports a faded hour as faded", () => {
    // 21:00 moves up decisively, 22:00 gives it straight back.
    const p = buildHourlyProfile(
      "UNIUSDT",
      build(60, { body: (h) => (h === 21 ? 3 : h === 22 ? -3 : 0), range: () => 1 })
    );
    const h21 = p.hours.find((h) => h.hour === 21)!;
    expect(h21.followThroughPct).toBe(0);
  });

  it("reads taker-buy share per hour", () => {
    const p = buildHourlyProfile("UNIUSDT", build(60, { takerShare: (h) => (h === 5 ? 0.8 : 0.5) }));
    expect(p.hours.find((h) => h.hour === 5)!.takerBuySharePct).toBeCloseTo(80, 0);
    expect(p.hours.find((h) => h.hour === 6)!.takerBuySharePct).toBeCloseTo(50, 0);
  });

  it("hedges every directional statement it makes", () => {
    // The failure mode this guards is the profile turning into a trading
    // schedule: "buy at 09:00" is exactly what a mean return per hour invites,
    // and exactly what the sample cannot support.
    const p = buildHourlyProfile("UNIUSDT", build(90, { body: (h, d) => (h === 9 ? 0.4 : d % 2 ? 0.05 : -0.05) }));
    const text = p.summary.join(" ").toLowerCase() + " " + p.note.toLowerCase();
    for (const banned of [
      "will rise",
      "will fall",
      "best time to buy",
      "best time to trade",
      "guaranteed",
      "expect price to",
    ]) {
      expect(text).not.toContain(banned);
    }
    expect(text).toMatch(/record of this window|describes this window|trivia|noisiest/);
  });

  it("says what a profile of one trend actually is", () => {
    const p = buildHourlyProfile("UNIUSDT", build(90));
    expect(p.note).toMatch(/window spanning one large trend/i);
  });

  it("carries the span so the reader can weigh the sample", () => {
    const p = buildHourlyProfile("UNIUSDT", build(90));
    expect(p.bars).toBe(90 * 24);
    expect(p.days).toBe(90);
    expect(p.from).toBe(START);
    expect(p.to).toBe(START + (90 * 24 - 1) * HOUR);
  });

  it("survives zero-volume and zero-range bars without emitting NaN", () => {
    // Newly listed contracts and exchange outages both produce these.
    const candles = build(40).map((c, i) =>
      i % 7 === 0 ? { ...c, volume: 0, takerBuyVolume: 0, high: c.close, low: c.close } : c
    );
    const p = buildHourlyProfile("UNIUSDT", candles);
    for (const h of p.hours) {
      for (const v of [h.volumeMultiple, h.volumeSharePct, h.rangeMultiple, h.rangePct]) {
        expect(Number.isFinite(v)).toBe(true);
      }
      if (h.takerBuySharePct != null) expect(Number.isFinite(h.takerBuySharePct)).toBe(true);
    }
  });

  it("labels hours as two-digit UTC", () => {
    expect(hourLabel(0)).toBe("00:00");
    expect(hourLabel(9)).toBe("09:00");
    expect(hourLabel(23)).toBe("23:00");
  });
});
