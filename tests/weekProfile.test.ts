import { describe, expect, it } from "vitest";
import { buildWeekProfile, sessionOf, WEEKDAYS } from "@/engines/weekProfile";
import { Candle } from "@/engines/types";

/**
 * The point of this engine is that it says "no" most of the time. A
 * weekday-by-hour scan will always turn up striking-looking cells on pure
 * noise, and the tests that matter here are the ones proving the engine
 * throws those away rather than reporting them.
 */

const HOUR = 3600;
/** A Sunday 00:00 UTC, so weekday 0 of the series really is Sunday. */
const START = Date.UTC(2024, 8, 1, 0, 0, 0) / 1000;

interface Shape {
  volume?: (weekday: number, hour: number) => number;
  /** close-open move in price units */
  body?: (weekday: number, hour: number, week: number) => number;
  range?: (weekday: number, hour: number) => number;
}

function build(weeks: number, shape: Shape = {}): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      for (let h = 0; h < 24; h++) {
        const time = START + ((w * 7 + d) * 24 + h) * HOUR;
        const body = shape.body?.(d, h, w) ?? 0;
        const range = shape.range?.(d, h) ?? 1;
        const open = price;
        const close = open + body;
        const volume = 1000 * (shape.volume?.(d, h) ?? 1);
        out.push({
          time,
          open,
          close,
          high: Math.max(open, close) + range / 2,
          low: Math.min(open, close) - range / 2,
          volume,
          takerBuyVolume: volume * 0.5,
        });
        price = close;
      }
    }
  }
  return out;
}

/** Deterministic pseudo-random noise, so "no pattern" means no pattern. */
function noise(seed: number) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5);
}

