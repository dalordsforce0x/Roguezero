# RogueZero 350-Bot Speed Research Plan

Status: research control document  
Created: 2026-06-04  
Scope: define the math inputs required before finalizing Glide / Pulse / Surge speeds, queue limits, provider caps, scanner cadence, and max-open-position behavior.

## Why this exists

The current `glide`, `pulse`, and `surge` values in code are not final researched speed math. They are operational placeholders that need to be replaced or confirmed by documented provider limits, measured RogueZero call costs, and 350-session simulation results.

Do not treat current cadence/concurrency values as proof that RogueZero is ready for 350 bots.

## Confirmed provider facts

### Jupiter Portal / Pro

Source: Jupiter Portal rate-limit docs and user-provided Pro plan context.

- Pro general API limit: 150 requests/second.
- Sliding window: 60 seconds.
- Pro general window capacity: 9,000 requests / 60 seconds.
- Rate limits apply per account, not per API key.
- Multiple API keys do not increase the account-level rate limit.
- Most APIs share the general bucket.
- `/swap/v2/execute` has a dedicated bucket.
- `/tx/v1/submit` has a dedicated bucket.
- Paid accounts get 100 RPS for `/execute` and 100 RPS for `/submit` dedicated buckets.
- Jupiter docs recommend exponential backoff and spreading requests evenly; aggressive retries can extend the rate-limit window.
- RogueZero currently uses Router `/swap/v2/build`, which belongs to the general bucket.

### Helius Business

Source: Helius pricing and docs.

- Business plan: 100M credits/month.
- RPC rate limit: 200 requests/second.
- DAS API: 50 requests/second.
- Enhanced APIs: 50 requests/second.
- `sendTransaction`: 50 transactions/second.
- `sendBundle`: 5 bundles/second.
- Enhanced WebSockets included.
- LaserStream gRPC mainnet included on Business and higher.
- WebSocket usage is metered at 2 credits per 0.1 MB streamed data.
- Opening a WebSocket connection costs 1 credit.
- Helius-specific WebSocket extensions include `transactionSubscribe` and enhanced `accountSubscribe`.
- `transactionSubscribe` can include up to 50,000 addresses in account include/exclude/required arrays.
- Sender default rate limit: 50 transactions/second.
- Sender does not consume API credits.
- Sender requires `skipPreflight: true`, priority fee, and a tip.
- Sender default dual routing minimum tip: 0.0002 SOL.
- Sender SWQOS-only minimum tip: 0.000005 SOL.
- Helius Priority Fee API provides real-time priority fee estimates.

### Helius credits and current-call costs

Source: Helius credits, RPC method, Sender, Priority Fee API, and WebSocket/LaserStream docs.

- Standard RPC calls cost 1 credit unless explicitly listed otherwise.
- Helius Priority Fee API costs 1 credit per request.
- `getTransaction` costs 1 credit.
- `getSignatureStatuses` costs 1 credit and supports up to 256 signatures per request.
- `getProgramAccounts` costs 10 credits; paginated `getProgramAccountsV2` costs 1 credit.
- DAS API calls cost 10 credits each and should not share the hot execution lane without a separate cap.
- Enhanced transaction parsing costs 100 credits and should not be used in the hot confirmation path unless explicitly budgeted.
- Sender costs 0 Helius credits but remains constrained by Sender TPS and SOL tip / priority-fee spend.
- Staked `sendTransaction` through normal RPC costs 1 credit; `sendBundle` costs 10 credits.
- LaserStream WebSocket and LaserStream gRPC are metered at 2 credits per 0.1 MB of uncompressed streamed data.
- Typical streamed data sizes in Helius docs are directional only: account message ~0.0004 MB, transaction message ~0.0006 MB, block ~4 MB. RogueZero must measure real payload sizes.

## Actual RogueZero provider call matrix

This section maps documented provider facts to current source call paths. It is intentionally call-site driven so the 350-bot math does not drift into unrelated provider features.

