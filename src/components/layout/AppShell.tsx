"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ReactNode, useEffect, useState } from "react";
import { useMarketStore } from "@/stores/marketStore";
import { useTickers } from "@/hooks/useLiveMarket";
import { MARKETS } from "@/lib/config";

const NAV = [
  { href: "/", label: "Terminal", icon: "◉" },
  { href: "/signals", label: "Signals", icon: "⚡" },
  { href: "/strategies", label: "Strategies", icon: "🧠" },
  { href: "/backtest", label: "Backtest", icon: "⏱" },
  { href: "/analytics", label: "Analytics", icon: "📊" },
  { href: "/settings", label: "Settings", icon: "⚙" },
];

/** App shell: collapsible sidebar, live ticker strip, mobile bottom nav. */
export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { sidebarCollapsed, toggleSidebar } = useMarketStore();
  const tickers = useTickers();
  const [user, setUser] = useState<{ email: string; role: string } | null>(null);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => setUser(d.user))
      .catch(() => undefined);
  }, []);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar (desktop) */}
      <aside
        className={`hidden shrink-0 flex-col border-r border-white/5 bg-base-900/60 backdrop-blur-xl transition-all duration-300 md:flex ${
          sidebarCollapsed ? "w-16" : "w-52"
        }`}
      >
        <div className="flex items-center gap-2 px-4 py-4">
          <span className="text-xl text-neon-cyan text-glow-cyan">◈</span>
          {!sidebarCollapsed && (
            <span className="text-sm font-bold tracking-wide">
              Trading<span className="text-neon-cyan">Master</span>
            </span>
          )}
        </div>
        <nav className="flex-1 space-y-1 px-2">
          {NAV.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                  active
                    ? "bg-neon-cyan/10 font-semibold text-neon-cyan"
                    : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
                }`}
                title={item.label}
              >
                <span className="text-base leading-none">{item.icon}</span>
                {!sidebarCollapsed && item.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-white/5 p-3">
          {!sidebarCollapsed && (
            <div className="mb-2 truncate text-[10px] text-slate-500">
              {user ? `${user.email} · ${user.role}` : <Link href="/login" className="text-neon-cyan hover:underline">Sign in →</Link>}
            </div>
          )}
          <button
            onClick={toggleSidebar}
            className="w-full rounded-lg bg-white/5 py-1.5 text-xs text-slate-400 transition-colors hover:bg-white/10"
            aria-label="Toggle sidebar"
          >
            {sidebarCollapsed ? "»" : "«"}
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Live ticker strip */}
        <div className="flex shrink-0 items-center gap-4 overflow-x-auto border-b border-white/5 bg-base-900/60 px-4 py-2 backdrop-blur-xl">
          <span className="pulse-dot h-2 w-2 shrink-0 rounded-full bg-bull" aria-label="Live" />
          {tickers.map((t) => {
            const m = MARKETS.find((x) => x.symbol === t.symbol);
            const up = t.priceChangePercent >= 0;
            return (
              <div key={t.symbol} className="flex shrink-0 items-baseline gap-1.5 font-mono text-xs">
                <span className="font-semibold text-slate-300">{m?.label ?? t.symbol}</span>
                <span className="text-slate-200">{t.lastPrice}</span>
                <span className={up ? "text-bull" : "text-bear"}>
                  {up ? "+" : ""}
                  {Number(t.priceChangePercent).toFixed(2)}%
                </span>
              </div>
            );
          })}
          {tickers.length === 0 && <span className="text-xs text-slate-600">Connecting to market feed…</span>}
        </div>

        <main className="min-h-0 flex-1 overflow-y-auto pb-16 md:pb-0">{children}</main>
      </div>

      {/* Mobile bottom nav */}
      <nav className="fixed inset-x-0 bottom-0 z-40 flex justify-around border-t border-white/10 bg-base-900/90 py-2 backdrop-blur-xl md:hidden">
        {NAV.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex flex-col items-center gap-0.5 px-2 text-[9px] ${
                active ? "text-neon-cyan" : "text-slate-500"
              }`}
            >
              <span className="text-lg leading-none">{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
