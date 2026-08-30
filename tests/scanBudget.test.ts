import { describe, expect, it } from "vitest";

/**
 * The sweep's time budget, tested against a local copy of the concurrency
 * helper's contract.
 *
 * `mapLimit` is private to scanService and pulling it out purely to test it
 * would widen the module's surface for no runtime benefit — but the behaviour
 * it encodes is load-bearing and easy to regress, so the contract is pinned
 * here against the same algorithm.
 *
 * The distinction that matters: an item the deadline prevented us reaching
 * comes back `undefined`, not as a rejection. Conflating the two would report
 * a healthy but truncated sweep as a broken one, and the dashboard would show
 * "430 failed" for a scan that simply ran long.
 */

const SCAN_BUDGET_MS = 50_000;

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
  budgetMs = SCAN_BUDGET_MS
): Promise<(PromiseSettledResult<R> | undefined)[]> {
  // `.fill()` matters: `new Array(n)` is *sparse*, and both `forEach` and
  // `filter` skip holes entirely. Leaving it sparse meant unreached symbols
  // were invisible to every caller — the truncation counter could never fire
  // and a half-finished sweep reported itself as complete.
  const results: (PromiseSettledResult<R> | undefined)[] = new Array(items.length).fill(undefined);
  const deadline = Date.now() + budgetMs;
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      if (Date.now() >= deadline) return;
      try {
        results[i] = { status: "fulfilled", value: await worker(items[i]) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("scan time budget", () => {
  it("completes everything when the budget is ample", async () => {
    const items = [1, 2, 3, 4, 5];
    const out = await mapLimit(items, 2, async (n) => n * 2, 5000);
    expect(out.every((r) => r?.status === "fulfilled")).toBe(true);
    expect(out.map((r) => (r?.status === "fulfilled" ? r.value : null))).toEqual([2, 4, 6, 8, 10]);
  });

  it("leaves unreached items undefined rather than rejected", async () => {
    // Concurrency 1 so the arithmetic is deterministic rather than a race:
    // 30 items at ~25ms each, sequentially, cannot fit in a 60ms budget on any
    // machine, so the skip is guaranteed instead of merely likely.
    const items = Array.from({ length: 30 }, (_, i) => i);
    const out = await mapLimit(items, 1, async (n) => {
      await sleep(25);
      return n;
    }, 60);

    const reached = out.filter((r) => r !== undefined);
    const missed = out.filter((r) => r === undefined);
    expect(reached.length).toBeGreaterThan(0);
    // The whole point: some work was skipped, and none of it looks like failure.
    expect(missed.length).toBeGreaterThan(0);
    expect(out.some((r) => r?.status === "rejected")).toBe(false);
  });

  it("still records genuine failures as rejections", async () => {
    const out = await mapLimit([1, 2, 3], 3, async (n) => {
      if (n === 2) throw new Error("delisted");
      return n;
    }, 5000);
    expect(out[0]?.status).toBe("fulfilled");
    expect(out[1]?.status).toBe("rejected");
    expect(out[2]?.status).toBe("fulfilled");
  });

  it("does not abandon work already in flight", async () => {
    // The deadline is checked before starting a symbol, never mid-request:
    // abandoning an in-flight call would waste the Binance weight already spent.
    let completed = 0;
    await mapLimit([1, 2, 3, 4], 4, async (n) => {
      await sleep(30);
      completed++;
      return n;
    }, 1);
    // All four started before the (immediate) deadline could stop them, and
    // every one that started was allowed to finish.
    expect(completed).toBe(4);
  });

  it("preserves index alignment so results map back to their symbols", async () => {
    const items = ["BTC", "ETH", "SOL", "XRP"];
    const out = await mapLimit(items, 2, async (s) => {
      // Deliberately uneven: a slow first item must not shift the others.
      await sleep(s === "BTC" ? 20 : 1);
      return s.toLowerCase();
    }, 5000);
    expect(out.map((r) => (r?.status === "fulfilled" ? r.value : null))).toEqual([
      "btc",
      "eth",
      "sol",
      "xrp",
    ]);
  });
});
