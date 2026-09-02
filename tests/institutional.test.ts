import { describe, expect, it } from "vitest";
import {
  detectInstitutional,
  Mark,
  measureHistory,
  summariseFunding,
} from "@/engines/institutional";
import { Candle } from "@/engines/types";
import { syntheticCandles } from "./helpers";

/**
 * This engine makes a narrow claim — several *different kinds* of evidence
 * landed on one price band — and deliberately stops short of a forecast. Both
 * halves need guarding: the confluence arithmetic must not inflate, and the
 * output must not start predicting.
 */

/**
 * A constructed accumulation sequence: a flush that liquidates longs, a base
 * where heavy volume trades in a tight range on the bid, and a departure that
 * leaves a gap behind. That is the shape the engine is meant to recognise.
 */
function accumulationSeries(): Candle[] {
  const out: Candle[] = [];
  const t = (i: number) => 1_700_000_000 + i * 3600;
  let price = 120;

  // 1. Distribution and decline — supplies the swings the structure engine needs.
  for (let i = 0; i < 40; i++) {
    const open = price;
    const close = open - 0.5 - (i % 3) * 0.1;
    out.push({
      time: t(i),
      open,
      high: open + 0.3,
      low: close - 0.35,
      close,
      volume: 1000 + (i % 5) * 60,
      takerBuyVolume: (1000 + (i % 5) * 60) * 0.4,
    });
    price = close;
  }

  // 2. The flush: an outsized down bar on sell-side aggression, with a long
  //    lower wick — forced supply hitting whatever was resting underneath.
  const flushOpen = price;
  const flushLow = flushOpen - 6;
  const flushClose = flushOpen - 1.4;
  out.push({
    time: t(40),
    open: flushOpen,
    high: flushOpen + 0.2,
    low: flushLow,
    close: flushClose,
    volume: 9000,
    takerBuyVolume: 9000 * 0.18,
  });
  price = flushClose;

  // 3. The base: heavy volume, tight range, buy-side taker share. Selling
  //    keeps arriving and price refuses to go with it.
  for (let i = 0; i < 14; i++) {
    const open = price;
    const close = open + 0.05;
    out.push({
      time: t(41 + i),
      open,
      high: open + 0.28,
      low: open - 0.3,
      close,
      volume: 6000,
      takerBuyVolume: 6000 * 0.63,
    });
    price = close;
  }

  // 4. The departure: three bars that gap away from the base, leaving an
  //    unfilled bullish imbalance behind them.
  const legs = [
    { o: price, h: price + 2.2, l: price - 0.1, c: price + 2.0 },
    { o: price + 2.4, h: price + 5.4, l: price + 2.3, c: price + 5.2 },
    { o: price + 5.3, h: price + 7.6, l: price + 5.2, c: price + 7.3 },
  ];
  legs.forEach((leg, i) => {
    out.push({
      time: t(55 + i),
      open: leg.o,
      high: leg.h,
      low: leg.l,
      close: leg.c,
      volume: 7000,
      takerBuyVolume: 7000 * 0.72,
    });
  });
  price = legs[2].c;

  // 5. A drift back toward the area, so the zone is still in range of price.
  for (let i = 0; i < 12; i++) {
    const open = price;
    const close = open - 0.25;
    out.push({
      time: t(58 + i),
      open,
      high: open + 0.2,
      low: close - 0.25,
      close,
      volume: 2200,
      takerBuyVolume: 2200 * 0.47,
    });
    price = close;
  }

  return out;
}

/**
 * A market oscillating between two boundaries it keeps coming back to. The
 * range detector is deliberately strict — both edges must be visited more than
 * once — so a fixture is the only way to reach the non-null branch.
 */
function rangingSeries(): Candle[] {
  const out: Candle[] = [];
  const t = (i: number) => 1_700_000_000 + i * 3600;
  const low = 100;
  const high = 108;
  for (let i = 0; i < 120; i++) {
    // Four full sweeps between the boundaries over the window.
    const phase = Math.sin((i / 15) * Math.PI);
    const mid = (low + high) / 2 + (phase * (high - low)) / 2;
    const open = mid;
    const close = mid + (i % 2 === 0 ? 0.12 : -0.12);
    out.push({
      time: t(i),
      open,
      high: Math.max(open, close) + 0.25,
      low: Math.min(open, close) - 0.25,
      close,
      volume: 1500 + (i % 7) * 80,
      takerBuyVolume: (1500 + (i % 7) * 80) * (phase < 0 ? 0.58 : 0.42),
    });
  }
  return out;
}

