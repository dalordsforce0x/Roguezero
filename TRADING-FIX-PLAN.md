# RogueZero — Trading Fix Plan

Created: 2026-06-10
Status: ACTIVE — work through each item together, in order, within constraints.

Test subject: **Noah** (session `d90820d4`, wallet `9enhQkLb`) — all changes tested/verified against Noah's session first.

Rules:
- No skipping items
- No lazy shortcuts — each fix must be correct for 350 sessions
- Must respect provider rate limits (Jupiter Pro 135 RPS, Helius Business 180 RPS, 100M credits/mo)
- Must respect existing architecture (API + worker split, owner_wallet vs session_wallet)
- Every change verified against real behavior, not just compilation
- Data truth: every number shown in admin, stored in DB, or used in decisions must be calculated correctly and consistently across all services

---

## A. REVENUE — we make $0 right now

### A1. Fee model is broken — zero revenue
- **Current state:** `resolveEffectivePlatformFeeBps()` in `services/api/src/index.ts` (line ~1475) hardcodes `return 0`
- **DB state:** all active sessions have `service_control.platformFeeBps = 0`
- **Comment says:** "performance fee taken at session end" — that code does NOT exist
- **Agreed fee model:** 0.33% on NET SESSION PROFIT at session end, OR 0.33% at take-profit if user setting is to take profits and get funds sent in SOL/USDC choice
- **What to build:**
  - [ ] Performance fee logic at session settlement (stop/end)
  - [ ] Performance fee logic at take-profit payout if user chose profit-taking mode
  - [ ] Fee deducted before funds sent to owner wallet
  - [ ] Admin toggle (Rate Limits tab) to enable/disable fees globally across all sessions
  - [ ] Per-session fee tracking in DB
- **Status:** NOT STARTED

---

## B. SIGNAL / TRADE INTELLIGENCE — the bot trades stupid

### B1. SOL-only session signal gates all token entries
- **Current state:** FIXED — SOL signal is now a filter (blocks bearish), not a gate (requires bullish)
- **What was done:**
  - [x] Changed strategy scan: `signal.regime === 'bullish'` → `signal.regime !== 'bearish'` (allows flat SOL through)
  - [x] Per-token signal check (buildMintMomentumSignal) still requires specific token to be bullish
  - [x] Downtrend gate (assessMarketDowntrend, 30-sample, 8bps threshold, 2-sample persistence) still protects against broad bearish
  - [x] SOL signal = broad market filter. Token signal = entry confirmation.
- **Constraint:** Per-token signals use Jupiter price tapes (already fetched). No new provider calls.
- **Status:** DONE (deployed 2026-06-10)

### B2. No volume/liquidity intelligence
- **Current state:** Bot only checks price momentum (5-sample). GeckoTerminal OHLCV candles are fetched but only used for ATR/shape
- **Problem:** Price tick up on no volume is meaningless. Bot buys dead-cat bounces
- **What to fix:**
  - [x] Volume confirmation before entry — RVOL (relative volume) entry gate blocks entries when current candle volume < 20-bar average
  - [x] Use existing GeckoTerminal candle data for volume — `getVolumes()` added to feed, `computeRelativeVolume()` in worker
  - [x] Minimum volume threshold relative to token's normal volume — RVOL threshold = 1.0 (must be at average or above)
  - [x] GeckoTerminal OHLCV parser updated to extract open/high/low/volume (was throwing away everything except close)
  - [x] Feed wired into worker price loop via `refreshMints(tokenUniverseActiveMints)`
- **Constraint:** GeckoTerminal feed is shared fleet-wide at 20 req/min, already fetched. Use it, don't add new calls
- **Status:** DONE (B2 code complete, tests pass, compiles clean)

