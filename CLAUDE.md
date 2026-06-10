# RogueZero — Claude Handoff

This file is the project handoff for any agent working on RogueZero.
It is synthesized from the current codebase and the architecture decisions already made in this session.
If generic framework assumptions conflict with this file, this file wins.

## What RogueZero is

RogueZero is a Solana trading system with:

- `apps/admin` — admin UI for licensed user management
- `apps/web` — end-user UI where licensed users connect wallet, create sessions, fund session wallets, and control sessions
- `services/api` — Fastify backend for user validation, session creation/control, and Jupiter swap build/prepare/submit
- `services/worker` — autonomous execution worker that monitors sessions and executes swaps
- `packages/runtime-config` — validated live integration config
- `packages/session-schema` — shared session and execution schemas

The immediate Stage 1 goal is not broad strategy work. It is very specific:

> Get one real swap executing end-to-end from worker -> API -> Jupiter -> Helius -> confirmed on-chain, with fee capture working.

## Core architecture decisions already made

## Locked boundary cut for RogueZero

This is the intended system boundary and Claude must preserve it when proposing future architecture.

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

Important implementation note:

- the current repo still stores session private keys in `session_keys` and signs from the worker
- that is a current implementation truth, not proof that it matches the stricter target boundary above
- Claude must not confuse current code behavior with the intended long-term custody boundary

## Locked service and deployment shape

Claude should treat this as the intended system shape for RogueZero:

### Service shape

1. User app
   - separate frontend for wallet auth, session controls, live activity, live performance, historical dashboard
2. Admin app
   - separate admin surface for license assignment, session monitoring, maintenance stops, ops visibility
3. Main API service
   - auth/session APIs, KeyAuth validation, dashboard APIs, admin APIs, session state reads/writes
4. Bot worker/runtime service
   - separate worker service for automation, session trade loop, runtime decisions, risk checks
   - not tied to the user HTTP request cycle
5. Execution layer
   - may live inside worker/backend first, but is logically separate
   - owns Jupiter integration, Helius submission, confirmation handling, execution result reporting
6. Persistent state store
   - session persistence, live state, historical results, dashboard reads, restart recovery
7. Shared provider control layer
   - rate-limit enforcement, monthly budget tracking, request priority lanes, graceful degradation

### Deployment base

RogueZero should deploy as:

- user frontend
- admin frontend
- API/control backend
- bot/runtime worker
- shared persistent state
- shared provider budget/rate-limit management

Do not reframe RogueZero as:

- one giant monolith doing everything in one loop
- 150 separate deployments
- user session logic tied to open browser tabs

Important implementation note:

- current code may combine some of these concerns more tightly than the target deployment base
- Claude must preserve the target shape in planning, while still reading the current code honestly

## Locked deployment model

Claude should treat this as the locked production model for RogueZero:

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

Hosts wallet auth, session controls, live session screen, live performance dashboard, and historical dashboard.

#### Admin frontend

Hosts license/admin controls, session monitoring, maintenance stop actions, and ops views.

#### API/control backend

Owns auth/session endpoints, KeyAuth validation, user/admin APIs, dashboard read APIs, and session state coordination.

#### Bot worker runtime

Owns 3-strategy rotation, active bot session loops, risk checks before execution, handing trades to the execution layer, and stop/pause awareness.

#### Persistent state store

Owns session persistence, live session state, historical performance, activity/event records, and recovery state after restart.

#### Shared provider control layer

Owns Jupiter throttling, Helius throttling, monthly budget tracking, priority lanes, and graceful degradation rules.

### Runtime rule

User traffic and bot traffic must be separated.

Do not run the trading loop inside the same request/response lifecycle as the user API.

### Scaling rule for ~150 bots

Do not reframe RogueZero as:

- enterprise microservice sprawl
- one deployment per bot

Best fit is:

- one backend/control service
- one worker/runtime service
- scale worker count later only if needed

### Restart / persistence rule

Sessions must survive frontend disconnects, backend restarts, worker restarts, and deployment cycles.

