"use client";

import { Suspense, useCallback, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import AppShell from "@/components/layout/AppShell";
import AnalystCards from "@/components/signals/AnalystCards";
import FilterBar, {
  EMPTY_FILTERS,
  SignalFilters,
  activeFilterCount,
  filtersToQuery,
} from "@/components/signals/FilterBar";
import PerformanceStrip from "@/components/signals/PerformanceStrip";
import SignalTable from "@/components/signals/SignalTable";
import { usePerformance, useSignals } from "@/hooks/useDashboard";

/**
 * Signal History.
 *
 * Every signal the app has ever produced, what each analyst said at the time,
 * and what actually happened. Four stacked layers, coarse to fine: the overall
 * performance dashboard, the filters, the three analysts scored separately, then
 * the signals themselves.
 *
 * Filters live in the URL rather than in component state alone, so a filtered
 * view — "failed SHORT range setups on 4h in the last week" — is a link someone
 * can send.
 *
 * The page reads statistics; it never writes them. Performance is derived from
 * the signal rows on each request, so what the strip claims and what the table
 * shows cannot disagree.
 */

const PAGE_SIZE = 60;
/** `/api/signals` caps `limit` at 200. */
const MAX_ROWS = 200;

const KEYS: (keyof SignalFilters)[] = [
  "symbol",
  "analyst",
  "source",
  "side",
  "outcome",
  "timeframe",
  "from",
  "to",
  "band",
];

function filtersFromParams(params: { get(key: string): string | null }): SignalFilters {
  const out = { ...EMPTY_FILTERS };
  for (const key of KEYS) out[key] = params.get(key) ?? "";
  return out;
}

function paramsFromFilters(f: SignalFilters): string {
  const q = new URLSearchParams();
  for (const key of KEYS) if (f[key]) q.set(key, f[key]);
  return q.toString();
}

export default function SignalHistoryPage() {
  return (
    <AppShell>
      {/* `useSearchParams` needs a boundary — without it the prerender of this
          statically-rendered route bails out. */}
      <Suspense fallback={<p className="p-4 text-sm text-slate-500">Loading Signal History…</p>}>
        <SignalHistory />
      </Suspense>
    </AppShell>
  );
}

function SignalHistory() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [filters, setFilters] = useState<SignalFilters>(() => filtersFromParams(searchParams));
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [expanded, setExpanded] = useState<string | null>(null);

  const query = useMemo(() => filtersToQuery(filters, limit), [filters, limit]);
  const { data, error, loading, refresh } = useSignals(query);
  const performance = usePerformance();

  /**
   * One writer for both the state and the URL. The URL is never read back into
   * state after mount — a round trip would fight the user's own typing.
   */
  const apply = useCallback(
    (next: SignalFilters) => {
      setFilters(next);
      setLimit(PAGE_SIZE);
      setExpanded(null);
      const qs = paramsFromFilters(next);
      router.replace(qs ? `/signals?${qs}` : "/signals", { scroll: false });
    },
    [router],
  );

  const onChange = useCallback(
    (patch: Partial<SignalFilters>) => apply({ ...filters, ...patch }),
    [apply, filters],
  );

  const signals = data?.signals ?? [];
  const canLoadMore = limit < MAX_ROWS && (data?.nextCursor != null || signals.length >= limit);

  return (
    <div className="space-y-3 p-3 md:p-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold text-slate-100">Signal History</h1>
          <p className="text-[11px] text-slate-500">
            Every signal, the verdict each analyst gave at the time, and what the market did next.
          </p>
        </div>
        <button
          onClick={refresh}
          className="rounded-lg bg-white/5 px-2.5 py-1.5 text-[11px] text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-200"
        >
          ↻ Refresh
        </button>
      </header>

      <PerformanceStrip
        report={performance.data}
        loading={performance.loading}
        error={performance.error}
      />

      <FilterBar
        filters={filters}
        onChange={onChange}
        onReset={() => apply({ ...EMPTY_FILTERS })}
        resultCount={data?.count ?? 0}
        overFetched={data?.overFetched}
      />

      {performance.data && performance.data.analysts.length > 0 && (
        <AnalystCards analysts={performance.data.analysts} />
      )}

      {data?.warning && (
        <p className="glass px-3 py-2 text-[11px] text-neon-amber/85">
          {data.warning} — the table below is empty because the signal store could not be reached,
          not because no signals exist.
        </p>
      )}

      <SignalTable
        signals={signals}
        loading={loading}
        error={error}
        expanded={expanded}
        onExpand={setExpanded}
      />

      {canLoadMore && (
        <div className="flex justify-center">
          <button
            onClick={() => setLimit((n) => Math.min(n + PAGE_SIZE, MAX_ROWS))}
            className="rounded-lg bg-white/5 px-3 py-1.5 text-[11px] text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-200"
          >
            Show more — {signals.length} of {limit} loaded
          </button>
        </div>
      )}

      {signals.length > 0 && (
        <p className="text-center text-[10px] text-slate-600">
          Click any row for the full explanation, each analyst&apos;s verdict at signal time, and the
          outcome analysis.
          {activeFilterCount(filters) === 0 &&
            " Newest first, across every coin and timeframe the engine has traded."}
        </p>
      )}
    </div>
  );
}
