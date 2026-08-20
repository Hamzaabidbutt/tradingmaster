"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSymbols } from "@/hooks/useSymbols";
import type { FuturesSymbol } from "@/lib/symbols";

/** Rows rendered at once. ~500 perpetuals would make the list janky. */
const MAX_VISIBLE = 100;

/**
 * Searchable symbol picker over the whole Binance USDT-M perpetual universe.
 *
 * This replaces a `<select>` of 7 hardcoded pairs. With ~500 contracts a
 * plain dropdown is unusable, so this is a proper combobox: type to filter,
 * arrows to move, Enter to pick, Escape to close. The curated pairs stay
 * pinned at the top so the familiar names are still one click away.
 */
export default function SymbolSearch({
  symbol,
  onSelect,
}: {
  symbol: string;
  onSelect: (symbol: string) => void;
}) {
  const { symbols, loading, labelFor } = useSymbols();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return symbols;
    // Rank exact, then prefix, then substring — typing "ARB" should not bury
    // ARBUSDT under every coin that merely contains those letters.
    const scored = symbols
      .map((s) => {
        const sym = s.symbol;
        const base = s.base;
        let rank = -1;
        if (base === q || sym === q) rank = 0;
        else if (base.startsWith(q)) rank = 1;
        else if (sym.startsWith(q)) rank = 2;
        else if (base.includes(q) || sym.includes(q)) rank = 3;
        return { s, rank };
      })
      .filter((x) => x.rank >= 0);
    scored.sort((a, b) => a.rank - b.rank || a.s.base.localeCompare(b.s.base));
    return scored.map((x) => x.s);
  }, [symbols, query]);

  const visible = filtered.slice(0, MAX_VISIBLE);

  // Clamp the highlight whenever the result set shrinks under it.
  useEffect(() => {
    setActive((a) => (a >= visible.length ? 0 : a));
  }, [visible.length]);

  // Click-outside closes and discards the half-typed query.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Keep the highlighted row in view during keyboard navigation.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const commit = (s: FuturesSymbol | undefined) => {
    if (!s) return;
    onSelect(s.symbol);
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) return setOpen(true);
      setActive((a) => Math.min(a + 1, visible.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open) commit(visible[active]);
      else setOpen(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      setQuery("");
      inputRef.current?.blur();
    } else if (e.key === "Home" && open) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End" && open) {
      e.preventDefault();
      setActive(visible.length - 1);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-base-800 px-2 py-1 focus-within:border-neon-cyan/50">
        <span className="text-[11px] text-slate-600" aria-hidden="true">
          ⌕
        </span>
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls="symbol-search-list"
          aria-autocomplete="list"
          aria-activedescendant={open && visible.length > 0 ? `symbol-opt-${active}` : undefined}
          aria-label="Search Binance USDT perpetuals"
          value={open ? query : labelFor(symbol)}
          placeholder="Search coins…"
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            if (!open) setOpen(true);
          }}
          onKeyDown={onKeyDown}
          className="w-[7.5rem] bg-transparent font-mono text-sm font-semibold text-slate-100 outline-none placeholder:font-normal placeholder:text-slate-600"
        />
        <button
          type="button"
          tabIndex={-1}
          aria-label={open ? "Close symbol list" : "Open symbol list"}
          onClick={() => {
            setOpen((o) => !o);
            if (!open) inputRef.current?.focus();
          }}
          className="text-[9px] text-slate-500 hover:text-slate-300"
        >
          {open ? "▲" : "▼"}
        </button>
      </div>

      {open && (
        <div className="animate-slide-up absolute left-0 top-full z-50 mt-1 w-64 overflow-hidden rounded-lg border border-white/10 bg-base-850 shadow-glass">
          <div className="flex items-center justify-between border-b border-white/5 px-2 py-1 text-[9px] uppercase tracking-wider text-slate-500">
            <span>
              {loading
                ? "Loading Binance universe…"
                : `${filtered.length} of ${symbols.length} perpetuals`}
            </span>
            {filtered.length > MAX_VISIBLE && <span className="text-slate-600">showing {MAX_VISIBLE}</span>}
          </div>

          <ul
            ref={listRef}
            id="symbol-search-list"
            role="listbox"
            aria-label="Trading pairs"
            className="max-h-72 overflow-y-auto py-0.5"
          >
            {visible.length === 0 ? (
              <li className="px-2 py-3 text-center text-[10px] text-slate-500">
                No USDT perpetual matches “{query}”.
              </li>
            ) : (
              visible.map((s, i) => (
                <li key={s.symbol}>
                  <button
                    type="button"
                    id={`symbol-opt-${i}`}
                    data-idx={i}
                    role="option"
                    aria-selected={s.symbol === symbol}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => commit(s)}
                    className={`flex w-full items-center gap-2 px-2 py-1 text-left transition-colors ${
                      i === active ? "bg-neon-cyan/10" : "hover:bg-white/5"
                    }`}
                  >
                    {s.featured && (
                      <span className="text-[9px] text-neon-amber" title="Curated pair">
                        ★
                      </span>
                    )}
                    <span
                      className={`font-mono text-[11px] font-semibold ${
                        s.symbol === symbol ? "text-neon-cyan" : "text-slate-200"
                      }`}
                    >
                      {s.base}
                    </span>
                    <span className="font-mono text-[9px] text-slate-600">/USDT</span>
                    <span className="ml-auto font-mono text-[9px] text-slate-600">{s.pricePrecision}d</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