| RogueZero stage | Current source calls | Provider lane | Documented cost / cap | 350-bot implication |
| --- | --- | --- | --- | --- |
| Awaiting-funding detection | worker `rlGetBalance(session_wallet)` fallback in `checkFunding` | Helius RPC | standard RPC, 1 credit/request; Business 200 RPS raw, 180 RPS with 10% headroom | Must be replaced by `accountSubscribe` for steady state; polling 350 awaiting sessions even every 5s is ~70 RPC/s before any trading work. |
| Funding/account event stream | future `accountSubscribe(session_wallet)` | LaserStream WebSocket | 2 credits / 0.1 MB streamed; connection open 1 credit; account messages estimated ~0.0004 MB but must be measured | Correct default for funding and balance changes. Cost becomes data volume + reconnect behavior rather than fixed poll RPS. |
| Jupiter Router build/prepare | API `fetchJupiterBuild()` calls `/swap/v2/build` | Jupiter general | Pro general 150 RPS raw, 135 RPS with 10% headroom; per account, not per key | This is the main Jupiter bottleneck for fresh trade construction. Multiple keys help lanes/rotation/observability, not total account RPS. |
| Lookup table loading | API `loadLookupTableAccounts()` -> `rlGetAddressLookupTable()` | Helius RPC | standard RPC, 1 credit/request | Per-trade Helius cost scales with Jupiter build ALT count. Must measure median/p95 ALT count per build. |
| Prepare simulation | API `rlSimulateTransaction()` with `replaceRecentBlockhash: true`, `sigVerify: false`, `commitment: confirmed` | Helius RPC | standard RPC, 1 credit/request; returns logs, errors, replacement blockhash, `unitsConsumed` | Required before Sender because Sender skips preflight. One simulation per candidate is a hard RPC cost unless safely cached/avoided. |
| Priority fee estimate | API `estimatePriorityFeeMicroLamports()` -> `getPriorityFeeEstimate` | Helius Priority Fee API / RPC endpoint | 1 credit/request; priority levels Min, Low, Medium, High, VeryHigh, UnsafeMax; total fee = CU price × CU consumed | Adds one Helius credit per prepared execution. Must be budgeted with simulation and ALT reads. |
| Sender tip floor | API `getDynamicSenderTipLamports()` -> Jito tip floor endpoint | external Jito endpoint | not a Jupiter or Helius bucket | Must have its own cache/TTL and failure fallback; do not let every bot/trade stampede this endpoint. |
| Submit signed tx | API `sendViaHeliusSender()` -> Sender `sendTransaction` | Helius Sender | 50 TPS default, 45 TPS with 10% headroom; 0 Helius credits; requires `skipPreflight: true`, priority fee, tip, `maxRetries: 0` recommended | Submit lane is TPS/SOL-cost constrained, not Helius-credit constrained. Current code’s Sender TPS limiter is valid. |
| Sender budget accounting | API `reserveHeliusSender()` currently reserves 1 Helius monthly credit | local provider-governor model | docs say Sender costs 0 credits | Code-model mismatch to fix after research: keep Sender TPS limiter and SOL-cost tracking, but do not burn Helius monthly API credits for Sender. |
| RPC raw-send fallback | API/worker `rlSendRawTransaction()` | Helius RPC / staked connection | staked `sendTransaction` through normal RPC costs 1 credit; normal RPC RPS applies | Useful fallback but must not share unlimited capacity with reads/simulation. |
| Confirmation status fallback | API `rlGetSignatureStatus(es)()` and worker/API `confirmTransaction()` | Helius RPC | `getSignatureStatuses` costs 1 credit and supports up to 256 signatures/request | Use batched status checks only as fallback or reconciliation; streaming/signature subscriptions should reduce steady polling. |
| Transaction reconciliation | API `rlGetTransaction()` | Helius RPC historical | 1 credit/request; supports `maxSupportedTransactionVersion` | Reconcile only submitted executions and batch/defer where safe. Do not use as high-frequency dashboard polling. |
| Session-wallet transaction events | future `transactionSubscribe({ accountInclude: session_wallets })` | LaserStream WebSocket extension | up to 50,000 addresses in include/exclude/required arrays; data-metered at 2 credits / 0.1 MB | Can cover 350 session wallets in one filtered subscription design. Must measure payload size and reconnect duplicate behavior. |
| High-reliability streaming | future LaserStream gRPC | LaserStream gRPC | mainnet requires Business/Professional; historical replay up to ~24h; multi-node reliability; data-metered | Better target for production 350-bot state recovery than manual WebSocket-only replay, especially after worker restarts. |
| Token account / position reads | worker `getTokenAccountsByOwner`, `getMint`; future account/program streams | Helius RPC now; WebSocket/LaserStream later | standard RPC 1 credit/request, unless broad `getProgramAccounts` is used at 10 credits | Must be event-driven or batched for open positions; per-position polling would dominate monthly credits. |
| Dashboard/history | API/admin future historical reads, DAS/enhanced APIs if used | Helius DAS/Enhanced/RPC | DAS 10 credits/call; Enhanced Transactions 100 credits/call; Enhanced API 50 RPS raw | Should be deprioritized/cut first under pressure. Never compete with safety/settlement/confirmation lanes. |

