# RogueZero — GPT + Human Working Plan

This file is the living plan between the user and GPT/Copilot.
It is not generic project documentation.
It is the active source of truth for:

- what has been agreed
- what is not agreed
- what step is actually next
- what proof is required before claiming progress
- what is blocked

If this file conflicts with vague assumptions, this file wins until the user changes it.

## Purpose

Use this file to keep the work accountable and grounded.

This file exists so the agent does **not**:

- drift away from the agreed plan
- rewrite architecture that was already decided
- skip steps in the original build order
- claim things are done without proof
- confuse planning decisions with implementation status

## Hard working rules

1. Do not mark a step complete without proof.
2. Do not skip ahead because something seems "obvious".
3. Do not rewrite agreed architecture unless the user explicitly changes it.
4. Do not confuse `owner_wallet` with `session_wallet`.
5. Do not confuse admin user creation with user session creation.
6. Do not treat compile/test green as proof of real mainnet behavior.
7. Every next step must connect to the agreed stage/order below.

## Original build order agreed during planning

1. Set up workspace
2. Research required accounts/services
3. Define package stack
4. Scaffold project services
5. Design session schema
6. Set up auth flow
7. Set up bot runtime
8. Wire execution layer
9. Add dashboards
10. Add admin controls

## Architecture decisions already agreed

- `owner_wallet` = user identity/login wallet
- `session_wallet` = ephemeral execution wallet
- users create sessions from the web app
- API creates the `session_wallet` keypair and stores it
- worker trades from `session_wallet`
- Jupiter path = Router
- fee capture = `platformFeeBps` + fee token accounts
- taker / fee payer must be a real funded System Program wallet
- admin manages users/licenses, not trading sessions

## Locked boundary cut

This is the intended responsibility boundary for RogueZero.

## Locked service shape

Best fit for RogueZero:

1. User app
	- separate frontend for wallet auth, start/pause/stop, live activity, live performance, historical dashboard
2. Admin app
	- separate admin surface for license assignment, session monitoring, maintenance stops, ops visibility
3. Main API service
	- auth/session APIs, KeyAuth validation, dashboard APIs, admin APIs, session state reads/writes
4. Bot worker/runtime service
	- separate worker service for 3-strategy rotating automation, session trade loop, runtime decisions, risk checks before execution
	- must not be tied to the user HTTP request cycle
5. Execution layer
	- can live inside worker/backend first, but is logically separate
	- owns Jupiter integration, Helius submission, confirmation handling, execution result reporting
6. Persistent state store
	- session persistence, live state, historical results, dashboard reads, recovery after restart
7. Shared provider control layer
	- rate-limit enforcement, monthly budget tracking, request priority lanes, graceful degradation

## Locked deployment base

RogueZero should deploy as:

- user frontend
- admin frontend
- main API
- bot worker
- persistent database/state
- shared provider budget/rate-limit layer

Not as:

- one giant monolith doing everything in one loop
- 150 separate deployments
- user session logic tied to open browser tabs

Why this deployment base is locked:

- RogueZero needs persistent sessions
- async automation
- real-time dashboards
- admin controls
- provider budget control
- stop/recovery flows

So the correct shape is:

- small multi-service architecture
- not monolith spaghetti
- not enterprise service explosion

## Locked deployment model

### Production shape

RogueZero should run as:

- user frontend
- admin frontend
- API/control backend
- bot worker runtime
- persistent database/state store
- shared provider control/rate-limit layer

### What runs where

#### User frontend

Hosts:

- wallet auth
- session controls
- live session screen
- live performance dashboard
- historical dashboard

#### Admin frontend

Hosts:

- license/admin controls
- session monitoring
- maintenance stop actions
- ops views

#### API/control backend

Owns:

- auth/session endpoints
- KeyAuth validation
- user/admin APIs
- dashboard read APIs
- session state coordination

#### Bot worker runtime

Owns:

