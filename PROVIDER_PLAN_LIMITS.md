# Provider Plan Limits

As of 2026-06-03.

## Jupiter Pro (yearly)

Source: user-provided Jupiter pricing screenshot from the plan card.

- Price: $5000/year
- Included credits: 6B credits/year
- General API rate limit: 150 requests/second
- Additional usage: $1 per 1M credits
- Support/features shown on the card:
  - Priority support
  - Early access to new features

## Helius Business

Source: `https://www.helius.dev/pricing`.

- Price: $499/month
- Included credits: 100M credits/month
- RPC rate limit: 200 requests/second
- sendTransaction: 50/second
- sendBundle: 5/second
- DAS rate limit: 50 requests/second
- getProgramAccounts: 50/second
- Included features shown on the pricing page:
  - Staked Connections
  - Enhanced WebSockets
  - LaserStream gRPC
  - Priority chat support

## RogueZero capacity note

The code defaults now equal the real **90%-of-cap fleet ceilings** (10% safety headroom) and consume the upgraded provider headroom without requiring env overrides. The rate-limit buckets are DB-backed and shared fleet-wide across worker + API by key, so these are combined-fleet limits, not per-process.

Built-in repo defaults (90% of plan caps):

- Jupiter general limiter default: 135 RPS (90% of 150)
  - `services/worker/src/index.ts`
  - `services/api/src/index.ts`
- Helius RPC limiter default: 180 RPS (90% of 200)
  - `services/worker/src/index.ts`
  - `services/api/src/index.ts`
- Sender limiter in API: 45 RPS (90% of 50)
  - `services/api/src/index.ts`
- Runtime base concurrent capacity default: 350 sessions
  - `packages/runtime-config/src/index.ts`
- Runtime profiles (capacity = base / divisor; max open positions per bot):
  - `glide`: 87 concurrent capacity, 3 max positions (deep fallback)
  - `pulse`: 175 concurrent capacity, 10 max positions (first fallback)
  - `surge`: 350 concurrent capacity, bot-decided positions (healthy default)

Mode selection is **auto** by default: the worker auto-shift loop watches worst-lane provider pressure (Helius RPC budget, Jupiter budget, execution-queue saturation) and steps Surge → Pulse → Glide down under pressure (fast) and back up on recovery (slow). Admin can pin a mode or return to auto.

## Measured per-trade call accounting

Traced from the worker + API code (not assumed):

- One entry trade ≈ **1 Jupiter request : 7 Helius RPC requests** before optimization (build : 2 ALT loads + simulate + priority-fee + blockheight + 2 balance).
- **Helius RPC is the binding lane**, capping the fleet at ~25 entry trades/sec before optimization.
- ALT caching and subscription-backed balance reads cut per-trade Helius RPC to ~3, raising the ceiling to ~60 entry trades/sec.

## Optional env overrides

The defaults already match the 90% fleet caps. Only override if you want different headroom:

- `JUPITER_GENERAL_RPS` (default 135)
- `JUPITER_GENERAL_BURST` (default min(20, RPS))
- `HELIUS_RPC_RPS` (default 180)
- `HELIUS_RPC_BURST` (default min(20, RPS))
- `WORKER_BASE_CONCURRENT_CAPACITY` (default 350)
- `WORKER_SPEED_PROFILE` (startup hint only; auto-shift manages live mode)

## Practical interpretation

- Jupiter Pro raises RogueZero's Jupiter general bucket to the 135 RPS fleet cap (90% of 150).
- Helius Business raises RogueZero's Helius RPC bucket to the 180 RPS fleet cap (90% of 200), and Sender to 45 TPS (90% of 50).
- Concurrency is controlled by `WORKER_BASE_CONCURRENT_CAPACITY` (350) divided per mode; the auto-shift loop keeps combined fleet load under 90% of the binding lane.

## Bottom line

For planning purposes:

- Jupiter Pro = 150 RPS general, 6B credits/year (RogueZero uses 135 RPS, 90% cap)
- Helius Business = 200 RPC RPS, 100M credits/month (RogueZero uses 180 RPS, 90% cap)
- Code defaults now equal the real 90% fleet caps; the worker auto-manages Surge/Pulse/Glide for 350 concurrent bots.