### Call-path research conclusions

- Current hot successful prepare path is at least: 1 Jupiter general request + N Helius RPC ALT reads + 1 Helius RPC simulation + 1 Helius Priority Fee API request, before submission and confirmation.
- Current submit path through Helius Sender adds 1 Sender TPS unit and SOL fee/tip spend, but 0 Helius API credits according to Helius docs.
- Current confirmation/reconciliation can be made much cheaper with stream-first design, but fallback RPC status checks should batch up to 256 signatures per `getSignatureStatuses` call.
- Current funding detection via polling is mathematically incompatible with healthy 350-bot Surge if many sessions sit in `awaiting_funding`; `accountSubscribe` or LaserStream should be the normal path.
- The final Surge math must include per-trade ALT count, simulation count, priority-fee request count, confirmation fallback count, and stream bytes/hour. Headline RPS alone is not enough.

## Immediate math truth

### RPS headroom

We should not plan against raw provider limits.

- Jupiter Pro safe planning cap at 10% headroom: `150 * 0.90 = 135 RPS`.
- Helius Business RPC safe planning cap at 10% headroom: `200 * 0.90 = 180 RPS`.
- Helius DAS safe planning cap at 10% headroom: `50 * 0.90 = 45 RPS`.
- Helius Sender safe planning cap at 10% headroom: `50 * 0.90 = 45 TPS`.

Existing local env targets are more conservative:

- `JUPITER_GENERAL_RPS=120`.
- `HELIUS_RPC_RPS=160`.
- `HELIUS_RPC_BURST=25`.
- `WORKER_BASE_CONCURRENT_CAPACITY=350`.

### Monthly budget headroom

Helius monthly credits are likely a stricter sustained-background-work constraint than peak RPS.

If every credit had equal weight, 100M credits/month gives roughly:

```text
100,000,000 / 30 / 24 / 60 / 60 = 38.58 credits/second
```

That does not mean RogueZero can only make 38 RPC calls/second, because endpoint credit costs vary and Sender does not consume credits. It does mean the runtime must forecast monthly burn and throttle scanner/dashboard/fallback polling before execution and safety lanes are starved.

## Combined Jupiter + Helius bottleneck model

Glide / Pulse / Surge speeds cannot be chosen from Jupiter limits alone or Helius limits alone. Every runtime lane must fit through the tightest effective provider constraint for that lane.

The research goal is to make `surge` the normal full-performance operating mode for 350 bots when the system is healthy. The math should make 350-bot Surge fit inside the combined provider, monthly-budget, queue, stream, and DB constraints. Pulse and Glide are fallback modes for concerning triggers; they should not be required merely because 350 bots are active.

For each lane:

```text
safe_lane_capacity = min(
  jupiter_lane_capacity_if_used,
  helius_rpc_capacity_if_used,
  helius_sender_capacity_if_used,
  helius_stream_budget_if_used,
  monthly_budget_allowed_capacity,
  db_queue_capacity,
  stale_candidate_capacity
)
```

If a lane does not use a provider, that provider should not constrain that lane. For example, Helius Sender constrains submit throughput, but not scanner candidate generation. Jupiter general constrains Router build/quote work, but not pure wallet-state WebSocket updates.

### Current combined safe caps

These are planning caps, not final runtime speeds.

| Provider lane | Raw documented cap | 10% headroom cap | Current local env target | Notes |
| --- | ---: | ---: | ---: | --- |
| Jupiter general | 150 RPS | 135 RPS | 120 RPS | Router `/swap/v2/build`, quotes/scanner/general requests. Shared account bucket. |
| Jupiter `/tx/v1/submit` | 100 RPS paid bucket | 90 RPS | not wired as main path | Dedicated bucket if RogueZero later uses Jupiter submit. |
| Jupiter `/swap/v2/execute` | 100 RPS paid bucket | 90 RPS | not current architecture | Dedicated bucket, mostly Meta-Aggregator path. |
| Helius RPC | 200 RPS | 180 RPS | 160 RPS | Reads, blockhash, simulation, status fallback, lookup tables depending on path. |
| Helius DAS / Enhanced APIs | 50 RPS | 45 RPS | not separately tuned | Metadata/history/dashboard; should not consume hot execution lane. |
| Helius Sender | 50 TPS | 45 TPS | API default 50 RPS | Does not consume Helius API credits, but still has TPS and SOL tip costs. |
| Helius WebSocket / LaserStream | data-metered | measured by MB/credits | not measured | Replaces polling, but speed math needs streamed MB/hour and reconnect cost. |