Session state cannot live only in memory.

## Locked security model

Claude should treat this as the intended security model for RogueZero.

### Identity security

User identity is:

- main wallet
- app identity fields such as `username` and `bot_name`
- KeyAuth license entitlement

So access requires wallet auth, a valid license, and wallet/license/user linkage.

### Session security

A session must have:

- authenticated main wallet
- valid license/access
- bound original return wallet
- persistent session state
- explicit session status (`active`, `paused`, `stopped`)

A session cannot start if license is invalid, wallet auth is invalid, funding fails, or session state creation fails.

### Fund security

Core rule:

- user knowingly funds an ephemeral trading wallet/context
- backend does not hold arbitrary custody over the user’s main wallet
- funds must return to the original custody wallet on stop, session end, fault flow, and maintenance/admin stop

Return destination must be bound to the original wallet. No silent destination swapping.

### Backend security

Backend may analyze, rotate strategies, request trades, execute through Jupiter + Helius, and manage runtime.

Backend must not:

- own the user’s main wallet
- change the original destination wallet arbitrarily
- exceed session authority/rules
- become a hidden custody layer

### Admin security

Admin may assign licenses, manage access, monitor sessions, and stop sessions for maintenance/ops.

Admin must not:

- reroute funds arbitrarily
- impersonate user trading authority
- silently seize session funds

Admin stop means operational control, not fund ownership.

### License/access security

KeyAuth gates who can use RogueZero, which wallet/user is entitled, whether bot access is valid, and whether session start is allowed.

Wallet connected is not enough. Access must be wallet-authenticated and linked to valid license/admin-assigned access.

### Execution security

Every automated trade should pass:

- session active check
- license still valid check
- strategy/runtime permission check
- risk/limit check
- allowed execution path check

### UI security

User app:

- only manages that user’s session data
- cannot issue admin actions
- cannot view other user sessions

Admin app:

- separate access control
- stronger auth boundary
- audit every maintenance stop/admin action

### Persistence security

Persistent state should store session state, activity, performance, historical records, and entitlement linkage.

Sensitive values should be minimized. Do not casually persist secrets that are not needed.

### Fault security

On failure, the system should:

- stop trading
- preserve session state
- preserve audit trail
- run safe return/unwind path
- return funds home where possible
- require explicit recovery/admin flow if automatic return fails

RogueZero should fail toward halt, preserve, and return — not continue blindly, lose state, or orphan funds.

## Locked security posture

RogueZero should be wallet-authenticated, license-gated, session-authorized, backend-automated, main-wallet non-custodial, return-path constrained, and admin operationally privileged rather than financially privileged.

## Locked on-chain scope

Claude should treat the on-chain layer as minimal and purpose-built for non-custodial control.

What should exist on-chain:

- session config account
- program-controlled vault / PDA
- allowed executor registration
- spend / risk bounds
- withdraw destination binding
- pause / stop / expiry state
- maybe strategy mode enum / permissions

What should not exist on-chain by default:

- full strategy logic

Keep strategy logic off-chain unless it becomes absolutely necessary to move it on-chain.

## Locked risk controls

Claude should treat risk controls as distinct from security.

Security says who is allowed. Risk controls say what the bot is allowed to do even when authorized.

RogueZero risk is two-layered.

### Layer 1: trading risk controls

Enforce:

- session capital cap
- per-trade cap
- max concurrent positions
- allowed token universe
- liquidity guard
- slippage guard
- cooldown / anti-overtrading
- strategy-level limits for the 3 rotating strategies
- pause behavior: no new entries, preserve state
- stop behavior: no new entries, unwind/return flow begins
- profit withdrawal behavior through the allowed session path
- failure behavior: stop new trading, preserve state, run safe return/unwind logic

### Layer 2: infrastructure / rate-limit risk controls

Enforce:

- monthly provider budgets for Helius, Jupiter, and later paid providers
- per-second / per-minute throttles by service type
- session usage ceilings for analysis frequency, refresh cadence, retry attempts, and execution attempts
- priority lanes preserving execution and safety before UI/analytics
- graceful degradation under pressure
- shared market-data design to avoid 150 duplicate expensive call patterns
- bounded retries; no infinite retry storms