- 3-strategy rotation
- active bot session loops
- risk checks before execution
- handing trades to execution layer
- stop/pause awareness

#### Persistent state store

Owns:

- session persistence
- live session state
- historical performance
- activity/event records
- recovery state after restart

#### Shared provider control layer

Owns:

- Jupiter usage throttling
- Helius usage throttling
- monthly budget tracking
- priority lanes
- graceful degradation rules

### Runtime rule

User traffic and bot traffic must be separated.

Do not run the trading loop inside the same request/response lifecycle as the user API.

Reason:

- user app traffic should not stall the bot
- bot traffic should not crush the UI
- restart behavior is cleaner
- scaling is cleaner

### Scaling rule for ~150 bots

RogueZero does not need:

- full enterprise microservice madness
- one deployment per bot

Best fit:

- one backend/control service
- one worker/runtime service
- scale worker count only if needed later

That is enough for this size if built cleanly.

### Restart / persistence rule

Sessions must survive:

- frontend disconnects
- backend restarts
- worker restarts
- deployment cycles

So session state cannot live only in memory.

## Locked security model

### 1. Identity security

User identity is:

- main wallet
- app identity fields: `username`, `bot_name`
- KeyAuth license entitlement

So access requires:

- wallet auth
- valid license
- wallet / license / user linkage

### 2. Session security

A session must have:

- authenticated main wallet
- valid license/access
- bound original return wallet
- persistent session state
- explicit session status: `active`, `paused`, `stopped`

A session cannot be started if:

- license invalid
- wallet/auth invalid
- funding step fails
- session state creation fails

### 3. Fund security

Core rule:

- user knowingly funds an ephemeral trading wallet/context
- backend does not hold arbitrary custody over the user’s main wallet
- funds must return to the original custody wallet on stop, session end, fault flow, and maintenance/admin stop

Security rule:

- return destination is bound to the original wallet
- no silent destination swapping

### 4. Backend security

Backend is allowed to:

- analyze
- rotate strategies
- request trades
- execute through Jupiter + Helius
- manage runtime

Backend is not allowed to:

- own the user’s main wallet
- change original destination wallet arbitrarily
- exceed session authority/rules
- become a hidden custody layer

### 5. Admin security

Admin can:

- assign licenses
- manage access
- monitor sessions
- stop sessions for maintenance/ops

Admin cannot:

- arbitrarily reroute funds
- impersonate user trading authority
- silently seize session funds

Admin stop = operational control, not fund ownership.

### 6. License/access security

KeyAuth should gate:

- who can use RogueZero
- which wallet/user is entitled
- whether bot access is valid
- whether session start is allowed

RogueZero access is not just “wallet connected.” It is:

- wallet authenticated
- wallet linked to valid license/admin-assigned access

### 7. Execution security

Every automated trade should pass:

- session active check
- license still valid check
- strategy/runtime permission check
- risk/limit check
- allowed execution path check

### 8. UI security

User app:

- only shows/manages that user’s session data
- cannot issue admin actions
- cannot view other user sessions

Admin app:

- separate access control
- stronger auth boundary
- audit every maintenance stop/admin action

### 9. Persistence security

Persistent state should store:

- session state
- activity
- performance
- historical records
- entitlement linkage

Sensitive values should be minimized.
Do not casually persist secrets you don’t need.
If a secret must exist, it gets explicit handling.

### 10. Fault security

If something fails:

- stop trading
- preserve session state
- preserve audit trail
- run safe return/unwind path
- return funds home where possible
- require explicit recovery/admin flow if automatic return fails

The system should fail toward:

- halt
- preserve
- return

Not:

- continue blindly
- lose state
- orphan funds

## Locked security posture

RogueZero should be:

- wallet-authenticated
- license-gated
- session-authorized
- backend-automated
- main-wallet non-custodial
- return-path constrained
- admin operationally privileged, not financially privileged

## Locked on-chain scope

Only what must exist on-chain to preserve non-custodial control should live on-chain.