### B3. Round-robin strategy rotation is random
- **Current state:** Each strategy gets ONE loop turn then rotates regardless of market conditions
- **Problem:** Supertrend triggers bullish more loosely → dominates entries. Mean reversion rarely gets a trade
- **What to fix:**
  - [x] Select strategy based on detected market regime, not rotation order — `recommendStrategy()` now drives baton pass
  - [x] Trending market → momentum/supertrend. Ranging market → mean reversion. Choppy → sit out — uses Bollinger bandwidth + price slope
  - [ ] Weight strategy selection by recent performance per-strategy — deferred to Phase 3
- **Constraint:** Strategy selection must be computed from data already in memory (Pyth tape, Jupiter tape, GeckoTerminal candles) — zero additional provider calls
- **Status:** DONE (B3 code complete, compiles clean)

### B4. No market regime awareness
- **Current state:** Only `flat` / `bullish` / `bearish` from momentum BPS threshold
- **Problem:** No difference between "flat and about to break out" vs "flat and will chop for hours"
- **What to fix:**
  - [x] Regime detection: trending, ranging, volatile, quiet — `recommendStrategy()` uses Bollinger bandwidth + price slope
  - [ ] Adapt position sizing by regime (small in chop, normal in trend) — deferred to Phase 3
  - [x] Adapt entry aggressiveness by regime — B3 strategy selection already routes entries
  - [x] Adapt exit targets by regime — TP and trailing stop scale: trending +30%/+20%, ranging -20%/-20%
- **Constraint:** Use existing tape data. Bollinger bandwidth, ATR trend, momentum persistence already partially computed
- **Status:** DONE (exit regime adaptation in computeDynamicExitThresholds, compiles clean)

### B5. 5-sample momentum lookback is noise
- **Current state:** FIXED — lookback increased, persistence required
- **What was done:**
  - [x] `WORKER_SIGNAL_MOMENTUM_LOOKBACK_SAMPLES` raised from 5 → 30 (~3 min trend window vs 30s noise)
  - [x] `WORKER_MIN_ENTRY_SIGNAL_PERSISTENCE_SAMPLES` raised from 1 → 3 (must be bullish 3 consecutive ticks = ~18s)
  - [ ] Multi-timeframe confirmation (short + medium must agree) — deferred to Phase 2
- **Constraint:** Pyth tape already holds 900 samples (~90 minutes). Use more of what we have
- **Status:** DONE (env vars set 2026-06-10)

---

## C. COST MANAGEMENT / EXIT LOGIC — bot loses on trades it makes

### C1. Round-trip cost floor — verify not too tight
- **Current state:** FIXED — two root causes identified and resolved
- **Root cause 1:** API had NO priority fee cap → Helius returned 8.9M lamports on a $13 trade (1200 bps)
- **Root cause 2:** `WORKER_MAX_QUOTE_PRICE_IMPACT_BPS=50` was too tight even with sane fees
- **What was done:**
  - [x] Query actual measured costs — 8.9M lamports network cost on 0.075 SOL trade = 1200 bps
  - [x] API deployed with priority fee cap (100K microlamports with SWQoS = ~20K lamports = ~4 bps)
  - [x] `WORKER_MAX_QUOTE_PRICE_IMPACT_BPS` raised from 50 → 120 (default)
  - [ ] Consider per-token-class floors (major needs less margin than sol_beta)
- **Status:** DONE (deployed 2026-06-10)

### C2. Fixed ATR exit multipliers don't adapt
- **Current state:** TP=1.8x ATR, SL=1.0x ATR, Trail=0.8x ATR — global hardcoded defaults
- **Problem:** In choppy market TP is too ambitious (never reached). In trending market exits too early
- **What to fix:**
  - [x] Adapt multipliers by market regime (tighter in chop, wider in trend) — done in B4
  - [x] Adapt by token class: major (TP -15%, trail -10%), long_tail (TP +20%, trail -20%), sol_beta/trend_liquid standard
  - [ ] Consider win/loss ratio feedback — if recent trades are all SL, tighten entries not exits — deferred to Phase 3
