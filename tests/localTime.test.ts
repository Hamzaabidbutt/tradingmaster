import { describe, expect, it } from "vitest";
import { localTimeOrDate } from "@/components/ui/primitives";

/**
 * A list ordered by recency has to look ordered.
 *
 * Showing time of day alone, a row from 2pm yesterday sits below one from 1am
 * today and reads as though the sort is broken — the sequence is right and the
 * display is what lies. This is the guard on that.
 */
describe("localTimeOrDate", () => {
  const nowSec = () => Math.floor(Date.now() / 1000);

  it("shows only the time for something from today", () => {
    const out = localTimeOrDate(nowSec() - 60);
    expect(out).toMatch(/^\d{1,2}:\d{2}/);
    expect(out).not.toMatch(/[A-Za-z]{3}\s\d/);
  });

  it("prefixes the date once the reading is not from today", () => {
    const out = localTimeOrDate(nowSec() - 36 * 3600);
    expect(out).toMatch(/[A-Za-z]{3}\s?\d+/);
  });

  it("disambiguates a later time on an earlier day", () => {
    /* The exact case that looked like a broken sort: 2pm yesterday against 1am
       today. Rendered without dates the two are indistinguishable as to which
       came first. */
    const today1am = new Date();
    today1am.setHours(1, 0, 0, 0);
    const yesterday2pm = new Date(today1am);
    yesterday2pm.setDate(yesterday2pm.getDate() - 1);
    yesterday2pm.setHours(14, 0, 0, 0);

    const a = localTimeOrDate(Math.floor(today1am.getTime() / 1000));
    const b = localTimeOrDate(Math.floor(yesterday2pm.getTime() / 1000));
    expect(a).not.toBe(b);
    // the older one carries a date; the newer one does not
    expect(b).toMatch(/[A-Za-z]{3}/);
    expect(a).not.toMatch(/[A-Za-z]{3}\s\d/);
  });

  it("never returns an empty string", () => {
    for (const offset of [0, 3600, 86_400, 86_400 * 400]) {
      expect(localTimeOrDate(nowSec() - offset).length).toBeGreaterThan(0);
    }
  });
});