What should exist on-chain:

- session config account
- program-controlled vault / PDA
- allowed executor registration
- spend / risk bounds
- withdraw destination binding
- pause / stop / expiry state
- maybe strategy mode enum / permissions

What should not be pushed on-chain by default:

- full strategy logic

Strategy logic stays off-chain unless absolutely necessary.

## Locked risk controls

Security says who is allowed. Risk controls say what the bot is allowed to do even when authorized.

RogueZero risk controls are split into two layers.

### Layer 1: trading risk controls

1. Session capital cap
	- hard cap on funded session capital
2. Per-trade cap
	- hard cap on each trade size
3. Max concurrent positions
	- bound how many open positions a session can hold
4. Allowed token universe
	- only trade assets/pairs that pass project rules
5. Liquidity guard
	- skip trades below minimum liquidity quality
6. Slippage guard
	- do not execute if expected slippage exceeds threshold
7. Cooldown / anti-overtrading
	- prevent churn and repeated rapid-fire entries
8. Strategy-level limits
	- each of the 3 rotating strategies can have its own size ceiling, concurrency ceiling, and cooldown profile
9. Pause behavior
	- no new entries, preserve state
10. Stop behavior
	- no new entries, unwind/return flow begins
11. Profit withdrawal behavior
	- user can withdraw realized profits through the allowed session path
12. Failure behavior
	- stop new trading, preserve state, run safe return/unwind logic

### Layer 2: infrastructure / rate-limit risk controls

1. Monthly provider budgets
	- hard monthly budget tracking for Helius, Jupiter, and any later paid provider
2. Per-second / per-minute throttles
	- throttle reads, execution, confirmations, dashboards, and background jobs
3. Session usage ceilings
	- cap analysis frequency, refresh cadence, retry attempts, and execution attempts per session
4. Priority lanes
	- preserve in this order:
	  - trade execution
	  - confirmations / active position safety
	  - stop / return / safety flows
	  - live session UI
	  - historical/dashboard analytics
5. Graceful degradation
	- slow low-priority refreshes, reduce scan cadence, keep core trading/safety alive first
6. Shared market-data model
	- do not let 150 bots duplicate the same expensive calls; use shared reads where possible
7. Retry discipline
	- retries must be bounded; no infinite retry storms

## Locked risk split

### Hard limits

Enforced at the session authority/program boundary:

- session capital cap
- per-trade cap
- status `active` / `paused` / `stopped`
- return wallet binding

### Runtime limits

Enforced by automation/backend:

- strategy cooldown
- trade frequency
- strategy rotation behavior
- liquidity checks
- slippage checks
- token eligibility

## Most important risk controls

Non-negotiables first:

- session capital cap
- per-trade cap
- allowed token universe
- slippage guard
- cooldown / anti-overtrading
- max concurrent positions
- pause / stop / return flow
- API rate limits based on accounts/providers and documented platform limits

## Final risk frame

Layer 1 controls market exposure and trade behavior.
Layer 2 controls provider usage, rate limits, and budget survival.

Both are real risk controls.

## Locked observability model

RogueZero needs to observe money flow, not just server uptime.

### 1. Session observability

For every active session, track:

- status: `active` / `paused` / `stopped`
- user wallet
- bot name
- license status
- funded amount
- current ephemeral wallet balance
- open positions
- last trade time
- last successful strategy cycle
- stop/pause reason

### 2. Trading observability

For every trade attempt, track:

- strategy that triggered it
- token/pair
- trade size
- expected route
- Jupiter response/result
- slippage estimate
- submitted tx signature
- confirmation result
- actual fill outcome
- realized PnL when closed

This is the core “did the bot actually trade correctly” layer.

### 3. Risk observability

Track whether sessions are bumping against controls:

- capital cap hits
- per-trade cap hits
- cooldown skips
- slippage rejects
- liquidity rejects
- token-universe rejects
- max-position rejects
- pause/stop triggers
- failure-triggered halts