### What likely bottlenecks each runtime activity

| Activity | Jupiter pressure | Helius pressure | Likely bottleneck before measurement |
| --- | --- | --- | --- |
| Shared scanner candidate discovery | Jupiter general if route/quote/build heavy | Helius RPC/DAS if metadata/chain reads are heavy | whichever call mix dominates per scanner run |
| Idle active session monitoring | should be near zero if event-driven | WebSocket/LaserStream data volume | stream data budget and DB/event handling |
| Just-in-time trade validation | Jupiter general if fresh build/quote required | Helius RPC for balance/blockhash/simulation/lookups | measured per-candidate validation cost |
| Swap prepare/build | Jupiter general `/swap/v2/build` | Helius RPC simulation / lookup tables | min(Jupiter general, Helius RPC) after per-trade cost |
| Swap submit via current Helius path | none if not using Jupiter submit | Helius Sender or RPC submit lane | Helius Sender TPS / landing policy |
| Confirmation | none normally | stream/signature subscription or batched RPC fallback | stream health first, Helius RPC fallback second |
| Stop / settlement | may use Jupiter if unwinding positions | Helius RPC/Sender + confirmation | safety lane must preempt scanner/new entries |
| Dashboard/history | none or low | DAS/Enhanced/RPC/DB | must be deprioritized under pressure |

### Joint mode selection rule

The runtime mode should be selected by the worst healthy lane, not by the best available lane.

```text
recommended_mode = min_by_safety(
  mode_from_jupiter_general_pressure,
  mode_from_helius_rpc_pressure,
  mode_from_sender_pressure,
  mode_from_stream_budget_pressure,
  mode_from_monthly_budget_forecast,
  mode_from_queue_backlog,
  mode_from_confirmation_backlog,
  mode_from_db_pressure
)
```

Meaning: if Jupiter looks healthy enough for Surge but Helius monthly credits or confirmation fallback pressure only supports Glide, the system must run Glide.

### Initial lane allocation hypothesis

This is a starting hypothesis for simulation, not a final production policy.

For normal sustained operation, do not give one class of work the whole provider cap. Reserve capacity by priority:

| Lane class | Purpose | Starting share of effective cap |
| --- | --- | ---: |
| Safety / stop / settlement | return funds, unwind, emergency recovery | 15-25% reserved |
| Confirmation / reconciliation | avoid stuck unknown execution state | 10-20% reserved |
| Trade submit | land already-approved trades | 15-25% |
| Trade prepare / build / simulation | new entries/exits after risk checks | 25-40% |
| Scanner | shared market discovery | 10-25%, mode dependent |
| Dashboard/history | admin/user visibility non-hot path | 0-10%, cut first under pressure |

Surge should be engineered to run 350 bots sustainably while safety, confirmation, monthly budget, stream health, DB pressure, and queue age remain healthy. Pulse should be the first automatic throttle-down mode when early pressure appears. Glide should cut scanner/dashboard/new-entry prepare deepest and protect settlement, confirmations, and safety lanes.

### What “good for both” means

A candidate Glide/Pulse/Surge speed is only acceptable if it satisfies all of these at the same time:

- Jupiter general remains below the selected safe cap and no 429 storm appears.
- Helius RPC remains below the selected safe cap and monthly credit forecast remains inside budget.
- Sender TPS remains below safe cap and tip/priority-fee spend remains acceptable.
- Stream/WebSocket/LaserStream data volume is affordable and stable.
- Queue age stays below candidate freshness windows.
- Confirmation lag stays below fallback thresholds.
- Stop/settlement lane can preempt trading within the required safety window.
- DB latency does not create scheduler or queue lock buildup.

The final speeds must be chosen from measured combined behavior, not from either provider's headline RPS.

## Unknowns that must be measured before final speeds

### Per-session state costs

Measure real provider usage per session state:

- `awaiting_funding` with WebSocket/webhook enabled.
- `awaiting_funding` fallback polling.
- `active_idle` with no candidate.
- `candidate_available` just-in-time checks.
- `prepare_queued` / `prepare_pending`.
- `submit_queued` / Sender submit.
- `submitted_waiting_confirmation` stream-first.
- `submitted_waiting_confirmation` batched fallback.
- `stopping` / `settling`.
- `error_halted` reconciliation.

For each state, record:

- Jupiter general requests.
- Jupiter `/submit` or `/execute` requests if used later.
- Helius RPC requests.
- Helius DAS/enhanced requests.
- Sender submissions.
- WebSocket/LaserStream bytes streamed.
- Webhook delivered events.
- DB reads/writes.
- average latency.
- p95 latency.
- retry rate.
- error/429 rate.

### Per-trade costs

Measure a full entry and exit path:

- candidate consumption.
- quote/build/prepare.
- lookup table reads.
- simulation.
- signing.
- submission.
- confirmation.
- reconciliation.
- position update.
- activity/performance write.

Record median, p95, and worst-case cost.

### Scanner costs

Measure global scanner cost as a function of:

- enabled token count.
- candidates evaluated per run.
- route-depth checks.
- quote/build calls.
- price/tape calls.
- token metadata enrichment.
- scanner cadence.
- candidate freshness window.

The scanner must be budgeted globally, not per bot.

### Stream costs

Measure WebSocket/LaserStream volume for:

- 350 session-wallet account subscriptions.
- token-account subscriptions for active positions.
- transaction subscriptions filtered by session wallets.
- signature subscriptions for pending executions.
- reconnect/resubscribe storms.

Record MB/hour and credits/hour.

### Queue costs

Measure how many prepare/submit/confirm jobs can be processed while preserving:

- no provider lane over cap.
- no queue starvation for settlement.
- bounded oldest queued age.
- bounded stale candidate rate.
- bounded confirmation lag.

## Draft formulas

### Effective lane cap

```text
effective_rps = min(
  documented_rps * headroom_factor,
  env_configured_rps,
  monthly_budget_allowed_rps,
  pressure_adjusted_rps
)
```

Where:

- `headroom_factor` starts at `0.90`.
- `monthly_budget_allowed_rps` comes from remaining credits/requests over remaining month seconds.
- `pressure_adjusted_rps` is lowered by error rate, latency, queue backlog, and stream health.

### Per-mode session budget

```text
mode_session_capacity = floor(
  effective_lane_rps / measured_requests_per_session_per_second
)
```

This must be calculated separately for:

- scanner lane.
- execution prepare lane.
- submit lane.
- confirmation lane.
- dashboard/history lane.
- fallback polling lane.

### Max open positions target

Mode-based position limits should be driven by measured execution and monitoring cost:

```text
max_positions_by_mode = min(
  product_target_for_mode,
  floor(mode_execution_budget / measured_position_monitoring_cost),
  risk_limits.maxOpenPositions,
  capital_and_trade_size_bounds
)
```

Initial product targets:

- Glide: 1-3.
- Pulse: 5-10.
- Surge: dynamic / bot-decided, bounded by risk and measured provider capacity.

## Draft mode research targets

These are research targets, not final production settings.

| Mode | Purpose | Research question |
| --- | --- | --- |
| Glide | protect providers and budget under stress | What is the slowest cadence that preserves safety, settlement, and minimum opportunity capture? |
| Pulse | first fallback throttle under early/concerning pressure | What reduced cadence preserves good trading while restoring provider, queue, stream, DB, and budget health? |
| Surge | mathematically engineered full-performance 350-bot operation | What fastest sustainable cadence supports 350 bots without exceeding combined Jupiter + Helius, monthly budget, queue, stream, DB, confirmation, or safety constraints? |

## Required simulation before coding final speeds

Build a 350-session simulation that can run without real funds and can emit fake:

- wallet funding events;
- token account events;
- scanner candidate events;
- prepare successes/failures;
- submit successes/failures;
- confirmation events;
- provider 429s;
- stream disconnects;
- DB slowdowns;
- stop/settlement preemption.

The simulation must report:

- RPS per provider/lane/key.
- credits/request budget burn forecast.
- queue depth and queue age.
- mode transitions.
- skipped trades by reason.
- per-state session counts.
- scanner freshness.
- confirmation lag.
- settlement preemption latency.
- DB query latency.

## Do not finalize until answered

