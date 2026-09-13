import { describe, expect, it } from "vitest";
import {
  DEFAULT_GATE,
  LADDER_KIND,
  THRUST_KIND,
  formatLadderAlert,
  formatThrustAlert,
  ladderAlertKey,
  selectLadderAlerts,
  selectThrustAlerts,
  thrustAlertKey,
} from "@/services/setupAlerts";
import type { CandleLadderEntry, RetestThrustEntry } from "@/services/scanService";
import type { RetestThrustSetup, ThrustState } from "@/engines/retestThrust";
import type { CandleLadder } from "@/engines/candleLadder";

/**
 * An alerter is judged by what it does not send. A channel that fires a
 * hundred times a day gets muted, and a muted channel is worse than none — the
 * same absence of information plus the belief that you are covered. So the
 * tests here are mostly about suppression, and about the wording of the one
 * thing in these messages that could be misread as a prediction.
 */

function thrust(over: Partial<RetestThrustSetup> = {}): RetestThrustEntry {
  const setup: RetestThrustSetup = {
    state: "armed" as ThrustState,
    direction: "long",
    level: 100,
    chochTime: 1_700_000_000,
    baseTime: 1_699_000_000,
    legAtr: 5,
    barsSinceBase: 30,
    barsSinceChoch: 4,
    retestDepthAtr: 0.3,
    retestTime: 1_700_003_600,
    thrustAtr: null,
    thrustVolumeX: null,
    distanceAtr: 0.2,
    checks: [
      { label: "a", pass: true, detail: "x" },
      { label: "b", pass: true, detail: "x" },
      { label: "c", pass: true, detail: "x" },
      { label: "d", pass: false, detail: "x" },
      { label: "e", pass: false, detail: "x" },
    ],
    score: 3,
    precedent: {
      count: 11,
      medianPeakAtr: 3.4,
      boomRate: 7 / 11,
      failRate: 3 / 11,
      followBars: 20,
      boomThresholdAtr: 3,
      note: "…",
    },
    note: "…",
    ...over,
  };
  return {
    symbol: "BTCUSDT",
    label: "BTC/USDT",
    timeframe: "1h",
    quoteVolume: 1e9,
    priceChangePercent: 1,
    barTime: Math.floor(Date.now() / 1000) - 600,
    price: 100.4,
    setup,
  };
}

function ladder(over: Partial<CandleLadder> = {}): CandleLadderEntry {
  const l: CandleLadder = {
    direction: "up",
    startIndex: 100,
    endIndex: 110,
    startTime: 1_700_000_000,
    endTime: 1_700_036_000,
    bars: 11,
    movePct: 4.2,
    moveAtr: 6,
    r2: 0.97,
    slopePctPerBar: 0.4,
    bodyShare: 0.9,
    lineNow: 99.5,
    barsSinceEnd: 0,
    broken: false,
    score: 74,
    ...over,
  };
  return {
    symbol: "ETHUSDT",
    label: "ETH/USDT",
    timeframe: "1h",
    quoteVolume: 1e9,
    priceChangePercent: 1,
    barTime: Math.floor(Date.now() / 1000) - 600,
    price: 101,
    ladder: l,
  };
}