This tells us whether the bot is blocked for good reasons or broken reasons.

### 4. Provider observability

Track provider health and usage for:

- Helius
- Jupiter
- KeyAuth
- any later paid data source

Need:

- call volume
- error rate
- latency
- timeout rate
- monthly budget burn
- rate-limit hits

### 5. Runtime observability

Track the automation engine itself:

- strategy rotation heartbeat
- cycle duration
- queue depth if any
- execution backlog
- failed cycles
- restart/crash events
- sessions currently running
- sessions stalled

### 6. Settlement / return-flow observability

Track stop/end flows:

- stop requested by user/admin/system
- unwind started
- unwind finished
- funds returned to original wallet
- tx signature for return path
- any residual stuck balance
- any failed recovery path

Session end is a trust-critical path.

### 7. Dashboard observability

Track freshness for:

- live session activity screen
- live performance dashboard
- historical dashboard

Need:

- last activity update time
- last performance aggregation time
- last historical sync time
- stale-data detection

Otherwise the UI can look alive while being wrong.

### 8. Admin observability

Admin needs to see:

- all active sessions
- paused/stopped/error sessions
- sessions needing manual attention
- provider pressure
- budget pressure
- maintenance stop actions
- audit trail of admin actions

Admin view should be ops truth, not marketing glitter.

## Locked alert minimums

At minimum, RogueZero should alert on:

- trade execution failure spike
- confirmation failure spike
- Jupiter error spike
- Helius latency/rate-limit spike
- session stalled
- return-flow failure
- stuck funds/residual balance after stop
- bot runtime crash/restart loop
- monthly usage burn too fast
- KeyAuth/license validation failures spike

## Three observability questions RogueZero must always answer

1. Is the bot trading correctly?
2. Is the money safe and returning correctly?
3. Are provider limits/infra degrading the product?

If observability cannot answer those, it is not enough.

## Working observability split

RogueZero observability is split into:

- session observability
- trade/execution observability
- risk observability
- provider observability
- runtime observability
- settlement observability
- dashboard freshness observability
- admin/audit observability

## Locked core data map

This is the correct first-pass RogueZero data model.

### 1. User

Represents the human account.

Fields:

- `user_id`
- `username`
- `status`
- `created_at`
- `updated_at`

### 2. Main wallet

Represents the user’s custody wallet.

Fields:

- `wallet_address`
- `user_id`
- `is_primary`
- `verified_at`

Relationship:

- one user -> one primary main wallet
- main wallet is the return destination anchor

### 3. License / entitlement

Represents KeyAuth-controlled access.

Fields:

- `license_id`
- `keyauth_key`
- `assigned_user_id`
- `assigned_wallet`
- `bot_name`
- `status`
- `issued_by_admin`
- `issued_at`
- `expires_at`

Relationship:

- one user/wallet has one active entitlement for RogueZero access

### 4. Bot identity

Represents the named RogueZero bot attached to that user/license.

Fields:

- `bot_id`
- `user_id`
- `license_id`
- `bot_name`
- `bot_type`
- `status`

Relationship:

- user <-> bot identity
- license <-> bot identity

### 5. Trading session

This is the main runtime object.

Fields:

- `session_id`
- `user_id`
- `wallet_address`
- `license_id`
- `bot_id`
- `status` (`active` / `paused` / `stopped`)
- `started_at`
- `ended_at`
- `pause_reason`
- `stop_reason`

Relationship:

- one bot can have many sessions over time
- one session belongs to one user/wallet/license/bot

### 6. Ephemeral wallet

Represents the on-chain trading wallet/context for the session.

Fields:

- `ephemeral_wallet_id`
- `session_id`
- `wallet_address`
- `funded_amount`
- `current_balance`
- `return_wallet_address`
- `created_at`
- `settled_at`

Relationship:

- one session -> one ephemeral wallet context
- return wallet must map to original main wallet

### 7. Session runtime state

Represents the live state of the bot while active.