## Locked risk split

#### Hard limits

Enforced at the session authority/program boundary:

- session capital cap
- per-trade cap
- status `active` / `paused` / `stopped`
- return wallet binding

#### Runtime limits

Enforced by automation/backend:

- strategy cooldown
- trade frequency
- strategy rotation behavior
- liquidity checks
- slippage checks
- token eligibility

### Non-negotiable first controls

Prioritize these first:

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

Claude should treat this as the intended observability model for RogueZero.

RogueZero must observe money flow, not just process uptime.

### Session observability

For each active session, track status, user wallet, bot name, license status, funded amount, current ephemeral wallet balance, open positions, last trade time, last successful strategy cycle, and stop/pause reason.

### Trade/execution observability

For each trade attempt, track strategy trigger, token/pair, trade size, expected route, Jupiter response/result, slippage estimate, submitted signature, confirmation result, actual fill outcome, and realized PnL when closed.

### Risk observability

Track cap hits, cooldown skips, slippage rejects, liquidity rejects, token-universe rejects, max-position rejects, pause/stop triggers, and failure-triggered halts.

### Provider observability

Track Helius, Jupiter, KeyAuth, and future paid providers for call volume, error rate, latency, timeout rate, monthly budget burn, and rate-limit hits.

### Runtime observability

Track strategy rotation heartbeat, cycle duration, queue depth, execution backlog, failed cycles, restart/crash events, sessions currently running, and sessions stalled.

### Settlement observability

Track stop/end flow with stop requester, unwind start/finish, return-funds result, return-path signature, residual stuck balance, and failed recovery path.

### Dashboard freshness observability

Track last activity update time, last performance aggregation time, last historical sync time, and stale-data detection.

### Admin/audit observability

Admin needs visibility into active sessions, paused/stopped/error sessions, sessions needing manual attention, provider pressure, budget pressure, maintenance stops, and audit trail of admin actions.

## Locked alert minimums

At minimum, alert on:

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

## Three observability questions

RogueZero observability must always answer:

1. Is the bot trading correctly?
2. Is the money safe and returning correctly?
3. Are provider limits/infra degrading the product?

## Working observability split

Use these buckets:

- session observability
- trade/execution observability
- risk observability
- provider observability
- runtime observability
- settlement observability
- dashboard freshness observability
- admin/audit observability

## Locked core data map

Claude should treat this as the correct first-pass RogueZero data model.

### Entities

1. User
   - `user_id`, `username`, `status`, `created_at`, `updated_at`
2. Main wallet
   - `wallet_address`, `user_id`, `is_primary`, `verified_at`
   - one user -> one primary main wallet
   - main wallet is the return destination anchor
3. License / entitlement
   - `license_id`, `keyauth_key`, `assigned_user_id`, `assigned_wallet`, `bot_name`, `status`, `issued_by_admin`, `issued_at`, `expires_at`
   - one user/wallet has one active entitlement for RogueZero access
4. Bot identity
   - `bot_id`, `user_id`, `license_id`, `bot_name`, `bot_type`, `status`
5. Trading session
   - `session_id`, `user_id`, `wallet_address`, `license_id`, `bot_id`, `status`, `started_at`, `ended_at`, `pause_reason`, `stop_reason`
   - one bot can have many sessions over time
   - one session belongs to one user/wallet/license/bot
6. Ephemeral wallet
   - `ephemeral_wallet_id`, `session_id`, `wallet_address`, `funded_amount`, `current_balance`, `return_wallet_address`, `created_at`, `settled_at`
   - one session -> one ephemeral wallet context
   - return wallet must map to original main wallet
7. Session runtime state
   - `session_id`, `active_strategy_index`, `last_cycle_at`, `current_positions_count`, `current_exposure`, `last_trade_at`, `runtime_health`, `provider_pressure_state`
