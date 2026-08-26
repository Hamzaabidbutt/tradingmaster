"use client";

import { useState } from "react";
import AppShell from "@/components/layout/AppShell";
import MarketOverviewCard from "@/components/dashboard/MarketOverviewCard";
import OverallDirectionCard from "@/components/dashboard/OverallDirectionCard";
import HighProbabilitySetups from "@/components/dashboard/HighProbabilitySetups";
import TopOpportunities from "@/components/dashboard/TopOpportunities";
import ActiveSignalsCard from "@/components/dashboard/ActiveSignalsCard";
import AnalystPerformanceCard from "@/components/dashboard/AnalystPerformanceCard";
import RecentOutcomes from "@/components/dashboard/RecentOutcomes";
import AccumulationScanner from "@/components/dashboard/AccumulationScanner";
import { ScanTimeframe } from "@/components/dashboard/shared";
import { useOverview, useScan } from "@/hooks/useDashboard";

/**
 * Market-wide dashboard.
 *
 * The terminal answers "what is this coin doing?". This answers the question a
 * single-symbol view structurally cannot: "of everything trading right now,
 * where is the strongest setup — long, short, or nowhere?"
 *
 * The scan is fetched **once here** and handed to the three blocks that read
 * from it. If each card owned its own `useScan`, changing the timeframe would
 * fire three universe sweeps for one click.
 */
export default function DashboardPage() {
  const [timeframe, setTimeframe] = useState<ScanTimeframe>("1h");
  const scan = useScan(timeframe);
  const overview = useOverview();

  return (
    <AppShell>
      <div className="space-y-3 p-3 md:p-4">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-lg font-bold tracking-tight text-slate-100">
            Market <span className="text-neon-cyan">Dashboard</span>
          </h1>
          <p className="text-[11px] text-slate-500">
            Every USDT perpetual, scored by three independent analysts. LONG, SHORT and NO TRADE are
            all valid answers.
          </p>
        </header>

        {/* 1 & 2 — where the market is, before any setup is quoted. */}
        <div className="grid gap-3 lg:grid-cols-[1.6fr_1fr]">
          <MarketOverviewCard
            data={overview.data}
            error={overview.error}
            loading={overview.loading}
          />
          <OverallDirectionCard data={overview.data} loading={overview.loading} />
        </div>

        {/* 3 — the lead block. */}
        <HighProbabilitySetups
          scan={scan.data}
          timeframe={timeframe}
          onTimeframe={setTimeframe}
          loading={scan.loading}
          error={scan.error}
          onRefresh={scan.refresh}
        />

        {/* 3b — the narrow question: who is building a base right now? */}
        <AccumulationScanner />

        {/* 4 — both sides, same component, same width. */}
        <div className="grid gap-3 lg:grid-cols-2">
          <TopOpportunities direction="LONG" scan={scan.data} loading={scan.loading} />
          <TopOpportunities direction="SHORT" scan={scan.data} loading={scan.loading} />
        </div>

        {/* 5 & 6 — what is running, and who has been right. */}
        <div className="grid gap-3 lg:grid-cols-2">
          <ActiveSignalsCard />
          <AnalystPerformanceCard />
        </div>

        {/* 7 & 8 — the track record, wins and losses given equal room. */}
        <div className="grid gap-3 lg:grid-cols-2">
          <RecentOutcomes outcome="successful" />
          <RecentOutcomes outcome="failed" />
        </div>
      </div>
    </AppShell>
  );
}
