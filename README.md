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
| **Numeric rows** | Printed under the price panel and toggleable: **volume numbers**, **volume delta numbers** (green/red by sign), **aggregate liquidation delta** per bar, and a **buy-pressure ribbon** shaded by how far each bar leans from neutral. A **cumulative aggregate liquidation delta** line (running forced-flow balance) is available as its own pane. Numbers auto-thin as you zoom out so they never overlap. |
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
| **Market Pulse (5-min conclusion)** | A tab inside the signal panel that answers "what just happened and what's next": explicit bullish/bearish odds with a transparent factor breakdown, the **most traded prices** in the window, the **institutional footprint band** (classified accumulation / distribution / neutral), **bearish candles that closed with positive delta** (and the bullish mirror) as absorbed-aggression tells, stop hunts, large prints, window vitals and a projected target with its invalidation level. Runs on 1-minute candles regardless of chart timeframe. |
| **Live candles** | The in-progress candle updates on every websocket frame, closed bars fold into state the instant they finish, and refetches reconcile incrementally so panning/zooming is never reset. A **countdown to candle close** sits beside the price axis, TradingView-style, alongside the live price. |
| **Multi-Window Read** | The same tape analysed across 3, 5, 7, 10, 12 and 15-bar lookbacks side by side, each with its own odds, delta, buy%, POC, volume multiple and close position. Reports the **consensus** (how many horizons agree) and flags **divergence** when short lookbacks turn against long ones — an early reversal tell no single lookback can produce. |
| **AI analyst panel** | Continuously updating desk-analyst feed ("Buyers absorbing aggressive sellers", "Short liquidations increasing", "Distribution phase detected"…), every line backed by the evidence that produced it. |
| **Signal engine** | 28 strategies vote -100..+100 — smart-money (SMC, ICT, liquidity sweep, order block, FVG, CHOCH, BOS), price action (breakout, trend continuation, reversal, engulfing, S/R, Fibonacci, MA stack) and order flow (**key-level absorption, exhaustion reversal, trapped traders, CVD divergence, stacked imbalance, value area/auction, LVN rejection, VWAP, liquidation delta, equal-level liquidity**). A tanh-squashed weighted blend produces bullish/bearish probability and a Weak/Moderate/Strong/Very Strong confidence label. Setups ladder TPs into resting liquidity, stop beyond structural invalidation, and always include reasoning + invalidation conditions. |
| **Backtesting** | Walk-forward, no lookahead, pessimistic intrabar resolution. Win rate, profit factor, max DD, Sharpe, streaks, avg RR, monthly/yearly buckets, equity curve; per-strategy isolation and comparison. |
| **Learning engine** | Every closed signal produces an immutable `LearningRecord`; strategy weights adjust (bounded, small learning rate) toward strategies that were right. History is never deleted. |
| **Analytics** | Real measured win rates (today/week/month/all-time), per-strategy accuracy, best/worst strategy — **never a hardcoded accuracy claim**. |
| **Alerts** | Browser notifications, Telegram, Discord, generic webhooks (env-configured) + per-user webhook channels. **Liquidation-spike alerts** push forced flow printing at an extreme straight to your phone — gated, deduplicated per spike and rate-limited per symbol (see below). |
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

> **Binance geo-blocking (important for cloud deploys).** Binance returns HTTP **451** to a number of
> datacentre regions, notably US ones. Vercel's default function region is `iad1` (US East), so a
> default deploy will show an empty chart and a stuck "Connecting to market feed…" strip while the
> browser's own websocket connects fine.
>
> This repo ships a `vercel.json` pinning functions to `fra1` (Frankfurt). Other permitted regions
> include `sin1`, `hnd1` and `syd1`. On other hosts, deploy outside the US or point
> `BINANCE_FAPI_BASE` at a reachable mirror/proxy.
>
> As a safety net the UI falls back to fetching klines and tickers **directly from the visitor's
> browser** when the server route fails, and shows a banner saying so. That keeps the chart alive,
> but the server-side analysis panels still require a server that can reach Binance.

## Liquidation-spike alerts

Forced flow is price-insensitive — a margin engine closes because collateral ran out, not because it
has a view — so it is finite by construction. When it lands at the extreme of a move and price holds,
the pressure that made the extreme has been spent. These alerts fire on exactly that: a spike **at an
extreme**, with a forced signature, that has **already begun reversing**.

### Setup