- What is the measured provider cost of one complete successful trade entry?
- What is the measured provider cost of one complete successful exit?
- What is the measured provider cost per active open position per minute?
- How much stream data do 350 session wallets produce per hour?
- How many candidates can the scanner evaluate per minute without starving execution?
- What queue age is acceptable before candidates become stale?
- What confirmation lag is acceptable before fallback polling begins?
- What error-rate threshold should trigger downshift?
- How long must recovery remain healthy before upshift?
- How much monthly credit reserve must be protected for settlement/safety?

## Measured per-trade provider call accounting (traced from code)

This section is derived directly from the current code paths, not assumed. Sources:
`services/api/src/index.ts` (`buildPreparedSimulationCandidate`, `/jupiter/swap/prepare`,
`/jupiter/swap/submit`, `watchSubmittedExecution`) and `services/worker/src/index.ts`
(`executeTrade`).

### One complete entry trade

| Stage | Call | Provider lane | Count |
| --- | --- | --- | ---: |
| prepare | `fetchJupiterBuild` (`/swap/v2/build`) | Jupiter general | 1 (+ up to ~3 retries on compute-heavy fallback) |
| prepare | `loadLookupTableAccounts` | Helius RPC | 1 per ALT (Router builds ~2-4) |
| prepare | `rlSimulateTransaction` | Helius RPC | 1 |
| prepare | `estimatePriorityFeeMicroLamports` | Helius RPC | 1 (Sender enabled) |
| prepare | `getDynamicSenderTipLamports` | Jito tip API (external) | 0 provider cost |
| submit | `rlGetBlockHeight` (expiry check) | Helius RPC | 1 |
| submit | `sendViaHeliusSender` | Helius Sender | 1 TPS, 0 credits |
| submit | `watchSubmittedExecution` (`onSignature`) | Helius WebSocket | 1 subscription (not RPC) |
| worker | `rlGetBalance` pre-trade | Helius RPC | 1 |
| worker | `rlGetBalance` post-submit | Helius RPC | 1 |

Confirmation is WebSocket-driven via `onSignature`. Batched `getSignatureStatuses` +
`getBlockHeight` only fire as a stale fallback (`reconcileStaleSubmittedExecutions`), so
confirmation does not multiply per-trade RPC under healthy stream conditions.

### Per-trade lane totals (healthy path, ~2 ALTs)

- Jupiter general: ~1 (build).
- Helius RPC: ~7 (2 ALT + 1 simulate + 1 priority-fee + 1 blockheight + 2 balance).
- Helius Sender: 1 TPS, 0 credits.
- Helius WebSocket: 1 subscription.

The previous model assumed ~1 Jupiter + 1 Helius per cycle. Measured reality per trade is
roughly **1 Jupiter : 7 Helius RPC**. Helius RPC is the binding constraint, not Jupiter.

### Corrected fleet trade-throughput ceilings (350 bots, 90% caps)

| Lane | Safe cap | Per-trade cost | Max fleet trades/sec |
| --- | ---: | ---: | ---: |
| Helius RPC | 180 RPS | ~7 | ~25 (binding) |
| Jupiter general | 135 RPS | 1 | ~135 |
| Helius Sender | 45 TPS | 1 | ~45 |

Sustainable fleet trade throughput is ~25 concurrent entries/sec, set by Helius RPC.

### Reduction levers (measured)

- Cache address lookup tables (rarely change): removes ~2-4 Helius RPC/trade.
- Serve session-wallet balance from a Helius account subscription instead of 2 RPC/trade.
- With both, per-trade Helius RPC drops ~7 -> ~3, raising sustainable throughput to
  ~60 entries/sec (about 2.4x headroom).

Idle active monitoring is not the bottleneck: 1 balance RPC/cycle. Surge active-in-position
cadence 3s -> ~117 RPS at 350 bots, under the 180 RPS cap.

## Current conclusion

We have the architecture, the control language, and now measured per-trade call accounting
traced from code. The binding constraint for 350-bot trade throughput is Helius RPC at
roughly 25 entries/sec, dominated by ALT loads and balance checks, not Jupiter.

Next correct step: encode the runtime profile fields (done: `maxOpenPositions`, 350 base
capacity, Glide cadence floor), then build the auto-shift loop that selects mode from the
worst healthy lane (Helius RPC pressure first), then add ALT caching and subscription-based
balance reads to widen the trade-throughput ceiling. Run 350-session simulation to confirm
before final threshold lock.
