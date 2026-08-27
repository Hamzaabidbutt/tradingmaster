import { describe, expect, it } from "vitest";
import { terminalHref } from "@/components/dashboard/shared";

/**
 * The coin travels in the URL, not in the shared store.
 *
 * That is what makes a terminal link work from a new tab, a Telegram alert or
 * a bookmark. A link that only lands on the right coin because something wrote
 * to localStorage first cannot be copied, sent, or opened twice.
 */
describe("terminalHref", () => {
  it("carries the symbol", () => {
    expect(terminalHref("BTCUSDT")).toBe("/terminal?symbol=BTCUSDT");
  });

  it("carries a valid timeframe", () => {
    expect(terminalHref("ETHUSDT", "15m")).toBe("/terminal?symbol=ETHUSDT&timeframe=15m");
  });

  it("drops a timeframe the app does not have", () => {
    // Better to land on the coin at the user's current timeframe than to
    // arrive somewhere undefined.
    expect(terminalHref("ETHUSDT", "7m")).toBe("/terminal?symbol=ETHUSDT");
    expect(terminalHref("ETHUSDT", "")).toBe("/terminal?symbol=ETHUSDT");
    expect(terminalHref("ETHUSDT", undefined)).toBe("/terminal?symbol=ETHUSDT");
  });

  it("normalises the symbol to uppercase", () => {
    expect(terminalHref("uniusdt", "1h")).toBe("/terminal?symbol=UNIUSDT&timeframe=1h");
  });

  it("escapes anything that would break the query string", () => {
    const href = terminalHref("A&B=C");
    expect(href).not.toContain("&B=");
    expect(new URL(href, "https://x.test").searchParams.get("symbol")).toBe("A&B=C");
  });

  it("parses back to exactly what the terminal reads", () => {
    const url = new URL(terminalHref("SOLUSDT", "4h"), "https://x.test");
    expect(url.pathname).toBe("/terminal");
    expect(url.searchParams.get("symbol")).toBe("SOLUSDT");
    expect(url.searchParams.get("timeframe")).toBe("4h");
  });
});
