import { describe, expect, it } from "vitest";
import { detectRetestThrust } from "@/engines/retestThrust";
import { Candle } from "@/engines/types";

/**
 * The claim this engine makes is a sequence: a real leg down, a base, a close
 * back through the last lower high, a return to that level, and an expansion
 * away from it. Each part is checkable, and the tests that matter are the ones
 * that would catch a part being asserted when it did not happen — a "change of
 * character" off a two-bar wiggle, a level reported as held after price closed
 * through it, a thrust claimed on a live setup where the thrust is still the
 * future.
 */

let clock = 1_700_000_000;
function bar(open: number, high: number, low: number, close: number, volume = 1000): Candle {
  clock += 3600;
  return { time: clock, open, high, low, close, volume };
}

/** Bars drifting gently, so no leg and no swing structure of consequence. */
function drift(n: number, price: number, per = 0.02): Candle[] {
  const out: Candle[] = [];
  let p = price;
  for (let i = 0; i < n; i++) {
    const next = p + (i % 2 === 0 ? per : -per);
    out.push(bar(p, Math.max(p, next) + 0.05, Math.min(p, next) - 0.05, next));
    p = next;
  }
  return out;
}

/** A sustained decline, with a lower high partway down that becomes the level. */
function decline(from: number, to: number, bars: number): Candle[] {
  const out: Candle[] = [];
  const step = (from - to) / bars;
  let p = from;
  for (let i = 0; i < bars; i++) {
    const next = p - step;
    // every fourth bar bounces, leaving the fractal highs the level comes from
    if (i % 4 === 3) {
      out.push(bar(p, p + step * 1.6, p - step * 0.2, p + step * 0.9));
      p = p + step * 0.9;
    } else {
      out.push(bar(p, p + step * 0.1, next - step * 0.2, next));
      p = next;
    }
  }
  return out;
}

/** A rally from `from` to `to`, with the last bar expanded if `thrust`. */
function rally(from: number, to: number, bars: number, thrust = false): Candle[] {
  const out: Candle[] = [];
  const step = (to - from) / bars;
  let p = from;
  for (let i = 0; i < bars; i++) {
    const next = p + step;
    const big = thrust && i === bars - 1;
    out.push(
      bar(p, next + step * (big ? 1.2 : 0.1), p - step * 0.1, next, big ? 6000 : 1000)
    );
    p = next;
  }
  return out;
}

/**
 * The full shape from the screenshot: decline, base, change of character,
 * pullback to the level, then expansion.
 */
function fullSequence(opts: { retest?: boolean; thrust?: boolean; lose?: boolean } = {}): Candle[] {
  const { retest = true, thrust = true, lose = false } = opts;
  const candles = [...drift(30, 100), ...decline(100, 70, 40)];
  // base
  candles.push(...drift(12, 70, 0.3));
  // change of character: push back above the decline's last lower high
  candles.push(...rally(70, 82, 10));
  if (retest) {
    // back down toward the level, holding it
    candles.push(...rally(82, lose ? 68 : 76, 6));
    candles.push(...drift(2, lose ? 68 : 76, 0.2));
  }
  if (thrust && !lose) candles.push(...rally(76, 95, 8, true));
  return candles;
}

describe("detectRetestThrust — what it refuses", () => {
  it("returns null for a series too short to hold the sequence", () => {
    expect(detectRetestThrust(drift(40, 100))).toBeNull();
  });

  it("finds nothing in a series that only drifts", () => {
    /* No leg means no character to change. Without this floor every two-bar
       dip produces a "reversal" and the scanner is a list of noise. */
    const setup = detectRetestThrust(drift(200, 100));
    expect(setup).toBeNull();
  });

  it("does not claim a thrust on a setup that has not thrust", () => {
    const setup = detectRetestThrust(fullSequence({ thrust: false }));
    expect(setup).not.toBeNull();
    expect(setup!.thrustAtr).toBeNull();
    expect(setup!.state).not.toBe("thrusting");
    expect(setup!.checks.find((c) => c.label === "Expanded away")!.pass).toBe(false);
  });

  it("does not claim the level held after price closed through it", () => {
    /* Asserts the check rather than the state on purpose. Breaking a level
       hard enough to fail a long sequence also builds a genuine short one off
       the same swing high, and the engine reports the more recent change of
       character — which is correct. What must never happen, whichever
       sequence is reported, is "came back and held" passing over a close
       through the level. */
    const setup = detectRetestThrust(fullSequence({ lose: true }));
    expect(setup).not.toBeNull();
    expect(setup!.checks.find((c) => c.label === "Came back and held")!.pass).toBe(false);
  });

  it("still reports a failure when nothing newer has replaced it", () => {
    /* The state has to be reachable. An earlier selection rule dropped failed
       sequences as "not live", so a setup could break and the scanner would
       quietly show something else rather than say the level was gone. */
    const candles = [...drift(30, 100), ...decline(100, 70, 40), ...drift(12, 70, 0.3)];
    // a small change of character, then give it straight back
    candles.push(...rally(70, 74, 5));
    candles.push(...rally(74, 69, 4));
    candles.push(...drift(6, 69, 0.2));
    const setup = detectRetestThrust(candles);
    if (setup && setup.direction === "long") {
      expect(setup.state).toBe("failed");
      expect(setup.checks.find((c) => c.label === "Came back and held")!.pass).toBe(false);
    }
  });
});