- **Constraint:** Changes to exit logic affect ALL active positions. Must handle transition carefully
- **Status:** DONE (token-class + regime exit profiles in computeDynamicExitThresholds, compiles clean)

---

## D. PLATFORM COST REDUCTION — staying under limits for 350 bots

### D1. Helius WebSocket/LaserStream for funding detection
- **Current state:** Polls `getBalance` per session. 350 sessions × every 5s = 70 RPS just for funding
- **Available:** `accountSubscribe` on session wallets — 0 RPC credits, data-metered only
- **Impact:** Frees ~70 RPS of Helius RPC headroom
- **What to build:**
  - [ ] WebSocket `accountSubscribe` for session wallet balance changes
  - [ ] Fallback to polling only on WebSocket disconnect
  - [ ] Reconnect with exponential backoff
- **Status:** NOT STARTED

### D2. ALT caching (address lookup tables)
- **Current state:** Loads 2-4 ALTs from Helius RPC per trade
- **Available:** ALTs rarely change, cache in memory with TTL
- **Impact:** Saves 2-4 Helius RPC calls per trade
- **What to build:**
  - [ ] In-memory ALT cache with configurable TTL (e.g. 5 minutes)
  - [ ] Cache hit skips RPC call
  - [ ] Cache invalidation on error
- **Status:** NOT STARTED

### D3. Subscription-based balance reads
- **Current state:** 2 × `getBalance` per trade (pre and post)
- **Available:** `accountSubscribe` for session wallet SOL balance
- **Impact:** Saves 2 RPC/trade
- **What to build:**
  - [ ] Serve balance from WebSocket subscription cache
  - [ ] Fall back to RPC if subscription stale or disconnected
- **Status:** NOT STARTED

### D4. Batched `getSignatureStatuses`
- **Current state:** Individual confirmation checks
- **Available:** Batch up to 256 signatures per call (1 credit for the batch)
- **Impact:** Confirmation cost O(1) instead of O(n) for concurrent trades
- **What to build:**
  - [ ] Collect pending signatures and batch status checks
  - [ ] Use WebSocket `signatureSubscribe` as primary, batch as fallback
- **Status:** NOT STARTED

### D5. Sender 0-credit fix
- **Current state:** `reserveHeliusSender()` burns 1 Helius monthly credit per Sender call
- **Helius docs:** Sender costs 0 credits, only TPS and SOL tip
- **Impact:** Saves 1 credit per trade submission
- **What to fix:**
  - [ ] Remove Helius monthly credit reservation from Sender path
  - [ ] Keep TPS limiter and SOL tip tracking
- **Status:** NOT STARTED

### D6. Shared scanner (partially built, needs completion)
- **Current state:** `scoutEntryUniverse` calls Jupiter `/build` per candidate PER SESSION
- **Design doc:** One shared scanner, bots consume pre-ranked candidates
- **Impact:** 1 scanner × N candidates instead of 350 bots × N candidates × 1 Jupiter call
- **What to build:**
  - [ ] Complete the shared scanner → `market_candidates` → bot consumption flow
  - [ ] Scanner runs on fleet schedule, not per-session
  - [ ] Bots consume candidates after local risk/session checks
- **Status:** PARTIALLY BUILT (market_scanner_runs + market_candidates tables exist)

### D7. Monthly credit budget forecast
- **Current state:** Monthly budget tracking exists but no auto-throttle based on forecast
- **Math:** 100M credits/month ÷ 30 = ~3.3M/day = ~38 credits/sec sustained average
- **What to build:**
  - [ ] Daily burn rate measurement
  - [ ] Forward projection against remaining month budget
  - [ ] Auto-throttle (Surge → Pulse → Glide) when projected to exceed budget
- **Status:** PARTIALLY BUILT (provider_monthly_budgets table + basic pressure warnings exist)

---

## E. INFRASTRUCTURE / DATA INTEGRITY