Fields:

- `session_id`
- `active_strategy_index`
- `last_cycle_at`
- `current_positions_count`
- `current_exposure`
- `last_trade_at`
- `runtime_health`
- `provider_pressure_state`

This is live state, not just historical record.

### 8. Trade record

Represents each execution attempt/result.

Fields:

- `trade_id`
- `session_id`
- `strategy_id` / `strategy_slot`
- `token_in`
- `token_out`
- `side`
- `size`
- `expected_route`
- `slippage_estimate`
- `tx_signature`
- `status`
- `created_at`
- `confirmed_at`

### 9. Position record

Represents open/closed positions.

Fields:

- `position_id`
- `session_id`
- `token`
- `entry_trade_id`
- `exit_trade_id`
- `quantity`
- `avg_entry`
- `avg_exit`
- `realized_pnl`
- `unrealized_pnl`
- `status`

### 10. Activity/event log

Feeds the live session activity screen.

Fields:

- `event_id`
- `session_id`
- `event_type`
- `message`
- `source`
- `created_at`

Examples:

- `session_started`
- `strategy_rotated`
- `trade_submitted`
- `trade_confirmed`
- `paused`
- `stopped`
- `return_started`
- `funds_returned`

### 11. Performance snapshot

Feeds live and historical dashboards.

Fields:

- `snapshot_id`
- `session_id`
- `timestamp`
- `realized_pnl`
- `unrealized_pnl`
- `total_volume`
- `win_rate`
- `active_positions`
- `fees_generated`
- `session_balance`

### 12. Provider usage record

Tracks infrastructure/rate-limit risk.

Fields:

- `usage_id`
- `provider`
- `session_id` nullable
- `request_type`
- `request_count`
- `error_count`
- `latency`
- `budget_window`
- `created_at`

### 13. Admin action record

Tracks operational actions.

Fields:

- `admin_action_id`
- `admin_user_id`
- `target_session_id`
- `action_type`
- `reason`
- `created_at`

Examples:

- `license_assigned`
- `session_stopped_for_maintenance`
- `access_revoked`

## Locked relationship map

### Main chain

User:

- has main wallet
- has license
- has bot identity
- has many sessions

### Session chain

Session:

- has one ephemeral wallet
- has one runtime state
- has many trades
- has many positions
- has many activity events
- has many performance snapshots

### Admin/infra chain

- license assigned by admin
- provider usage tied to project and optionally session
- admin actions tied to sessions/licenses/users

## Locked source-of-truth rules

### Main wallet

Source of truth for:

- identity anchor
- return destination

### License

Source of truth for:

- entitlement/access

### Session

Source of truth for:

- active runtime lifecycle

### Ephemeral wallet

Source of truth for:

- session trading capital context

### Trades / positions / performance

Source of truth for:

- live activity
- live dashboard
- historical dashboard

### Frontend

Responsible for:

- wallet connect
- wallet sign-in
- session creation approval
- funding approval
- user controls: start / pause / stop / withdraw
- strategy config within allowed bounds

Not responsible for:

- trade logic
- continuous market scanning
- signing every trade
- holding bot runtime state

### Backend

Responsible for:

- strategy execution logic
- market data ingestion
- signal generation
- tx construction
- Jupiter quote/build requests
- Helius RPC submission / reads / monitoring
- session orchestration
- telemetry / logs / alerts

Not allowed to:

- hold spendable trading private key
- arbitrarily withdraw user funds
- mutate on-chain session rules without authorized path

### On-chain program layer

Responsible for:

- session/vault state
- execution permissions
- per-session rules
- allowed actions
- withdrawal destination restrictions
- pause/stop/revoke logic
- expiry / TTL enforcement

## Current implementation conflict to remember

The current repo does **not** fully match the locked boundary cut above.

Right now, the worker/API flow stores the session private key in `session_keys` and uses it for signing.
That means the current implementation still gives backend/runtime custody over the spendable session key.

