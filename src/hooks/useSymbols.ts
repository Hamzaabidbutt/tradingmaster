"use client";

import { useEffect, useState } from "react";
import type { FuturesSymbol } from "@/lib/symbols";
import { MARKETS } from "@/lib/config";

/** The curated pairs, shaped like the live list so the UI never sees a gap. */
const FALLBACK: FuturesSymbol[] = MARKETS.map((m) => ({
  symbol: m.symbol,
  base: m.symbol.replace(/USDT$/, ""),
  quote: "USDT",
  label: m.label,
  pricePrecision: m.pricePrecision,
  featured: true,
}));

/** Fetched once per page load and shared — the list changes on the order of days. */
let cache: FuturesSymbol[] | null = null;
let inflight: Promise<FuturesSymbol[]> | null = null;

async function load(): Promise<FuturesSymbol[]> {
  if (cache) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch("/api/market/symbols", { cache: "no-store" });
      const data = (await res.json()) as { symbols?: FuturesSymbol[] };
      // An empty list means Binance was unreachable server-side. Falling back
      // to the curated pairs keeps the selector usable rather than empty.
      const list = data.symbols?.length ? data.symbols : FALLBACK;
      cache = list;
      return list;
    } catch {
      cache = FALLBACK;
      return FALLBACK;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Every tradable Binance USDT perpetual, plus the price precision lookup that
 * used to come from the 7-entry hardcoded `MARKETS` array.
 */
export function useSymbols() {
  const [symbols, setSymbols] = useState<FuturesSymbol[]>(cache ?? FALLBACK);
  const [loading, setLoading] = useState(cache === null);

  useEffect(() => {
    let stop = false;
    load().then((list) => {
      if (stop) return;
      setSymbols(list);
      setLoading(false);
    });
    return () => {
      stop = true;
    };
  }, []);

  /** Decimals for a symbol: live precision, then curated, then a safe 4. */
  const precisionFor = (symbol: string): number =>
    symbols.find((s) => s.symbol === symbol)?.pricePrecision ??
    MARKETS.find((m) => m.symbol === symbol)?.pricePrecision ??
    4;

  const labelFor = (symbol: string): string =>
    symbols.find((s) => s.symbol === symbol)?.label ??
    `${symbol.replace(/USDT$/, "")}/USDT`;

  return { symbols, loading, precisionFor, labelFor };
}