describe("selectThrustAlerts — what it will not send", () => {
  it("sends an armed setup", () => {
    expect(selectThrustAlerts([thrust()], DEFAULT_GATE)).toHaveLength(1);
  });

  it("never sends a setup that has already expanded", () => {
    /* By the time price has thrust, the level is behind you. An alert for it
       is an invitation to chase arriving with the authority of a
       notification. */
    for (const state of ["thrusting", "extended"] as ThrustState[]) {
      expect(selectThrustAlerts([thrust({ state })], DEFAULT_GATE)).toEqual([]);
    }
  });

  it("never sends a failed or forming setup", () => {
    for (const state of ["failed", "forming"] as ThrustState[]) {
      expect(selectThrustAlerts([thrust({ state })], DEFAULT_GATE)).toEqual([]);
    }
  });

  it("never sends a held setup", () => {
    // A state price can sit in for twenty bars describes no moment in
    // particular, so there is nothing to timestamp an alert to.
    expect(selectThrustAlerts([thrust({ state: "held" })], DEFAULT_GATE)).toEqual([]);
  });

  it("drops a setup below the score floor", () => {
    expect(selectThrustAlerts([thrust({ score: 1 })], DEFAULT_GATE)).toEqual([]);
  });

  it("caps a violent session", () => {
    const many = Array.from({ length: 40 }, () => thrust());
    expect(selectThrustAlerts(many, DEFAULT_GATE)).toHaveLength(DEFAULT_GATE.maxPerRun);
  });

  it("does not filter on a precedent rate by default", () => {
    /* Filtering on a measured frequency is a judgement about how much that
       frequency means, and the default should not make it. */
    const bad = thrust({
      precedent: { ...thrust().setup.precedent, count: 20, boomRate: 0 },
    });
    expect(selectThrustAlerts([bad], DEFAULT_GATE)).toHaveLength(1);
  });

  it("applies a precedent floor only when one is set and the sample supports it", () => {
    const gate = { ...DEFAULT_GATE, thrustMinBoomRate: 0.6, thrustMinPrecedent: 5 };
    const weak = thrust({ precedent: { ...thrust().setup.precedent, count: 20, boomRate: 0.2 } });
    const strong = thrust({ precedent: { ...thrust().setup.precedent, count: 20, boomRate: 0.8 } });
    // thin record: not filtered out, because no record is not a bad record
    const thin = thrust({ precedent: { ...thrust().setup.precedent, count: 2, boomRate: 0 } });
    expect(selectThrustAlerts([weak], gate)).toEqual([]);
    expect(selectThrustAlerts([strong], gate)).toHaveLength(1);
    expect(selectThrustAlerts([thin], gate)).toHaveLength(1);
  });

  it("ranks a longer record above a flattering short one", () => {
    const short = thrust({ precedent: { ...thrust().setup.precedent, count: 3, boomRate: 1 } });
    short.symbol = "SHORTREC";
    const long = thrust({ precedent: { ...thrust().setup.precedent, count: 9, boomRate: 7 / 9 } });
    long.symbol = "LONGREC";
    const picked = selectThrustAlerts([short, long], DEFAULT_GATE);
    expect(picked[0].symbol).toBe("LONGREC");
  });
});

describe("selectLadderAlerts — what it will not send", () => {
  it("sends a live, straight, full-bodied run", () => {
    expect(selectLadderAlerts([ladder()], DEFAULT_GATE)).toHaveLength(1);
  });

  it("never sends a run that has stopped stepping", () => {
    expect(selectLadderAlerts([ladder({ barsSinceEnd: 2 })], DEFAULT_GATE)).toEqual([]);
  });

  it("never sends a broken run", () => {
    expect(selectLadderAlerts([ladder({ broken: true })], DEFAULT_GATE)).toEqual([]);
  });

  it("drops a short, crooked or hollow run", () => {
    expect(selectLadderAlerts([ladder({ bars: 4 })], DEFAULT_GATE)).toEqual([]);
    expect(selectLadderAlerts([ladder({ r2: 0.5 })], DEFAULT_GATE)).toEqual([]);
    // higher highs made of red candles is a grind, not a drive
    expect(selectLadderAlerts([ladder({ bodyShare: 0.2 })], DEFAULT_GATE)).toEqual([]);
  });

  it("caps a violent session", () => {
    const many = Array.from({ length: 40 }, () => ladder());
    expect(selectLadderAlerts(many, DEFAULT_GATE)).toHaveLength(DEFAULT_GATE.maxPerRun);
  });
});