So this must be treated as:

- the current implementation truth for debugging the existing code, and
- a target architecture conflict if/when enforcing the stricter boundary cut above.

The same rule applies to the service/deployment shape:

- treat the locked service/deployment base as the target architecture
- treat the current repo structure as the current implementation state
- do not silently claim they are identical if they are not

Do not silently blur those two states together.

## Stage map

### Completed foundations

- Workspace exists
- Required external accounts were researched enough to start implementation
- Package stack and services were scaffolded
- Session schema exists
- Auth flow exists at a usable level
- Bot runtime exists at a usable level
- Execution layer is partially wired
- Admin and dashboard surfaces exist at a usable level

### Current real focus

Stage 3 profitability path, after Stage 1 and Stage 2 proof completion:

> Replace fixed tiny swap sizing with risk-aware session sizing, then add a real trade gate so the bot only trades when expected edge beats cost.

## What has been proven already

- Jupiter Router path is the chosen path
- `/swap/v2/build` is wired and returns instructions
- `/jupiter/swap/prepare` simulation path exists
- `/jupiter/swap/submit` exists
- worker signs prepared transactions using the stored session keypair
- referral/program-owned account as taker fails as fee payer
- unfunded brand-new wallet fails simulation pre-execution
- real funded `session_wallet` flow succeeds end-to-end: prepare -> sign -> submit -> reconcile -> confirmed on-chain
- fee capture is verified landing in the configured fee account
- worker stop flow now keeps sessions in `stopping` until wallet state is actually drained, and live proof ended with DB `stopped` + chain balance `0` for all 10 proof sessions
- shared provider governance is live across worker + API, and a 10-session / 60s proof completed without visible 429s while all sessions made progress
- admin now has a dedicated session health view for aggregate stalled/stopping/error session visibility without exposing raw wallet data on the page
- the admin session-health route/UI now builds cleanly, runs on the real admin app, and lints without errors

## What is still not proven

- risk-aware per-session sizing instead of the hardcoded `0.001 SOL` trade amount
- a real strategy/signal gate that proves trades are only attempted when expected edge exceeds cost
- session-level realized profitability under live conditions
- per-trade / per-session PnL and fee reporting that proves the bot is actually making money, not just trading correctly

## Current blocker / active question

There is no Stage 1 / Stage 2 proof blocker anymore.
The admin observability layer needed to support those proofs is now stable enough to stop blocking profitability work.

The active question is how to move from “the bot runs safely” to “the bot makes money” without regressing safety:

- Stage 3 must replace the fixed trade size with balance/risk-aware sizing
- Stage 4 must stop the worker from trading every cooldown cycle without an edge
- PnL/fee reporting must become trustworthy enough to prove profitability after those changes

## Rules for updating this file

When progress is made, update only these sections:

- `Current real focus`
- `What has been proven already`
- `What is still not proven`
- `Current blocker / active question`

Do not rewrite the whole file casually.

## Next-step format

Every next proposed move should be written in this format:

- Step:
- Why this is the next correct step:
- What proof will make it complete:
- What does **not** become complete yet:

## Current implementation status (2026-05-30)

All SDLC stages through Stage 5 are complete. Stage 6 and 7 are mostly complete.

## Current implementation status (2026-06-04 live reset)

The previous deploy-ready claim was too broad. Live debugging showed the actual product path was not complete:

- The worker was effectively momentum-only for new sessions because API session creation disabled `mean_reversion` and `supertrend` by default.
- Multi-position storage/UI existed, and the worker was portfolio-aware, but user-created sessions still requested `maxOpenPositions: 1`, so live behavior was single-position by default.
- The token universe scripts existed, but live `rz_token_universe` still had enabled pump/junk targets including APPLE/USELESS-style rows, so the worker could chase low-quality entries.
- The latest live session was stopped after a route/setup SOL shortfall, so it is not valid proof of profitable token trading.

Changes applied in this reset:

