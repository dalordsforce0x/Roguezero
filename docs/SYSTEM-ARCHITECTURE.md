# RogueZero System Architecture — Definitive Reference

> **This document is the canonical source of truth for how the trading system works.**
> Every component, data source, pipeline, and gate is documented here.
> If the code disagrees with this doc, update this doc — not the other way around.
> Last verified against code: 2026-06-11 (commit dd0d07f)

---

## 1. WHAT IS ROGUEZERO

RogueZero is an automated Solana token trading bot. It:
- Maintains a universe of tradeable tokens
- Monitors price movements across those tokens
- Identifies entry opportunities using multiple strategies
- Executes trades via Jupiter swap
- Manages positions with stop-loss, take-profit, and trailing stops

The system has two deployed services:
- **Worker** (`services/worker/`) — the trading engine. Runs price loops, evaluates signals, executes trades.
- **API** (`services/api/`) — REST API for the admin dashboard. Also handles swap execution via Jupiter.

Both deploy to Railway.

---

## 2. DATA SOURCES — What feeds the bot

### 2.1 Pyth / Hermes (SOL price only)

- **What:** Real-time SOL/USD price from Pyth Network's Hermes API
- **How:** HTTP polling (`/v2/updates/price/latest`) every ~3 seconds
- **Feeds:** `sharedMarketTape.solUsdPyth` — the SOL price tape
- **Used for:** SOL momentum signal, SOL ATR calculation, drift comparison vs Jupiter
- **Only tracks SOL.** No other tokens use Pyth.

### 2.2 Jupiter Price API v3 (all tokens)

- **What:** USD prices for ALL tracked tokens from Jupiter aggregator
- **How:** HTTP polling every ~12 seconds. Fetches prices for all 108 tracked mints in one batch call.
- **Feeds:** `jupiterMomentumTapeByMint` — a Map of mint → price tape (array of {usdPrice, sampledAt})
- **Used for:**
  - Momentum signal calculation for non-SOL tokens
  - Bollinger band calculation (mean reversion strategy)
  - Supertrend signal calculation
  - Current mark price for position valuation
- **Tape size:** ~900 samples per token (configurable via `pricePollPolicy.sharedTapeSize`)
- **Rate limit:** 8 RPS general bucket (shared across all Jupiter calls)

### 2.3 GeckoTerminal (1-minute OHLCV candles)

- **What:** 1-minute candlestick data (open/high/low/close/volume) from GeckoTerminal's free API
- **Purpose:** Provides ATR (Average True Range) and RVOL (Relative Volume) data for entry gating
- **How it works:**
  1. For each tracked mint, calls `GET /tokens/{mint}/pools?page=1` to find the highest-liquidity DEX pool
  2. Then calls `GET /pools/{pool}/ohlcv/minute?aggregate=1&limit=1000` to get 1-min candles
  3. Caches pool addresses for 24h (successful) or 5min (failed/null)
  4. Caches candle data per mint, up to 240 candles (4 hours)
- **Refresh trigger:** Called inside `runJupiterPricePollTick()` after each Jupiter price poll via `geckoFeed.refreshMints(tokenUniverseActiveMints)`
- **Rate limiting:** Internal 1200ms spacing between calls. No external rate governor. Free tier is ~30 req/min.
- **Feeds:**
  - `geckoFeed.getTape(mint)` — candle array for ATR
  - `geckoFeed.getCloses(mint)` — close prices
  - `geckoFeed.getVolumes(mint)` — volume per candle for RVOL
  - `geckoFeed.hasFreshCandles(mint)` — true if candles fetched within 15 min
- **Critical dependency:** When `GECKO_CANDLES_REQUIRED_FOR_ENTRY=true` (default), **ALL non-SOL entries are blocked** if gecko has no fresh candles for that token. This is the gecko freshness gate.

### 2.4 CoinGecko (market cap enrichment — admission only)

- **What:** Market cap, FDV, 24h volume from CoinGecko API
- **When:** Only during token admission (`admit-token-candidates.mjs`), NOT at runtime
- **Purpose:** Gate new token admissions by market cap floor ($250k default)
- **Current state:** Running on free tier (no API key), matching ~118-122 out of ~160 candidates
- **NOT used by the worker at runtime.** Only used by the admission script.

---

## 3. TOKEN UNIVERSE — How tokens get tracked

### 3.1 Database table: `rz_token_universe`

Columns: `mint`, `symbol`, `enabled`, `priority`, `notes`, `updated_at`, `synced_at`