describe("alert identity", () => {
  it("keys a thrust on the change of character, not on the sweep", () => {
    /* A setup sitting in its retest zone for six bars must produce one alert,
       not six. Keying on anything that moves with the sweep is how an alerter
       becomes a notification every five minutes. */
    const a = thrust();
    const b = thrust();
    b.barTime = a.barTime + 99999;
    b.price = a.price * 1.05;
    expect(thrustAlertKey(a)).toBe(thrustAlertKey(b));
  });

  it("gives two different character changes two keys", () => {
    const a = thrust();
    const b = thrust({ chochTime: 1_700_999_999 });
    expect(thrustAlertKey(a)).not.toBe(thrustAlertKey(b));
  });

  it("keys a ladder on where the run started", () => {
    const a = ladder();
    const b = ladder({ bars: 14, endTime: 1_700_099_999, score: 80 });
    expect(ladderAlertKey(a)).toBe(ladderAlertKey(b));
  });

  it("scopes keys by symbol, timeframe and kind", () => {
    const a = thrust();
    const other = thrust();
    other.timeframe = "4h";
    expect(thrustAlertKey(a)).not.toBe(thrustAlertKey(other));
    expect(thrustAlertKey(a).startsWith(THRUST_KIND)).toBe(true);
    expect(ladderAlertKey(ladder()).startsWith(LADDER_KIND)).toBe(true);
  });
});

describe("what the message is allowed to say", () => {
  it("never states a bare percentage for the precedent", () => {
    /* An alert is read in two seconds on a lock screen with no surrounding
       context, which is exactly where "64%" stops being a description of
       eleven past bars and becomes a belief about the next one. */
    const body = formatThrustAlert(thrust()).body;
    expect(body).not.toMatch(/\d+\s*%/);
  });

  it("gives the precedent a denominator", () => {
    const body = formatThrustAlert(thrust()).body;
    expect(body).toMatch(/7 of 11/);
  });

  it("says plainly when there is no record", () => {
    const body = formatThrustAlert(
      thrust({ precedent: { ...thrust().setup.precedent, count: 0, boomRate: 0 } })
    ).body;
    expect(body).toMatch(/No previous instance/i);
  });

  it("refuses to quote a thin record as a rate", () => {
    const body = formatThrustAlert(
      thrust({ precedent: { ...thrust().setup.precedent, count: 3, boomRate: 1 } })
    ).body;
    expect(body).toMatch(/too few/i);
    expect(body).not.toMatch(/\d+\s*%/);
  });

  it("keeps the precedent sentence on its own line", () => {
    /* An earlier version filtered the message array with `.filter(Boolean)`,
       which cannot tell an optional line from a deliberate blank separator and
       removed every blank — running the precedent straight into the numbers
       above it, in the one message where it most needs to stand alone. */
    const lines = formatThrustAlert(thrust()).body.split("\n");
    const at = lines.findIndex((l) => l.includes("of 11"));
    expect(at).toBeGreaterThan(0);
    expect(lines[at - 1]).toBe("");
    expect(lines[at + 1]).toBe("");
  });

  it("says the expansion has not happened", () => {
    // The alert fires at the point of least confirmation, and has to say so.
    expect(formatThrustAlert(thrust()).body).toMatch(/has not happened|least confirmation/i);
  });

  it("calls the ladder's line a level to hold, not a target", () => {
    expect(formatLadderAlert(ladder()).body).toMatch(/not a target/i);
  });

  it("does not promise the ladder continues", () => {
    expect(formatLadderAlert(ladder()).body).toMatch(/says nothing about the next/i);
  });

  it("tags every payload with its kind so an allowlist can filter it", () => {
    /* An untagged payload is blocked whenever ALERT_KINDS is set, so an
       untagged alert is an alert nobody with an allowlist ever receives. */
    expect(formatThrustAlert(thrust()).kind).toBe(THRUST_KIND);
    expect(formatLadderAlert(ladder()).kind).toBe(LADDER_KIND);
  });

  it("marks a late alert as late", () => {
    /* Schedulers drift — GitHub's runs ten or fifteen minutes behind under
       load — and an alert that does not say how old it is reads as live
       whenever it arrives. */
    const stale = thrust();
    stale.barTime = Math.floor(Date.now() / 1000) - 60 * 60 * 5;
    expect(formatThrustAlert(stale).body).toMatch(/late/i);
    expect(formatThrustAlert(thrust()).body).not.toMatch(/late/i);
  });

  it("carries a symbol and a side on every payload", () => {
    const t = formatThrustAlert(thrust());
    expect(t.symbol).toBe("BTCUSDT");
    expect(t.side).toBe("BUY");
    expect(formatThrustAlert(thrust({ direction: "short" })).side).toBe("SELL");
    expect(formatLadderAlert(ladder({ direction: "down" })).side).toBe("SELL");
  });
});
