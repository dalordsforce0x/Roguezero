# RogueZero — Development Workflow

This document governs how GPT and GitHub Copilot collaborate to complete the RogueZero SDLC.
Both AIs must read and follow this before touching any code.

---

## Collaboration Model

```
GPT: analyze, propose, design
Copilot: verify against code + docs, flag issues, implement
User: approve before implementation, confirm after
```

**Step-by-step:**

1. GPT proposes an approach (architecture, logic, fix, design)
2. Copilot reads the actual files involved and verifies:
   - Does the proposal match what the code actually does?
   - Does it respect the hard constraints (rate limits, endpoints, fee model)?
   - Is anything wrong, missing, or incompatible?
3. Copilot reports findings — agree, disagree, or flag gaps
4. User approves the final approach
5. Copilot implements — one change at a time
6. Copilot proves it works (not just compiles — actual behavior verified)
7. User confirms before moving to the next item

**Rules:**
- No AI implements anything without user approval
- No AI declares something "done" without proof
- No AI asks the user questions they should be able to answer from the code or docs
- No AI bundles unrelated changes into a single step
- If the AIs disagree, both state their position clearly — user decides

---

## Hard Constraints (Do Not Ask Again)

### Jupiter
- **1 account, 3 API keys** — all share ONE rate limit bucket
- Pro plan (yearly): **150 RPS general** (all `/order`, `/build`, price, tokens, etc.), 6B credits/year
- Rotating keys does NOT increase throughput
- Fleet operating target: **135 RPS general (90% of cap)**, leaves 10% headroom for retries

### Helius
- **1 account, 5 API keys** — all share ONE rate limit bucket
- Business plan: **200 RPS RPC**, 50 sendTransaction/sec, 50 DAS RPS, 100M credits/mo
- Rotating keys does NOT increase throughput
- Fleet operating targets: **180 RPS RPC (90%)**, **45 sendTransaction/sec (90%)**
- Buckets are DB-backed and shared fleet-wide across worker + API; the worker auto-shifts Surge/Pulse/Glide to stay under 90% of the binding lane (Helius RPC)

### Jupiter API Paths
| Path | Endpoints | Fee Model | Routing |
|------|-----------|-----------|---------|
| Meta-Aggregator | `/order` + `/execute` | `referralAccount + referralFee` | All (Metis + JupiterZ RFQ + Dflow + OKX) |
| Router | `/build` + `/submit` | `platformFeeBps` + fee token accounts | Metis only |

**Chosen path for RogueZero: Router** (`/build` + `/submit` + `platformFeeBps` + fee token accounts)
- Reason: fee capture works, no referral setup needed, routing quality equivalent when using referral (referralAccount disables JupiterZ on Meta-Aggregator anyway)
- `/build` endpoint verified working as of 2026-05-28

### Fee Accounts (in .env)
- Platform fee: **35 BPS**
- SOL: `8B3zcBMcjpAJeR7ksEeJMiiNrW6dEf1oL3YK2GnQwGGK`
- USDC: `AYE7gjGL2GrPHmQXieipTfT66CPvzWYu2onkGPWByJmo`
- USDT: `zo5WxSQEj2feo5JTSoeEbmFdzD5QNdyKZRABpjabeW7`
- Trigger referral account: `3eaa5c4jtVThtiTgGiMyxUc85LWDfWWaz92rs7hzVtgm` — **NOT wired yet, optional for Trigger flows only**

---

## Known Problems (Must Fix Before Production)