```bash
# 1. Create a bot with @BotFather in Telegram, then message your new bot once.
# 2. Find your chat id — this script says WHY it is missing when it is:
#      npm run telegram:chat-id -- <token>
#      npm run telegram:chat-id -- --test <chat-id>     # prove it end to end
#    (Shortcut for a DM: message @userinfobot. The id it reports is your own
#     user id, which is the chat id for a private chat with your bot.)
TELEGRAM_BOT_TOKEN="123456:ABC..."
TELEGRAM_CHAT_ID="987654321"

# 3. Secret for the scheduled endpoint. Without it the route stays disabled.
CRON_SECRET="$(openssl rand -base64 32)"
APP_URL="https://your-app.vercel.app"   # used for the link inside each alert
```

Then apply the schema (`SentAlert` is new) and check the gate before pointing it at a live channel:

```bash
npm run db:push
curl "$APP_URL/api/alerts/liquidations?dry=1&secret=$CRON_SECRET"
```

`dry=1` evaluates and reports without sending or recording anything.

### Running it on a schedule

Something has to call the endpoint; the app is serverless and nothing runs between page loads.

| Option | Granularity | Notes |
| --- | --- | --- |
| **GitHub Actions** (shipped) | 5 min | Free, works on a Vercel Hobby plan, secret stays in repo secrets. See below. |
| `npm run worker` | `LIQ_ALERT_INTERVAL_SEC` (default 300s) | Best latency, but needs an always-on host (Railway/Fly/Render/VPS). |
| Vercel Cron | 1 min on **Pro**, once a day on Hobby | Add a `crons` entry to `vercel.json`; Vercel sends `CRON_SECRET` as a bearer token automatically. |
| cron-job.org / Upstash QStash | 1 min | Free tiers. Send the secret as a header, not in the URL — query strings land in access logs. |

#### GitHub Actions (the shipped default)

`.github/workflows/liquidation-alerts.yml` calls the endpoint every five minutes. Add two
repository secrets under **Settings → Secrets and variables → Actions**:

| Secret | Value |
| --- | --- |
| `APP_URL` | `https://your-app.vercel.app` (no trailing slash) |
| `CRON_SECRET` | the same value as in the app's environment |

Then run it once by hand from the **Actions** tab — the `Run workflow` button takes a `dry_run`
flag, which defaults to true, so the first run reports what it *would* send without sending
anything. The JSON summary appears on the run page.

Three things to know about GitHub's scheduler:

* **Scheduled workflows only run from the default branch.** Nothing fires until this file is merged
  to `main`, however many times you push it to a feature branch.
* **Five minutes is the floor, and it drifts.** A run can land 10–15 minutes late when GitHub is
  busy. Alerts state how old their spike is, so a late one reads as late rather than as live.
* **Schedules are disabled after 60 days of repository inactivity**, with an email to the owner.

### Tuning

Every threshold is an env var (see `.env.example`). The defaults are deliberately strict, because an
alerter that fires a hundred times a day gets muted and is then worse than no alerts at all:

| Variable | Default | What it does |
| --- | --- | --- |
| `LIQ_ALERT_TIMEFRAME` | `5m` | Also the floor latency — see below. |
| `LIQ_ALERT_MIN_SCORE` | `70` | Raise for fewer, stronger alerts. |
| `LIQ_ALERT_MAX_BARS_AGO` | `3` | Older spikes are history, not an entry. |
| `LIQ_ALERT_MIN_REVERSAL_PCT` | `0.4` | Requires the turn to have started. |
| `LIQ_ALERT_MAX_PER_RUN` | `5` | Caps a violent session. |
| `LIQ_ALERT_COOLDOWN_MIN` | `45` | Per symbol, so one coin cannot spam. |

Each spike alerts **once**: the dedupe key is built from the spike bar's own timestamp and enforced
by a unique index, so re-reading the same candles on the next sweep sends nothing.

### What this cannot do (yet)

Spikes are detected from **closed candles**, so an alert is inherently up to one bar behind — on the
5m default, up to ~5 minutes, plus whatever your scheduler adds. Every message states how long ago
the spike printed rather than implying it is live.

Genuinely immediate alerting needs Binance's `!forceOrder@arr` all-market websocket, which streams
real liquidation prints as they happen and would also upgrade `forced` from `inferred` to
`confirmed` (the engine already supports the distinction — it just never receives measured data). A
websocket needs a persistent connection, so that step only makes sense once the worker is deployed
somewhere always-on.

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