- 874 total rows, 113 enabled, 761 disabled (as of 2026-06-11)
- `synced_at` is updated by `sync-token-universe.mjs` script — NOT by the worker, NOT automatically
- The worker reads this table but never writes to it

### 3.2 Token Admission (`scripts/admit-token-candidates.mjs`)

This is a **manually-run script** (not scheduled, not automatic). It:

1. Fetches candidates from Jupiter Token API v2 across 8 feed paths:
   - `toptraded/1h`, `toptraded/24h` — most-traded tokens
   - `toporganicscore/24h`, `toporganicscore/1h` — highest organic (non-wash) trading
   - `tag?query=verified` — Jupiter-verified tokens
   - `toptrending/24h`, `toptrending/1h` — trending tokens
   - `recent` — newly listed
2. Runs safety checks on each candidate:
   - Must be Jupiter-verified
   - Organic score ≥ 50
   - Liquidity ≥ $50,000
   - Holders ≥ 1,000
   - 24h volume ≥ $25,000
   - Mint authority disabled
   - Freeze authority disabled
   - Not flagged as suspicious
   - Top holders ≤ 35%
   - Dev balance ≤ 5%
   - Not a pump.fun mint
3. Route-tests via Jupiter quotes (1/2/5/10 USDC entry AND exit):
   - Needs 4+ successful quotes
   - Entry price impact ≤ 50 bps at $5 USDC
   - Entry price impact ≤ 100 bps at $10 USDC
   - Same thresholds for exit routes
4. CoinGecko enrichment (best-effort): market cap ≥ $250k
5. Writes results to `token_admission_candidates` table
6. If admitted: upserts into `rz_token_universe` with `enabled=true`
7. Runs in **additive-only mode** by default — never disables existing tokens

**10 hardcoded always-admit tokens:** SOL, USDC, USDT, JUP, JitoSOL, mSOL, bSOL, JTO, PYTH, KMNO

### 3.3 Token Sync (`scripts/sync-token-universe.mjs`)

Another **manually-run script**. Updates metadata (symbol, liquidity, volume, holder count, etc.) for existing universe tokens. Sets `synced_at` timestamp. Last run: June 9 (2 days stale as of June 11).

### 3.4 Worker Token Loading (`refreshTokenUniverseMints`)

- Runs at startup and periodically (rate-limited by `TOKEN_UNIVERSE_REFRESH_MS`)
- Reads `rz_token_universe` table, filters to enabled rows
- Merges with `TRUSTED_ENTRY_UNIVERSE_MINTS` (21 hardcoded mints — see Section 3.5)
- Stores in `tokenUniverseMints` (all), `tokenUniverseActiveMints` (enabled), `tokenUniverseSymbolByMint` (symbol lookup)
- Result: ~108 tracked mints after dedup and filtering
- Also runs `applyTokenUniverseAutoSort()` which can dynamically enable/disable tokens based on performance

### 3.5 Trusted Entry Universe (hardcoded)

These 21 mints are ALWAYS included regardless of DB state:
SOL, USDC, USDT, JUP, JitoSOL, mSOL, bSOL, JTO, PYTH, KMNO, WBTC, W, HNT, BONK, WIF, MEW, POPCAT, RAY, ORCA, INF, SHDW

### 3.6 Token Class Assignment

Every token gets a class via `getTokenTradeClass(mint)`:
- `major` — SOL, JUP (hardcoded)
- `sol_beta` — tokens in the sol_beta cluster (set via `TOKEN_CLUSTER_BY_MINT` / `TOKEN_CLUSTER_BY_SYMBOL`)
- `trend_liquid` — any trusted entry universe mint not in the above
- `long_tail` — everything else

**`WORKER_ALLOWED_TOKEN_CLASSES`** env var (currently `major,sol_beta`) filters which classes can be scouted for entry. This means only `major` and `sol_beta` tokens pass the scout filter right now. `trend_liquid` and `long_tail` tokens are excluded from entry scouting.

---

## 4. PRICE LOOPS — How market data flows

### 4.1 Pyth Poll Loop

```
Every ~3 seconds:
  1. HTTP GET Hermes /v2/updates/price/latest for SOL/USD feed
  2. Push sample to sharedMarketTape.solUsdPyth
  3. Compare with Jupiter SOL price → compute drift
  4. Push drift to sharedMarketTape.solUsdDrift
```

### 4.2 Jupiter Price Poll Loop