describe("buildWeekProfile", () => {
  it("declines to profile a window too short for the repeat test", () => {
    const p = buildWeekProfile("UNIUSDT", build(3));
    expect(p.cells).toEqual([]);
    expect(p.recurring).toEqual([]);
    expect(p.note).toMatch(/not enough history/i);
  });

  it("fills the full 7x24 grid keyed to UTC weekday and hour", () => {
    const p = buildWeekProfile("UNIUSDT", build(20));
    expect(p.cells).toHaveLength(168);
    for (const c of p.cells) expect(c.samples).toBe(20);
    expect(p.weekdays).toHaveLength(7);
    expect(p.weekdays[0].label).toBe("Sunday");
    expect(p.weekdays[5].label).toBe("Friday");
  });

  it("finds the weekend volume gap every crypto market has", () => {
    // Weekdays trade at 2x the weekend.
    const p = buildWeekProfile(
      "UNIUSDT",
      build(26, { volume: (d) => (d === 0 || d === 6 ? 1 : 2) })
    );
    const sat = p.weekdays[6];
    const wed = p.weekdays[3];
    expect(wed.volumeMultiple).toBeGreaterThan(sat.volumeMultiple * 1.7);
    expect(p.summary.join(" ")).toMatch(/busiest weekday is/i);
  });

  it("locates the busy weekday-session slots", () => {
    // Friday US hours carries triple volume.
    const p = buildWeekProfile(
      "UNIUSDT",
      build(26, { volume: (d, h) => (d === 5 && h >= 13 && h < 21 ? 3 : 1) })
    );
    expect(p.busiestSlots[0]).toBe("5-us");
    const slot = p.slots.find((s) => s.key === "5-us")!;
    expect(slot.label).toBe("Friday 13–21 UTC");
    expect(slot.volumeMultiple).toBeGreaterThan(2.5);
  });

  /* ---- The part that matters ---- */

  it("reports no recurring pattern on pure noise", () => {
    // A year of directionless bars. A naive 5% scan over 168 cells would be
    // expected to surface several "patterns" here; the corrected, repeat-
    // checked search must surface none.
    const rnd = noise(11);
    const p = buildWeekProfile("UNIUSDT", build(52, { body: () => rnd() * 2 }));
    expect(p.recurring).toEqual([]);
    expect(p.candidatesTested).toBeGreaterThan(150);
    expect(p.patternNote).toMatch(/did not survive|ordinary outcome/i);
  });

  it("stays empty on noise across several different seeds", () => {
    // One quiet seed proves nothing — the claim is that the filter holds.
    for (const seed of [3, 29, 61, 97, 131]) {
      const rnd = noise(seed);
      const p = buildWeekProfile("UNIUSDT", build(52, { body: () => rnd() * 2 }));
      expect(p.recurring).toEqual([]);
    }
  });

  it("corrects the threshold for the number of candidates tested", () => {
    const p = buildWeekProfile("UNIUSDT", build(52, { body: () => 0 }));
    // Expected false positives = tests x corrected alpha, which is alpha
    // itself. That is the whole point of the correction.
    expect(p.expectedByChance).toBeCloseTo(0.05, 2);
  });

  it("does surface a bias that is both strong and repeated", () => {
    // Friday US hours closes up every single time, all year. If the engine
    // cannot find this, it is filtering too hard to be useful.
    const rnd = noise(5);
    const p = buildWeekProfile(
      "UNIUSDT",
      build(52, {
        body: (d, h) => (d === 5 && h >= 13 && h < 21 ? 0.5 : rnd() * 2),
      })
    );
    expect(p.recurring.length).toBeGreaterThan(0);
    expect(p.recurring.some((b) => b.key === "5-us")).toBe(true);
    const friday = p.recurring.find((b) => b.key === "5-us")!;
    expect(friday.upSharePct).toBe(100);
    expect(friday.firstHalfUpPct).toBe(100);
    expect(friday.secondHalfUpPct).toBe(100);
  });

  it("rejects a bias that appears in only one half of the window", () => {
    // The failure mode the repeat test exists for: a strong tendency that
    // stopped. Over the whole window it looks significant; it is not a
    // pattern, it is a thing that used to happen.
    const rnd = noise(17);
    const p = buildWeekProfile(
      "UNIUSDT",
      build(52, {
        body: (d, h, w) => (d === 2 && h >= 8 && h < 13 && w < 26 ? 0.6 : rnd() * 2),
      })
    );
    expect(p.recurring.some((b) => b.key === "2-europe")).toBe(false);
    const tue = p.slots.find((s) => s.key === "2-europe")!;
    // The raw figures still show what happened — only the verdict is withheld.
    expect(tue.firstHalfUpPct!).toBeGreaterThan(tue.secondHalfUpPct!);
  });

  it("keeps both halves on the record so the reader can see the split", () => {
    const p = buildWeekProfile("UNIUSDT", build(52, { body: () => 0.1 }));
    for (const b of [...p.weekdays, ...p.sessions]) {
      expect(b.firstHalfUpPct).not.toBeNull();
      expect(b.secondHalfUpPct).not.toBeNull();
    }
  });

  it("withholds every directional figure below the sample floor", () => {
    const p = buildWeekProfile("UNIUSDT", build(8));
    for (const c of p.cells) {
      // 8 samples per cell is far under the floor.
      expect(c.upSharePct).toBeNull();
      expect(c.meanReturnPct).toBeNull();
      // Volume is still reported: it needs no significance test.
      expect(c.volumeMultiple).toBeGreaterThan(0);
    }
  });

  it("never promises a pattern will hold", () => {
    const rnd = noise(5);
    const p = buildWeekProfile(
      "UNIUSDT",
      build(52, { body: (d, h) => (d === 5 && h >= 13 && h < 21 ? 0.5 : rnd() * 2) })
    );
    const text = `${p.summary.join(" ")} ${p.patternNote} ${p.note}`.toLowerCase();
    for (const banned of [
      "will continue",
      "will repeat",
      "always pumps",
      "guaranteed",
      "reliable edge",
      "you should buy",
    ]) {
      expect(text).not.toContain(banned);
    }
    expect(text).toMatch(/lead to watch forward|not an edge to size/);
    expect(text).toMatch(/describes this window|one market cycle/);
  });

  it("maps hours onto the right session", () => {
    expect(sessionOf(0).key).toBe("asia");
    expect(sessionOf(7).key).toBe("asia");
    expect(sessionOf(8).key).toBe("europe");
    expect(sessionOf(12).key).toBe("europe");
    expect(sessionOf(13).key).toBe("us");
    expect(sessionOf(20).key).toBe("us");
    expect(sessionOf(21).key).toBe("late");
    expect(sessionOf(23).key).toBe("late");
  });

  it("covers every hour of the week exactly once across the sessions", () => {
    // A gap would silently drop bars out of the slot buckets.
    const seen = new Set<number>();
    for (let h = 0; h < 24; h++) seen.add(h);
    const covered = new Set<number>();
    for (let h = 0; h < 24; h++) covered.add(sessionOf(h).from <= h ? h : -1);
    expect(covered).toEqual(seen);
    const p = buildWeekProfile("UNIUSDT", build(20));
    const slotBars = p.slots.reduce((s, x) => s + x.samples, 0);
    expect(slotBars).toBe(p.bars);
  });

  it("survives zero-volume and flat bars without emitting NaN", () => {
    const candles = build(20).map((c, i) =>
      i % 11 === 0 ? { ...c, volume: 0, takerBuyVolume: 0, high: c.close, low: c.close } : c
    );
    const p = buildWeekProfile("UNIUSDT", candles);
    for (const c of p.cells) {
      expect(Number.isFinite(c.volumeMultiple)).toBe(true);
      expect(Number.isFinite(c.rangeMultiple)).toBe(true);
    }
    for (const b of [...p.weekdays, ...p.sessions, ...p.slots]) {
      if (b.z != null) expect(Number.isFinite(b.z)).toBe(true);
    }
  });

  it("names weekdays in UTC, matching the bucketing", () => {
    expect(WEEKDAYS[new Date(START * 1000).getUTCDay()]).toBe("Sunday");
    const p = buildWeekProfile("UNIUSDT", build(20));
    expect(p.weekdays.map((d) => d.label)).toEqual(WEEKDAYS);
  });
});
