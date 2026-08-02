# ◈ TradingMaster

**AI-powered, institutional-style crypto market intelligence & signal platform.**

TradingMaster continuously analyzes live futures market data — order flow, liquidity, market
structure, volume behavior, liquidations and price action — to estimate the highest-probability
next move, then generates complete trade setups (entry / stop / TP1-3 / RR / confidence) with the
full evidence stack behind every call. It is **not** an indicator site: every signal explains *why*
it exists.

Built with **Next.js 14 (App Router) + TypeScript + MySQL (Prisma) + Tailwind + lightweight-charts**.

---

## Feature map

| Area | What it does |
|---|---|
| **Markets** | UNI, ORDI, BTC, ETH, SOL, BNB, DEXE vs USDT (Binance USDT-M futures). Add a row to `src/lib/config.ts` → the entire platform picks it up. |
| **Timeframes** | 1m → 1M, each with independent structure & analysis. |
| **Chart** | TradingView-style candles with live websocket updates plus auto-drawn overlays, **all individually toggleable** from the Indicators panel: order blocks (fresh/respected/mitigated), breaker blocks, FVGs (+fill state), supply/demand, premium/discount + equilibrium, BOS/CHOCH markers, liquidity sweeps, equal highs/lows **connected with lines**, buy/sell-side liquidity, S/R, volume profile histogram with POC/VAH/VAL/LVN lines, **auto Fibonacci with golden pocket**, **key moving averages** (EMA 9/21/50, SMA 100/200), **session VWAP**, CVD line, big-trade bubbles, absorption/exhaustion/trap markers, entry/SL/TP levels, pattern markers. |
| **Numeric rows** | Printed under the price panel and toggleable: **volume numbers**, **volume delta numbers** (green/red by sign), and **aggregate liquidation delta** per bar. Numbers auto-thin as you zoom out so they never overlap. |
| **Volume Profile & Auction Theory** | POC (Point of Control), 70% Value Area with VAH/VAL, HVN (accepted price) and LVN (rejected price — the better trade location) detection, profile shape classification (**D** balanced, **P** short covering, **b** long liquidation, **B** double distribution) and balance ↔ imbalance auction state with value acceptance above/inside/below. |
| **Footprint** | Per-price bid × ask ladder rebuilt from lower-timeframe candles (fidelity is reported: `reconstructed` vs `modelled`), diagonal **imbalance detection at a configurable 3x threshold**, **stacked imbalances** (3+ consecutive levels), **zero prints**, per-candle POC, and delta-vs-body divergence — the classic absorption/trap signature. |
| **Absorption / Exhaustion / Traps** | Absorption scored **only where it matters** — at the POC, value-area edges, LVNs or strong S/R (mid-range absorption is explicitly down-weighted as noise). Exhaustion tracked in three stages (momentum → weakening → danger) including the hollow low-volume push into a new extreme. Trapped buyers/sellers identified with the stop pool they left behind. |
| **Delta & CVD** | Per-bar delta, cumulative volume delta, regular and hidden **CVD divergences** (earlier than any price-derived oscillator), trap bars where delta contradicts the candle body, and delta-spike levels that act as future S/R. |
| **Market structure engine** | Fractal swings (major/minor), HH/HL/LH/LL labeling, BOS & CHOCH detection on both structure scopes, range detection, trend + reversal/continuation probabilities. |
| **Order flow engine** | Buy/sell pressure, per-bar delta, cumulative delta (CVD), aggression, absorption, exhaustion, large-order detection — derived from taker-buy volume. |
| **Liquidity engine** | Equal highs/lows clustering, swing liquidity pools, buy/sell stops, sweep/grab/hunt detection with reversal vs continuation odds and plain-language explanation of who likely drove it. |
| **Liquidation engine** | Heuristic cascade detection from price/volume/delta signatures, long/short pressure, cluster heat map projection, whale-driven & fake-move classification, plus the **live forced-order tape** streamed from Binance (`@forceOrder`). |
| **Patterns** | Engulfing, hammer, shooting star, morning/evening star, doji, inside/outside bar, pin bars, marubozu, strong rejection candles — each with top/bottom price, strength, contextual probability. Double/triple tops & bottoms with neckline, measured target and breakout odds. |
| **S/R engine** | Clustered levels with strength (0-100), touch & rejection counts, break/bounce probabilities, volume confirmation. |
| **AI analyst panel** | Continuously updating desk-analyst feed ("Buyers absorbing aggressive sellers", "Short liquidations increasing", "Distribution phase detected"…), every line backed by the evidence that produced it. |
| **Signal engine** | 28 strategies vote -100..+100 — smart-money (SMC, ICT, liquidity sweep, order block, FVG, CHOCH, BOS), price action (breakout, trend continuation, reversal, engulfing, S/R, Fibonacci, MA stack) and order flow (**key-level absorption, exhaustion reversal, trapped traders, CVD divergence, stacked imbalance, value area/auction, LVN rejection, VWAP, liquidation delta, equal-level liquidity**). A tanh-squashed weighted blend produces bullish/bearish probability and a Weak/Moderate/Strong/Very Strong confidence label. Setups ladder TPs into resting liquidity, stop beyond structural invalidation, and always include reasoning + invalidation conditions. |
| **Backtesting** | Walk-forward, no lookahead, pessimistic intrabar resolution. Win rate, profit factor, max DD, Sharpe, streaks, avg RR, monthly/yearly buckets, equity curve; per-strategy isolation and comparison. |
| **Learning engine** | Every closed signal produces an immutable `LearningRecord`; strategy weights adjust (bounded, small learning rate) toward strategies that were right. History is never deleted. |
| **Analytics** | Real measured win rates (today/week/month/all-time), per-strategy accuracy, best/worst strategy — **never a hardcoded accuracy claim**. |
| **Alerts** | Browser notifications, Telegram, Discord, generic webhooks (env-configured) + per-user webhook channels. |
| **Security** | JWT httpOnly sessions, bcrypt, RBAC (ADMIN/ANALYST/VIEWER), zod input validation, per-IP rate limiting (middleware + per-route), audit log, security headers. |