/**
 * Demand areas that are subsequently cut through. Without this the `broke`
 * branch of the historical measurement would never run, and "100% held" would
 * be indistinguishable from a detector that cannot record a failure.
 */
function brokenDemandSeries(): Candle[] {
  const out: Candle[] = [];
  const t = (i: number) => 1_700_000_000 + i * 3600;
  let price = 100;

  // Build: impulses up leaving gaps and blocks behind them.
  for (let cycle = 0; cycle < 5; cycle++) {
    for (let i = 0; i < 3; i++) {
      const open = price;
      const close = open - 0.6;
      out.push({
        time: t(out.length),
        open,
        high: open + 0.2,
        low: close - 0.8, // long lower wicks → rejection marks
        close,
        volume: 2000,
        takerBuyVolume: 2000 * 0.42,
      });
      price = close;
    }
    for (let i = 0; i < 3; i++) {
      const open = price + 0.9; // gap up, leaving an unfilled bullish FVG
      const close = open + 1.6;
      out.push({
        time: t(out.length),
        open,
        high: close + 0.2,
        low: open - 0.1,
        close,
        volume: 3000,
        takerBuyVolume: 3000 * 0.7,
      });
      price = close;
    }
  }

  // Break: a sustained decline that closes back through everything built above.
  for (let i = 0; i < 60; i++) {
    const open = price;
    const close = open - 0.55;
    out.push({
      time: t(out.length),
      open,
      high: open + 0.15,
      low: close - 0.2,
      close,
      volume: 2600,
      takerBuyVolume: 2600 * 0.33,
    });
    price = close;
  }

  // Finish on a bounce off the lows, so the *current* read leans demand while
  // every demand area in the history above was already cut through. Without
  // this tail the series ends mid-decline, supply leads, and the historical
  // pass measures supply areas instead of the broken demand ones.
  for (let i = 0; i < 18; i++) {
    const open = price;
    const close = open + 0.35;
    out.push({
      time: t(out.length),
      open,
      high: close + 0.15,
      low: open - 1.1, // deep lower wicks: bought back every time
      close,
      volume: 4200,
      takerBuyVolume: 4200 * 0.68,
    });
    price = close;
  }
  return out;
}

