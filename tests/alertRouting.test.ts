import { afterEach, describe, expect, it } from "vitest";
import { AlertPayload, shouldDispatch } from "@/lib/alerts";

/**
 * Which alerts reach a channel.
 *
 * Every channel is shared by every producer, so this filter is the only thing
 * standing between "I want liquidation spikes" and a phone that also buzzes
 * for each new signal and each closure.
 */

const original = process.env.ALERT_KINDS;

afterEach(() => {
  if (original === undefined) delete process.env.ALERT_KINDS;
  else process.env.ALERT_KINDS = original;
});

function alert(kind?: AlertPayload["kind"]): AlertPayload {
  return { title: "t", body: "b", symbol: "BTCUSDT", kind };
}

describe("alert kind routing", () => {
  it("delivers everything when no allowlist is configured", () => {
    delete process.env.ALERT_KINDS;
    expect(shouldDispatch(alert("liqspike"))).toBe(true);
    expect(shouldDispatch(alert("signal.opened"))).toBe(true);
    // Historical behaviour: an untagged payload still goes out.
    expect(shouldDispatch(alert(undefined))).toBe(true);
  });

  it("delivers only the listed kinds", () => {
    process.env.ALERT_KINDS = "liqspike";
    expect(shouldDispatch(alert("liqspike"))).toBe(true);
    expect(shouldDispatch(alert("signal.opened"))).toBe(false);
    expect(shouldDispatch(alert("signal.confluence"))).toBe(false);
    expect(shouldDispatch(alert("signal.closed"))).toBe(false);
  });

  it("blocks untagged alerts once an allowlist exists", () => {
    // Someone who asked for liquidation spikes only should not start receiving
    // a new alert type merely because whoever added it forgot to tag it.
    process.env.ALERT_KINDS = "liqspike";
    expect(shouldDispatch(alert(undefined))).toBe(false);
  });

  it("accepts several kinds, and tolerates spacing", () => {
    process.env.ALERT_KINDS = " liqspike , signal.closed ";
    expect(shouldDispatch(alert("liqspike"))).toBe(true);
    expect(shouldDispatch(alert("signal.closed"))).toBe(true);
    expect(shouldDispatch(alert("signal.opened"))).toBe(false);
  });

  it("treats an empty or whitespace value as unset, not as block-everything", () => {
    // A blank env var is far more often an accident than a request for
    // silence, and silent total suppression is the worst way to find out.
    process.env.ALERT_KINDS = "";
    expect(shouldDispatch(alert("signal.opened"))).toBe(true);
    process.env.ALERT_KINDS = "  ,  ";
    expect(shouldDispatch(alert("signal.opened"))).toBe(true);
  });

  it("does not match on a partial kind name", () => {
    process.env.ALERT_KINDS = "signal.closed";
    expect(shouldDispatch(alert("signal.opened"))).toBe(false);
    expect(shouldDispatch(alert("signal.confluence"))).toBe(false);
  });
});