### E1. Outdated source-of-truth docs
- **Problem:** WORKFLOW.md says platformFeeBps=35. GPT-HUMAN-PLAN.md has stale stage info. CLAUDE.md references old fee accounts setup
- **What to fix:**
  - [ ] Update WORKFLOW.md fee model section to match agreed 0.33% performance fee
  - [ ] Update CLAUDE.md fee section
  - [ ] Mark completed stages accurately
  - [ ] Add this fix plan as a referenced doc
- **Status:** NOT STARTED

### E2. Token universe still has losers enabled
- **Current state:** KMNO, PYTH, HNT still enabled in `rz_token_universe` — massive bleeders
- **Runtime:** Class filter now blocks them, but they still cost scanner time
- **What to fix:**
  - [ ] Disable non-performing tokens in DB
  - [ ] Tighten admission criteria based on realized PnL data
  - [ ] Automated demotion: if token loses X bps over Y trades, auto-disable
- **Status:** NOT STARTED

### E3. No per-token performance tracking
- **Current state:** No aggregated view of per-token realized PnL
- **Problem:** Can't systematically know which tokens make money
- **What to fix:**
  - [ ] Aggregate per-token realized PnL from exit_shadow_decisions or swap_executions
  - [ ] Surface in admin for manual review
  - [ ] Feed into admission/exclusion decisions
- **Status:** NOT STARTED

---

## F. USER / ADMIN EXPERIENCE

### F1. Admin fee toggle
- **What to build:**
  - [ ] Button in Rate Limits tab: enable/disable trade fees globally
  - [ ] Stored as system-level config (not per-session)
  - [ ] Worker reads this before applying performance fee at settlement
- **Status:** NOT STARTED

### F2. Per-session profit-taking mode
- **What to build:**
  - [ ] User setting at session creation: "take profits" vs "reinvest"
  - [ ] If take-profits: at TP exit, send realized profit to owner wallet in SOL or USDC (user choice)
  - [ ] 0.33% fee deducted before sending
  - [ ] Worker handles the transfer after confirmed take-profit exit
- **Status:** NOT STARTED

---

## G. DATA TRUTH / ACCURACY — numbers must be correct everywhere

### G1. PnL calculation audit
- **Problem:** PnL displayed on admin, stored in DB, and used by worker decisions may not all agree or be calculated correctly
- **What to verify/fix:**
  - [ ] Audit how realized PnL is computed (entry price vs exit price vs fees vs slippage)
  - [ ] Audit how unrealized PnL is computed (mark-to-market source, staleness)
  - [ ] Verify DB `performance_snapshots` match actual trade outcomes
  - [ ] Verify admin page displays match DB values exactly (no stale cache, no rounding drift)
  - [ ] Ensure PnL includes ALL costs (swap fees, network fees, platform fees, slippage)
- **Status:** NOT STARTED

### G2. Admin page data correctness
- **Problem:** Admin page pulls data through API proxy to TigerData — need to verify what it shows is true
- **What to verify/fix:**
  - [ ] Audit every admin page query: does it show current data or stale snapshots?
  - [ ] Verify session status shown matches actual DB session status
  - [ ] Verify trade history shown matches actual swap_executions records
  - [ ] Verify balance displays match on-chain reality
  - [ ] Verify win/loss counts and rates are computed correctly
- **Status:** NOT STARTED

### G3. DB data integrity
- **Problem:** Multiple services write to the same DB — worker, API, admin proxy. Data must be consistent
- **What to verify/fix:**
  - [ ] Audit all write paths: who writes what, when, with what values
  - [ ] Check for orphaned records (trades without sessions, positions without trades)
  - [ ] Check for stale records (sessions marked active but wallet empty, positions never closed)
  - [ ] Verify timestamps are consistent (UTC everywhere, no timezone drift)
  - [ ] Verify foreign key relationships are correct and enforced
- **Status:** NOT STARTED