- New sessions now enable all 3 strategies by default: `momentum`, `mean_reversion`, and `supertrend`.
- Strategy rotation is sequential scanner rotation, not regime-recommender replacement: scan the current strategy first, if it is flat/bearish/not ready then scan the next enabled strategy, and after an entry trade submits advance the scanner to the next strategy while existing positions continue to be monitored by the strategy that opened them.
- New sessions now default to `maxOpenPositions: 10` as the session/bot safety ceiling, so GLIDE/PULSE/SURGE can clamp behavior correctly: GLIDE = 3, PULSE = 10, SURGE = bot/session-decided.
- Worker entry selection now excludes stablecoin targets, pump mints by default, and hard-blocked symbols such as APPLE/USELESS.
- Worker candidate ordering now prefers trusted Solana ecosystem assets before admitted long-tail tokens.
- Token admission/sync scripts now reject pump mints by default with `TOKEN_ADMISSION_BLOCK_PUMP_MINTS` unless explicitly overridden.
- Live DB universe was repaired: enabled pump count is `0`, enabled APPLE/USELESS count is `0`, trusted ecosystem tokens are enabled at top priority.

Current proof status:

- Build proof passed for `@roguezero/session-schema`, `@roguezero/api`, `@roguezero/worker`, and `web` after the changes.
- No active/ready sessions currently exist; all sessions are stopped. A fresh funded session is required for live proof.

Next proof before any deploy claim:

- Create/fund a fresh session through the frontend.
- Confirm the start modal appears and records explicit profit handling.
- Confirm the session starts with all 3 strategies enabled and session `maxOpenPositions: 10`, then verify the active runtime profile applies GLIDE/PULSE/SURGE caps correctly.
- Confirm strategy scanner behavior: current strategy scans first; flat/bearish/no-entry moves to the next strategy; a submitted entry records `entryStrategy` on the position and advances `rotationState.activeStrategy` to the next strategy.
- Confirm worker scout candidates exclude APPLE/USELESS/pump mints and prefer trusted Solana ecosystem tokens.
- Confirm at least one real USDC→trusted-token entry, then a token→USDC exit, with positions tracked in `positionsState`.
- Confirm profile-aware multi-position behavior: GLIDE caps at 3, PULSE caps at 10, and SURGE uses the session/bot ceiling; do not claim multi-position complete from UI/schema alone.

### What has been built and proven
- Stage 1: Foundation — real mainnet swaps confirmed, fee capture working
- Stage 2: Rate governance — DB-backed shared token buckets, 10 concurrent sessions proven
- Stage 3: Adaptive sizing — balance/risk-aware sizing, proven with different balances
- Stage 4: Strategy signal — momentum + Bollinger mean reversion + Supertrend, auto-rotation, take-profit exit confirmed on mainnet
- Stage 5: PnL reconciliation — write-back working, 38 completed round trips, $25.84 confirmed PnL, fee calculation fixed
- Stage 6: Production hardening — stale auto-stop, duration auto-stop, worker dedup, API rate limiting, keypair encryption (AES-256-GCM)
- Stage 7: Features — 3-strategy rotation, live session state in web UI, withdrawal = stop flow, admin password updated
- DB: migrated all 209 sessions from `breakout` → `supertrend`

### What remains before production deploy
- Deployment to Railway or equivalent
- Load test at target concurrency

## Current next step

- Step: Deploy to Railway (or equivalent platform) for production testing
- Why this is the next correct step: runtime automation now owns session defaults, full deployable session-wallet inventory is used on flat re-entry, warm-up tape survives worker restarts, blockhash-expired submits can rebuild without waiting out cooldown, and admin force-stop is available in the UI. The remaining gap is production deployment + scale proof.
- What proof will make it complete: all 4 services running on Railway, accessible via public URLs, test session funded and trading successfully from the deployed instance, followed by a concurrency load test.
- What does **not** become complete yet: nothing functional inside the local codebase — only deployment verification and load proof remain.
