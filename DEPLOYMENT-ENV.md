# RogueZero — Deployment Env Manifest (Railway)

Single source of truth for environment variables across all services.

## Operating rules (do not break these)

1. **Every new env var MUST have a safe in-code default** (`Number(process.env.X ?? default)` /
   `process.env.X !== 'false'`). If a var is unset on Railway, the service must still boot and run
   the default. This is the existing codebase convention — keep it mandatory.
2. **Only the REQUIRED vars below have no safe default** (secrets / URLs). These MUST be set on
   Railway per service or the service will not work.
3. **When a feature adds a knob, add it to "PENDING FOR NEXT DEPLOY" in the SAME edit.** After a
   successful deploy, move it down into the per-service tuning list and clear the pending section.

---

## REQUIRED (no safe default — must be set on Railway)

| Var | Services | Notes |
|---|---|---|
| `DATABASE_PRIVATE_URL` | api, worker, admin | Tiger Cloud Postgres private URL. |
| `SESSION_KEY_ENCRYPTION_KEY` | api, worker | Encrypts/decrypts stored session keypairs. MUST match across api+worker. |
| `RZ_INTERNAL_SECRET` | api, worker, web | Shared internal auth secret. MUST match across all. |
| `API_URL` | worker | Worker throws on boot if missing. Points at the api service. |
| `HELIUS_API_KEY` | api | Helius RPC auth (server-side only). |
| `HELIUS_RPC_URL` | worker, scripts | Full Helius RPC URL. Server-side only. |
| `JUPITER_API_KEY` | api, worker, admin, scripts | Jupiter Pro API key for Router, Price v3, Token API v2 discovery, and route admission. |
| `JUPITER_API_KEY_*` | api, worker, scripts | Optional additional Jupiter keys; code dedupes and round-robins by variable name while preserving account-level rate limits. |
| `KEYAUTH_SELLER_KEY` | admin | KeyAuth license validation. |
| `NEXT_PUBLIC_API_URL` | web | Browser-visible api base. |
| `NEXT_PUBLIC_HELIUS_RPC_URL` / `NEXT_PUBLIC_SOLANA_RPC_URL` | web | Browser RPC endpoint. |
| `WEB_PUBLIC_ORIGIN` (or `FRONTEND_ORIGIN`) | api | CORS allow-origin for the web app. |
| `WEB_GATE_TEMP_PASSWORD` | web | Temp gate password (defaults to `1121` if unset — set in prod). |

> Secrets stay server-side only. Never put `HELIUS_API_KEY`, `RZ_INTERNAL_SECRET`,
> `SESSION_KEY_ENCRYPTION_KEY`, `DATABASE_PRIVATE_URL`, or `KEYAUTH_SELLER_KEY` in any
> `NEXT_PUBLIC_*` var or browser-delivered code.

---

## OPTIONAL (safe defaults in code — override only to tune)

Fee / swap:
- `JUPITER_PLATFORM_FEE_BPS` (default 30 in code; **set to 35** in prod to match fee model).

Rate limits / budgets (fleet-wide, 90% of provider caps):
- `JUPITER_GENERAL_RPS` (135), `HELIUS_RPC_RPS` (180), `HELIUS_MONTHLY_CREDIT_LIMIT`,
  `JUPITER_MONTHLY_REQUEST_LIMIT`, `*_BUDGET_ENFORCE` flags.

Worker loop / lifecycle: `WORKER_POLL_INTERVAL_MS` (5000), `WORKER_SPEED_PROFILE`,
`WORKER_AUTO_SHIFT_*`, `WORKER_BASE_CONCURRENT_CAPACITY` (350), timeouts.

Token universe (already present, many knobs): `WORKER_TOKEN_UNIVERSE_*`,
`WORKER_UNIVERSE_SCOUT_*`, `TOKEN_ADMISSION_*` (scripts).

Profit payout: `WORKER_MIN_PROFIT_TRANSFER_USD` (0.25).

> Full list of tuning knobs lives in code (`process.env.*` with `?? default`). This file tracks the
> ones that MATTER for a working deploy plus anything NEW per feature.

---

## PENDING FOR NEXT DEPLOY

- **Item 2/4 (ATR exits)** — safe defaults in code; add to Railway only if tuning is needed:
   - `WORKER_ATR_TP_MULT` default `1.8`
   - `WORKER_ATR_SL_MULT` default `1.0`
   - `WORKER_ATR_TRAIL_MULT` default `0.8`
   - `WORKER_EXIT_COST_FLOOR_BPS` default `60`
- **Item 3 (USDC base)** — safe defaults in code; add to Railway only if tuning is needed:
   - `WORKER_SOL_FEE_RESERVE_LAMPORTS` default = worker SOL operating reserve
   - `WORKER_USDC_OPERATING_RESERVE_ATOMIC` default `0`
- **Item 6 (real universe)** — safe defaults in code; add to Railway/scripts only if tuning is needed:
   - `JUPITER_TOKEN_API_BASE_URL` default `https://api.jup.ag/tokens/v2` (**not Lite**)
   - `JUPITER_QUOTE_BASE_URL` default `https://api.jup.ag/swap/v2/order` (**not Lite**)
   - `TOKEN_ADMISSION_SOURCE_LIMIT` default `250`; sources follow Jupiter docs: `toptrending`, `toptraded`, `toporganicscore`, `tag?query=verified`, `recent`
   - `TOKEN_ADMISSION_MAX_5_USDC_IMPACT_BPS` default `50`
   - `TOKEN_ADMISSION_MAX_10_USDC_IMPACT_BPS` default `100`
   - `TOKEN_ADMISSION_REQUIRE_EXIT_ROUTES` default `true`
   - `TOKEN_ADMISSION_REQUIRE_VERIFIED` default `true`
   - `TOKEN_ADMISSION_MIN_ORGANIC_SCORE` default `50`
   - `TOKEN_ADMISSION_MIN_LIQUIDITY_USD` default `50000`
   - `TOKEN_ADMISSION_MIN_HOLDER_COUNT` default `1000`
   - `TOKEN_ADMISSION_MIN_24H_VOLUME_USD` default `25000`
   - `TOKEN_ADMISSION_MAX_TOP_HOLDERS_PCT` default `35`
   - `TOKEN_ADMISSION_MAX_DEV_BALANCE_PCT` default `5`
   - `TOKEN_ADMISSION_REJECT_UNKNOWN_DEV_BALANCE` default `false`
   - `TOKEN_ADMISSION_REQUIRE_MINT_AUTH_DISABLED` default `true`
   - `TOKEN_ADMISSION_REQUIRE_FREEZE_AUTH_DISABLED` default `true`
   - `TOKEN_ADMISSION_REJECT_SUS` default `true`
   - `TOKEN_SYNC_SOURCE_LIMIT` default sync limit argument; sources follow Jupiter docs: `toptrending`, `toptraded`, `toporganicscore`, `tag?query=verified`, `recent`

### Reserved names for upcoming features (will be filled when built)
- **Item 1 (payout-at-exit):** no new vars (reuses `WORKER_MIN_PROFIT_TRANSFER_USD`).
- **Item 2/4 (ATR exits):** added above; safe defaults so unset deploys still boot and run.
- **Item 3 (USDC base):** added above; safe defaults so unset deploys still boot and run.
- **Item 6 (real universe):** in progress above. Uses Jupiter Pro `api.jup.ag`, not deprecated Lite endpoints.