8. Trade record
   - `trade_id`, `session_id`, `strategy_id` / `strategy_slot`, `token_in`, `token_out`, `side`, `size`, `expected_route`, `slippage_estimate`, `tx_signature`, `status`, `created_at`, `confirmed_at`
9. Position record
   - `position_id`, `session_id`, `token`, `entry_trade_id`, `exit_trade_id`, `quantity`, `avg_entry`, `avg_exit`, `realized_pnl`, `unrealized_pnl`, `status`
10. Activity/event log
   - `event_id`, `session_id`, `event_type`, `message`, `source`, `created_at`
11. Performance snapshot
   - `snapshot_id`, `session_id`, `timestamp`, `realized_pnl`, `unrealized_pnl`, `total_volume`, `win_rate`, `active_positions`, `fees_generated`, `session_balance`
12. Provider usage record
   - `usage_id`, `provider`, nullable `session_id`, `request_type`, `request_count`, `error_count`, `latency`, `budget_window`, `created_at`
13. Admin action record
   - `admin_action_id`, `admin_user_id`, `target_session_id`, `action_type`, `reason`, `created_at`

### Relationship map

Main chain:

- user has main wallet
- user has license
- user has bot identity
- user has many sessions

Session chain:

- session has one ephemeral wallet
- session has one runtime state
- session has many trades
- session has many positions
- session has many activity events
- session has many performance snapshots

Admin/infra chain:

- license assigned by admin
- provider usage tied to project and optionally session
- admin actions tied to sessions/licenses/users

### Source-of-truth rules

- main wallet = identity anchor and return destination
- license = entitlement/access
- session = active runtime lifecycle
- ephemeral wallet = session trading capital context
- trades / positions / performance = live activity + live dashboard + historical dashboard

### 1) Owner wallet is not the trading wallet

RogueZero has two wallet roles:

- `owner_wallet` = the user’s connected/sign-in wallet
- `session_wallet` = the ephemeral execution wallet used for trading

These are intentionally different.

The user connects with `owner_wallet` in `apps/web`.
When a session is created, the API generates a fresh Solana keypair and assigns its public key as `session_wallet`.
The corresponding private key is stored in `session_keys`.

This means:

- the user’s login wallet is identity / access control
- the session wallet is the autonomous signer / taker / fee payer for trades
- trading must use `session_wallet`, not `owner_wallet`

### 2) Sessions are user-created from the web app

Admin does **not** create trading sessions.

Admin only manages licensed users in `rz_users`.

The actual session flow is:

1. User connects wallet in `apps/web`
2. Web app validates the wallet via `GET /users/by-wallet/:wallet`
3. Authorized user creates a session via `POST /sessions`
4. API generates:
   - `session.id`
   - ephemeral `session_wallet`
   - private key stored in `session_keys`
   - initial status = `awaiting_funding`
5. API returns funding instructions telling the user to send SOL to `session_wallet`
6. Worker watches for funding and transitions the session forward

### 3) The worker owns autonomous execution

The worker is the thing that actually trades.

Worker behavior today:

- polls session table every 5s
- watches statuses: `awaiting_funding`, `ready`, `starting`, `active`, `stopping`
- checks `session_wallet` funding on-chain
- moves funded sessions to `ready`
- moves `ready` / `starting` to `active`
- for `active` sessions, calls the Jupiter prepare/submit flow
- signs prepared transactions with the session keypair from `session_keys`

Important invariant:

- stored keypair public key **must equal** `session.session_wallet`

If they mismatch, execution is invalid.

### 4) Chosen Jupiter path is Router, not Meta-Aggregator

RogueZero has already chosen the Jupiter Router path.
That decision is done.

Use:

- `GET /swap/v2/build`
- Router-style build + signed submit flow
- `platformFeeBps` = 0 (per-trade fees disabled; 0.33% performance fee at session end instead — BUILT)
- platform fee token accounts (configured but unused while platformFeeBps=0)

Do **not** switch this project back to `/order` + `/execute` unless the user explicitly changes architecture.

Reason this path was chosen:

- fee capture works through `platformFeeBps` (currently disabled, 0.33% performance fee model agreed instead)
- no referral setup required for the main swap path
- routing is acceptable for current needs
- this is already wired in code and tested to return build instructions

Implementation note:

- the current code calls Jupiter for `GET /swap/v2/build`
- the signed transaction is then submitted by our API through Helius RPC in `POST /jupiter/swap/submit`
- do not assume the repo currently calls Jupiter submit directly just because the architecture discussion used “build + submit” language

## Fee model

**Per-trade platformFeeBps is 0** — disabled. Per-trade fees eat into bot profitability.

**Agreed revenue model: 0.33% performance fee on NET SESSION PROFIT at session end.**
- OR 0.33% at take-profit payout if user chose profit-taking mode
- Fee deducted before funds sent to owner wallet
- **BUILT** — worker `sweepFunds` computes 33bps of net SOL profit, deducts before return transfer
- Feature-gated: `performanceFeeEnabled` in `runtime_control_settings` + admin toggle
- Env: `WORKER_PERFORMANCE_FEE_BPS` (default 33), `WORKER_PERFORMANCE_FEE_ENABLED` (default true)

Fee token accounts (for future per-trade fees if re-enabled):

- SOL: `8B3zcBMcjpAJeR7ksEeJMiiNrW6dEf1oL3YK2GnQwGGK`
- USDC: `AYE7gjGL2GrPHmQXieipTfT66CPvzWYu2onkGPWByJmo`
- USDT: `zo5WxSQEj2feo5JTSoeEbmFdzD5QNdyKZRABpjabeW7`

Important distinction:

- platform fee token accounts are about **fee capture token destination**
- the transaction fee payer is the `taker` / `session_wallet`
- these are not the same thing

## Critical execution truth discovered in this session

The `taker` in `/jupiter/swap/prepare` is also the transaction fee payer.

That means the `taker` must be:

- a real on-chain account
- owned by the System Program
- funded with lamports

Two failures already proved this:

1. Using the referral account `3eaa5c4jtVThtiTgGiMyxUc85LWDfWWaz92rs7hzVtgm` as taker produced `InvalidAccountForFee`
   - because it is owned by the Jupiter referral program, not the System Program
2. Using a brand-new unfunded keypair as taker produced `AccountNotFound` with `unitsConsumed: 0`
   - meaning simulation failed before instruction execution

Therefore:

- `owner_wallet` is not the taker unless it is explicitly the funded system wallet being used for execution
- referral accounts / PDAs / program-owned accounts cannot be used as fee payer
- a session wallet must be funded before `/prepare` can simulate successfully

## End-to-end flow that Claude must preserve

### User and session flow

1. Admin creates user in `rz_users`
2. User connects wallet in `apps/web`
3. API authorizes wallet via `GET /users/by-wallet/:wallet`
4. User creates session via `POST /sessions`
5. API generates and stores ephemeral session keypair
6. User funds `session_wallet` with SOL
7. Worker detects funding and sets session `ready`
8. Session becomes `active`
9. Worker executes trade loop using `session_wallet`

### Swap flow

1. Worker calls `POST /jupiter/swap/prepare`
2. API calls Jupiter Router `GET /swap/v2/build`
3. API loads lookup tables and simulates transaction
4. API persists prepared execution
5. Worker deserializes and signs prepared tx with session keypair
6. Worker calls `POST /jupiter/swap/submit`
7. API submits through Helius
8. API confirms / reconciles execution status
9. Fee capture is verified in configured fee account

## Current code truths

### `services/api/src/index.ts`

This file currently owns:

- user wallet authorization route
- session creation and control routes
- Jupiter `/build`, `/prepare`, `/submit`
- execution reconcile routes

Important current behavior:

- `POST /sessions` generates the ephemeral session keypair and stores it immediately
- `/jupiter/swap/prepare` uses `taker` as `payerKey`
- `/jupiter/swap/submit` requires the signed tx message to match the prepared tx exactly

### `services/worker/src/index.ts`