```
Every ~12 seconds:
  1. Call refreshTokenUniverseMints() — reload DB if stale
  2. Fetch Jupiter prices for ALL tracked mints (108 mints)
  3. For each mint with valid price:
     a. Update latestJupiterUsdByMint
     b. Push to jupiterMomentumTapeByMint (per-token tape)
  4. Run applyTokenUniverseAutoSort() — dynamic enable/disable
  5. Run geckoFeed.refreshMints(tokenUniverseActiveMints) — fire-and-forget
  6. Persist market tape state
  7. Sample signal observation forward returns (measurement only)
```

### 4.3 Gecko Candle Refresh (inside Jupiter poll)

```
For each active mint (108 mints):
  1. Check pool cache — if fresh (null=5min, good=24h), use cached pool
  2. If stale: GET /tokens/{mint}/pools?page=1 → find top pool
  3. If no pool found: cache as null, skip candle fetch → "no_pool"
  4. If pool found: GET /pools/{pool}/ohlcv/minute?limit=1000
  5. Parse OHLCV, store up to 240 candles
  6. Wait 1200ms between each API call

With 108 mints × 2 calls each = 216 calls per cycle
At 1200ms spacing = ~260 seconds (4.3 minutes) per full cycle
Free tier ceiling: ~30 req/min = 500 calls in 4.3 minutes → sufficient IF no 429s
```

---

## 5. SIGNAL GENERATION — How the bot decides direction

### 5.1 Three Strategies

The bot rotates between three strategies. Each evaluates the same price tape but with different math:

#### Momentum
- Compares current price to price N samples ago (lookbackSamples)
- If price change > thresholdBps → bullish
- If price change < -thresholdBps → bearish
- Otherwise → flat
- For SOL: uses Pyth tape. For others: uses Jupiter tape.

#### Mean Reversion (Bollinger Bands)
- Computes 20-period SMA and standard deviation bands
- BBP (Bollinger Band Percentage) = where price sits in the bands
- BBP < 0.2 → oversold → bullish (buy)
- BBP > 0.8 → overbought → bearish (sell)
- Band width < 0.006 (0.6%) → flat (no edge, bands too narrow)

#### Supertrend
- Builds candles from price samples, computes ATR
- ATR × multiplier defines a trailing band
- Price above band → bullish, below → bearish

### 5.2 Strategy Rotation

- Sessions rotate through enabled strategies in a fixed order: momentum → mean_reversion → supertrend
- Each loop iteration: scan from current strategy forward
- First strategy with a non-bearish, ready signal wins the entry attempt
- After each loop: advance the baton to the next strategy regardless of outcome
- This prevents one strategy from hogging all entries

### 5.3 Per-Token Signal (Entry Scouting)

When the session's global signal is bullish:
- `buildRuntimeSignalForMint(mint, strategy, config)` computes a token-specific signal
- For momentum: uses that token's Jupiter tape
- For mean_reversion: uses that token's tape through Bollinger
- For supertrend: uses that token's tape through supertrend

---

## 6. ENTRY FLOW — The complete gate chain

When the worker loop fires for a session, and the session has no open position:

### 6.1 Scout Phase (`scoutEntryUniverse`)

```
1. getUniverseScoutCandidateMints() filters the universe:
   - Remove stables (USDC, USDT)
   - Remove hard-blocked tokens
   - Apply WORKER_ALLOWED_TOKEN_CLASSES filter (currently: major, sol_beta only)
   - Remove excluded mints/clusters
   - Sort by quality rank (SOL first, trusted second, named majors third, rest last)
   - Limit to WORKER_UNIVERSE_SCOUT_MAX_CANDIDATES

2. For each candidate mint:
   - Build per-token signal via buildRuntimeSignalForMint()
   - Check if signal is ready + bullish + persistent
   - If the token passes signal check: probe a Jupiter quote route
   - Score candidates by signal strength + route quality

3. Return the best candidate (highest score with valid route)
```

### 6.2 Entry Gate Chain (sequential — ALL must pass)

Once a candidate is selected, it must pass EVERY gate in order:

```
GATE 1: Token Signal Check (L8161)
  - tokenEntrySignal.status must be 'ready'
  - tokenEntrySignal.regime must NOT be 'bearish'
  - Blocks: warming_up signals, bearish regime
  - Result: flat and bullish proceed

GATE 2: Momentum Persistence (L8174)
  - For momentum strategy only
  - The bullish regime must persist across MIN_ENTRY_SIGNAL_PERSISTENCE_SAMPLES consecutive samples
  - Prevents entering on a single-sample spike

GATE 3: Gecko Candle Freshness (L6679 in dist)
  - GECKO_CANDLES_REQUIRED_FOR_ENTRY must be true (default: true)
  - SOL is exempt (uses Pyth tape)
  - geckoFeed.hasFreshCandles(mint) must be true (candles fetched within 15 min)
  - If no fresh candles: BLOCKED with reason 'stale_candles_no_fresh_signal'
  - THIS IS THE GATE THAT BLOCKS MOST NON-SOL ENTRIES when gecko feed fails

GATE 4: Trending Shape Gate (L8198)
  - Only applies to non-SOL, non-trusted tokens
  - Checks price shape: not chasing a pump, has a pullback, reclaiming from low
  - Prevents buying into an extended run

GATE 5: Cost Floor Reachability (L6697 in dist)
  - Only for 'major' class tokens
  - Computes ATR from candle-backed tape
  - reachableTakeProfitBps = ATR × takeProfitMultiplier
  - Must clear computeExitCostFloorBps (entry cost + exit cost + platform fee + safety buffer)
  - If ATR is too low (flat market), TP can't cover costs → BLOCKED

GATE 6: Entry Quality Gate (L8392)
  - WORKER_ENTRY_QUALITY_GATE_ENABLED must be true
  - Computes ATR from tape
  - reachableTakeProfitBps = ATR × atrTakeProfitMultiplier
  - Must clear roundTripCostBps × WORKER_ENTRY_QUALITY_TP_COST_RATIO
  - Similar to Gate 5 but applies to ALL classes

GATE 7: Entry Quality Score (L6735 in dist)
  - Computes composite quality score from price shape, pullback, impact
  - Blocks entries below threshold score
  - Uses getCandleBackedPriceTape() which prefers gecko candles, falls back to Jupiter tape

GATE 8: RVOL Gate (L8538)
  - computeRelativeVolume(mint) from gecko candle volume data
  - Current candle volume / average volume over last 20 candles
  - Must be ≥ 1.0 (above average volume)
  - If RVOL < 1.0: BLOCKED — no conviction behind the move
  - Returns null (passes) if insufficient gecko data

GATE 9: Exit Liquidity Probe
  - Probes a reverse Jupiter quote to verify the token can be sold
  - Measures exit price impact
  - Must have viable exit route

GATE 10: Route Stability
  - Multiple quote samples to verify price impact consistency
  - Rejects if impact varies wildly between samples
```

### 6.3 getCandleBackedPriceTape (critical merge function)

```typescript
// For SOL: always returns Pyth tape
// For others: if gecko has fresh candles with ≥ GECKO_CANDLE_MIN_SAMPLES (30):
//   return gecko candle tape (1-min OHLCV close prices)
// Otherwise: fall back to Jupiter momentum tape (~12s samples)
```

This means:
- **With gecko candles:** ATR/shape/quality gates use real 1-min data — accurate
- **Without gecko candles:** ATR/shape/quality gates use Jupiter's ~12s tape — "blind, failed open" as the code comments say

---

## 7. EXIT FLOW — How positions close

Once a position is open:

### 7.1 Stop Loss
- ATR-based: `atrBps × atrStopLossMultiplier`
- Hard floor: `WORKER_STOP_LOSS_BPS` (100 bps = 1%)
- Cost floor: decoupled from stop loss (R:R fix deployed this session)

### 7.2 Take Profit
- ATR-based: `atrBps × atrTakeProfitMultiplier`
- Floor: `computeExitCostFloorBps()` = entry cost + exit cost + platform fee + safety buffer
- The TP target must clear the cost floor — otherwise the trade can't profit after friction

### 7.3 Trailing Stop
- Activates after price moves past a threshold
- Trails at `WORKER_TRAILING_STOP_BPS` (100 bps)

### 7.4 Anti-Churn
- Positions held < 2 minutes cannot stop-loss unless loss > 250 bps
- Prevents stop-outs inside entry slippage noise

---

## 8. EXTERNAL SERVICE DEPENDENCIES

| Service | Account | Rate Limit | Used For |
|---------|---------|------------|----------|
| Jupiter Swap API | 1 account, 3 keys | 10 RPS general, 100 RPS execute | Quotes, swaps |
| Jupiter Price API v3 | Same account | Same bucket | All token prices |
| Jupiter Token API v2 | Same account | Same bucket | Token discovery (admission only) |
| Helius RPC | 1 account, 5 keys | 50 RPS RPC, 10 RPS DAS | On-chain reads, tx sending |
| Pyth Hermes | Free | No hard limit | SOL/USD price |
| GeckoTerminal | Free, no key | ~30 req/min | 1-min candles for ATR/RVOL |
| CoinGecko | Free, no key | Very limited | Market cap (admission script only) |
| Railway | Deployment platform | N/A | Hosting worker + API |
| TimescaleDB (Tiger) | Managed | N/A | All persistent state |

