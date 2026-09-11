import { describe, expect, it } from "vitest";
import { barIntervalSeconds, thinMarkers, PlaceableMarker } from "@/components/chart/markerLayout";

/**
 * The bug this exists for: `SUPPLY ABSORBED ★` printed on three adjacent bars
 * with `SELLERS TRAPPED` under them, all in the belowBar lane, rendered as one
 * unreadable block. So the tests that matter are the crowded ones — and the
 * ones asserting nothing is hidden when there is room, because a chart that
 * quietly drops events is worse than a busy one.
 */

const T0 = 1_700_000_000;
const BAR = 900; // 15m

function mark(
  offsetBars: number,
  text: string,
  extra: Partial<PlaceableMarker> = {}
): PlaceableMarker {
  return {
    time: T0 + offsetBars * BAR,
    position: "belowBar",
    text,
    ...extra,
  };
}

/** Roomy: 40px per bar fits a ~14-character label inside three bars. */
const ROOMY = { pxPerBar: 40, barSeconds: BAR };
/** Tight: 4px per bar, where a label spans dozens of bars. */
const TIGHT = { pxPerBar: 4, barSeconds: BAR };

describe("thinMarkers — what it refuses to do", () => {
  it("drops nothing when the bar spacing is unknown", () => {
    // Before layout there is no measurement, and guessing would hide events.
    const all = [mark(0, "SUPPLY ABSORBED"), mark(1, "SELLERS TRAPPED")];
    expect(thinMarkers(all, { pxPerBar: 0, barSeconds: BAR })).toHaveLength(2);
    expect(thinMarkers(all, { pxPerBar: NaN, barSeconds: BAR })).toHaveLength(2);
  });

  it("drops nothing when the bar interval is unknown", () => {
    const all = [mark(0, "SUPPLY ABSORBED"), mark(1, "SELLERS TRAPPED")];
    expect(thinMarkers(all, { pxPerBar: 40, barSeconds: 0 })).toHaveLength(2);
  });

  it("keeps everything that genuinely fits", () => {
    const all = [mark(0, "BOS"), mark(20, "CHOCH"), mark(40, "SWEEP")];
    expect(thinMarkers(all, ROOMY)).toHaveLength(3);
  });

  it("never collides two lanes against each other", () => {
    // Above and below the bar are different bands, so the same x is fine.
    const all = [
      mark(0, "SUPPLY ABSORBED", { position: "belowBar" }),
      mark(0, "BUYERS EXHAUSTED", { position: "aboveBar" }),
    ];
    expect(thinMarkers(all, ROOMY)).toHaveLength(2);
  });

  it("leaves the input array alone", () => {
    const all = [mark(3, "C"), mark(1, "A"), mark(2, "B")];
    const before = all.map((m) => m.text);
    thinMarkers(all, ROOMY);
    expect(all.map((m) => m.text)).toEqual(before);
  });

  it("returns nothing for nothing", () => {
    expect(thinMarkers([], ROOMY)).toEqual([]);
  });
});