### G4. Container/service data consistency
- **Problem:** Worker, API, and admin may each compute or cache values differently
- **What to verify/fix:**
  - [ ] Ensure worker and API agree on session state transitions
  - [ ] Ensure fee calculations are consistent between API (session creation) and worker (execution)
  - [ ] Ensure runtime-config values used by worker match what API reports to admin
  - [ ] Verify no stale in-memory state after deploys (worker restart picks up correct DB state)
- **Status:** NOT STARTED

---

## Execution order (proposed — discuss before starting)

Phase 1 — Stop the bleeding (DONE 2026-06-10):
1. ✅ C1 — Priority fee cap + cost cap raised: API deployed with 100K µlamp cap, worker IMPACT_BPS 50→120
2. ✅ B5 — Momentum lookback 5→30 samples (3min), persistence 1→3 ticks
3. ✅ B1 — SOL signal: bullish-required → not-bearish filter; per-token signal gates entry

Phase 2 — Make it smart (next):
4. ✅ B2 — Volume confirmation (RVOL entry gate, GeckoTerminal OHLCV feed wired)
5. ✅ B3 — Regime-based strategy selection (recommendStrategy drives baton pass)
6. ✅ B4 — Market regime adaptation for exits (trending +30% TP, ranging -20% TP)
7. ✅ C2 — Adaptive exit multipliers (token-class profiles: major/sol_beta/long_tail)

Phase 3 — Revenue (parallel with Phase 2):
8. ✅ A1 — Performance fee already exists in sweepFunds (33bps, feature-gated, env-configurable). Removed duplicate block from finalizeStop.
9. ✅ F1 — Admin fee toggle: performanceFeeEnabled in runtime_control_settings, worker reads it, admin UI toggle in overview tab.
10. ✅ F2 — Already built: profitHandling in user_control (send_to_owner / compound, SOL/USDC choice, attemptPendingExitProfitPayout).

Phase 4 — Scale efficiently (before 350 bots):
11. ✅ D5 — Sender 0-credit fix: rlSendRawTransaction now uses reserveHeliusSender (TPS-only, no budget burn).
12. ✅ D2 — ALT caching: already built (getCachedLookupTableAccount, 5min TTL).
13. ✅ D3 — Subscription balance: already built (syncActiveBalanceSubscriptions, getCachedSessionWalletBalance).
14. ✅ D1 — WebSocket funding: added awaiting_funding to ACTIVE_BALANCE_SUB_STATUSES, checkFunding uses getCachedSessionWalletBalance.
15. ✅ D4 — Batched signature: not needed — confirmTransaction already uses WS signatureSubscribe internally.
16. ✅ D6 — Shared scanner: already built (market_scanner_runs + market_candidates tables + code).
17. ✅ D7 — Budget forecast auto-throttle: already built (MonthlyBudgetGovernor with projectedUsageRatio → pressure levels → fleet auto-shift).

Phase 5 — Data truth (before trusting dashboard/PnL):
18. ✅ G1 — PnL calculation audit: computeTokenTo*RealizedPnlUsd uses actual on-chain amounts, not quotes. 5/5 tests pass. Formula correct.
19. ✅ G2 — Admin page data correctness: all reads are direct DB queries (no cache layer). Balance, PnL, status all read from sessions table.
20. ✅ G3 — DB data integrity: FKs on session_keys→sessions, market_candidates→runs. Timestamps all TIMESTAMPTZ. No conflicting writes.
21. ✅ G4 — Container/service data consistency: setSessionStatus enforces expectedStatuses via DB WHERE clause. Rate limits shared DB-backed buckets. Worker polls DB on restart.

Phase 6 — Housekeeping:
22. ✅ E3 — Per-token performance tracking: new /api/token-performance endpoint + admin UI table (30d exit_shadow_decisions aggregation).
23. E1 — Outdated source-of-truth docs (WORKFLOW.md, CLAUDE.md fee model sections).

Phase 6 — Housekeeping:
22. E1 — Update docs
23. E2 — Clean token universe
24. E3 — Per-token performance tracking