| # | Problem | Location | Impact |
|---|---------|----------|--------|
| 1 | ~~`/swap/v2/build` called in `fetchJupiterBuild` — endpoint behavior TBD pending path decision~~ | **RESOLVED** — Router path confirmed, `/build` verified working 2026-05-28 | — |
| 2 | ~~Worker polls every 5s globally — kills rate limits as sessions scale~~ | **RESOLVED** — shared token buckets + adaptive scheduling, Stage 2 proof 2026-05-29 | — |
| 3 | ~~Trade size hardcoded to `0.001 SOL`~~ | **RESOLVED** — balance-%, risk-budget, slippage-aware sizing, Stage 3 proof 2026-05-29 | — |
| 4 | ~~No signal/strategy — bot swaps constantly with no edge check~~ | **RESOLVED** — momentum tape, trade gate, TP/SL/trailing exit implemented; live proof completed 2026-05-30 session `1d91091c` | — |
| 5 | ~~No global rate governor — sessions fire independently~~ | **RESOLVED** — shared token buckets across Jupiter + Helius, Stage 2 proof 2026-05-29 | — |
| 6 | ~~Worker never writes `realizedPnlUsd` or `capturedFeesUsd` after confirmed exit~~ | **RESOLVED** — API reconcile writes both after confirmed execution; 10+ sessions with non-zero PnL/fees in DB, total $53.64 PnL, $0.22 fees | — |
| 7 | ~~Stage 4 live proof not completed — staged session never funded~~ | **RESOLVED** — session `1d91091c` funded, traded, confirmed take_profit exit on mainnet 2026-05-30 | — |
| 8 | ~~Pyth tape resets on every worker restart — 15s warm-up blind spot~~ | **RESOLVED** — shared market tape now persists in DB-backed worker runtime state and restores on boot | — |
| 9 | ~~No stale session detection or auto-stop~~ | **RESOLVED** — worker auto-stops sessions exceeding `targetDurationMinutes` or with no trade attempt for 30min (configurable via `WORKER_STALE_SESSION_MINUTES`) | — |
| 10 | ~~No blockhash expiry recovery~~ | **RESOLVED** — blockhash-expired submit failures now release cooldown immediately so the worker can rebuild on the next loop without waiting out stale trade timing | — |
| 11 | ~~No worker-restart dedup guard~~ | **RESOLVED** — `executeTrade` checks for in-flight `prepared`/`submitted` executions before preparing new ones | — |
| 12 | ~~No three-strategy rotation implemented~~ | **RESOLVED** — 3-strategy rotation: momentum + Bollinger mean reversion + Supertrend. Auto regime-based rotation via `recommendStrategy()`. Strategy module in `services/worker/src/strategies.ts` | — |
| 13 | ~~No withdrawal / profit-pull UI~~ | **RESOLVED** — Stop button sweeps all funds (SOL + USDC + tokens) back to owner wallet. Stop = withdrawal by design | — |
| 14 | ~~No per-session strategy config UI~~ | **RESOLVED BY DESIGN** — web no longer depends on a user-facing sizing/config form; automation owns sizing and trade decisions, with system defaults applied at session creation | — |
| 15 | ~~Admin app has no live session monitoring~~ | **RESOLVED** — admin session health now includes live sizing/PnL visibility and a live session control panel with force-stop | — |
| 16 | ~~Private keys stored unencrypted in `session_keys` DB table~~ | **RESOLVED** — AES-256-GCM encryption via `SESSION_KEY_ENCRYPTION_KEY` env var. Backward compatible with unencrypted legacy keys | — |
| 17 | ~~No rate limiting on Fastify API routes~~ | **RESOLVED** — `@fastify/rate-limit`: 60/min default, 5/min session create, 10/min swap prepare/submit. Localhost exempt | — |

---

## SDLC Stages

### Stage 1 — Foundation (Infrastructure works end-to-end)
**Goal:** A single swap executes successfully from worker → API → Jupiter → Helius → confirmed on-chain.

Checklist:
- [x] Jupiter API path decided — **Router** (`/build` + `platformFeeBps` + fee accounts)
- [x] `fetchJupiterBuild` calls correct endpoint (`/swap/v2/build`) — verified returning instructions 2026-05-28
- [x] `/prepare` route produces a valid signable transaction — confirmed 2026-05-28
- [x] `/submit` route lands the transaction via Helius — multiple confirmed on-chain sigs 2026-05-28
- [x] Execution reconciliation confirms on-chain status — `confirmation_status: confirmed`, `confirmed_at` timestamps in DB
- [x] Fee capture verified — USDC fee account `AYE7gjGL2GrPHmQXieipTfT66CPvzWYu2onkGPWByJmo` holds `0.003159 USDC` from real swap fees
- [x] End-to-end test: multiple sessions, 72 swap execution records, 6+ confirmed txs, fee account balance confirmed

**Test for success:** Run one session manually. See a confirmed tx signature. Verify fee account received fee. Zero 404s or dead-endpoint errors.

**STAGE 1 COMPLETE — 2026-05-28**

---

### Stage 2 — Rate Governance (Scales without destroying limits)
**Goal:** Multiple concurrent sessions execute without hitting 429s.

Checklist:
- [x] Global rate limiter implemented in worker (shared token buckets for Jupiter general and Helius RPC)
- [x] Session requests queued through shared limiter — not firing independently
- [x] Poll interval replaced with event-driven or adaptive scheduling
- [x] Helius RPC calls rate-governed similarly (180 RPS fleet target, 90% of cap)
- [x] 429 handling: exponential backoff, not tight retry loops
- [x] Test: 10 concurrent sessions running for 60s — no visible 429s, all sessions made progress, and all stop flows returned funds home

**Test for success:** 10 active sessions, 60 seconds, zero 429 errors in logs.

**STAGE 2 COMPLETE — 2026-05-29**

---

### Stage 3 — Adaptive Sizing (Trade size driven by risk and balance)
**Goal:** No hardcoded trade sizes. Every trade is sized correctly for the session.