## Architecture

```
src/
  engines/          Pure, deterministic analysis engines (no I/O — unit-testable)
    marketStructure, orderBlocks, fvg, liquidity, candlestick,
    supportResistance, volume, orderflow, liquidations, doublePatterns,
    premiumDiscount, volumeProfile, footprint, orderFlowEvents,
    deltaAnalysis, liquidationDelta, indicators (MA/VWAP/Fib/equal levels),
    strategies, signal, insights, analyzer, backtest, learning
  services/         Signal lifecycle: generate → persist → evaluate → learn
  lib/              Binance client, Prisma, auth, cache, rate limit, logger, alerts, config
  app/              Next.js App Router pages + REST API routes
  components/       Chart (lightweight-charts + custom overlay canvas), panels, shell
  hooks/            Live websocket market feed, analysis polling
  stores/           Zustand UI state (persisted)
scripts/worker.ts   Background scanner: analyzes all markets, persists signals,
                    evaluates open trades, feeds the learning engine
prisma/             MySQL schema + seed
tests/              Vitest unit/integration tests for the engines
```

**Data flow:** Binance REST (klines/ticker/depth) → analysis engines → API/worker → MySQL.
Browser additionally connects straight to Binance websockets (`kline`, `markPrice`, `forceOrder`)
for zero-latency chart ticks and the live liquidation tape.

## Getting started

### Docker (recommended)

```bash
cp .env.example .env          # set AUTH_SECRET at minimum
docker compose up --build
# → web on http://localhost:3000, MySQL, migrations+seed, background worker
```

### Local development

```bash
cp .env.example .env          # point DATABASE_URL at your MySQL, set AUTH_SECRET
npm install                   # runs prisma generate
npx prisma db push && npm run db:seed
npm run dev                   # web  → http://localhost:3000
npm run worker                # background signal scanner (separate terminal)
npm test                      # engine test suite
```

The dashboard works without a database (analysis is computed live); MySQL enables signal
persistence, learning, analytics and auth. The first registered account becomes **ADMIN**.

> Binance's public API must be reachable from the server. Some cloud/CI egress policies block
> `fapi.binance.com` — set `BINANCE_FAPI_BASE` to a compatible mirror/proxy if needed.

## Honest-accuracy policy

The platform deliberately makes **no fixed accuracy claims** (no "90% win rate" marketing):

- Confidence scores are derived from objective market evidence and saturate below 100%.
- Win rates shown anywhere in the UI are **measured** from realized, persisted signal outcomes.
- The learning engine re-weights strategies from real results and keeps a full audit trail.
- Every signal ships with its reasoning, its invalidation conditions and the live historical
  performance of the strategies that produced it — users judge reliability from evidence.
- Backtests resolve intrabar SL/TP ambiguity as losses, so reported results under-promise.

**This software is a research/analysis tool, not financial advice. Futures trading carries a
substantial risk of loss.**