---

## 9. KNOWN ISSUES (as of 2026-06-11)

### 9.1 Gecko Feed Broken from Railway
- `fetchJson` in worker returns `null` on ANY non-200 (including 429) — no status code logging
- `acquire()` is empty — no rate limiting beyond 1200ms spacing
- 108 mints × 2 calls = 216 calls per cycle at 30 req/min free tier → rate limiting likely
- Result: most tokens show `no_pool` or `empty candles` in Railway logs
- Result: `GECKO_CANDLES_REQUIRED_FOR_ENTRY` blocks ALL non-SOL entries
- Works locally because local IP has different rate limit / fewer concurrent calls

### 9.2 SOL Blocked by Cost Floor
- SOL ATR ~3 bps in current flat market
- Cost floor ~100 bps (entry + exit + fees)
- Reachable TP = 3 × multiplier = still far below 100 → correctly blocked
- This is the gate working as designed — market is genuinely flat for SOL

### 9.3 Token Universe Metadata Stale
- `synced_at` all June 9 (2 days old) — sync script is manual, not scheduled
- 542 tokens have NULL `synced_at` — never synced
- Not blocking trading, but metadata (liquidity, volume, holders) may be outdated

### 9.4 Logger Mismatch in Gecko Feed
- The injected `log` function checks `entry.event === 'error'`
- But the gecko feed module uses `entry.kind` (e.g., `kind: 'gecko_candle_no_pool'`)
- Result: gecko feed logs are silently dropped — invisible in Railway logs

---

## 10. FILE MAP

| File | Purpose |
|------|---------|
| `services/worker/src/index.ts` | Main worker — ALL trading logic (~10000+ lines) |
| `services/worker/src/strategies.ts` | Strategy math (Bollinger, Supertrend, ATR) |
| `services/worker/src/geckoTerminalCandles.ts` | GeckoTerminal candle feed module |
| `services/api/src/index.ts` | API server — swap execution, admin endpoints |
| `scripts/admit-token-candidates.mjs` | Token admission (manual script) |
| `scripts/sync-token-universe.mjs` | Token metadata sync (manual script) |
| `scripts/coingeckoMarketData.mjs` | CoinGecko market data helper |
| `scripts/bootstrap-token-universe.mjs` | Initial universe bootstrap |
| `scripts/dbcli.mjs` | Database CLI for queries |

---

## 11. ENV VARS THAT MATTER

### Trading
- `WORKER_STOP_LOSS_BPS=100` — 1% stop loss floor
- `WORKER_TAKE_PROFIT_BPS=100` — 1% take profit floor
- `WORKER_TRAILING_STOP_BPS=100` — 1% trailing stop
- `WORKER_EXIT_COST_FLOOR_BPS=50` — minimum exit cost assumption
- `WORKER_ATR_SL_MULT=2.0` — ATR multiplier for stop loss
- `WORKER_ALLOWED_TOKEN_CLASSES=major,sol_beta` — which classes to trade

### Gecko / Candles
- `GECKO_CANDLES_ENABLED=true` — master switch
- `GECKO_CANDLE_REFRESH_MS=300000` — 5 min refresh interval
- `GECKO_CANDLE_RPM=20` — rate limit (but acquire() is empty so not enforced)
- `GECKO_CANDLE_MIN_SAMPLES=30` — minimum candles needed
- `WORKER_GECKO_CANDLES_REQUIRED_FOR_ENTRY` — if true (default), blocks non-SOL entries without fresh candles

### Feature Flags
- `WORKER_ENTRY_QUALITY_GATE_ENABLED` — ATR vs cost quality gate
- `WORKER_MAJOR_COST_FLOOR_GATE_ENABLED` — major token cost floor gate
- `WORKER_TRENDING_ENTRY_SHAPE_GATE_ENABLED` — shape analysis gate
- `WORKER_TOKEN_CLASS_EXIT_PROFILES_ENABLED=true` — per-class exit profiles
- `JUPITER_USE_ULTRA=true` — use Jupiter Ultra for swaps

### Providers
- `HELIUS_GATEKEEPER_ENABLED=true`
- `JUPITER_API_KEY` / `JUPITER_API_KEY_*` — Jupiter Pro keys
- `HELIUS_API_KEY` / `HELIUS_API_KEY_*` — Helius keys
- `PYTH_HERMES_BASE_URL` — Pyth price endpoint