This file currently owns:

- session polling and lifecycle transitions
- funding detection for `session_wallet`
- signing and submitting prepared Jupiter transactions

Important current behavior:

- worker uses `session.session_wallet` as `taker`
- worker signs with stored session keypair
- worker stops if keypair and session wallet do not match

### `packages/runtime-config/src/index.ts`

This file is the source of truth for:

- Jupiter Router API base URL
- `platformFeeBps` (currently 0 — per-trade fees disabled)
- fee accounts (for future use if per-trade fees re-enabled)
- env validation / readiness

## Things Claude should not get wrong

### Do not confuse these roles

- `owner_wallet` != `session_wallet`
- admin user creation != trading session creation
- fee account != fee payer
- referral account != execution wallet

### Do not “fix” the architecture by collapsing wallets

The split-wallet design is intentional.
The project is built around the session wallet being the autonomous execution account.
Do not rewrite the system to trade directly from the user login wallet unless the user explicitly requests that architecture change.

### Do not debug Jupiter instructions before validating the payer

If `/prepare` returns errors like:

- `InvalidAccountForFee`
- `AccountNotFound` with `unitsConsumed: 0`

first verify:

- what wallet was used as `taker`
- whether it is system-owned
- whether it exists on-chain
- whether it has SOL

Do not blame Jupiter fee accounts first when payer validity is already broken.

### Do not treat tests/compile as proof of Stage 1 success

Stage 1 is only done when a real mainnet flow succeeds:

- worker -> prepare -> sign -> submit -> confirmed
- fee capture verified on-chain

## Current Stage 1 status

Already established:

- Router path decision is done
- `/swap/v2/build` is wired and returning instructions
- `/prepare` Zod issue with zero compute units was fixed
- root cause for `InvalidAccountForFee` was identified correctly

Still required:

- use a real funded `session_wallet`
- get `/prepare` to return a valid signable transaction for that wallet
- sign and submit it
- confirm on-chain
- verify captured fee lands in fee account

## Operational limits

These are hard constraints for the current project. The rate-limit buckets are DB-backed and shared fleet-wide across worker + API by key, so these are combined-fleet ceilings (not per-process). Defaults equal 90% of the provider cap (10% safety headroom).

### Jupiter (Pro, yearly)
- 1 account, 3 API keys, shared bucket
- provider cap: 150 RPS general; fleet target: **135 RPS (90%)**
- high-throughput submit path exists conceptually in the Router model, but current code submits signed transactions through Helius RPC

### Helius (Business)
- 1 account, 5 API keys, shared bucket
- provider cap: 200 RPS RPC; fleet target: **180 RPS (90%)**
- Sender: 50 TPS cap; fleet target: **45 TPS (90%)**

### Fleet throttle
- The worker runs a single fleet-wide Surge/Pulse/Glide auto-shift loop for all 350 bots.
- It downshifts (toward Glide) fast on worst-lane pressure and upshifts (toward Surge) slowly on recovery; admin can pin a mode or return to auto.
- Measured call accounting: ~1 Jupiter : ~7 Helius RPC per entry trade (Helius RPC is the binding lane), reduced to ~3 RPC/trade via ALT caching + subscription-backed balance.

## Source-of-truth files

When in doubt, read these first:

- `WORKFLOW.md`
- `services/api/src/index.ts`
- `services/api/src/sessionStore.ts`
- `services/worker/src/index.ts`
- `packages/runtime-config/src/index.ts`
- `packages/session-schema/src/index.ts`
- `apps/web/src/app/page.tsx`

## Instruction to Claude

If you are working on RogueZero, start from this model:

- licensed user connects `owner_wallet`
- user creates a trading session from the web app
- API generates `session_wallet` + private key storage
- user funds `session_wallet`
- worker trades from `session_wallet`
- Jupiter Router path is the chosen swap architecture
- `session_wallet` is the taker / signer / fee payer
- a real funded system wallet is required for simulation and execution

If you propose anything that breaks those invariants, stop and re-check the code first.