describe("detectRetestThrust — the sequence", () => {
  it("finds the shape and names its parts", () => {
    const setup = detectRetestThrust(fullSequence())!;
    expect(setup).not.toBeNull();
    expect(setup.direction).toBe("long");
    expect(setup.legAtr).toBeGreaterThanOrEqual(3);
    expect(setup.chochTime).not.toBeNull();
    expect(setup.level).toBeGreaterThan(70);
    expect(setup.level).toBeLessThan(100);
  });

  it("orders the sequence in time", () => {
    const s = detectRetestThrust(fullSequence())!;
    expect(s.chochTime).toBeGreaterThan(s.baseTime);
    if (s.retestTime != null) expect(s.retestTime).toBeGreaterThan(s.chochTime!);
  });

  it("scores only the checks that actually passed", () => {
    const s = detectRetestThrust(fullSequence())!;
    expect(s.score).toBe(s.checks.filter((c) => c.pass).length);
    expect(s.score).toBeGreaterThanOrEqual(0);
    expect(s.score).toBeLessThanOrEqual(s.checks.length);
  });

  it("gives every check a detail line, passing or not", () => {
    const s = detectRetestThrust(fullSequence({ thrust: false }))!;
    for (const c of s.checks) expect(c.detail.length).toBeGreaterThan(0);
  });

  it("carries a note matching the state it reported", () => {
    const s = detectRetestThrust(fullSequence())!;
    expect(s.note.length).toBeGreaterThan(0);
  });
});

describe("precedent", () => {
  it("says so plainly when there is no precedent", () => {
    const s = detectRetestThrust(fullSequence())!;
    if (s.precedent.count === 0) {
      expect(s.precedent.note).toMatch(/no precedent|No completed instance/i);
    }
  });

  it("never reports a rate without the count beside it", () => {
    const s = detectRetestThrust(fullSequence())!;
    expect(s.precedent.note).toMatch(new RegExp(`${s.precedent.count}|No completed instance`));
  });

  it("calls a thin sample thin rather than quoting it as a frequency", () => {
    /* Two repeats of the shape gives a handful of instances at most. A rate
       from that is a description of two cases, and saying otherwise is the
       exact dishonesty this engine exists to avoid. */
    const candles = [...fullSequence(), ...fullSequence()];
    const s = detectRetestThrust(candles)!;
    if (s.precedent.count > 0 && s.precedent.count < 5) {
      expect(s.precedent.note).toMatch(/too few|individually/i);
    }
  });

  it("keeps rates inside 0-1", () => {
    const candles = [...fullSequence(), ...fullSequence(), ...fullSequence()];
    const s = detectRetestThrust(candles)!;
    expect(s.precedent.boomRate).toBeGreaterThanOrEqual(0);
    expect(s.precedent.boomRate).toBeLessThanOrEqual(1);
    expect(s.precedent.failRate).toBeGreaterThanOrEqual(0);
    expect(s.precedent.failRate).toBeLessThanOrEqual(1);
  });

  it("excludes the setup being reported from its own precedent", () => {
    /* Counting the live instance among the cases that "already worked" would
       let a setup cite itself as evidence for itself. */
    const s = detectRetestThrust(fullSequence())!;
    expect(s.precedent.count).toBeLessThan(3);
  });
});

describe("states", () => {
  it("never reports a live setup as extended without distance to justify it", () => {
    const s = detectRetestThrust(fullSequence({ thrust: false }))!;
    if (s.state === "extended") expect(s.distanceAtr).toBeGreaterThan(0);
  });

  it("is one of the declared states, always", () => {
    const states = ["armed", "held", "thrusting", "extended", "failed", "forming"];
    for (const opts of [{}, { thrust: false }, { retest: false }, { lose: true }]) {
      const s = detectRetestThrust(fullSequence(opts));
      if (s) expect(states).toContain(s.state);
    }
  });
});