describe("thinMarkers — the overlap that started this", () => {
  it("collapses a run of absorption labels on adjacent bars", () => {
    const run = [0, 1, 2, 3].map((i) => mark(i, "SUPPLY ABSORBED ★"));
    const kept = thinMarkers(run, ROOMY);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(run.length);
  });

  it("lets the trap beat the absorption for the same stretch of chart", () => {
    const kept = thinMarkers(
      [
        mark(0, "SUPPLY ABSORBED ★", { priority: 80 }),
        mark(1, "SUPPLY ABSORBED ★", { priority: 80 }),
        mark(2, "SELLERS TRAPPED", { priority: 90 }),
      ],
      ROOMY
    );
    expect(kept.map((m) => m.text)).toContain("SELLERS TRAPPED");
  });

  it("gives way to the higher rank regardless of which came first", () => {
    // Same pair, opposite order in the input: the answer must not change.
    const a = thinMarkers(
      [mark(0, "AGGR SELL 80%", { priority: 30 }), mark(1, "CHOCH", { priority: 85 })],
      ROOMY
    );
    const b = thinMarkers(
      [mark(1, "CHOCH", { priority: 85 }), mark(0, "AGGR SELL 80%", { priority: 30 })],
      ROOMY
    );
    expect(a.map((m) => m.text)).toEqual(["CHOCH"]);
    expect(b.map((m) => m.text)).toEqual(["CHOCH"]);
  });

  it("prefers the newer of two equally ranked marks", () => {
    // Usefulness decays: the recent read is live, the old one is history.
    const kept = thinMarkers([mark(0, "SWEEP"), mark(1, "SWEEP")], ROOMY);
    expect(kept).toHaveLength(1);
    expect(kept[0].time).toBe(T0 + BAR);
  });

  it("thins harder as the chart zooms out", () => {
    const spread = [0, 4, 8, 12, 16, 20].map((i) => mark(i, "DEMAND ABSORBED"));
    expect(thinMarkers(spread, TIGHT).length).toBeLessThan(thinMarkers(spread, ROOMY).length);
  });

  it("keeps at least one marker however tight the zoom", () => {
    const spread = [0, 1, 2, 3, 4].map((i) => mark(i, "BUYERS EXHAUSTED"));
    expect(thinMarkers(spread, { pxPerBar: 1, barSeconds: BAR }).length).toBeGreaterThanOrEqual(1);
  });

  it("a long label crowds out more than a short one", () => {
    const long = [0, 2].map((i) => mark(i, "SHAKEOUT SHORTS 12.4× !"));
    const short = [0, 2].map((i) => mark(i, "BOS"));
    expect(thinMarkers(long, ROOMY).length).toBeLessThanOrEqual(thinMarkers(short, ROOMY).length);
  });

  it("still separates textless markers by their shape", () => {
    // Two arrows drawn on the same spot are as unreadable as two labels.
    const kept = thinMarkers([mark(0, ""), mark(0, "")], { pxPerBar: 4, barSeconds: BAR });
    expect(kept).toHaveLength(1);
  });
});

describe("thinMarkers — output contract", () => {
  it("returns markers sorted ascending by time", () => {
    // setMarkers throws on unsorted input, so this is not cosmetic.
    const kept = thinMarkers(
      [
        mark(30, "C", { position: "aboveBar" }),
        mark(10, "A"),
        mark(20, "B", { position: "aboveBar" }),
        mark(0, "D"),
      ],
      ROOMY
    );
    const times = kept.map((m) => m.time);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("sorts even when it drops nothing", () => {
    const kept = thinMarkers([mark(2, "B"), mark(0, "A")], { pxPerBar: 0, barSeconds: BAR });
    expect(kept.map((m) => m.text)).toEqual(["A", "B"]);
  });

  it("hands back the original objects, not copies", () => {
    const one = mark(0, "BOS");
    expect(thinMarkers([one], ROOMY)[0]).toBe(one);
  });
});

describe("barIntervalSeconds", () => {
  it("reads the interval off a regular series", () => {
    const times = [0, 1, 2, 3, 4].map((i) => T0 + i * BAR);
    expect(barIntervalSeconds(times)).toBe(BAR);
  });

  it("survives a gap in the series", () => {
    // Exchange downtime leaves holes; one sampled gap would report 15m as 2h.
    const times = [T0, T0 + BAR, T0 + BAR * 9, T0 + BAR * 10, T0 + BAR * 11];
    expect(barIntervalSeconds(times)).toBe(BAR);
  });

  it("reports nothing measurable as zero", () => {
    expect(barIntervalSeconds([])).toBe(0);
    expect(barIntervalSeconds([T0])).toBe(0);
    expect(barIntervalSeconds([T0, T0])).toBe(0);
  });
});