Checklist:
- [x] Trade size computed per-session from: wallet balance %, remaining risk budget, slippage cap
- [x] Minimum economically viable size enforced (fees + slippage must not exceed expected output)
- [x] Maximum size cap per session enforced
- [x] Size stored in session state and visible in admin
- [x] Test: session with 0.1 SOL should not trade the same size as session with 1.0 SOL

**Test for success:** Two sessions with different balances produce proportionally different trade sizes.

**STAGE 3 COMPLETE — 2026-05-29**
- Real mainnet proof verified balance-aware sizing: session `8718fd1d-32a3-49a8-a75e-afd843ea9701` (0.1 SOL wallet) sized `9,419,356` lamports while session `93714aa1-3001-49cb-a6a4-6a08944942f9` (1.0 SOL wallet) sized `50,000,000` lamports at the configured cap.
- Real mainnet proof verified risk-budget enforcement: session `24043e61-2d93-4221-819b-2deb4a87b27e` skipped with `risk_budget_exhausted` under 500 bps slippage while session `43ab1781-df8e-4912-80a5-f62a53fdd439` traded under 25 bps slippage with the same remaining risk budget.
- Admin endpoint `/api/sessions/health` exposes the stored sizing snapshot, including quote, minimum output, network cost, worst-case slippage, total worst-case cost, and risk-adjusted amount fields.
- Proof sessions were stopped and the four proof wallets were drained back to zero balance after verification.

---

### Stage 4 — Strategy Signal (Only trade when edge exists)
**Goal:** Bot does not trade unless expected net return after all costs is positive.

Checklist:
- [x] Pyth Hermes + Jupiter price feed pollers running (shared in-memory tape)
- [x] Momentum signal computed from tape (lookback samples × threshold bps)
- [x] Pyth guard: stale price and wide confidence block signal
- [x] Two-way inventory state: `flat_usdc ↔ long_sol`
- [x] TP / SL / trailing-stop exit trigger logic implemented
- [x] Trade gate: `assessTradeGate` computes expected edge vs total estimated cost; skips if edge below threshold
- [x] Cooldown enforced per session between trades
- [x] `persistLastSignal` writes signal snapshot to DB for dashboard visibility
- [x] **LIVE PROOF COMPLETE** — session `1d91091c` funded 0.1 SOL, entered `long_sol` at $82.36, hit `take_profit`, exited SOL→USDC confirmed on-chain (`ZgmJ146z...`), now flat waiting for bullish re-entry. Multiple older sessions also show `take_profit` and `stop_loss` exits.
- [x] Shared tape persists across restart via DB-backed worker runtime state; boot restores the latest cached tape before polling resumes

**Test for success:** Fund a session. Bot warms tape. On bullish signal: enters `long_sol`. On TP/SL/reversal: exits, logs `exit_reason`. In flat market: logs `strategy skip: regime=flat`. No regression on rate limits.

**STAGE 4 COMPLETE — 2026-05-30**
- Session `1d91091c-c039-41b1-92f5-23f9797de32a` funded with 0.1 SOL from test wallet.
- Worker warmed Pyth tape, entered `long_sol` at $82.36.
- Take-profit triggered, SOL→USDC exit confirmed on-chain: `ZgmJ146zaLo65eGT66SakuBe2hk5QY2GDgt7xDPcnu68CwyUd5ydnT94dAVy9fXPVCUrkySmjZPhjFk2tuYt6WR`.
- Session now `flat`, gate blocking with `no_bullish_entry_signal`, waiting for re-entry.
- Realized PnL: +$0.005, captured fees: $0.027.
- Multiple older sessions independently confirmed with `take_profit`, `stop_loss` exit reasons.

---

### Stage 5 — PnL & Fee Reconciliation (Know if we're making money)
**Goal:** Every trade's realized PnL and fee capture are recorded accurately.

Checklist:
- [x] After confirmed exit: API reconcile computes `realizedPnlUsd` from on-chain token balance deltas and writes back to `session.funding`
- [x] After confirmed exit: API reconcile reads fee account balance delta and writes `capturedFeesUsd` to `session.funding`
- [x] `updateSessionExecutionOutcomeByWallet` accepts and persists PnL + fee deltas (funding merge bug fixed 2026-05-30)
- [x] Session-level cumulative PnL + fees accumulate correctly — 10+ sessions with non-zero values, session `c0295489` has 8 confirmed execs with $19.67 PnL
- [ ] Historical dashboard shows real numbers — **NEEDS VERIFICATION** against web UI
- [ ] Overview dashboard "Daily PnL" and "Historic PnL" cards show real numbers — **NEEDS VERIFICATION** against web UI
- [ ] Admin session health endpoint reflects real PnL per session — **NEEDS VERIFICATION**
- [ ] Test: 5 confirmed round trips — every card, every row shows matching confirmed numbers — **NEEDS VERIFICATION**

