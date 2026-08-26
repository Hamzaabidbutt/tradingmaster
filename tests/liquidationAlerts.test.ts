import { describe, expect, it } from "vitest";
import {
  DEFAULT_GATE,
  alertKey,
  formatSpikeAlert,
  selectAlertable,
} from "@/services/liquidationAlerts";
import type { LiquidationReversalEntry } from "@/services/scanService";
import { LiquidationReversalSetup } from "@/engines/types";

/** A qualifying long flush, with the fields the gate and formatter read. */
function entry(over: Partial<LiquidationReversalSetup> = {}, symbol = "BTCUSDT"): LiquidationReversalEntry {
  // `spike` is merged rather than replaced, so a case can override one field
  // (barsAgo, side) without restating the whole print.
  const { spike: spikeOver, ...rest } = over;
  const spike = {
    time: 1_700_000_000,
    side: "long" as const,
    volume: 4200,
    multiple: 6.4,
    price: 93,
    extreme: 92,
    atExtreme: true,
    distanceFromExtremePct: 0,
    barsAgo: 1,
    ...(spikeOver ?? {}),
  };
  const setup: LiquidationReversalSetup = {
    symbol,
    timeframe: "5m",
    price: 95.7,
    location: "bottom",
    reversalPct: 4.02,
    peakReversalPct: 4.5,
    forced: "inferred",
    forcedNote: "signature is unambiguous",
    score: 82,
    qualified: true,
    grade: "prime",
    invalidation: 92,
    target: 100,
    headline: "Prime long flush at the low",
    explanation: ["Prime long flush at the low"],
    ...rest,
    spike,
  };
  return {
    symbol,
    label: symbol.replace(/USDT$/, "/USDT"),
    timeframe: "5m",
    quoteVolume: 1e9,
    priceChangePercent: -3.2,
    setup,
  };
}

describe("spike alert gate", () => {
  it("passes a fresh, forced, reversing spike at an extreme", () => {
    expect(selectAlertable([entry()], DEFAULT_GATE)).toHaveLength(1);
  });

  it("drops a setup the engine did not qualify", () => {
    expect(selectAlertable([entry({ qualified: false })], DEFAULT_GATE)).toEqual([]);
  });

  it("drops a spike below the score threshold", () => {
    expect(selectAlertable([entry({ score: 69 })], DEFAULT_GATE)).toEqual([]);
    expect(selectAlertable([entry({ score: 70 })], DEFAULT_GATE)).toHaveLength(1);
  });

  it("drops an orderly bar with no forced signature", () => {
    expect(selectAlertable([entry({ forced: "unlikely" })], DEFAULT_GATE)).toEqual([]);
    // …unless the operator has explicitly asked for those too.
    expect(
      selectAlertable([entry({ forced: "unlikely" })], { ...DEFAULT_GATE, requireForced: false })
    ).toHaveLength(1);
  });

  it("drops a stale spike", () => {
    // The reversal this alert exists to catch has happened without you.
    expect(selectAlertable([entry({ spike: { barsAgo: 9 } as never })], DEFAULT_GATE)).toEqual([]);
  });

  it("drops a spike that has not started reversing", () => {
    expect(selectAlertable([entry({ reversalPct: 0.1 })], DEFAULT_GATE)).toEqual([]);
  });

  it("ranks by score and caps the batch", () => {
    const many = [
      entry({ score: 74 }, "AAAUSDT"),
      entry({ score: 91 }, "BBBUSDT"),
      entry({ score: 83 }, "CCCUSDT"),
    ];
    const picked = selectAlertable(many, { ...DEFAULT_GATE, maxPerRun: 2 });
    expect(picked.map((e) => e.symbol)).toEqual(["BBBUSDT", "CCCUSDT"]);
  });
});

describe("dedupe key", () => {
  it("is stable across re-evaluations of the same spike", () => {
    // The same spike seen on two consecutive sweeps — different reversal %,
    // different score, same bar. One event, one alert.
    const first = entry({ reversalPct: 1.2, score: 71 });
    const later = entry({ reversalPct: 4.4, score: 88 });
    expect(alertKey(first)).toBe(alertKey(later));
  });

  it("separates different spikes, symbols and timeframes", () => {
    const a = entry();
    const b = entry({ spike: { time: 1_700_000_300 } as never });
    const other = entry({}, "ETHUSDT");
    expect(alertKey(a)).not.toBe(alertKey(b));
    expect(alertKey(a)).not.toBe(alertKey(other));
    expect(alertKey(a)).toContain("BTCUSDT");
  });
});

describe("alert message", () => {
  const payload = formatSpikeAlert(entry(), "https://example.app/");

  it("names the coin and the event in the title", () => {
    expect(payload.title).toContain("BTC/USDT");
    expect(payload.title.toLowerCase()).toContain("liquidation spike");
  });

  it("carries the numbers a decision needs", () => {
    expect(payload.body).toContain("4.02%");
    expect(payload.body).toContain("Long flush at the low");
    expect(payload.body).toContain("Invalidation");
    expect(payload.confidence).toBe(82);
  });

  it("states how old the spike is rather than implying it is live", () => {
    expect(payload.body).toContain("1 bar ago");
    expect(payload.body).toContain("5m");
  });

  it("says the forced size is inferred, not measured", () => {
    expect(payload.body).toContain("inferred");
    const measured = formatSpikeAlert(entry({ forced: "confirmed" }));
    expect(measured.body).toContain("measured");
    expect(measured.body).not.toContain("inferred");
  });

  it("does not present the reversal as a forecast", () => {
    // The engine reports what has happened. The message must not read as a
    // promise that it continues.
    expect(payload.body).toContain("not a forecast");
  });

  it("sides with whoever benefits from the flush", () => {
    // Forced *selling* ending is bullish; a squeeze at the high is the mirror.
    expect(payload.side).toBe("BUY");
    expect(formatSpikeAlert(entry({ spike: { side: "short" } as never })).side).toBe("SELL");
  });

  it("builds a terminal link, and omits it when no base URL is configured", () => {
    expect(payload.url).toBe("https://example.app/terminal?symbol=BTCUSDT&timeframe=5m");
    expect(formatSpikeAlert(entry()).url).toBeUndefined();
  });
});