describe("detectInstitutional", () => {
  it("returns a safe empty read on short history", () => {
    const r = detectInstitutional("TESTUSDT", "1h", syntheticCandles(20, 5, 100));
    expect(r.qualified).toBe(false);
    expect(r.zone).toBeNull();
    expect(r.score).toBe(0);
    expect(r.headline).toMatch(/history/i);
  });

  it("counts distinct kinds of evidence, never repeats of one", () => {
    const r = detectInstitutional("TESTUSDT", "1h", accumulationSeries());
    for (const z of r.zones) {
      // The whole thesis: three order blocks at one price is one mechanism
      // repeating, so `confluence` must track distinct sources, not marks.
      expect(new Set(z.sources).size).toBe(z.sources.length);
      expect(z.confluence).toBe(z.sources.length);
    }
  });

  it("only qualifies when score, kinds and confluence all clear their bars", () => {
    for (const seed of [3, 11, 29, 47, 61]) {
      const r = detectInstitutional("TESTUSDT", "1h", syntheticCandles(200, seed, 100));
      const kinds = r.evidence.filter((e) => e.found).length;
      if (r.qualified) {
        expect(r.score).toBeGreaterThanOrEqual(60);
        expect(kinds).toBeGreaterThanOrEqual(4);
        expect(r.zone?.confluence ?? 0).toBeGreaterThanOrEqual(2);
        expect(r.side).toBe("accumulation");
      } else {
        expect(r.side).toBe("none");
      }
    }
  });

  it("finds converging evidence on a constructed accumulation sequence", () => {
    const r = detectInstitutional("TESTUSDT", "1h", accumulationSeries());
    const found = r.evidence.filter((e) => e.found).map((e) => e.key);
    // Not asserting `qualified` — the bar is deliberately high and a synthetic
    // series need not clear it. What must hold is that the shape registers:
    // several mechanisms fire, and they land on one area rather than scatter.
    expect(found.length).toBeGreaterThanOrEqual(3);
    expect(r.zones.length).toBeGreaterThan(0);
    expect(r.zone).not.toBeNull();
    expect(r.score).toBeGreaterThan(0);
  });

  it("states the limit of its claim rather than implying a forecast", () => {
    const r = detectInstitutional("TESTUSDT", "1h", accumulationSeries());
    const text = r.explanation.join(" ");
    expect(text).toMatch(/What this does not say: where price goes next/);
    // No probability-of-profit language anywhere in the output.
    expect(text).not.toMatch(/\d+% (chance|likely|probability of (a )?(win|profit))/i);
  });

  it("keeps every reported zone within the in-range window", () => {
    for (const seed of [2, 13, 37]) {
      const r = detectInstitutional("TESTUSDT", "1h", syntheticCandles(200, seed, 100));
      for (const z of r.zones) {
        // Evidence 12% away is history, not an area price is trading against.
        expect(Math.abs(z.distancePct)).toBeLessThanOrEqual(12);
        expect(z.low).toBeLessThanOrEqual(z.high);
        expect(z.mid).toBeGreaterThanOrEqual(z.low);
        expect(z.mid).toBeLessThanOrEqual(z.high);
      }
    }
  });

  it("points its levels in the direction of the leading side", () => {
    for (const seed of [3, 11, 29, 47, 61]) {
      const r = detectInstitutional("TESTUSDT", "1h", syntheticCandles(200, seed, 100));
      const buy = r.demand.score >= r.supply.score;
      if (r.zone) {
        // Invalidation is the far edge of the area: below it on a demand read,
        // above it on a supply read. A field named `confirmAbove` would have
        // been simply wrong on half of these.
        expect(r.invalidateLevel).toBe(buy ? r.zone.low : r.zone.high);
      }
      if (r.confirmLevel != null) {
        if (buy) expect(r.confirmLevel).toBeGreaterThan(r.price);
        else expect(r.confirmLevel).toBeLessThan(r.price);
      }
      if (r.objective != null && r.confirmLevel != null) {
        if (buy) expect(r.objective).toBeGreaterThan(r.confirmLevel);
        else expect(r.objective).toBeLessThan(r.confirmLevel);
      }
    }
  });

  it("reads falling open interest as positions leaving, not size building", () => {
    const candles = accumulationSeries();
    const rising = detectInstitutional("TESTUSDT", "1h", candles, [100, 110, 125, 140, 160]);
    const falling = detectInstitutional("TESTUSDT", "1h", candles, [160, 145, 130, 115, 100]);

    const oiOf = (r: ReturnType<typeof detectInstitutional>) =>
      r.evidence.find((e) => e.key === "open_interest")!;
    expect(oiOf(rising).found).toBe(true);
    expect(oiOf(falling).found).toBe(false);
    expect(rising.score).toBeGreaterThan(falling.score);
    expect(oiOf(falling).detail).toMatch(/closing|covering/i);
  });

  it("reports no open-interest read when none is supplied", () => {
    const r = detectInstitutional("TESTUSDT", "1h", accumulationSeries(), null);
    expect(r.openInterestChangePct).toBeNull();
    const oi = r.evidence.find((e) => e.key === "open_interest")!;
    expect(oi.found).toBe(false);
    expect(oi.detail).toMatch(/No open-interest history/i);
  });

  /* ---- Both sides ---- */

  it("always evaluates supply as well as demand", () => {
    // The original engine only ever checked the buy side, so every chart came
    // back looking like accumulation — the absence of a supply read was never
    // visible. Both must always be present and fully scored.
    const r = detectInstitutional("TESTUSDT", "1h", accumulationSeries());
    expect(r.demand.side).toBe("accumulation");
    expect(r.supply.side).toBe("distribution");
    expect(r.demand.evidence.length).toBe(r.supply.evidence.length);
    expect(r.demand.evidence.length).toBeGreaterThanOrEqual(10);
    for (const read of [r.demand, r.supply]) {
      expect(read.score).toBeGreaterThanOrEqual(0);
      expect(read.score).toBeLessThanOrEqual(100);
      expect(read.kinds).toBeLessThanOrEqual(read.evidence.length);
    }
  });

  it("checks buying-absorbed on the supply side, not only selling-absorbed", () => {
    const r = detectInstitutional("TESTUSDT", "1h", accumulationSeries());
    const demandLabels = r.demand.evidence.map((e) => e.label);
    const supplyLabels = r.supply.evidence.map((e) => e.label);
    expect(demandLabels).toContain("Selling absorbed");
    expect(supplyLabels).toContain("Buying absorbed");
    expect(demandLabels).toContain("Unmitigated demand block");
    expect(supplyLabels).toContain("Unmitigated supply block");
    expect(demandLabels).toContain("Unfilled demand gap");
    expect(supplyLabels).toContain("Unfilled supply gap");
  });

  it("reports the stronger side and mirrors it in the top-level fields", () => {
    for (const seed of [3, 11, 29, 47, 61]) {
      const r = detectInstitutional("TESTUSDT", "1h", syntheticCandles(200, seed, 100));
      const lead = r.supply.score > r.demand.score ? r.supply : r.demand;
      expect(r.score).toBe(lead.score);
      expect(r.evidence).toBe(lead.evidence);
      expect(r.zone).toBe(lead.zone);
      if (r.qualified) expect(r.side).toBe(lead.side);
    }
  });

  /* ---- Checklist additions ---- */

  it("carries HH/HL on the demand side and LH/LL on the supply side", () => {
    const r = detectInstitutional("TESTUSDT", "1h", accumulationSeries());
    const d = r.demand.evidence.find((e) => e.key === "structure")!;
    const s = r.supply.evidence.find((e) => e.key === "structure")!;
    expect(d.label).toBe("Higher highs and higher lows");
    expect(s.label).toBe("Lower highs and lower lows");
    // The detail names the actual swing counts either way, so a "not found"
    // still says what was there rather than only that nothing was.
    expect(d.detail).toMatch(/HH|higher high/i);
    expect(s.detail).toMatch(/LH|lower high/i);
  });

  it("scores range location only when a range actually exists", () => {
    for (const seed of [2, 13, 37, 61]) {
      const r = detectInstitutional("TESTUSDT", "1h", syntheticCandles(200, seed, 100));
      const item = r.demand.evidence.find((e) => e.key === "range_location")!;
      if (r.range == null) {
        // The whole point of making this conditional: a high and low taken out
        // of a trend are two arbitrary numbers, so the item must score nothing
        // rather than manufacture a boundary.
        expect(item.found).toBe(false);
        expect(item.score).toBe(0);
        expect(item.price).toBeNull();
        expect(item.detail).toMatch(/no balance area/i);
      } else {
        expect(r.range.low).toBeLessThan(r.range.high);
        expect(r.range.position).toBeGreaterThanOrEqual(0);
        expect(r.range.position).toBeLessThanOrEqual(1);
        expect(r.range.touchesLow).toBeGreaterThanOrEqual(2);
        expect(r.range.touchesHigh).toBeGreaterThanOrEqual(2);
        if (item.found) expect(r.range.position).toBeLessThanOrEqual(0.35);
      }
    }
  });

  it("does not let a longer checklist make qualification easier", () => {
    // Adding items raises the number of ways to score, so the bar has to rise
    // with it. Guarded explicitly because the regression is silent: the engine
    // would simply start qualifying more symbols.
    for (const seed of [3, 11, 29, 47, 61, 2, 13, 37]) {
      const r = detectInstitutional("TESTUSDT", "1h", syntheticCandles(200, seed, 100));
      for (const read of [r.demand, r.supply]) {
        if (read.qualified) {
          expect(read.score).toBeGreaterThanOrEqual(64);
          expect(read.kinds).toBeGreaterThanOrEqual(5);
          expect(read.zone?.confluence ?? 0).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });

  /* ---- Historical analogues ---- */

  it("measures comparable areas from history rather than modelling them", () => {
    for (const seed of [3, 11, 29, 47]) {
      const candles = syntheticCandles(240, seed, 100);
      const r = detectInstitutional("TESTUSDT", "1h", candles);
      const h = r.history;
      expect(h.held + h.broke).toBe(h.samples);
      for (const a of h.analogues) {
        expect(a.low).toBeLessThanOrEqual(a.high);
        // Every analogue must sit on a real bar in the series.
        expect(candles.some((c) => c.time === a.time)).toBe(true);
        if (a.tapTime != null) {
          expect(candles.some((c) => c.time === a.tapTime)).toBe(true);
          // Price cannot return to an area before the area finished forming.
          expect(a.tapTime).toBeGreaterThan(a.time);
        } else {
          expect(a.outcome).toBe("unresolved");
        }
      }
    }
  });

  it("withholds a hit rate until it has enough resolved cases", () => {
    for (const seed of [3, 11, 29, 47, 61, 2, 13, 37]) {
      const h = detectInstitutional("TESTUSDT", "1h", syntheticCandles(240, seed, 100)).history;
      if (h.samples < 4) {
        // A rate from two cases is not a rate, and rendering one invites it to
        // be read as an edge.
        expect(h.holdRatePct).toBeNull();
        expect(h.medianFavourablePct).toBeNull();
        expect(h.medianAdversePct).toBeNull();
        expect(h.note).toMatch(/below the 4 needed|Only \d+ comparable/);
      } else {
        expect(h.holdRatePct).toBeCloseTo((h.held / h.samples) * 100, 1);
        expect(h.note).toMatch(/not an edge/i);
      }
    }
  });

  it("never scores an analogue whose outcome has not had time to resolve", () => {
    const candles = syntheticCandles(240, 11, 100);
    const lastTime = candles[candles.length - 1].time;
    const barSeconds = candles[1].time - candles[0].time;
    const h = detectInstitutional("TESTUSDT", "1h", candles).history;
    for (const a of h.analogues) {
      if (a.outcome === "unresolved") continue;
      // A resolved case needs 20 bars of forward data after the tap; anything
      // closer to the live edge would be counting the present as history.
      expect(a.tapTime).not.toBeNull();
      expect(lastTime - a.tapTime!).toBeGreaterThanOrEqual(20 * barSeconds);
    }
  });

  it("records areas that failed, not only the ones that held", () => {
    // Driven directly rather than through a fixture: reaching the `broke`
    // branch end-to-end requires four upstream detectors to agree on a
    // synthetic series, which tests their thresholds rather than this logic.
    // Guards the failure mode where every sample comes back "held" — a
    // classifier that cannot record a loss reports 100% on any input.
    const candles = brokenDemandSeries();
    const price = candles[candles.length - 1].close;
    const area = { low: price * 0.98, high: price * 0.99 };
    // Two distinct sources, so the cluster reaches the confluence floor.
    const marks: Mark[] = [
      { source: "order_block", low: area.low, high: area.high, index: 5 },
      { source: "rejection", low: area.low, high: area.high, index: 6 },
    ];
    const h = measureHistory("accumulation", marks, candles);
    expect(h.samples).toBe(1);
    // The fixture closes far below that band during its decline.
    expect(h.broke).toBe(1);
    expect(h.analogues[0].outcome).toBe("broke");
    expect(h.analogues[0].tapTime).not.toBeNull();
  });

  it("counts a hold when price returns to an area and does not close through", () => {
    // The mirror of the case above, so "held" is not simply the default that
    // arrives whenever nothing else fires.
    const candles = rangingSeries();
    const low = Math.min(...candles.map((c) => c.low));
    // An area below everything the series ever traded: touched by nothing,
    // closed through by nothing.
    const untouched: Mark[] = [
      { source: "order_block", low: low * 0.9, high: low * 0.92, index: 3 },
      { source: "rejection", low: low * 0.9, high: low * 0.92, index: 4 },
    ];
    const never = measureHistory("accumulation", untouched, candles);
    expect(never.analogues[0].outcome).toBe("unresolved");
    expect(never.samples).toBe(0);

    // An area inside the range, which price revisits repeatedly without ever
    // closing below it.
    const inside: Mark[] = [
      { source: "order_block", low: low + 0.05, high: low + 0.4, index: 3 },
      { source: "rejection", low: low + 0.05, high: low + 0.4, index: 4 },
    ];
    const held = measureHistory("accumulation", inside, candles);
    expect(held.samples).toBe(1);
    expect(held.held).toBe(1);
    expect(held.analogues[0].favourablePct).toBeGreaterThan(0);
  });

  it("will not resolve an area price never returned to", () => {
    const candles = rangingSeries();
    const high = Math.max(...candles.map((c) => c.high));
    // Kept narrow deliberately: a band wider than the 2.5% ceiling is split
    // into single-source clusters and dropped before it reaches the classifier.
    const marks: Mark[] = [
      { source: "order_block", low: high * 1.5, high: high * 1.51, index: 2 },
      { source: "fvg", low: high * 1.5, high: high * 1.51, index: 3 },
    ];
    const h = measureHistory("accumulation", marks, candles);
    expect(h.samples).toBe(0);
    expect(h.holdRatePct).toBeNull();
    expect(h.analogues[0].outcome).toBe("unresolved");
    expect(h.analogues[0].tapTime).toBeNull();
  });

  it("ignores areas with only one kind of evidence behind them", () => {
    const candles = rangingSeries();
    const price = candles[candles.length - 1].close;
    // Three marks, one source — a mechanism repeating, not confluence.
    const marks: Mark[] = [
      { source: "rejection", low: price * 0.98, high: price * 0.99, index: 3 },
      { source: "rejection", low: price * 0.981, high: price * 0.991, index: 4 },
      { source: "rejection", low: price * 0.982, high: price * 0.992, index: 5 },
    ];
    expect(measureHistory("accumulation", marks, candles).analogues).toHaveLength(0);
  });

  it("keeps every area narrow enough to still be a level", () => {
    for (const seed of [3, 11, 29, 47, 61, 2, 13, 37]) {
      const r = detectInstitutional("TESTUSDT", "1h", syntheticCandles(240, seed, 100));
      for (const z of [...r.demand.zones, ...r.supply.zones]) {
        expect(((z.high - z.low) / r.price) * 100).toBeLessThanOrEqual(2.5);
      }
      for (const a of r.history.analogues) {
        expect(((a.high - a.low) / r.price) * 100).toBeLessThanOrEqual(2.5);
      }
    }
  });

  it("locates the checklist against a real range when one exists", () => {
    const r = detectInstitutional("TESTUSDT", "1h", rangingSeries());
    expect(r.range).not.toBeNull();
    const range = r.range!;
    expect(range.low).toBeLessThan(range.high);
    expect(range.touchesLow).toBeGreaterThanOrEqual(2);
    expect(range.touchesHigh).toBeGreaterThanOrEqual(2);
    expect(range.position).toBeGreaterThanOrEqual(0);
    expect(range.position).toBeLessThanOrEqual(1);

    // Demand and supply cannot both be "at the edge" — the item is about where
    // price sits, and it sits in one place.
    const d = r.demand.evidence.find((e) => e.key === "range_location")!;
    const s = r.supply.evidence.find((e) => e.key === "range_location")!;
    expect(d.found && s.found).toBe(false);
    expect(r.explanation.join(" ")).toMatch(/Range: /);
  });

  /* ---- Funding ---- */

  it("reads the payer from Binance's sign convention, not the other way round", () => {
    // Positive rate = longs pay shorts. Getting this backwards would invert
    // every funding read on the page while still looking plausible.
    const longsPay = summariseFunding([{ rate: 0.0003 }, { rate: 0.0004 }, { rate: 0.00035 }])!;
    expect(longsPay.payer).toBe("longs");
    expect(longsPay.avgRatePct).toBeGreaterThan(0);

    const shortsPay = summariseFunding([{ rate: -0.0003 }, { rate: -0.0004 }, { rate: -0.00035 }])!;
    expect(shortsPay.payer).toBe("shorts");
    expect(shortsPay.avgRatePct).toBeLessThan(0);
  });

  it("calls near-zero funding balanced rather than picking a side", () => {
    // A hundredth of a basis point is noise around the anchor. Reporting it as
    // "longs pay" would manufacture a crowded cohort out of rounding.
    const f = summariseFunding([{ rate: 0.0000001 }, { rate: -0.0000002 }, { rate: 0.0000001 }])!;
    expect(f.payer).toBe("balanced");
  });

  it("separates a standing cost from a single spike via consistency", () => {
    const steady = summariseFunding(Array.from({ length: 10 }, () => ({ rate: -0.0002 })))!;
    expect(steady.consistency).toBe(1);

    // One large negative print in an otherwise positive series: the mean can
    // still come out negative while almost nothing agrees with it.
    const spike = summariseFunding([
      { rate: 0.0001 },
      { rate: 0.0001 },
      { rate: 0.0001 },
      { rate: 0.0001 },
      { rate: -0.01 },
    ])!;
    expect(spike.payer).toBe("shorts");
    expect(spike.consistency).toBeLessThan(0.7);
  });

  it("sums the cumulative cost rather than averaging it", () => {
    const f = summariseFunding([{ rate: -0.0001 }, { rate: -0.0001 }, { rate: -0.0001 }])!;
    // Three settlements at -0.01% each = -0.03% carried, which is the figure
    // that matters to the side paying it.
    expect(f.cumulativePct).toBeCloseTo(-0.03, 5);
    expect(f.avgRatePct).toBeCloseTo(-0.01, 5);
    expect(f.latestRatePct).toBeCloseTo(-0.01, 5);
  });

  it("declines to summarise a series too short to mean anything", () => {
    expect(summariseFunding([])).toBeNull();
    expect(summariseFunding([{ rate: 0.0001 }])).toBeNull();
    expect(summariseFunding([{ rate: 0.0001 }, { rate: 0.0002 }])).toBeNull();
  });

  it("scores funding for the side the crowd is NOT on", () => {
    const candles = syntheticCandles(240, 13, 100);
    // Shorts paying persistently: supports a demand read, argues against supply.
    const shortsPay = Array.from({ length: 10 }, () => ({ rate: -0.0004 }));
    const r = detectInstitutional("TESTUSDT", "1h", candles, RISING_OI, shortsPay);

    const demandItem = r.demand.evidence.find((e) => e.key === "funding")!;
    const supplyItem = r.supply.evidence.find((e) => e.key === "funding")!;
    expect(demandItem.found).toBe(true);
    expect(supplyItem.found).toBe(false);
    expect(demandItem.score).toBeGreaterThan(supplyItem.score);
    // The losing side must say *why* rather than merely report absence.
    expect(supplyItem.detail).toMatch(/same\b.*side|argues against/i);
  });

  it("reports no funding read when the series is unavailable", () => {
    const r = detectInstitutional("TESTUSDT", "1h", syntheticCandles(240, 13, 100), RISING_OI, null);
    expect(r.funding).toBeNull();
    const item = r.demand.evidence.find((e) => e.key === "funding")!;
    expect(item.found).toBe(false);
    expect(item.score).toBe(0);
    expect(item.detail).toMatch(/No funding history/i);
  });

  it("scores a bigger standing cost higher than a token one", () => {
    const candles = syntheticCandles(240, 13, 100);
    const token = Array.from({ length: 10 }, () => ({ rate: -0.00002 }));
    const heavy = Array.from({ length: 10 }, () => ({ rate: -0.0005 }));
    const cheap = detectInstitutional("TESTUSDT", "1h", candles, RISING_OI, token)
      .demand.evidence.find((e) => e.key === "funding")!;
    const dear = detectInstitutional("TESTUSDT", "1h", candles, RISING_OI, heavy)
      .demand.evidence.find((e) => e.key === "funding")!;
    // Right sign at a tenth of a basis point costs nobody anything; it must
    // not score the same as a crowd being bled every settlement.
    expect(dear.score).toBeGreaterThan(cheap.score);
  });

  /* ---- Tradable geometry ---- */

  /**
   * Open interest is supplied on purpose. Without it the checklist loses a
   * whole item and nothing in these fixtures clears the qualification bar, so
   * every geometry assertion below would pass on an empty set — the tests
   * would be green and would be checking nothing.
   */
  const RISING_OI = [100, 110, 125, 140, 160];
  // Widened when the qualification bar rose with the funding item: 17 is the
  // seed that qualifies and still withholds the trade, 41 the one that
  // qualifies with it. Without both, half the assertions below would be
  // checking an empty set.
  const GEOMETRY_SEEDS = [3, 11, 29, 47, 61, 2, 13, 37, 5, 23, 17, 41];

  it("reaches the qualified-with-trade state on at least one fixture", () => {
    const reads = GEOMETRY_SEEDS.map((seed) =>
      detectInstitutional("TESTUSDT", "1h", syntheticCandles(240, seed, 100), RISING_OI)
    );
    expect(reads.some((r) => r.qualified && r.trade !== null)).toBe(true);
    // And the withheld-trade branch, so "no trade" is not merely what happens
    // when nothing ever qualifies.
    expect(reads.some((r) => r.qualified && r.trade === null)).toBe(true);
  });

  it("only offers a trade on a qualified read", () => {
    for (const seed of GEOMETRY_SEEDS) {
      const r = detectInstitutional("TESTUSDT", "1h", syntheticCandles(240, seed, 100), RISING_OI);
      // An unqualified footprint is still a valid set of levels. Attaching an
      // entry price to it would put a number on a conclusion the engine
      // explicitly declined to draw.
      if (!r.qualified) expect(r.trade).toBeNull();
    }
  });

  it("points the trade the same way as the read, with the stop past invalidation", () => {
    let checked = 0;
    for (const seed of GEOMETRY_SEEDS) {
      const r = detectInstitutional("TESTUSDT", "1h", syntheticCandles(240, seed, 100), RISING_OI);
      if (!r.trade) continue;
      checked++;
      const t = r.trade;
      expect(t.side).toBe(r.side === "accumulation" ? "BUY" : "SELL");
      if (t.side === "BUY") {
        // Stop strictly beyond invalidation, never on it: a stop resting
        // exactly on the zone edge is taken by the wick that tests the area —
        // the move the read expects, not the one that refutes it.
        expect(t.stopLoss).toBeLessThan(r.invalidateLevel!);
        expect(t.tp1).toBeGreaterThan(t.entry);
        expect(t.tp2).toBeGreaterThan(t.entry);
        expect(t.tp3).toBeGreaterThan(t.tp2);
      } else {
        expect(t.stopLoss).toBeGreaterThan(r.invalidateLevel!);
        expect(t.tp1).toBeLessThan(t.entry);
        expect(t.tp2).toBeLessThan(t.entry);
        expect(t.tp3).toBeLessThan(t.tp2);
      }
      expect(t.riskReward).toBeGreaterThanOrEqual(1);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("withholds the trade when the geometry is worse than 1R", () => {
    for (const seed of GEOMETRY_SEEDS) {
      const r = detectInstitutional("TESTUSDT", "1h", syntheticCandles(240, seed, 100), RISING_OI);
      if (r.qualified && r.trade === null) {
        // The levels must still be reported — only the trade is withheld.
        expect(r.zone).not.toBeNull();
        expect(r.invalidateLevel).not.toBeNull();
      }
    }
  });

  /* ---------------- Chart marks ----------------
     These are what the overlay draws. A mark whose time is not a real bar
     lands nowhere, and a mark that disagrees with the evidence list turns the
     chart into a second opinion about the same checklist — which is exactly
     what the shared engine is supposed to prevent. */

  it("puts every chart mark on a bar that exists in the series", () => {
    const candles = accumulationSeries();
    const times = new Set(candles.map((c) => c.time));
    const r = detectInstitutional("TESTUSDT", "1h", candles);
    expect(r.demand.marks.length).toBeGreaterThan(0);
    for (const side of [r.demand, r.supply]) {
      for (const m of side.marks) {
        expect(times.has(m.time)).toBe(true);
        expect(m.label.length).toBeGreaterThan(0);
        expect(m.high).toBeGreaterThanOrEqual(m.low);
        expect(Number.isFinite(m.low)).toBe(true);
      }
    }
  });

  it("never marks a kind the checklist reports as absent", () => {
    // The card renders ticks from `evidence` and the candles render marks; if
    // a source can appear in one and not the other the two disagree in front
    // of the user.
    for (const seed of [4, 17, 33, 58]) {
      const r = detectInstitutional("TESTUSDT", "1h", syntheticCandles(200, seed, 60));
      for (const side of [r.demand, r.supply]) {
        const foundKeys = new Set(side.evidence.filter((e) => e.found).map((e) => e.key));
        for (const m of side.marks) expect(foundKeys.has(m.source)).toBe(true);
      }
    }
  });

  it("returns marks in time order so the chart can draw them as they came", () => {
    const r = detectInstitutional("TESTUSDT", "1h", accumulationSeries());
    for (const side of [r.demand, r.supply]) {
      const times = side.marks.map((m) => m.time);
      expect([...times].sort((a, b) => a - b)).toEqual(times);
    }
  });

  it("labels the structure marks with the swing they are claiming", () => {
    // The HH/HL item asserts a sequence; the marks are where the reader checks
    // it. Demand may only ever claim upward steps, supply only downward.
    for (const seed of [6, 21, 39, 52, 70]) {
      const r = detectInstitutional("TESTUSDT", "1h", syntheticCandles(220, seed, 80));
      for (const m of r.demand.marks) {
        if (m.source === "structure") expect(["HH", "HL"]).toContain(m.label);
      }
      for (const m of r.supply.marks) {
        if (m.source === "structure") expect(["LH", "LL"]).toContain(m.label);
      }
    }
  });

  it("keeps annotation marks out of the confluence count", () => {
    // Divergence and structure are claims about a sequence, not an area. If
    // they were clustered they would inflate a band's confluence with evidence
    // that does not locate anything — and confluence is the whole thesis.
    for (const seed of [9, 24, 41, 63]) {
      const r = detectInstitutional("TESTUSDT", "1h", syntheticCandles(200, seed, 70));
      for (const side of [r.demand, r.supply]) {
        for (const z of side.zones) {
          expect(z.sources).not.toContain("divergence");
          expect(z.sources).not.toContain("structure");
        }
      }
    }
  });

  it("dates a zone from the first mark inside it, not the last", () => {
    // The box should start where the evidence began accumulating; starting it
    // at the most recent mark would draw an area that visibly postdates the
    // bars it is meant to describe.
    const candles = accumulationSeries();
    const r = detectInstitutional("TESTUSDT", "1h", candles);
    for (const side of [r.demand, r.supply]) {
      for (const z of side.zones) {
        if (z.startTime == null) continue;
        expect(candles.some((c) => c.time === z.startTime)).toBe(true);
        const inside = side.marks.filter((m) => m.low <= z.high && m.high >= z.low);
        if (inside.length > 0) {
          expect(z.startTime).toBeLessThanOrEqual(Math.max(...inside.map((m) => m.time)));
        }
      }
    }
  });

  it("reports no marks rather than throwing on a series too short to read", () => {
    const r = detectInstitutional("TESTUSDT", "1h", syntheticCandles(20, 3, 50));
    expect(r.demand.marks).toEqual([]);
    expect(r.supply.marks).toEqual([]);
  });

  it("survives arbitrary series without throwing or emitting bad numbers", () => {
    for (const seed of [1, 8, 19, 26, 44, 53]) {
      const r = detectInstitutional("TESTUSDT", "1h", syntheticCandles(160, seed, 50));
      expect(Number.isFinite(r.score)).toBe(true);
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
      expect(r.evidence.length).toBeGreaterThan(0);
      for (const e of r.evidence) {
        expect(e.score).toBeLessThanOrEqual(e.weight);
        expect(e.detail.length).toBeGreaterThan(0);
      }
    }
  });
});