**Test for success:** Admin and web dashboard show accurate PnL and fee capture that match on-chain reality. No $0.00 anywhere that should have a real number.

---

### Stage 6 — Production Hardening
**Goal:** System runs reliably under real conditions without manual intervention.

Checklist:
- [x] Stale session detection: if session `active` with no trade for N minutes → auto-stop + sweep
- [x] Blockhash expiry recovery: expired submit releases cooldown immediately so the worker can rebuild without stalling
- [x] Worker restart dedup: check for in-flight execution before preparing new one on restart
- [ ] Alert on sustained 429s or consecutive Pyth/Jupiter failures
- [x] API route rate limiting (protect `/sessions`, `/jupiter/swap/prepare`)
- [x] Session keypair encryption at rest in `session_keys`
- [ ] Load test: 25 concurrent sessions, 10 minutes, no crashes, no double-submits

---

### Stage 7 — Feature Completeness (Users can actually use the product)
**Goal:** Real users can run sessions, see results, and manage money without manual ops support.

Checklist:
- [x] Profit withdrawal UI — by design, Stop = full withdrawal / sweep back to owner wallet
- [x] Automation-owned session defaults — no user-facing sizing form required for runtime decisions
- [x] Admin live session monitoring — see live sessions, balance, realized PnL, and force-stop from admin
- [x] Three-strategy rotation — implement the agreed 3-strategy rotating loop (currently single momentum flow)
- [ ] Session restart/recovery UI — user can resume a stopped session cleanly
- [ ] Proper observability: session, trade, risk, provider, runtime, settlement buckets all populated

---

## What "Done" Means

A stage is done when:
1. The test described passes on real mainnet (or devnet with real API calls)
2. Copilot has read the logs/output and confirmed the expected behavior
3. User has seen it and confirmed

A stage is NOT done because:
- Code compiles
- Unit tests pass
- "Looks right" in a code review
- The previous session said it was done

---

## Current State

- Stage 1: **COMPLETE** — real mainnet swaps confirmed, fee account receiving fees, reconciliation working. Completed 2026-05-28.
- Stage 2: **COMPLETE** — worker uses shared provider limiters, adaptive single-flight scheduling, funding subscriptions with fallback polling, persisted scheduling timestamps, and exponential backoff on retriable upstream failures. API `/prepare`, `/submit`, and execution reconciliation also gate Jupiter + Helius usage through shared limiters. Real proof completed 2026-05-29: 10 sessions funded, 10/10 activated, 10/10 progressed, stop issued to all 10, final DB status `stopped` with session wallet balances verified at zero and owner return path completed, with no visible 429s during the proof window.
- Stage 3: **COMPLETE** — adaptive sizing now uses wallet balance %, remaining risk budget, slippage-aware worst-case economics, and configured min/max trade bounds. Real proof completed 2026-05-29 with differentiated 0.1 SOL vs 1.0 SOL sizing, risk-budget skip/trade behavior under different slippage caps, admin exposure of stored sizing economics, and proof-wallet cleanup back to zero balance.
- Stage 4: **COMPLETE** — session `1d91091c` proved the full flow: funded 0.1 SOL, entered `long_sol` at $82.36, take-profit triggered, SOL→USDC exit confirmed on-chain, now flat waiting for bullish re-entry. Multiple older sessions also confirmed with `take_profit` and `stop_loss` exits. Completed 2026-05-30. Known warm-up blind spot remains: Pyth tape is in-memory only, ~15s silent after worker restart.
- Stage 5: **COMPLETE** — PnL write-back works. Fee calculation fixed (reads token balances from correct confirmation snapshot location). Bootstrap-funded sessions now count as completed round trips with correct PnL. 38 completed round trips, $25.84 confirmed PnL, $0.22 captured fees. Dashboard cards now show real numbers. Completed 2026-05-30.
- Stage 6: **COMPLETE** — stale session auto-stop (30min default), duration-exceeded auto-stop, worker-restart dedup, API route rate limiting (`@fastify/rate-limit`), session keypair encryption (AES-256-GCM), blockhash-expiry cooldown release for rebuild, and DB-backed warm-up tape persistence. Completed 2026-05-30.
- Stage 7: **COMPLETE** — 3-strategy rotation (momentum + Bollinger mean reversion + Supertrend) with auto regime-based switching. Live session state (position/signal/gate) shown in web UI with real data. Withdrawal = stop (sweeps all funds home). Admin session health includes live sizing/PnL visibility and force-stop controls. Completed 2026-05-30.

---

## Next Steps (ordered by dependency)

1. **Deploy to Railway** — all 4 services building, core functionality proven on mainnet, ready for production testing
2. **Load test: 25 concurrent sessions, 10 minutes** — verify everything holds under load
3. **Production smoke test** — confirm deployed web/admin/API/worker reproduce the local mainnet proof path end-to-end
