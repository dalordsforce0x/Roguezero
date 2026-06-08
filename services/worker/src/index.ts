import { createDecipheriv, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';
import bs58 from 'bs58';
import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  SystemProgram,
  TransactionMessage,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  getAccount,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  createCloseAccountInstruction,
  getMint,
  getAccountLenForMint,
  unpackAccount,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  type Account as SplTokenAccount,
  type Mint as SplTokenMint,
} from '@solana/spl-token';
import { createMonthlyBudgetGovernor, createSharedTokenBucket, getExponentialBackoffDelayMs } from '@roguezero/provider-governor';
import {
  createRoundRobinKeySelector,
  computeTradeAmountLamports,
  getDatabaseConnectionUrl,
  getHeliusRpcUrls,
  getJupiterPriceConfig,
  getPythPriceConfig,
  getRuntimeSpeedProfile,
  getRuntimeConfigReport,
  getWorkerFundingThresholds,
  getWorkerPositionExitPolicy,
  getWorkerPricePollPolicy,
  getWorkerSignalPolicy,
  getWorkerSizingPolicy,
  normalizeRuntimeSpeedProfileName,
  type RuntimeSpeedProfileName,
  type JupiterPriceConfig,
  type PythPriceConfig,
  type TradeSizingDecision,
  type WorkerPositionExitPolicy,
  type WorkerPricePollPolicy,
  type WorkerSignalPolicy,
} from '@roguezero/runtime-config';
import {
  DEFAULT_ROTATION_INTERVAL_MINUTES,
  buildFlatSessionPositionState,
  mergeSessionServiceControl,
  summarizePositionsState,
  type Session,
  type SessionPositionState,
  type SessionPositionsState,
  type SessionServiceControlPatch,
} from '@roguezero/session-schema';
import {
  computePrePrepareEntryGate,
  computeFullExitAmountAtomic,
  computeGasRefillPlan,
  computeTrendingEntryShapeGate,
  resolveTradeGateAssessment,
  shouldApplyPostExitSolReserveProtection,
  shouldForceExitExecution,
  type TradeDirection,
  type TradeGateAssessment,
} from './tradeExecutionPolicy.js';
import {
  computeSessionSolSweepLamports,
  getResidualTokenAccounts,
  hasResidualWalletState,
  isBrickedResidualWallet,
} from './stopRecoveryPolicy.js';
import {
  DEFAULT_BOLLINGER_CONFIG,
  DEFAULT_SUPERTREND_CONFIG,
  computeBollingerSignal,
  computeAtrFromTape,
  computeSupertrendSignal,
  getNextStrategyInSequence,
  getStrategyScanOrder,
  type BollingerConfig,
  type PriceSample,
  type StrategyKey,
  type SupertrendConfig,
} from './strategies.js';

dotenv.config({ path: '../../.env' });

// â”€â”€ Config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const configReport = getRuntimeConfigReport(process.env);
if (!process.env.API_URL) {
  throw new Error('API_URL must be set on the worker service');
}
const API_BASE = process.env.API_URL;
const WORKER_INTERNAL_SECRET = process.env.RZ_INTERNAL_SECRET?.trim() ?? '';
const POLL_MS  = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 5000);
const MIN_LOOP_MS = Number(process.env.WORKER_MIN_LOOP_INTERVAL_MS ?? 250);
const LOOP_JITTER_RATIO = Number(process.env.WORKER_LOOP_JITTER_RATIO ?? 0.1);
const FUNDING_POLL_FALLBACK_MS = Number(process.env.WORKER_FUNDING_POLL_FALLBACK_MS ?? 60000);
// Active session-wallet balance is served from a subscription-backed cache, revalidated by
// RPC at most this often. onAccountChange keeps it fresh between revalidations; the TTL is a
// safety net against websocket gaps. Cuts the per-cycle pre-trade balance RPC for 350 bots.
const BALANCE_CACHE_TTL_MS = Number(process.env.WORKER_BALANCE_CACHE_TTL_MS ?? 60000);
const AWAITING_FUNDING_TIMEOUT_MINUTES = Number(process.env.WORKER_AWAITING_FUNDING_TIMEOUT_MINUTES ?? 3);
const POST_SUBMIT_RECONCILE_GRACE_MS = Number(process.env.WORKER_POST_SUBMIT_RECONCILE_GRACE_MS ?? 10000);
const STALE_SESSION_MINUTES = Number(process.env.WORKER_STALE_SESSION_MINUTES ?? 0);
const EXECUTION_QUEUE_CLAIMS_PER_TICK = Number(process.env.WORKER_EXECUTION_QUEUE_CLAIMS_PER_TICK ?? 5);
const EXECUTION_QUEUE_LOCK_MS = Number(process.env.WORKER_EXECUTION_QUEUE_LOCK_MS ?? 120000);
// Shared DB-backed fleet buckets (same keys in worker + API). Defaults are the
// real provider 90%-of-cap fleet ceilings for 350 bots:
//   Jupiter Pro general: 150 RPS cap -> 135 RPS (90%)
//   Helius Business RPC: 200 RPS cap -> 180 RPS (90%)
const JUPITER_GENERAL_RPS = Number(process.env.JUPITER_GENERAL_RPS ?? 135);
const JUPITER_GENERAL_BURST = Number(process.env.JUPITER_GENERAL_BURST ?? Math.min(20, JUPITER_GENERAL_RPS));
const HELIUS_RPC_RPS = Number(process.env.HELIUS_RPC_RPS ?? 180);
const HELIUS_RPC_BURST = Number(process.env.HELIUS_RPC_BURST ?? Math.min(20, HELIUS_RPC_RPS));
const HELIUS_MONTHLY_CREDIT_LIMIT = Number(process.env.HELIUS_MONTHLY_CREDIT_LIMIT ?? 100_000_000);
const HELIUS_MONTHLY_BUDGET_ENFORCE = process.env.HELIUS_MONTHLY_BUDGET_ENFORCE !== 'false';
// Jupiter Pro yearly includes 6B credits/year (~500M/month equivalent).
const JUPITER_MONTHLY_REQUEST_LIMIT = Number(process.env.JUPITER_MONTHLY_REQUEST_LIMIT ?? 500_000_000);
const JUPITER_MONTHLY_BUDGET_ENFORCE = process.env.JUPITER_MONTHLY_BUDGET_ENFORCE === 'true';
const DATABASE_QUERY_TIMEOUT_MS = Number(process.env.DATABASE_QUERY_TIMEOUT_MS ?? 15000);
const DATABASE_STATEMENT_TIMEOUT_MS = Number(process.env.DATABASE_STATEMENT_TIMEOUT_MS ?? 12000);
const DATABASE_LOCK_TIMEOUT_MS = Number(process.env.DATABASE_LOCK_TIMEOUT_MS ?? 5000);
const DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS = Number(process.env.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS ?? 10000);
const DEPLOY_CANARY = process.env.DEPLOY_CANARY ?? 'rz-canary-2026-06-01-01';
const WORKER_SOURCE_REV = 'entry-reject-cooldown-v1-2026-06-07';
const fundingThresholds = getWorkerFundingThresholds(process.env);
const sizingPolicy = getWorkerSizingPolicy(process.env);
const pricePollPolicy: WorkerPricePollPolicy = getWorkerPricePollPolicy(process.env);
const signalPolicy: WorkerSignalPolicy = getWorkerSignalPolicy(process.env);
const positionExitPolicy: WorkerPositionExitPolicy = getWorkerPositionExitPolicy(process.env);
let jupiterPriceConfig: JupiterPriceConfig | null = null;
let jupiterPriceApiKeySelector: ReturnType<typeof createRoundRobinKeySelector> | null = null;
let pythPriceConfig: PythPriceConfig | null = null;
try {
  jupiterPriceConfig = getJupiterPriceConfig(process.env);
  jupiterPriceApiKeySelector = createRoundRobinKeySelector(jupiterPriceConfig.apiKeys);
  pythPriceConfig = getPythPriceConfig(process.env);
} catch (err) {
  console.warn('[worker] price feed config unavailable:', String(err));
  jupiterPriceApiKeySelector = null;
}

// SOL mint address
const SOL_MINT  = 'So11111111111111111111111111111111111111112';
// USDC on mainnet
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
// Reserves retained on the session wallet so simulation, Sender tip, priority
// fees, and route-setup rent are always covered. The actual per-trade swap
// size is now computed adaptively via computeTradeAmountLamports() (Stage 3).
const MAX_ROUTE_SETUP_LAMPORTS = fundingThresholds.maxRouteSetupLamports;
const OPERATING_BUFFER_LAMPORTS = fundingThresholds.operatingBufferLamports;
const TX_FEE_LAMPORTS = fundingThresholds.txFeeLamports;
const MIN_TRADEABLE_LAMPORTS = fundingThresholds.minimumTradeableLamports;
const FUNDING_READY_SLOP_LAMPORTS = Number(process.env.WORKER_FUNDING_READY_SLOP_LAMPORTS ?? 5_000);
const MIN_SOL_OPERATING_RESERVE_LAMPORTS = TX_FEE_LAMPORTS + OPERATING_BUFFER_LAMPORTS;
const MIN_USDC_ENTRY_ATOMIC = Number(process.env.WORKER_MIN_USDC_ENTRY_ATOMIC ?? 1_000_000);
const MIN_USDC_POSITION_NOTIONAL_ATOMIC = Number(
  process.env.WORKER_MIN_USDC_POSITION_NOTIONAL_ATOMIC ?? MIN_USDC_ENTRY_ATOMIC,
);
const SOL_FEE_RESERVE_LAMPORTS = Number(process.env.WORKER_SOL_FEE_RESERVE_LAMPORTS ?? MIN_SOL_OPERATING_RESERVE_LAMPORTS);
// ── SOL gas keep-alive ───────────────────────────────────────────────────────
// Every swap (including selling back to SOL) costs SOL for fees + tip + rent. If
// a session's SOL fee reserve drains while it still holds USDC working capital,
// the loop would otherwise stall (`insufficient_sol_fee_reserve`) or stop
// (`depleted`) with money still in the wallet. The keep-alive converts a small
// USDC slice back into SOL BEFORE the reserve is exhausted, so sessions keep
// compounding instead of giving up.
// Cost of a single refill swap (fee + route-setup rent) — also the hard cutoff
// below which a refill swap can no longer be afforded.
const GAS_REFILL_SWAP_COST_LAMPORTS = Number(
  process.env.WORKER_GAS_REFILL_SWAP_COST_LAMPORTS
  ?? (TX_FEE_LAMPORTS + MAX_ROUTE_SETUP_LAMPORTS),
);
// Trigger a refill once SOL falls to/below the operating reserve plus one swap
// cost — i.e. low, but still affordable to act on.
const GAS_REFILL_TRIGGER_LAMPORTS = Number(
  process.env.WORKER_GAS_REFILL_TRIGGER_LAMPORTS
  ?? (MIN_SOL_OPERATING_RESERVE_LAMPORTS + GAS_REFILL_SWAP_COST_LAMPORTS),
);
// Refill back up to a comfortable multi-swap buffer so we do not refill every loop.
const GAS_REFILL_BUFFER_SWAPS = Number(process.env.WORKER_GAS_REFILL_BUFFER_SWAPS ?? 4);
const GAS_REFILL_TARGET_LAMPORTS = Number(
  process.env.WORKER_GAS_REFILL_TARGET_LAMPORTS
  ?? (MIN_SOL_OPERATING_RESERVE_LAMPORTS + (GAS_REFILL_BUFFER_SWAPS * GAS_REFILL_SWAP_COST_LAMPORTS)),
);
// USDC kept untouched so a refill never strands trading capital below an entry.
const GAS_REFILL_MIN_USDC_KEEP_ATOMIC = Number(process.env.WORKER_GAS_REFILL_MIN_USDC_KEEP_ATOMIC ?? 0);
// Smallest USDC slice worth converting for a refill (default 0.20 USDC).
const GAS_REFILL_MIN_USDC_ATOMIC = Number(process.env.WORKER_GAS_REFILL_MIN_USDC_ATOMIC ?? 200_000);
const GAS_REFILL_SLIPPAGE_HEADROOM = Number(process.env.WORKER_GAS_REFILL_SLIPPAGE_HEADROOM ?? 1.02);
const USDC_OPERATING_RESERVE_ATOMIC = Number(process.env.WORKER_USDC_OPERATING_RESERVE_ATOMIC ?? 0);
const SOL_TO_USDC_CONVERSION_RESERVE_LAMPORTS = Math.max(
  SOL_FEE_RESERVE_LAMPORTS,
  MIN_SOL_OPERATING_RESERVE_LAMPORTS,
) + (TX_FEE_LAMPORTS * 4) + (MAX_ROUTE_SETUP_LAMPORTS * 2);
const MIN_ENTRY_SIGNAL_PERSISTENCE_SAMPLES = Number(process.env.WORKER_MIN_ENTRY_SIGNAL_PERSISTENCE_SAMPLES ?? 1);
const MAX_QUOTE_PRICE_IMPACT_BPS = Number(process.env.WORKER_MAX_QUOTE_PRICE_IMPACT_BPS ?? 120);
const WORKER_UNIVERSE_SCOUT_ENABLED = process.env.WORKER_UNIVERSE_SCOUT_ENABLED !== 'false';
const WORKER_UNIVERSE_SCOUT_MAX_CANDIDATES = Number(process.env.WORKER_UNIVERSE_SCOUT_MAX_CANDIDATES ?? 20);
const WORKER_UNIVERSE_SCOUT_REQUIRE_PERSISTENT_BULLISH = process.env.WORKER_UNIVERSE_SCOUT_REQUIRE_PERSISTENT_BULLISH === 'true';
const WORKER_UNIVERSE_SCOUT_ALLOW_ROUTED_FALLBACK = process.env.WORKER_UNIVERSE_SCOUT_ALLOW_ROUTED_FALLBACK !== 'false';
const WORKER_ENTRY_CORE_UNIVERSE_ONLY = process.env.WORKER_ENTRY_CORE_UNIVERSE_ONLY === 'true';
const WORKER_BLOCK_PUMP_MINT_ENTRIES = process.env.WORKER_BLOCK_PUMP_MINT_ENTRIES !== 'false';
const WORKER_UNIVERSE_SCOUT_MAX_ENTRY_PRICE_IMPACT_BPS = Number(
  process.env.WORKER_UNIVERSE_SCOUT_MAX_ENTRY_PRICE_IMPACT_BPS
  ?? process.env.WORKER_UNIVERSE_SCOUT_MAX_SOL_PRICE_IMPACT_BPS
  ?? 50,
);
// FORCED-SELL BRAKE. The time-decay take-profit ladder lowers a position's take-
// profit target toward the cost floor as it ages, which DUMPS green-but-stuck
// bags near breakeven-minus-fees -- a forced loss exit. Disabled by default so
// winners ride the trailing stop instead of being force-sold flat. Set true to
// re-enable the decay ladder.
const WORKER_TP_TIME_DECAY_ENABLED = process.env.WORKER_TP_TIME_DECAY_ENABLED === 'true';
const WORKER_MAX_CONSECUTIVE_LOSSES = Number(process.env.WORKER_MAX_CONSECUTIVE_LOSSES ?? 2);
const WORKER_MAX_BAD_FILL_STREAK = Number(process.env.WORKER_MAX_BAD_FILL_STREAK ?? 2);
const WORKER_SOFT_RISK_COOLDOWN_MS = Number(process.env.WORKER_SOFT_RISK_COOLDOWN_MS ?? 5 * 60_000);
// Correlation diversification + post-loss cooldown controls.
// Cap how many open positions may share a correlation cluster (e.g. all the
// SOL-beta LSTs move together, so holding SOL + JitoSOL + mSOL + bSOL is one
// directional bet across four slots). Default 1 = strict diversification.
const WORKER_MAX_OPEN_PER_CLUSTER = Number(process.env.WORKER_MAX_OPEN_PER_CLUSTER ?? 1);
// After a stop_loss, exclude the stopped token's whole cluster from new entries
// for this window so the bot does not immediately re-buy what it just sold.
const WORKER_STOP_LOSS_LOCK_MS = Number(process.env.WORKER_STOP_LOSS_LOCK_MS ?? 10 * 60_000);
// Post-prepare entry reject cooldown. If a candidate passes the cheap scout but
// then fails a cost/economics/route gate, do not let it monopolize the next few
// cycles. This is intentionally short and in-memory: prices move every minute,
// so the token can re-enter consideration quickly without pinning selection.
const WORKER_ENTRY_REJECT_COOLDOWN_MS = Number(process.env.WORKER_ENTRY_REJECT_COOLDOWN_MS ?? 3 * 60_000);
// In a flat tape there is no persistent bullish candidate; only a routed-fallback
// pick survives. Suppress those noise entries so we only buy real momentum.
const WORKER_FLAT_REGIME_SUPPRESS_FALLBACK = process.env.WORKER_FLAT_REGIME_SUPPRESS_FALLBACK !== 'false';
const WORKER_VOLATILITY_SIZING_ENABLED = process.env.WORKER_VOLATILITY_SIZING_ENABLED !== 'false';
const WORKER_VOLATILITY_LOOKBACK_SAMPLES = Number(process.env.WORKER_VOLATILITY_LOOKBACK_SAMPLES ?? 12);
const WORKER_VOLATILITY_TARGET_BPS = Number(process.env.WORKER_VOLATILITY_TARGET_BPS ?? 40);
const WORKER_VOLATILITY_MIN_SIZE_BPS = Number(process.env.WORKER_VOLATILITY_MIN_SIZE_BPS ?? 2500);
const WORKER_ROUTE_STABILITY_ENABLED = process.env.WORKER_ROUTE_STABILITY_ENABLED !== 'false';
const WORKER_ROUTE_STABILITY_SAMPLES = Number(process.env.WORKER_ROUTE_STABILITY_SAMPLES ?? 2);
const WORKER_ROUTE_STABILITY_DELAY_MS = Number(process.env.WORKER_ROUTE_STABILITY_DELAY_MS ?? 350);
const WORKER_ROUTE_STABILITY_MAX_OUTPUT_DRIFT_BPS = Number(process.env.WORKER_ROUTE_STABILITY_MAX_OUTPUT_DRIFT_BPS ?? 30);
const WORKER_ROUTE_STABILITY_MAX_IMPACT_DRIFT_BPS = Number(process.env.WORKER_ROUTE_STABILITY_MAX_IMPACT_DRIFT_BPS ?? 15);
const TOKEN_UNIVERSE_AUTO_SORT_ENABLED = process.env.WORKER_TOKEN_UNIVERSE_AUTO_SORT_ENABLED !== 'false';
// For 350-bot fleet breadth, default to scouting disabled rows too, then let
// autosort/admission decide what gets enabled.
const TOKEN_UNIVERSE_INCLUDE_DISABLED_CANDIDATES = process.env.WORKER_TOKEN_UNIVERSE_INCLUDE_DISABLED_CANDIDATES === 'true';
const TOKEN_UNIVERSE_AUTO_SORT_INTERVAL_MS = Number(process.env.WORKER_TOKEN_UNIVERSE_AUTO_SORT_INTERVAL_MS ?? 180000);
const TOKEN_UNIVERSE_AUTO_SORT_MAX_MINTS = Number(process.env.WORKER_TOKEN_UNIVERSE_AUTO_SORT_MAX_MINTS ?? 200);
const TOKEN_UNIVERSE_AUTO_SORT_TOP_ENABLED = Number(process.env.WORKER_TOKEN_UNIVERSE_AUTO_SORT_TOP_ENABLED ?? 120);
const TOKEN_UNIVERSE_AUTO_SORT_NOTIONAL_USDC_ATOMIC = Number(process.env.WORKER_TOKEN_UNIVERSE_AUTO_SORT_NOTIONAL_USDC_ATOMIC ?? 10_000_000);
const TOKEN_UNIVERSE_AUTO_SORT_MAX_PRICE_IMPACT_BPS = Number(process.env.WORKER_TOKEN_UNIVERSE_AUTO_SORT_MAX_PRICE_IMPACT_BPS ?? 200);
const TOKEN_UNIVERSE_ENGINE_MAX_STALE_MS = Number(process.env.WORKER_TOKEN_UNIVERSE_ENGINE_MAX_STALE_MS ?? 900000);
const TOKEN_UNIVERSE_DEAD_RUN_THRESHOLD = Number(process.env.WORKER_TOKEN_UNIVERSE_DEAD_RUN_THRESHOLD ?? 6);
const TOKEN_UNIVERSE_HEALTH_MAX_TRACKED_MINTS = Number(process.env.WORKER_TOKEN_UNIVERSE_HEALTH_MAX_TRACKED_MINTS ?? 512);
const TOKEN_UNIVERSE_DEAD_PRUNE_ENABLED = process.env.WORKER_TOKEN_UNIVERSE_DEAD_PRUNE_ENABLED !== 'false';
const TOKEN_UNIVERSE_ADMISSION_STREAK = Number(process.env.WORKER_TOKEN_UNIVERSE_ADMISSION_STREAK ?? 2);
const TOKEN_UNIVERSE_EVICTION_STREAK = Number(process.env.WORKER_TOKEN_UNIVERSE_EVICTION_STREAK ?? 3);
const TOKEN_UNIVERSE_MIN_STAY_RUNS = Number(process.env.WORKER_TOKEN_UNIVERSE_MIN_STAY_RUNS ?? 4);
const TOKEN_UNIVERSE_EVICTION_RANK_BUFFER = Number(process.env.WORKER_TOKEN_UNIVERSE_EVICTION_RANK_BUFFER ?? 2);
const TOKEN_UNIVERSE_PROBE_FREEZE_FAILURE_STREAK = Number(process.env.WORKER_TOKEN_UNIVERSE_PROBE_FREEZE_FAILURE_STREAK ?? 3);
const TOKEN_UNIVERSE_PROBE_UNFREEZE_HEALTHY_STREAK = Number(process.env.WORKER_TOKEN_UNIVERSE_PROBE_UNFREEZE_HEALTHY_STREAK ?? 2);
// Scheduled new-token discovery (the "feeder"): runs scripts/admit-token-candidates.mjs
// on a timer so brand-new hot tokens get exit-route-tested and added to the universe
// automatically. Runs ADDITIVE-ONLY (never disables existing rows; eviction is owned by
// the autosort engine). This is the second half of the living universe; autosort only
// re-ranks/prunes tokens already in the table.
const TOKEN_ADMISSION_SCHEDULE_ENABLED = process.env.WORKER_TOKEN_ADMISSION_SCHEDULE_ENABLED !== 'false';
const TOKEN_ADMISSION_SCHEDULE_INTERVAL_MS = Number(process.env.WORKER_TOKEN_ADMISSION_SCHEDULE_INTERVAL_MS ?? 3_600_000);
const TOKEN_ADMISSION_SCHEDULE_INITIAL_DELAY_MS = Number(process.env.WORKER_TOKEN_ADMISSION_SCHEDULE_INITIAL_DELAY_MS ?? 120_000);
const TOKEN_UNIVERSE_AUTOSORT_STATE_WRITE_MIN_INTERVAL_MS = Number(process.env.WORKER_TOKEN_UNIVERSE_AUTOSORT_STATE_WRITE_MIN_INTERVAL_MS ?? 120000);
const TOKEN_UNIVERSE_METADATA_WRITE_MIN_INTERVAL_MS = Number(process.env.WORKER_TOKEN_UNIVERSE_METADATA_WRITE_MIN_INTERVAL_MS ?? 300000);
const MARKET_SCANNER_CANDIDATE_TTL_MS = Number(process.env.WORKER_MARKET_SCANNER_CANDIDATE_TTL_MS ?? 180000);
const MARKET_SCANNER_MAX_PERSISTED_CANDIDATES = Number(process.env.WORKER_MARKET_SCANNER_MAX_PERSISTED_CANDIDATES ?? 50);
const WORKER_TRENDING_ENTRY_SHAPE_GATE_ENABLED = process.env.WORKER_TRENDING_ENTRY_SHAPE_GATE_ENABLED !== 'false';
const WORKER_TRENDING_ENTRY_SHAPE_MIN_SAMPLES = Number(process.env.WORKER_TRENDING_ENTRY_SHAPE_MIN_SAMPLES ?? 12);
const WORKER_EXIT_TELEMETRY_ENABLED = process.env.WORKER_EXIT_TELEMETRY_ENABLED !== 'false';
const WORKER_ADAPTIVE_EXIT_SHADOW_ENABLED = process.env.WORKER_ADAPTIVE_EXIT_SHADOW_ENABLED === 'true';
const WORKER_GRID_CHOP_SHADOW_ENABLED = process.env.WORKER_GRID_CHOP_SHADOW_ENABLED === 'true';
// Expected REAL exit-leg slippage in bps (observed confirmed fills ran ~1-17 bps). Used only by the
// honest break-even telemetry below, NOT by the live exit cost-floor. The live floor still uses the
// conservative maxSlippage cap; this measures what a partial-TP would net against ACTUAL friction.
const WORKER_EXIT_EXPECTED_SLIPPAGE_BPS = Number(process.env.WORKER_EXIT_EXPECTED_SLIPPAGE_BPS ?? 15);
// Step 4 (real exec, Noah-only, default OFF): when enabled + canary-scoped, the worker may sell a
// token-class fraction of a position that has cleared its honest-break-even partial-TP trigger,
// but only when no hard exit (stop/TP/reversal) is competing that cycle. One partial per position.
const WORKER_PARTIAL_TP_ENABLED = process.env.WORKER_PARTIAL_TP_ENABLED === 'true';
const WORKER_PARTIAL_TP_MAX_FRACTION_BPS = Number(process.env.WORKER_PARTIAL_TP_MAX_FRACTION_BPS ?? 6000);
// Phase 4 (Noah-only, default OFF): when enabled + canary-scoped, exit ATR multipliers become
// token-class aware (runners get a wider take-profit leash; majors/betas bank quicker). Floors
// and the no-TP-below-breakeven rule are unchanged, so stops are never disabled.
const WORKER_TOKEN_CLASS_EXIT_PROFILES_ENABLED = process.env.WORKER_TOKEN_CLASS_EXIT_PROFILES_ENABLED === 'true';
// Class-weighted entry sizing (Noah-only, default OFF): reallocate capital away from the
// token class that structurally cannot clear the ~50bps round-trip break-even (trend_liquid,
// median peak ~21bps, 62% of position-time) toward the classes that do (sol_beta/long_tail/
// major). This is SIZING, not a gate: it never blocks an entry, only scales its notional.
// Multipliers are bps of the base entry size (10000 = 1.0x). With the flag OFF the sizing is
// computed for shadow telemetry only and never applied.
const WORKER_CLASS_ENTRY_SIZING_ENABLED = process.env.WORKER_CLASS_ENTRY_SIZING_ENABLED === 'true';
const WORKER_CLASS_SIZE_MAJOR_BPS = Number(process.env.WORKER_CLASS_SIZE_MAJOR_BPS ?? 10000);
const WORKER_CLASS_SIZE_SOL_BETA_BPS = Number(process.env.WORKER_CLASS_SIZE_SOL_BETA_BPS ?? 7000);
const WORKER_CLASS_SIZE_TREND_LIQUID_BPS = Number(process.env.WORKER_CLASS_SIZE_TREND_LIQUID_BPS ?? 2000);
const WORKER_CLASS_SIZE_LONG_TAIL_BPS = Number(process.env.WORKER_CLASS_SIZE_LONG_TAIL_BPS ?? 10000);
const WORKER_EXIT_SHADOW_HISTORY_ENABLED = process.env.WORKER_EXIT_SHADOW_HISTORY_ENABLED !== 'false';
const WORKER_ADAPTIVE_EXIT_CANARY_SESSION_ID = process.env.WORKER_ADAPTIVE_EXIT_CANARY_SESSION_ID?.trim() || null;
// Sessions are ephemeral (a fresh session_wallet + session id every funding cycle), so
// pinning the canary to a single session id forces an env change + redeploy every time a
// new Noah session is created. Scoping by the stable OWNER wallet (the DaLordsForce test
// wallet that funds Noah) lets every new ephemeral Noah session auto-enroll as the canary
// with zero redeploy. Real customer wallets never match, so they are never shadow-scoped.
const WORKER_ADAPTIVE_EXIT_CANARY_OWNER_WALLET = process.env.WORKER_ADAPTIVE_EXIT_CANARY_OWNER_WALLET?.trim() || null;
const WORKER_TRENDING_ENTRY_CHASE_LOOKBACK_SAMPLES = Number(process.env.WORKER_TRENDING_ENTRY_CHASE_LOOKBACK_SAMPLES ?? 4);
const WORKER_TRENDING_ENTRY_MAX_RECENT_SURGE_BPS = Number(process.env.WORKER_TRENDING_ENTRY_MAX_RECENT_SURGE_BPS ?? 80);
const WORKER_TRENDING_ENTRY_MIN_PULLBACK_BPS = Number(process.env.WORKER_TRENDING_ENTRY_MIN_PULLBACK_BPS ?? 35);
const WORKER_TRENDING_ENTRY_MIN_RECLAIM_BPS = Number(process.env.WORKER_TRENDING_ENTRY_MIN_RECLAIM_BPS ?? 20);
const WORKER_TRENDING_ENTRY_MAX_RANGE_POSITION_BPS = Number(process.env.WORKER_TRENDING_ENTRY_MAX_RANGE_POSITION_BPS ?? 8500);
const WORKER_TRENDING_ENTRY_MAX_NEGATIVE_WINDOW_BPS = Number(process.env.WORKER_TRENDING_ENTRY_MAX_NEGATIVE_WINDOW_BPS ?? 250);
const RUNTIME_CONTROL_KEY = 'global_live_runtime';
const RUNTIME_CONTROL_REFRESH_MS = Number(process.env.RUNTIME_CONTROL_REFRESH_MS ?? 5000);
let liveSpeedProfileName: RuntimeSpeedProfileName = normalizeRuntimeSpeedProfileName(process.env.WORKER_SPEED_PROFILE);
let liveSpeedProfile = getRuntimeSpeedProfile(liveSpeedProfileName, process.env);
let lastRuntimeControlRefreshAt = 0;

// ── Fleet auto-shift (Surge/Pulse/Glide) ────────────────────────────────────
// The worker is the single fleet-wide throttle for all bots. It watches real
// provider pressure (Helius + Jupiter monthly-budget projection) and real-time
// execution-queue saturation, then shifts the live speed profile so combined
// fleet load stays under 90% of every provider lane. Downshift (toward glide)
// is fast for safety; upshift (toward surge) is slow to avoid flapping. When an
// operator pins the mode (modeSource === 'manual') the worker only computes the
// recommendation and never applies it.
type BudgetPressureLevel = 'normal' | 'watch' | 'throttle' | 'halt';
type LaneBudgetPressure = { pressure: BudgetPressureLevel; usageRatio: number; at: number };
let latestHeliusBudgetPressure: LaneBudgetPressure = { pressure: 'normal', usageRatio: 0, at: 0 };
let latestJupiterBudgetPressure: LaneBudgetPressure = { pressure: 'normal', usageRatio: 0, at: 0 };
let liveModeSource: 'auto' | 'manual' = 'auto';
let liveEntriesEnabled: boolean = true;
let liveMaintenanceReason: string | null = null;

const AUTO_SHIFT_ENABLED = process.env.WORKER_AUTO_SHIFT_ENABLED !== 'false';
const AUTO_SHIFT_EVAL_MS = Number(process.env.WORKER_AUTO_SHIFT_EVAL_MS ?? 15_000);
const AUTO_SHIFT_DOWNSHIFT_SAMPLES = Number(process.env.WORKER_AUTO_SHIFT_DOWNSHIFT_SAMPLES ?? 2);
const AUTO_SHIFT_UPSHIFT_SAMPLES = Number(process.env.WORKER_AUTO_SHIFT_UPSHIFT_SAMPLES ?? 6);
const AUTO_SHIFT_QUEUE_PULSE_AGE_MS = Number(process.env.WORKER_AUTO_SHIFT_QUEUE_PULSE_AGE_MS ?? 8_000);
const AUTO_SHIFT_QUEUE_GLIDE_AGE_MS = Number(process.env.WORKER_AUTO_SHIFT_QUEUE_GLIDE_AGE_MS ?? 20_000);
const AUTO_SHIFT_QUEUE_PULSE_DEPTH = Number(process.env.WORKER_AUTO_SHIFT_QUEUE_PULSE_DEPTH ?? 50);
const AUTO_SHIFT_QUEUE_GLIDE_DEPTH = Number(process.env.WORKER_AUTO_SHIFT_QUEUE_GLIDE_DEPTH ?? 120);

// Profile severity ladder: lower index = more restrictive (deeper protection).
const SPEED_PROFILE_LADDER: RuntimeSpeedProfileName[] = ['glide', 'pulse', 'surge'];
const speedProfileLevel = (name: RuntimeSpeedProfileName): number => {
  const idx = SPEED_PROFILE_LADDER.indexOf(name);
  return idx === -1 ? SPEED_PROFILE_LADDER.length - 1 : idx;
};
const speedProfileFromLevel = (level: number): RuntimeSpeedProfileName => {
  const clamped = Math.max(0, Math.min(SPEED_PROFILE_LADDER.length - 1, level));
  return SPEED_PROFILE_LADDER[clamped];
};

let autoShiftDownStreak = 0;
let autoShiftUpStreak = 0;
let lastAutoShiftEvalAt = 0;
let lastAutoShiftReason = 'init';
let lastAutoShiftTransitionAt: string | null = null;
const WORKER_INSTANCE_ID = process.env.WORKER_INSTANCE_ID?.trim() || `worker-${process.pid}-${randomUUID()}`;

// â”€â”€ DB pool â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const { Pool } = pg;
let pool: pg.Pool | null = null;
let tokenUniversePool: pg.Pool | null = null;

const getPool = () => {
  if (pool) return pool;
  const url = getDatabaseConnectionUrl(process.env);
  const parsed = new URL(url);
  parsed.searchParams.delete('sslmode');
  pool = new Pool({
    connectionString: parsed.toString(),
    ssl: { rejectUnauthorized: false },
    max: 3,
    query_timeout: DATABASE_QUERY_TIMEOUT_MS,
    statement_timeout: DATABASE_STATEMENT_TIMEOUT_MS,
    lock_timeout: DATABASE_LOCK_TIMEOUT_MS,
    idle_in_transaction_session_timeout: DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  });
  return pool;
};

const getTokenUniversePool = () => {
  if (tokenUniversePool) return tokenUniversePool;
  tokenUniversePool = getPool();
  return tokenUniversePool;
};

// â”€â”€ Solana connection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

let connection: Connection | null = null;
let connectionPool: Connection[] | null = null;
let connectionCursor = 0;
const getConnection = () => {
  if (!connectionPool || connectionPool.length === 0) {
    const rpcUrls = getHeliusRpcUrls(process.env);
    connectionPool = rpcUrls.map((rpcUrl) => new Connection(rpcUrl, 'confirmed'));
    connection = connectionPool[0] ?? null;
  }

  if (!connectionPool || connectionPool.length === 0) {
    throw new Error('Helius RPC connection pool is not configured');
  }

  const selected = connectionPool[connectionCursor % connectionPool.length];
  connectionCursor = (connectionCursor + 1) % connectionPool.length;
  return selected;
};

// â”€â”€ DB helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

type RawSession = {
  id: string;
  user_id: string;
  owner_wallet: string;
  session_wallet: string;
  status: string;
  requested_at: Date;
  started_at: Date | null;
  ended_at: Date | null;
  stop_reason: string | null;
  user_control: Session['userControl'];
  service_control: Session['serviceControl'];
  risk_limits: Session['riskLimits'];
  funding: Session['funding'];
};

type RuntimeControlRow = {
  state: {
    speedProfile?: unknown;
    modeSource?: unknown;
    recommendedProfile?: unknown;
    transitionReason?: unknown;
    lastTransitionAt?: unknown;
    pressure?: unknown;
    entriesEnabled?: boolean;
    maintenanceReason?: string | null;
  } | null;
};

type ExecutionQueueRow = {
  id: string;
  session_id: string;
  status: 'queued' | 'running';
  priority: number;
  reason: string;
  attempts: number;
  available_at: Date;
  locked_by: string | null;
  locked_until: Date | null;
  created_at: Date;
  updated_at: Date;
};

let executionQueueReadyPromise: Promise<void> | null = null;

const ensureExecutionQueueReady = async () => {
  if (!executionQueueReadyPromise) {
    const dbPool = getPool();
    executionQueueReadyPromise = dbPool.query(`
      CREATE TABLE IF NOT EXISTS execution_queue (
        id UUID PRIMARY KEY,
        session_id UUID NOT NULL,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        reason TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        locked_by TEXT,
        locked_until TIMESTAMPTZ,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
      .then(() => dbPool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS execution_queue_one_active_per_session_idx
        ON execution_queue (session_id)
        WHERE status IN ('queued', 'running')
      `))
      .then(() => dbPool.query(`
        CREATE INDEX IF NOT EXISTS execution_queue_claim_idx
        ON execution_queue (status, available_at, priority DESC, created_at ASC)
      `))
      .then(() => undefined);
  }

  return executionQueueReadyPromise;
};

const enqueueExecutionIntent = async (
  session: RawSession,
  params: { priority?: number; reason?: string } = {},
): Promise<boolean> => {
  await ensureExecutionQueueReady();
  const dbPool = getPool();

  const result = await dbPool.query<{ id: string }>(
    `
      INSERT INTO execution_queue (
        id,
        session_id,
        status,
        priority,
        reason,
        available_at,
        created_at,
        updated_at
      ) VALUES (
        $1,
        $2,
        'queued',
        $3,
        $4,
        NOW(),
        NOW(),
        NOW()
      )
      ON CONFLICT (session_id) WHERE status IN ('queued', 'running')
      DO NOTHING
      RETURNING id
    `,
    [randomUUID(), session.id, params.priority ?? 0, params.reason ?? 'trade_due'],
  );

  return (result.rowCount ?? 0) > 0;
};

const claimExecutionQueueItems = async (): Promise<ExecutionQueueRow[]> => {
  await ensureExecutionQueueReady();
  const dbPool = getPool();
  const limit = Math.max(1, Math.floor(EXECUTION_QUEUE_CLAIMS_PER_TICK));
  const lockMs = Math.max(1000, Math.floor(EXECUTION_QUEUE_LOCK_MS));

  await dbPool.query(
    `
      UPDATE execution_queue
         SET status = 'queued',
             locked_by = NULL,
             locked_until = NULL,
             updated_at = NOW(),
             last_error = 'stale_running_lock_reclaimed'
       WHERE status = 'running'
         AND locked_until IS NOT NULL
         AND locked_until < NOW()
    `,
  );

  const result = await dbPool.query<ExecutionQueueRow>(
    `
      WITH claimable AS (
        SELECT id
          FROM execution_queue
         WHERE status = 'queued'
           AND available_at <= NOW()
         ORDER BY priority DESC, available_at ASC, created_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      UPDATE execution_queue q
         SET status = 'running',
             locked_by = $2,
             locked_until = NOW() + ($3::text || ' milliseconds')::interval,
             attempts = q.attempts + 1,
             updated_at = NOW()
        FROM claimable
       WHERE q.id = claimable.id
      RETURNING q.*
    `,
    [limit, WORKER_INSTANCE_ID, lockMs],
  );

  return result.rows;
};

const completeExecutionQueueItem = async (queueItemId: string) => {
  await ensureExecutionQueueReady();
  await getPool().query(
    `DELETE FROM execution_queue WHERE id = $1`,
    [queueItemId],
  );
};

const failExecutionQueueItem = async (queueItemId: string, error: unknown) => {
  await ensureExecutionQueueReady();
  await getPool().query(
    `
      UPDATE execution_queue
         SET status = 'queued',
             locked_by = NULL,
             locked_until = NULL,
             last_error = $2,
             available_at = NOW() + INTERVAL '5 seconds',
             updated_at = NOW()
       WHERE id = $1
    `,
    [queueItemId, String(error).slice(0, 500)],
  );
};

const reclaimOwnExecutionQueueLocksOnBoot = async () => {
  await ensureExecutionQueueReady();
  const result = await getPool().query<{ id: string }>(
    `
      UPDATE execution_queue
         SET status = 'queued',
             locked_by = NULL,
             locked_until = NULL,
             last_error = 'worker_restart_reclaimed_own_lock',
             available_at = NOW(),
             updated_at = NOW()
       WHERE status = 'running'
         AND locked_by = $1
      RETURNING id
    `,
    [WORKER_INSTANCE_ID],
  );

  if ((result.rowCount ?? 0) > 0) {
    console.warn(JSON.stringify({
      service: 'roguezero-worker',
      kind: 'execution_queue_reclaim_on_boot',
      workerInstanceId: WORKER_INSTANCE_ID,
      reclaimed: result.rowCount,
      ids: result.rows.map((row) => row.id),
      ts: new Date().toISOString(),
    }));
  }
};

const querySessions = async (statuses: string[]): Promise<RawSession[]> => {
  const dbPool = getPool();
  const placeholders = statuses.map((_, i) => `$${i + 1}`).join(', ');
  const result = await dbPool.query<RawSession>(
    `SELECT *
       FROM sessions
      WHERE status IN (${placeholders})
      ORDER BY requested_at ASC, id ASC`,
    statuses,
  );
  return result.rows;
};

const getSessionById = async (id: string): Promise<RawSession | null> => {
  const dbPool = getPool();
  const result = await dbPool.query<RawSession>(
    `SELECT *
       FROM sessions
      WHERE id = $1
      LIMIT 1`,
    [id],
  );
  return result.rows[0] ?? null;
};

const ensureRuntimeControlStore = async () => {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS runtime_control_settings (
      control_key TEXT PRIMARY KEY,
      state JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
};

const refreshLiveRuntimeControl = async (force = false) => {
  const now = Date.now();
  if (!force && (now - lastRuntimeControlRefreshAt) < RUNTIME_CONTROL_REFRESH_MS) {
    return liveSpeedProfile;
  }

  await ensureRuntimeControlStore();
  const result = await getPool().query<RuntimeControlRow>(
    `SELECT state
       FROM runtime_control_settings
      WHERE control_key = $1
      LIMIT 1`,
    [RUNTIME_CONTROL_KEY],
  );

  const selectedProfile = normalizeRuntimeSpeedProfileName(
    typeof result.rows[0]?.state?.speedProfile === 'string'
      ? result.rows[0].state.speedProfile
      : process.env.WORKER_SPEED_PROFILE,
  );

  liveModeSource = result.rows[0]?.state?.modeSource === 'manual' ? 'manual' : 'auto';
  liveEntriesEnabled = result.rows[0]?.state?.entriesEnabled === false ? false : true;
  liveMaintenanceReason = typeof result.rows[0]?.state?.maintenanceReason === 'string'
    ? result.rows[0].state.maintenanceReason.slice(0, 160)
    : null;

  if (result.rowCount === 0) {
    await getPool().query(
      `INSERT INTO runtime_control_settings (control_key, state, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (control_key)
       DO UPDATE SET state = runtime_control_settings.state`,
      [RUNTIME_CONTROL_KEY, JSON.stringify({ speedProfile: selectedProfile })],
    );
  }

  liveSpeedProfileName = selectedProfile;
  liveSpeedProfile = getRuntimeSpeedProfile(selectedProfile, process.env);
  lastRuntimeControlRefreshAt = now;
  return liveSpeedProfile;
};

const getLiveSpeedProfile = () => liveSpeedProfile;

// ── Fleet auto-shift controller ──────────────────────────────────────────────
// Maps the worst-performing provider lane to the most restrictive profile it
// warrants, applies hysteresis, and persists the resulting mode plus the
// recommendation/pressure telemetry the admin surface reads.
const budgetPressureToLevel = (pressure: BudgetPressureLevel): number => {
  switch (pressure) {
    case 'halt':
    case 'throttle':
      return speedProfileLevel('glide');
    case 'watch':
      return speedProfileLevel('pulse');
    case 'normal':
    default:
      return speedProfileLevel('surge');
  }
};

const getExecutionQueuePressure = async (): Promise<{ depth: number; oldestMs: number }> => {
  try {
    await ensureExecutionQueueReady();
    const result = await getPool().query<{ depth: string; oldest_ms: string | null }>(
      `SELECT count(*)::text AS depth,
              COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at))) * 1000, 0)::text AS oldest_ms
         FROM execution_queue
        WHERE status = 'queued'
          AND available_at <= NOW()`,
    );
    const row = result.rows[0];
    return {
      depth: Number(row?.depth ?? 0),
      oldestMs: Math.max(0, Number(row?.oldest_ms ?? 0)),
    };
  } catch {
    return { depth: 0, oldestMs: 0 };
  }
};

const queuePressureToLevel = (depth: number, oldestMs: number): number => {
  if (oldestMs >= AUTO_SHIFT_QUEUE_GLIDE_AGE_MS || depth >= AUTO_SHIFT_QUEUE_GLIDE_DEPTH) {
    return speedProfileLevel('glide');
  }
  if (oldestMs >= AUTO_SHIFT_QUEUE_PULSE_AGE_MS || depth >= AUTO_SHIFT_QUEUE_PULSE_DEPTH) {
    return speedProfileLevel('pulse');
  }
  return speedProfileLevel('surge');
};

const persistRuntimeControlState = async (state: Record<string, unknown>) => {
  await ensureRuntimeControlStore();
  await getPool().query(
    `INSERT INTO runtime_control_settings (control_key, state, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (control_key)
     DO UPDATE SET state = $2::jsonb, updated_at = NOW()`,
    [RUNTIME_CONTROL_KEY, JSON.stringify(state)],
  );
};

const evaluateFleetAutoShift = async () => {
  if (!AUTO_SHIFT_ENABLED) return;
  const now = Date.now();
  if ((now - lastAutoShiftEvalAt) < AUTO_SHIFT_EVAL_MS) return;
  lastAutoShiftEvalAt = now;

  const queue = await getExecutionQueuePressure();

  // Worst lane wins: the most restrictive (lowest) level any lane demands.
  const heliusLevel = budgetPressureToLevel(latestHeliusBudgetPressure.pressure);
  const jupiterLevel = budgetPressureToLevel(latestJupiterBudgetPressure.pressure);
  const queueLevel = queuePressureToLevel(queue.depth, queue.oldestMs);
  const instantLevel = Math.min(heliusLevel, jupiterLevel, queueLevel);
  const recommended = speedProfileFromLevel(instantLevel);

  const worstLaneReason = (() => {
    if (instantLevel === queueLevel && queueLevel <= heliusLevel && queueLevel <= jupiterLevel) {
      return `queue depth=${queue.depth} oldest=${Math.round(queue.oldestMs)}ms`;
    }
    if (instantLevel === heliusLevel && heliusLevel <= jupiterLevel) {
      return `helius budget ${latestHeliusBudgetPressure.pressure}`;
    }
    return `jupiter budget ${latestJupiterBudgetPressure.pressure}`;
  })();

  const pressureTelemetry = {
    heliusBudget: latestHeliusBudgetPressure.pressure,
    heliusUsageRatio: latestHeliusBudgetPressure.usageRatio,
    jupiterBudget: latestJupiterBudgetPressure.pressure,
    jupiterUsageRatio: latestJupiterBudgetPressure.usageRatio,
    queueDepth: queue.depth,
    queueOldestMs: Math.round(queue.oldestMs),
    worstLane: worstLaneReason,
  };

  // Operator pinned the mode: surface the recommendation/pressure, apply nothing.
  if (liveModeSource === 'manual') {
    autoShiftDownStreak = 0;
    autoShiftUpStreak = 0;
    await persistRuntimeControlState({
      speedProfile: liveSpeedProfileName,
      modeSource: 'manual',
      entriesEnabled: liveEntriesEnabled,
      maintenanceReason: liveMaintenanceReason,
      recommendedProfile: recommended,
      transitionReason: lastAutoShiftReason,
      lastTransitionAt: lastAutoShiftTransitionAt,
      pressure: pressureTelemetry,
    }).catch((err) => console.warn('[worker] auto-shift persist (manual) failed:', String(err)));
    return;
  }

  const appliedLevel = speedProfileLevel(liveSpeedProfileName);
  let targetLevel = appliedLevel;
  let transitioned = false;
  let reason = lastAutoShiftReason;

  if (instantLevel < appliedLevel) {
    // Pressure rising → downshift toward protection. Fast, can jump straight.
    autoShiftDownStreak += 1;
    autoShiftUpStreak = 0;
    if (autoShiftDownStreak >= AUTO_SHIFT_DOWNSHIFT_SAMPLES) {
      targetLevel = instantLevel;
      transitioned = true;
      reason = `auto_downshift: ${worstLaneReason}`;
      autoShiftDownStreak = 0;
    }
  } else if (instantLevel > appliedLevel) {
    // Pressure recovering → upshift one step at a time. Slow.
    autoShiftUpStreak += 1;
    autoShiftDownStreak = 0;
    if (autoShiftUpStreak >= AUTO_SHIFT_UPSHIFT_SAMPLES) {
      targetLevel = appliedLevel + 1;
      transitioned = true;
      reason = `auto_upshift: lanes recovered (${worstLaneReason})`;
      autoShiftUpStreak = 0;
    }
  } else {
    autoShiftDownStreak = 0;
    autoShiftUpStreak = 0;
  }

  if (transitioned && targetLevel !== appliedLevel) {
    const nextProfile = speedProfileFromLevel(targetLevel);
    liveSpeedProfileName = nextProfile;
    liveSpeedProfile = getRuntimeSpeedProfile(nextProfile, process.env);
    lastAutoShiftReason = reason;
    lastAutoShiftTransitionAt = new Date().toISOString();
    log('info', 'fleet', `auto-shift ${speedProfileFromLevel(appliedLevel)} → ${nextProfile} (${reason})`);
  }

  await persistRuntimeControlState({
    speedProfile: liveSpeedProfileName,
    modeSource: 'auto',
    entriesEnabled: liveEntriesEnabled,
    maintenanceReason: liveMaintenanceReason,
    recommendedProfile: recommended,
    transitionReason: lastAutoShiftReason,
    lastTransitionAt: lastAutoShiftTransitionAt,
    pressure: pressureTelemetry,
  }).catch((err) => console.warn('[worker] auto-shift persist failed:', String(err)));
};

const setSessionStatus = async (
  id: string,
  status: string,
  extra: Record<string, unknown> = {},
  opts: { expectedStatuses?: string[] } = {},
) => {
  const dbPool = getPool();
  const fields = ['status = $2'];
  const vals: unknown[] = [id, status];

  if ('started_at' in extra) { vals.push(extra.started_at); fields.push(`started_at = $${vals.length}`); }
  if ('ended_at'   in extra) { vals.push(extra.ended_at);   fields.push(`ended_at = $${vals.length}`); }
  if ('stop_reason' in extra) { vals.push(extra.stop_reason); fields.push(`stop_reason = $${vals.length}`); }
  if ('funding' in extra) {
    vals.push(JSON.stringify(extra.funding));
    fields.push(`funding = $${vals.length}::jsonb`);
  }
  if ('service_control' in extra) {
    vals.push(JSON.stringify(extra.service_control));
    fields.push(`service_control = $${vals.length}::jsonb`);
  }

  let whereClause = 'WHERE id = $1';
  if (opts.expectedStatuses && opts.expectedStatuses.length > 0) {
    vals.push(opts.expectedStatuses);
    whereClause += ` AND status = ANY($${vals.length}::text[])`;
  }

  await dbPool.query(
    `UPDATE sessions SET ${fields.join(', ')} ${whereClause}`,
    vals,
  );
};

const mergeServiceControlPatch = async (
  session: RawSession,
  patch: SessionServiceControlPatch,
) => {
  const latestSession = await getSessionById(session.id);
  const baseServiceControl = latestSession?.service_control ?? session.service_control;
  const mergedServiceControl = mergeSessionServiceControl(baseServiceControl, patch);

  session.status = latestSession?.status ?? session.status;
  session.service_control = mergedServiceControl;

  await setSessionStatus(
    session.id,
    session.status,
    { service_control: mergedServiceControl },
    { expectedStatuses: [session.status] },
  );

  return mergedServiceControl;
};

const persistServiceControl = async (
  session: RawSession,
  serviceControlPatch: SessionServiceControlPatch,
) => {
  await mergeServiceControlPatch(session, serviceControlPatch);
};

const mergeFundingPatch = async (
  session: RawSession,
  fundingPatch: Partial<Session['funding']>,
) => {
  const latestSession = await getSessionById(session.id);
  const baseFunding = latestSession?.funding ?? session.funding;
  const latestStatus = latestSession?.status ?? session.status;
  const mergedFunding: Session['funding'] = {
    ...baseFunding,
    ...fundingPatch,
  };

  session.status = latestStatus;
  session.funding = mergedFunding;

  await setSessionStatus(session.id, latestStatus, {
    funding: mergedFunding,
  }, { expectedStatuses: [latestStatus] });
};

const decryptKeypair = (stored: string): string => {
  if (!stored.startsWith('enc:')) return stored;
  const envKey = process.env.SESSION_KEY_ENCRYPTION_KEY ?? '';
  if (!envKey || envKey.length < 32) throw new Error('SESSION_KEY_ENCRYPTION_KEY required to decrypt session keypairs');
  const keyBytes = envKey.length === 64
    ? Buffer.from(envKey, 'hex')
    : Buffer.from(envKey.slice(0, 32), 'utf8');
  const key = keyBytes.subarray(0, 32);
  const parts = stored.split(':');
  if (parts.length !== 4) throw new Error('Invalid encrypted keypair format');
  const iv = Buffer.from(parts[1], 'hex');
  const tag = Buffer.from(parts[2], 'hex');
  const ciphertext = Buffer.from(parts[3], 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
};

const getKeypair = async (sessionId: string): Promise<Keypair | null> => {
  const dbPool = getPool();
  const result = await dbPool.query<{ keypair_base58: string }>(
    'SELECT keypair_base58 FROM session_keys WHERE session_id = $1',
    [sessionId],
  );
  if (!result.rowCount) return null;
  const secretKey = bs58.decode(decryptKeypair(result.rows[0].keypair_base58));
  return Keypair.fromSecretKey(secretKey);
};

// â”€â”€ Rate limiter â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const sharedRatePool = getPool();
const jupiterLimiter = createSharedTokenBucket({
  pool: sharedRatePool,
  key: 'jupiter-general',
  maxTokens: JUPITER_GENERAL_BURST,
  refillRatePerSec: JUPITER_GENERAL_RPS,
});
const heliusLimiter = createSharedTokenBucket({
  pool: sharedRatePool,
  key: 'helius-rpc',
  maxTokens: HELIUS_RPC_BURST,
  refillRatePerSec: HELIUS_RPC_RPS,
});
const heliusMonthlyBudget = createMonthlyBudgetGovernor({
  pool: sharedRatePool,
  key: 'helius-credits',
  monthlyLimitUnits: HELIUS_MONTHLY_CREDIT_LIMIT,
  enforceLimit: HELIUS_MONTHLY_BUDGET_ENFORCE,
});
const jupiterMonthlyBudget = createMonthlyBudgetGovernor({
  pool: sharedRatePool,
  key: 'jupiter-requests',
  monthlyLimitUnits: JUPITER_MONTHLY_REQUEST_LIMIT,
  enforceLimit: JUPITER_MONTHLY_BUDGET_ENFORCE,
});

const reserveProviderBudget = async (params: {
  provider: 'helius' | 'jupiter';
  units?: number;
  governor: { reserve: (units?: number) => Promise<{ granted: boolean; pressure: string; remainingUnits: number; usageRatio: number }> };
}) => {
  const budget = await params.governor.reserve(params.units ?? 1);

  // Record the latest projected budget pressure per provider so the fleet
  // auto-shift controller can react to slow-burn monthly-budget exhaustion.
  const laneSnapshot: LaneBudgetPressure = {
    pressure: (budget.pressure as BudgetPressureLevel) ?? 'normal',
    usageRatio: budget.usageRatio,
    at: Date.now(),
  };
  if (params.provider === 'helius') {
    latestHeliusBudgetPressure = laneSnapshot;
  } else {
    latestJupiterBudgetPressure = laneSnapshot;
  }

  if (budget.pressure === 'watch' || budget.pressure === 'throttle') {
    console.warn(JSON.stringify({
      level: 'warn',
      service: 'roguezero-worker',
      kind: 'provider_monthly_budget_pressure',
      provider: params.provider,
      pressure: budget.pressure,
      remainingUnits: budget.remainingUnits,
      usageRatio: budget.usageRatio,
      ts: new Date().toISOString(),
    }));
  }

  if (!budget.granted) {
    throw new Error(`${params.provider} monthly budget exhausted`);
  }
};

const reserveHeliusRpc = async () => {
  await reserveProviderBudget({ provider: 'helius', governor: heliusMonthlyBudget, units: 1 });
  await heliusLimiter.acquire();
};

const reserveJupiterRequest = async () => {
  await reserveProviderBudget({ provider: 'jupiter', governor: jupiterMonthlyBudget, units: 1 });
  await jupiterLimiter.acquire();
};

// â”€â”€ Stage 4 price feeds (chunk 2) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Two independent pollers, two independent rate buckets:
//   â€¢ Pyth Hermes â€” primary, ~3s cadence, no auth, separate vendor
//   â€¢ Jupiter /price/v3 â€” slow drift check, ~60s cadence, on jupiter bucket
// Outputs are LOG-ONLY in chunk 2. No DB writes, no signal, no trade impact.

type PythSample = {
  source: 'pyth-hermes';
  feedId: string;
  usdPrice: number;
  confidenceUsd: number;
  confidenceBps: number;
  publishTime: number;
  slot: number;
  sampledAt: string;
};

type TokenTradeClass = 'major' | 'sol_beta' | 'trend_liquid' | 'long_tail';

type JupiterPriceSample = {
  source: 'jupiter-price-v3';
  mint: string;
  usdPrice: number;
  blockId: number;
  decimals: number;
  sampledAt: string;
};

let lastPythSolSample: PythSample | null = null;
let lastJupiterSolSample: JupiterPriceSample | null = null;
let lastSignalSnapshot: NonNullable<Session['serviceControl']['lastSignal']> | null = null;
let pythConsecutiveFailures = 0;
let jupiterPriceConsecutiveFailures = 0;
let tokenUniverseMints: string[] = [];
let tokenUniverseActiveMints: string[] = [];
let tokenUniverseSourceTable: string | null = null;
let tokenUniverseTableMeta: TokenUniverseTableMeta | null = null;
let lastTokenUniverseRefreshAt = 0;
let tokenUniverseBootstrapAttempted = false;
let lastTokenUniverseAutoSortAt = 0;
let lastTokenUniverseEngineAppliedAt = 0;
let lastTokenUniverseEngineEnabledCount = 0;
let tokenUniverseProbeFrozen = false;
let lastTokenUniverseAutoSortStateWriteMs = 0;
let lastTokenUniverseAutoSortStateSignature: string | null = null;
let lastTokenUniverseMetadataWriteMs = 0;
let lastTokenUniverseMetadataSignature: string | null = null;
const universeSortProbeTaker = process.env.WORKER_UNIVERSE_PROBE_TAKER?.trim()
  || '11111111111111111111111111111111';
const tokenUniverseSymbolByMint = new Map<string, string>();
const latestJupiterUsdByMint = new Map<string, number>();
const previousJupiterUsdByMint = new Map<string, number>();
const latestJupiterDecimalsByMint = new Map<string, number>();

const TOKEN_UNIVERSE_REFRESH_MS = Number(process.env.WORKER_TOKEN_UNIVERSE_REFRESH_MS ?? 60000);
const TOKEN_UNIVERSE_TABLE_CANDIDATES = (process.env.RZ_TOKEN_UNIVERSE_TABLES
  ?? 'rz_token_universe,token_universe')
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value.length > 0);
const TOKEN_UNIVERSE_MAX_MINTS = Number(process.env.WORKER_TOKEN_UNIVERSE_MAX_MINTS ?? 500);
const WORKER_JUPITER_PRICE_BATCH_SIZE = Number(process.env.WORKER_JUPITER_PRICE_BATCH_SIZE ?? 80);
const solanaPublicKeyPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TOKEN_UNIVERSE_BOOTSTRAP_ENABLED = process.env.WORKER_TOKEN_UNIVERSE_BOOTSTRAP_ENABLED !== 'false';
const DEFAULT_TOKEN_UNIVERSE_SEED = [
  { mint: SOL_MINT, symbol: 'SOL', priority: 100 },
  { mint: USDC_MINT, symbol: 'USDC', priority: 90 },
  { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', symbol: 'JUP', priority: 89 },
  { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT', priority: 88 },
  { mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', symbol: 'JitoSOL', priority: 87 },
  { mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', symbol: 'mSOL', priority: 86 },
  { mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', symbol: 'bSOL', priority: 85 },
  { mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', symbol: 'JTO', priority: 84 },
  { mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', symbol: 'PYTH', priority: 83 },
  { mint: 'KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS', symbol: 'KMNO', priority: 82 },
  { mint: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', symbol: 'WBTC', priority: 81 },
  { mint: '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ', symbol: 'W', priority: 80 },
  { mint: 'hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux', symbol: 'HNT', priority: 79 },
  { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK', priority: 78 },
  { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', symbol: 'WIF', priority: 77 },
  { mint: 'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5', symbol: 'MEW', priority: 76 },
  { mint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr', symbol: 'POPCAT', priority: 75 },
  { mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', symbol: 'RAY', priority: 74 },
  { mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE', symbol: 'ORCA', priority: 73 },
  { mint: '5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm', symbol: 'DRIFT', priority: 72 },
  { mint: 'SHDWyBxihqiCjDYwvisits5jfez2EfbR347c5cKAgqje', symbol: 'SHDW', priority: 71 },
];
const TRUSTED_ENTRY_UNIVERSE_MINTS = [
  SOL_MINT,
  USDC_MINT,
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',
  'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',
  'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
  'KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS',
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
  '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ',
  'hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux',
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5',
  '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
  'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',
  '5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm',
  'SHDWyBxihqiCjDYwvisits5jfez2EfbR347c5cKAgqje',
];
const TRUSTED_ENTRY_UNIVERSE_MINT_SET = new Set(TRUSTED_ENTRY_UNIVERSE_MINTS);
const STABLE_ENTRY_TARGET_MINTS = new Set<string>([
  USDC_MINT,
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
]);
const TOKEN_UNIVERSE_HARD_BLOCKED_MINTS = new Set<string>([
  '4SZjjNABoqhbd4hnapbvoEPEqT8mnNkfbEoAwALf1V8t', // CAVE
]);
const TOKEN_UNIVERSE_HARD_BLOCKED_SYMBOLS = new Set<string>([
  'CAVE',
  'APPLE',
  'USELESS',
]);

// Correlation clusters for diversification. Tokens in the same cluster move
// together, so the bot treats them as a single directional bet. SOL and its
// liquid-staking derivatives (LSTs) track the SOL price almost 1:1; wrapped BTC
// variants track BTC; stables track the dollar. Everything else is treated as
// its own single-token cluster so the per-cluster cap never restricts genuinely
// uncorrelated names.
const TOKEN_CLUSTER_BY_MINT: Record<string, string> = {
  [SOL_MINT]: 'sol_beta',
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn': 'sol_beta', // JitoSOL
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So': 'sol_beta', // mSOL
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1': 'sol_beta', // bSOL
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh': 'btc', // WBTC
  [USDC_MINT]: 'stable',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'stable', // USDT
};
const TOKEN_CLUSTER_BY_SYMBOL: Record<string, string> = {
  SOL: 'sol_beta',
  JitoSOL: 'sol_beta',
  mSOL: 'sol_beta',
  bSOL: 'sol_beta',
  JupSOL: 'sol_beta',
  jupSOL: 'sol_beta',
  INF: 'sol_beta',
  WBTC: 'btc',
  PBTC: 'btc',
  pBTC: 'btc',
  cbBTC: 'btc',
  BTC: 'btc',
  USDC: 'stable',
  USDT: 'stable',
  USDS: 'stable',
  USDe: 'stable',
};
const getClusterForMint = (mint: string): string => {
  const byMint = TOKEN_CLUSTER_BY_MINT[mint];
  if (byMint) {
    return byMint;
  }
  const symbol = tokenUniverseSymbolByMint.get(mint);
  if (symbol) {
    const bySymbol = TOKEN_CLUSTER_BY_SYMBOL[symbol];
    if (bySymbol) {
      return bySymbol;
    }
  }
  return `single:${mint}`;
};

type TokenUniverseTableMeta = {
  tableName: string;
  mintColumn: string;
  symbolColumn: string | null;
  enabledColumn: string | null;
  priorityColumn: string | null;
  updatedAtColumn: string | null;
};

type TokenUniverseRow = {
  mint: string | null;
  symbol: string | null;
  enabled: boolean;
  notes: string | null;
};

const isApprovedUniverseRow = (row: TokenUniverseRow) => {
  const notes = row.notes?.trim() ?? '';
  return TRUSTED_ENTRY_UNIVERSE_MINT_SET.has(row.mint ?? '')
    || notes === 'core-seed'
    || notes.startsWith('admitted:');
};

type TokenUniverseRankSample = {
  mint: string;
  usdPrice: number | null;
  priorUsdPrice: number | null;
  momentumBps: number;
  routeFound: boolean;
  priceImpactBps: number | null;
  score: number;
};

type MarketTapePoint = {
  sampledAt: string;
  usdPrice: number;
  source: 'pyth-hermes' | 'jupiter-price-v3';
};

type DriftTapePoint = {
  sampledAt: string;
  pythUsd: number;
  jupiterUsd: number;
  driftBps: number;
};

const sharedMarketTape = {
  solUsdPyth: [] as MarketTapePoint[],
  solUsdJupiter: [] as MarketTapePoint[],
  solUsdDrift: [] as DriftTapePoint[],
};

const jupiterMomentumTapeByMint = new Map<string, MarketTapePoint[]>();

type PersistedMarketTapeRow = {
  state: {
    solUsdPyth?: unknown;
    solUsdJupiter?: unknown;
    solUsdDrift?: unknown;
    lastPythSolSample?: unknown;
    lastJupiterSolSample?: unknown;
    lastSignalSnapshot?: unknown;
  } | null;
};

const WORKER_RUNTIME_STATE_KEY = 'shared_market_tape_v1';
const TOKEN_UNIVERSE_AUTOSORT_STATE_KEY = 'token_universe_autosort_v1';
const TOKEN_UNIVERSE_HEALTH_STATE_KEY = 'token_universe_health_v1';
const MARKET_TAPE_PERSIST_MIN_INTERVAL_MS = Number(process.env.WORKER_MARKET_TAPE_PERSIST_MIN_INTERVAL_MS ?? 3000);
let workerRuntimeStateReadyPromise: Promise<void> | null = null;
let lastMarketTapePersistMs = 0;

type TokenUniverseHealthEntry = {
  deadRuns: number;
  admitRuns: number;
  evictRuns: number;
  enabled: boolean;
  enabledSinceRun: number | null;
  lastReason: string | null;
  lastSeenAt: string;
};

type TokenUniverseHealthState = {
  run: number;
  mints: Record<string, TokenUniverseHealthEntry>;
  probeFailureStreak: number;
  probeHealthyStreak: number;
  probeFrozen: boolean;
  probeFrozenAt: string | null;
  lastSuccessfulProbeAt: string | null;
};

const trimTokenUniverseHealthState = (state: TokenUniverseHealthState): TokenUniverseHealthState => {
  const trackedEntries = Object.entries(state.mints)
    .sort((a, b) => {
      const aSeen = Date.parse(a[1].lastSeenAt);
      const bSeen = Date.parse(b[1].lastSeenAt);
      return (Number.isFinite(bSeen) ? bSeen : 0) - (Number.isFinite(aSeen) ? aSeen : 0);
    })
    .slice(0, Math.max(32, TOKEN_UNIVERSE_HEALTH_MAX_TRACKED_MINTS));

  return {
    ...state,
    mints: Object.fromEntries(trackedEntries),
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object';

const toFiniteNumber = (value: unknown) => {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const toMarketTapePoint = (value: unknown): MarketTapePoint | null => {
  if (!isRecord(value)) return null;
  const sampledAt = typeof value.sampledAt === 'string' ? value.sampledAt : null;
  const usdPrice = toFiniteNumber(value.usdPrice);
  const source = value.source === 'pyth-hermes' || value.source === 'jupiter-price-v3'
    ? value.source
    : null;

  if (!sampledAt || usdPrice === null || !source) return null;
  return { sampledAt, usdPrice, source };
};

const toDriftTapePoint = (value: unknown): DriftTapePoint | null => {
  if (!isRecord(value)) return null;
  const sampledAt = typeof value.sampledAt === 'string' ? value.sampledAt : null;
  const pythUsd = toFiniteNumber(value.pythUsd);
  const jupiterUsd = toFiniteNumber(value.jupiterUsd);
  const driftBps = toFiniteNumber(value.driftBps);

  if (!sampledAt || pythUsd === null || jupiterUsd === null || driftBps === null) return null;
  return { sampledAt, pythUsd, jupiterUsd, driftBps };
};

const toPythSample = (value: unknown): PythSample | null => {
  if (!isRecord(value)) return null;
  const feedId = typeof value.feedId === 'string' ? value.feedId : null;
  const usdPrice = toFiniteNumber(value.usdPrice);
  const confidenceUsd = toFiniteNumber(value.confidenceUsd);
  const confidenceBps = toFiniteNumber(value.confidenceBps);
  const publishTime = toFiniteNumber(value.publishTime);
  const slot = toFiniteNumber(value.slot);
  const sampledAt = typeof value.sampledAt === 'string' ? value.sampledAt : null;

  if (!feedId || usdPrice === null || confidenceUsd === null || confidenceBps === null || publishTime === null || slot === null || !sampledAt) {
    return null;
  }

  return {
    source: 'pyth-hermes',
    feedId,
    usdPrice,
    confidenceUsd,
    confidenceBps,
    publishTime,
    slot,
    sampledAt,
  };
};

const toJupiterPriceSample = (value: unknown): JupiterPriceSample | null => {
  if (!isRecord(value)) return null;
  const mint = typeof value.mint === 'string' ? value.mint : null;
  const usdPrice = toFiniteNumber(value.usdPrice);
  const blockId = toFiniteNumber(value.blockId);
  const decimals = toFiniteNumber(value.decimals);
  const sampledAt = typeof value.sampledAt === 'string' ? value.sampledAt : null;

  if (!mint || usdPrice === null || blockId === null || decimals === null || !sampledAt) {
    return null;
  }

  return {
    source: 'jupiter-price-v3',
    mint,
    usdPrice,
    blockId,
    decimals,
    sampledAt,
  };
};

const toLastSignalSnapshot = (value: unknown): NonNullable<Session['serviceControl']['lastSignal']> | null => {
  if (!isRecord(value)) return null;

  const at = typeof value.at === 'string' ? value.at : null;
  const source = value.source === 'pyth-hermes' ? value.source : null;
  const signal = value.signal === 'momentum' ? value.signal : null;
  const status = value.status === 'warming_up' || value.status === 'ready' || value.status === 'guarded_off'
    ? value.status
    : null;
  const regime = value.regime === 'bullish' || value.regime === 'bearish' || value.regime === 'flat' || value.regime === null
    ? value.regime
    : null;
  const lookbackSamples = toFiniteNumber(value.lookbackSamples);
  const thresholdBps = toFiniteNumber(value.thresholdBps);
  const momentumBps = value.momentumBps === null ? null : toFiniteNumber(value.momentumBps);
  const guardReason = typeof value.guardReason === 'string' || value.guardReason === null
    ? value.guardReason
    : null;

  if (!at || !source || !signal || !status || lookbackSamples === null || thresholdBps === null) {
    return null;
  }

  return {
    at,
    source,
    signal,
    status,
    regime,
    lookbackSamples,
    thresholdBps,
    momentumBps,
    guardReason,
  };
};

const ensureWorkerRuntimeStateStore = async () => {
  if (!workerRuntimeStateReadyPromise) {
    workerRuntimeStateReadyPromise = getPool().query(`
      CREATE TABLE IF NOT EXISTS worker_runtime_state_cache (
        state_key TEXT PRIMARY KEY,
        state JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `).then(() => undefined);
  }

  return workerRuntimeStateReadyPromise;
};

const loadPersistedMarketTapeState = async () => {
  await ensureWorkerRuntimeStateStore();
  const dbPool = getPool();
  const result = await dbPool.query<PersistedMarketTapeRow>(
    `SELECT state FROM worker_runtime_state_cache WHERE state_key = $1 LIMIT 1`,
    [WORKER_RUNTIME_STATE_KEY],
  );

  const state = result.rows[0]?.state;
  if (!state) {
    return;
  }

  sharedMarketTape.solUsdPyth.splice(0, sharedMarketTape.solUsdPyth.length, ...(
    Array.isArray(state.solUsdPyth)
      ? state.solUsdPyth.map(toMarketTapePoint).filter((value): value is MarketTapePoint => value !== null)
      : []
  ));
  sharedMarketTape.solUsdJupiter.splice(0, sharedMarketTape.solUsdJupiter.length, ...(
    Array.isArray(state.solUsdJupiter)
      ? state.solUsdJupiter.map(toMarketTapePoint).filter((value): value is MarketTapePoint => value !== null)
      : []
  ));
  sharedMarketTape.solUsdDrift.splice(0, sharedMarketTape.solUsdDrift.length, ...(
    Array.isArray(state.solUsdDrift)
      ? state.solUsdDrift.map(toDriftTapePoint).filter((value): value is DriftTapePoint => value !== null)
      : []
  ));

  lastPythSolSample = toPythSample(state.lastPythSolSample);
  lastJupiterSolSample = toJupiterPriceSample(state.lastJupiterSolSample);
  lastSignalSnapshot = toLastSignalSnapshot(state.lastSignalSnapshot);

  console.log(JSON.stringify({
    service: 'roguezero-worker',
    kind: 'price',
    ts: new Date().toISOString(),
    restoredMarketTape: true,
    pythDepth: sharedMarketTape.solUsdPyth.length,
    jupiterDepth: sharedMarketTape.solUsdJupiter.length,
    driftDepth: sharedMarketTape.solUsdDrift.length,
  }));
};

const persistMarketTapeState = async () => {
  const nowMs = Date.now();
  if ((nowMs - lastMarketTapePersistMs) < MARKET_TAPE_PERSIST_MIN_INTERVAL_MS) {
    return;
  }

  lastMarketTapePersistMs = nowMs;

  await ensureWorkerRuntimeStateStore();
  const dbPool = getPool();
  await dbPool.query(
    `INSERT INTO worker_runtime_state_cache (state_key, state, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (state_key)
     DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
    [
      WORKER_RUNTIME_STATE_KEY,
      JSON.stringify({
        solUsdPyth: sharedMarketTape.solUsdPyth,
        solUsdJupiter: sharedMarketTape.solUsdJupiter,
        solUsdDrift: sharedMarketTape.solUsdDrift,
        lastPythSolSample,
        lastJupiterSolSample,
        lastSignalSnapshot,
      }),
    ],
  );
};

const stableJsonStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonStringify(entry)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, nestedValue]) => `${JSON.stringify(key)}:${stableJsonStringify(nestedValue)}`);

  return `{${entries.join(',')}}`;
};

type TokenUniverseMetadataWrite = {
  sourceTable: string | null;
  status: string;
  reason: string | null;
  candidateCount: number;
  enabledCount: number;
  avgMomentumBps?: number | null;
  avgPriceImpactBps?: number | null;
  topTokens: unknown[];
};

let marketScannerStoreReadyPromise: Promise<void> | null = null;

const ensureMarketScannerStore = async (dbPool: pg.Pool = getTokenUniversePool()) => {
  if (!marketScannerStoreReadyPromise) {
    marketScannerStoreReadyPromise = dbPool.query(`
      CREATE TABLE IF NOT EXISTS public.market_scanner_runs (
        id UUID PRIMARY KEY,
        scanner_name TEXT NOT NULL,
        source_table TEXT,
        status TEXT NOT NULL,
        reason TEXT,
        candidate_count INTEGER NOT NULL DEFAULT 0,
        accepted_count INTEGER NOT NULL DEFAULT 0,
        rejected_count INTEGER NOT NULL DEFAULT 0,
        provider_cost_estimate INTEGER NOT NULL DEFAULT 0,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        details JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `)
      .then(() => dbPool.query(`
        CREATE TABLE IF NOT EXISTS public.market_candidates (
          id UUID PRIMARY KEY,
          scanner_run_id UUID NOT NULL REFERENCES public.market_scanner_runs(id) ON DELETE CASCADE,
          strategy_slot TEXT NOT NULL,
          input_mint TEXT NOT NULL,
          output_mint TEXT NOT NULL,
          output_symbol TEXT,
          signal_score NUMERIC,
          liquidity_score NUMERIC,
          route_quality NUMERIC,
          slippage_bps NUMERIC,
          max_trade_size_atomic TEXT,
          observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          valid_until TIMESTAMPTZ NOT NULL,
          status TEXT NOT NULL,
          provider_cost_estimate INTEGER NOT NULL DEFAULT 0,
          risk_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
          details JSONB NOT NULL DEFAULT '{}'::jsonb
        )
      `))
      .then(() => dbPool.query(`
        CREATE INDEX IF NOT EXISTS market_candidates_active_idx
        ON public.market_candidates (status, valid_until DESC, route_quality DESC)
      `))
      .then(() => dbPool.query(`
        CREATE INDEX IF NOT EXISTS market_candidates_output_mint_idx
        ON public.market_candidates (output_mint, observed_at DESC)
      `))
      .then(() => undefined);
  }

  return marketScannerStoreReadyPromise;
};

const persistMarketScannerRun = async (params: {
  sourceTable: string | null;
  status: 'applied' | 'skipped';
  reason: string | null;
  samples: TokenUniverseRankSample[];
  enabledTop: number;
  dbPool?: pg.Pool;
}) => {
  const dbPool = params.dbPool ?? getTokenUniversePool();
  await ensureMarketScannerStore(dbPool);

  const now = new Date();
  const validUntil = new Date(now.getTime() + Math.max(30_000, MARKET_SCANNER_CANDIDATE_TTL_MS));
  const persistedSamples = params.samples.slice(0, Math.max(1, MARKET_SCANNER_MAX_PERSISTED_CANDIDATES));
  const acceptedSamples = persistedSamples.filter((sample, index) => (
    index < params.enabledTop
    && sample.routeFound
    && (sample.priceImpactBps === null || sample.priceImpactBps <= TOKEN_UNIVERSE_AUTO_SORT_MAX_PRICE_IMPACT_BPS)
  ));
  const runId = randomUUID();

  await dbPool.query('BEGIN');
  try {
    await dbPool.query(
      `INSERT INTO public.market_scanner_runs (
         id, scanner_name, source_table, status, reason, candidate_count,
         accepted_count, rejected_count, provider_cost_estimate, started_at,
         finished_at, details
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11::jsonb)`,
      [
        runId,
        'token_universe_autosort',
        params.sourceTable,
        params.status,
        params.reason,
        params.samples.length,
        acceptedSamples.length,
        Math.max(0, persistedSamples.length - acceptedSamples.length),
        params.samples.length,
        now,
        JSON.stringify({
          enabledTop: params.enabledTop,
          maxPriceImpactBps: TOKEN_UNIVERSE_AUTO_SORT_MAX_PRICE_IMPACT_BPS,
          candidateTtlMs: MARKET_SCANNER_CANDIDATE_TTL_MS,
        }),
      ],
    );

    for (let index = 0; index < persistedSamples.length; index += 1) {
      const sample = persistedSamples[index];
      const impactPass = sample.priceImpactBps === null || sample.priceImpactBps <= TOKEN_UNIVERSE_AUTO_SORT_MAX_PRICE_IMPACT_BPS;
      const rankPass = index < params.enabledTop;
      const accepted = sample.routeFound && impactPass && rankPass;
      const riskFlags = [
        !sample.routeFound ? 'route_not_found' : null,
        !impactPass ? 'price_impact_too_high' : null,
        !rankPass ? 'below_enabled_rank_cutoff' : null,
      ].filter((value): value is string => value !== null);

      await dbPool.query(
        `INSERT INTO public.market_candidates (
           id, scanner_run_id, strategy_slot, input_mint, output_mint,
           output_symbol, signal_score, liquidity_score, route_quality,
           slippage_bps, max_trade_size_atomic, observed_at, valid_until,
           status, provider_cost_estimate, risk_flags, details
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17::jsonb)`,
        [
          randomUUID(),
          runId,
          'momentum',
          SOL_MINT,
          sample.mint,
          resolveTokenSymbol(sample.mint),
          sample.momentumBps,
          sample.priceImpactBps === null ? null : -sample.priceImpactBps,
          sample.score,
          sample.priceImpactBps,
          String(TOKEN_UNIVERSE_AUTO_SORT_NOTIONAL_USDC_ATOMIC),
          now,
          validUntil,
          accepted ? 'active' : 'rejected',
          1,
          JSON.stringify(riskFlags),
          JSON.stringify({
            rank: index + 1,
            usdPrice: sample.usdPrice,
            priorUsdPrice: sample.priorUsdPrice,
            routeFound: sample.routeFound,
          }),
        ],
      );
    }

    await dbPool.query('COMMIT');
  } catch (error) {
    await dbPool.query('ROLLBACK');
    throw error;
  }
};

const persistTokenUniverseMetadata = async (
  write: TokenUniverseMetadataWrite,
  dbPool: pg.Pool = getTokenUniversePool(),
) => {
  const nowMs = Date.now();
  const signature = stableJsonStringify(write);

  if (
    signature === lastTokenUniverseMetadataSignature
    && (nowMs - lastTokenUniverseMetadataWriteMs) < TOKEN_UNIVERSE_METADATA_WRITE_MIN_INTERVAL_MS
  ) {
    return;
  }

  try {
    await dbPool.query(
      `INSERT INTO public.rz_token_universe_metadata (
         source_table, status, reason, candidate_count, enabled_count,
         avg_momentum_bps, avg_price_impact_bps, top_tokens, built_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now())`,
      [
        write.sourceTable,
        write.status,
        write.reason,
        write.candidateCount,
        write.enabledCount,
        write.avgMomentumBps ?? null,
        write.avgPriceImpactBps ?? null,
        JSON.stringify(write.topTokens),
      ],
    );
    lastTokenUniverseMetadataWriteMs = nowMs;
    lastTokenUniverseMetadataSignature = signature;
  } catch {
    // metadata writes are best-effort only
  }
};

const persistTokenUniverseAutoSortState = async (state: Record<string, unknown>) => {
  const nowMs = Date.now();
  const signature = stableJsonStringify(state);

  if (
    signature === lastTokenUniverseAutoSortStateSignature
    && (nowMs - lastTokenUniverseAutoSortStateWriteMs) < TOKEN_UNIVERSE_AUTOSORT_STATE_WRITE_MIN_INTERVAL_MS
  ) {
    return;
  }

  await ensureWorkerRuntimeStateStore();
  const dbPool = getPool();
  await dbPool.query(
    `INSERT INTO worker_runtime_state_cache (state_key, state, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (state_key)
     DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
    [TOKEN_UNIVERSE_AUTOSORT_STATE_KEY, JSON.stringify(state)],
  );

  lastTokenUniverseAutoSortStateWriteMs = nowMs;
  lastTokenUniverseAutoSortStateSignature = signature;
};

const loadTokenUniverseHealthState = async (): Promise<TokenUniverseHealthState> => {
  await ensureWorkerRuntimeStateStore();
  const dbPool = getPool();
  const result = await dbPool.query<{ state: unknown | null }>(
    `SELECT state FROM worker_runtime_state_cache WHERE state_key = $1 LIMIT 1`,
    [TOKEN_UNIVERSE_HEALTH_STATE_KEY],
  );

  const state = result.rows[0]?.state;
  if (!isRecord(state) || !isRecord(state.mints)) {
    return {
      run: 0,
      mints: {},
      probeFailureStreak: 0,
      probeHealthyStreak: 0,
      probeFrozen: false,
      probeFrozenAt: null,
      lastSuccessfulProbeAt: null,
    };
  }

  const runValue = toFiniteNumber(state.run);
  const probeFailureStreakValue = toFiniteNumber(state.probeFailureStreak);
  const probeHealthyStreakValue = toFiniteNumber(state.probeHealthyStreak);
  const probeFrozen = state.probeFrozen === true;
  const probeFrozenAt = typeof state.probeFrozenAt === 'string' ? state.probeFrozenAt : null;
  const lastSuccessfulProbeAt = typeof state.lastSuccessfulProbeAt === 'string' ? state.lastSuccessfulProbeAt : null;
  const mints: Record<string, TokenUniverseHealthEntry> = {};
  for (const [mint, rawEntry] of Object.entries(state.mints)) {
    if (!isRecord(rawEntry)) continue;
    const deadRuns = toFiniteNumber(rawEntry.deadRuns);
    const admitRuns = toFiniteNumber(rawEntry.admitRuns);
    const evictRuns = toFiniteNumber(rawEntry.evictRuns);
    const enabledSinceRun = rawEntry.enabledSinceRun === null ? null : toFiniteNumber(rawEntry.enabledSinceRun);
    const enabled = rawEntry.enabled === true;
    const lastReason = typeof rawEntry.lastReason === 'string' ? rawEntry.lastReason : null;
    const lastSeenAt = typeof rawEntry.lastSeenAt === 'string' ? rawEntry.lastSeenAt : new Date().toISOString();
    if (!Number.isFinite(deadRuns ?? null)) continue;
    mints[mint] = {
      deadRuns: Math.max(0, Math.floor(deadRuns ?? 0)),
      admitRuns: Math.max(0, Math.floor(admitRuns ?? 0)),
      evictRuns: Math.max(0, Math.floor(evictRuns ?? 0)),
      enabled,
      enabledSinceRun: enabledSinceRun === null || !Number.isFinite(enabledSinceRun) ? null : Math.max(0, Math.floor(enabledSinceRun)),
      lastReason,
      lastSeenAt,
    };
  }

  return {
    run: runValue === null ? 0 : Math.max(0, Math.floor(runValue)),
    mints,
    probeFailureStreak: probeFailureStreakValue === null ? 0 : Math.max(0, Math.floor(probeFailureStreakValue)),
    probeHealthyStreak: probeHealthyStreakValue === null ? 0 : Math.max(0, Math.floor(probeHealthyStreakValue)),
    probeFrozen,
    probeFrozenAt,
    lastSuccessfulProbeAt,
  };
};

const persistTokenUniverseHealthState = async (state: TokenUniverseHealthState) => {
  await ensureWorkerRuntimeStateStore();
  const dbPool = getPool();
  await dbPool.query(
    `INSERT INTO worker_runtime_state_cache (state_key, state, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (state_key)
     DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
    [TOKEN_UNIVERSE_HEALTH_STATE_KEY, JSON.stringify(state)],
  );
};

const pushBounded = <T>(tape: T[], point: T, maxSize: number) => {
  tape.push(point);
  if (tape.length > maxSize) {
    tape.splice(0, tape.length - maxSize);
  }
};

const getMomentumTapeForMint = (mint: string): readonly MarketTapePoint[] => {
  if (mint === SOL_MINT) {
    return sharedMarketTape.solUsdPyth;
  }
  return jupiterMomentumTapeByMint.get(mint) ?? [];
};

const getSharedMarketTapeSummary = () => ({
  pythDepth: sharedMarketTape.solUsdPyth.length,
  jupiterDepth: sharedMarketTape.solUsdJupiter.length,
  driftDepth: sharedMarketTape.solUsdDrift.length,
  latestPythUsd: sharedMarketTape.solUsdPyth.at(-1)?.usdPrice ?? null,
  latestJupiterUsd: sharedMarketTape.solUsdJupiter.at(-1)?.usdPrice ?? null,
  latestDriftBps: sharedMarketTape.solUsdDrift.at(-1)?.driftBps ?? null,
});

const computeMomentumBps = (samples: readonly MarketTapePoint[], lookbackSamples: number): number | null => {
  if (samples.length <= lookbackSamples) {
    return null;
  }

  const latest = samples.at(-1);
  const baseline = samples.at(-(lookbackSamples + 1));

  if (!latest || !baseline || baseline.usdPrice <= 0) {
    return null;
  }

  return Math.round(((latest.usdPrice - baseline.usdPrice) / baseline.usdPrice) * 10_000);
};

const classifyMomentum = (momentumBps: number, thresholdBps: number): 'bullish' | 'bearish' | 'flat' => {
  if (momentumBps >= thresholdBps) {
    return 'bullish';
  }
  if (momentumBps <= -thresholdBps) {
    return 'bearish';
  }
  return 'flat';
};

const computeMomentumBpsAtOffset = (
  samples: readonly MarketTapePoint[],
  lookbackSamples: number,
  offsetFromEnd: number,
): number | null => {
  const latestIdx = samples.length - 1 - offsetFromEnd;
  const baselineIdx = latestIdx - lookbackSamples;
  if (latestIdx < 0 || baselineIdx < 0) {
    return null;
  }

  const latest = samples[latestIdx];
  const baseline = samples[baselineIdx];
  if (!latest || !baseline || baseline.usdPrice <= 0) {
    return null;
  }

  return Math.round(((latest.usdPrice - baseline.usdPrice) / baseline.usdPrice) * 10_000);
};

const hasMomentumRegimePersistence = (params: {
  samples: readonly MarketTapePoint[];
  lookbackSamples: number;
  thresholdBps: number;
  regime: 'bullish' | 'bearish';
  requiredSamples: number;
}) => {
  const requiredSamples = Math.max(1, params.requiredSamples);
  if (requiredSamples <= 1) {
    return true;
  }

  for (let offset = 0; offset < requiredSamples; offset += 1) {
    const momentumBps = computeMomentumBpsAtOffset(
      params.samples,
      params.lookbackSamples,
      offset,
    );
    if (momentumBps === null) {
      return false;
    }

    const regime = classifyMomentum(momentumBps, params.thresholdBps);
    if (regime !== params.regime) {
      return false;
    }
  }

  return true;
};

const parseQuotePriceImpactBps = (priceImpactPct: string | null | undefined): number | null => {
  if (!priceImpactPct) {
    return null;
  }

  const parsed = Number(priceImpactPct);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  const absoluteImpact = Math.abs(parsed);

  // Jupiter payloads have historically appeared as either fraction (0.01 = 1%)
  // or percentage-like values. Support both defensively.
  return absoluteImpact <= 1
    ? Math.round(absoluteImpact * 10_000)
    : Math.round(absoluteImpact * 100);
};

// Per-tick price/signal telemetry is high-frequency; throttle to stay well under Railway's
// 500 logs/sec replica cap (which was dropping messages). 0 disables throttling.
const WORKER_TICK_LOG_MIN_INTERVAL_MS = Number(process.env.WORKER_TICK_LOG_MIN_INTERVAL_MS ?? 5000);
let lastSignalLogMs = 0;
let lastPriceLogMs = 0;

const logSignalEvent = (event: object) => {
  const nowMs = Date.now();
  if (WORKER_TICK_LOG_MIN_INTERVAL_MS > 0 && (nowMs - lastSignalLogMs) < WORKER_TICK_LOG_MIN_INTERVAL_MS) {
    return;
  }
  lastSignalLogMs = nowMs;
  console.log(JSON.stringify({
    service: 'roguezero-worker',
    kind: 'signal',
    ts: new Date().toISOString(),
    ...event,
  }));
};

const logPriceEvent = (event: object) => {
  const nowMs = Date.now();
  if (WORKER_TICK_LOG_MIN_INTERVAL_MS > 0 && (nowMs - lastPriceLogMs) < WORKER_TICK_LOG_MIN_INTERVAL_MS) {
    return;
  }
  lastPriceLogMs = nowMs;
  console.log(JSON.stringify({
    service: 'roguezero-worker',
    kind: 'price',
    ts: new Date().toISOString(),
    ...event,
  }));
};

const getPythSampleAgeSeconds = (sample: PythSample) =>
  Math.max(0, Math.floor(Date.now() / 1000) - sample.publishTime);

const getPythGuardReason = (sample: PythSample): string | null => {
  const sampleAgeSeconds = getPythSampleAgeSeconds(sample);

  if (sampleAgeSeconds > signalPolicy.maxPythAgeSeconds) {
    return `stale_price_${sampleAgeSeconds}s`;
  }

  if (sample.confidenceBps > signalPolicy.maxPythConfidenceBps) {
    return `confidence_too_wide_${sample.confidenceBps}bps`;
  }

  return null;
};

const isSafeSqlIdentifier = (value: string) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value);

const dedupeMints = (mints: readonly string[]) => {
  const next: string[] = [];
  const seen = new Set<string>();

  for (const mint of mints) {
    if (!solanaPublicKeyPattern.test(mint)) continue;
    if (seen.has(mint)) continue;
    seen.add(mint);
    next.push(mint);
  }

  return next;
};

const isHardBlockedUniverseToken = (params: { mint: string; symbol?: string | null }) => {
  if (TOKEN_UNIVERSE_HARD_BLOCKED_MINTS.has(params.mint)) {
    return true;
  }

  const symbol = params.symbol?.trim().toUpperCase();
  return !!symbol && TOKEN_UNIVERSE_HARD_BLOCKED_SYMBOLS.has(symbol);
};

const computePriceMomentumBps = (latestUsd: number | null, priorUsd: number | null) => {
  if (!latestUsd || !priorUsd || priorUsd <= 0) {
    return 0;
  }
  return Math.round(((latestUsd - priorUsd) / priorUsd) * 10_000);
};

const buildUniverseSortScore = (params: {
  momentumBps: number;
  routeFound: boolean;
  priceImpactBps: number | null;
}) => {
  const boundedMomentum = Math.max(-1_000, Math.min(1_000, params.momentumBps));
  const impactPenalty = params.priceImpactBps ?? 1_000;
  const routeBonus = params.routeFound ? 200 : -2_000;
  return boundedMomentum - impactPenalty + routeBonus;
};

const getMintDecimals = (mint: string): number => {
  if (mint === SOL_MINT) return 9;
  if (mint === USDC_MINT) return 6;
  if (mint === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB') return 6;
  return latestJupiterDecimalsByMint.get(mint) ?? 9;
};

const toUiAmount = (mint: string, atomicAmount: number, decimalsOverride?: number | null): number => {
  const decimals = decimalsOverride ?? getMintDecimals(mint);
  return atomicAmount / (10 ** decimals);
};

const resolveTokenSymbol = (mint: string): string => {
  if (mint === SOL_MINT) return 'SOL';
  if (mint === USDC_MINT) return 'USDC';
  if (mint === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB') return 'USDT';
  return tokenUniverseSymbolByMint.get(mint) ?? `${mint.slice(0, 4)}...${mint.slice(-4)}`;
};

const isLongPositionStatus = (status: SessionPositionState['status']) =>
  status === 'long' || status === 'long_sol';

const getPositionMint = (positionState: SessionPositionState): string =>
  positionState.positionMint ?? SOL_MINT;

const getPositionSymbol = (positionState: SessionPositionState): string =>
  positionState.positionSymbol ?? resolveTokenSymbol(getPositionMint(positionState));

const clonePositionState = (positionState: SessionPositionState): SessionPositionState => ({
  ...positionState,
});

const normalizePositionsState = (positionsState: SessionPositionsState | null | undefined): SessionPositionsState => {
  const nextPositions = Object.fromEntries(
    Object.entries(positionsState?.positions ?? {}).filter(([, position]) => (
      !!position
      && isLongPositionStatus(position.status)
      && typeof position.positionMint === 'string'
    )),
  ) as SessionPositionsState['positions'];

  const activePositionMint = positionsState?.activePositionMint;
  return {
    activePositionMint: activePositionMint && nextPositions[activePositionMint]
      ? activePositionMint
      : (Object.keys(nextPositions)[0] ?? null),
    positions: nextPositions,
  };
};

const getPositionsState = (session: RawSession): SessionPositionsState => {
  if (session.service_control.positionsState) {
    return normalizePositionsState(session.service_control.positionsState);
  }

  const legacy = session.service_control.positionState;
  if (legacy && isLongPositionStatus(legacy.status)) {
    const mint = legacy.positionMint ?? SOL_MINT;
    return {
      activePositionMint: mint,
      positions: {
        [mint]: clonePositionState({
          ...legacy,
          positionMint: mint,
          positionSymbol: legacy.positionSymbol ?? resolveTokenSymbol(mint),
        }),
      },
    };
  }

  return {
    activePositionMint: null,
    positions: {},
  };
};

const listOpenPositions = (positionsState: SessionPositionsState) =>
  Object.entries(normalizePositionsState(positionsState).positions)
    .map(([mint, position]) => ({ mint, position }))
    .filter(({ position }) => isLongPositionStatus(position.status));

const countOpenPositions = (positionsState: SessionPositionsState) =>
  listOpenPositions(positionsState).length;

const persistPositionsState = async (
  session: RawSession,
  positionsState: SessionPositionsState,
  summaryFallback: Partial<SessionPositionState> = {},
) => {
  const normalized = normalizePositionsState(positionsState);
  const currentSummary = session.service_control.positionState;
  const nextSummary = summarizePositionsState(normalized, {
    lastMarkedPriceUsd: summaryFallback.lastMarkedPriceUsd ?? currentSummary?.lastMarkedPriceUsd ?? null,
    lastMarkedAt: summaryFallback.lastMarkedAt ?? currentSummary?.lastMarkedAt ?? null,
    exitReason: summaryFallback.exitReason ?? currentSummary?.exitReason ?? null,
  });

  await persistServiceControl(session, {
    positionsState: normalized,
    positionState: nextSummary,
  });

  return normalized;
};

const buildMintMomentumSignal = (mint: string, config: { lookbackSamples: number; thresholdBps: number }) => {
  const latestUsd = latestJupiterUsdByMint.get(mint) ?? null;
  const priorUsd = previousJupiterUsdByMint.get(mint) ?? null;
  const tape = getMomentumTapeForMint(mint);
  const momentumBps = computeMomentumBps(tape, config.lookbackSamples);
  const fallbackMomentumBps = computePriceMomentumBps(latestUsd, priorUsd);
  const ready = momentumBps !== null;
  return {
    at: new Date().toISOString(),
    source: 'pyth-hermes' as const,
    signal: 'momentum' as const,
    status: ready ? 'ready' as const : 'warming_up' as const,
    regime: ready ? classifyMomentum(momentumBps, config.thresholdBps) : null,
    lookbackSamples: config.lookbackSamples,
    thresholdBps: config.thresholdBps,
    momentumBps: ready ? momentumBps : null,
    guardReason: ready ? null : `price_tape_warming_${tape.length}/${config.lookbackSamples + 1}`,
    latestUsd,
    priorUsdPrice: priorUsd,
    fallbackMomentumBps,
  };
};

const buildRuntimeSignalForMint = (
  mint: string,
  activeStrategy: 'momentum' | 'mean_reversion' | 'supertrend',
  strategyConfig: ReturnType<typeof getSessionStrategyConfig>,
): NonNullable<Session['serviceControl']['lastSignal']> => {
  if (activeStrategy === 'momentum') {
    return buildMintMomentumSignal(mint, strategyConfig.momentum);
  }

  if (activeStrategy === 'mean_reversion') {
    const tape = getMomentumTapeForMint(mint).map((sample) => ({
      sampledAt: sample.sampledAt,
      usdPrice: sample.usdPrice,
    }));
    const signal = computeBollingerSignal(tape, strategyConfig.meanReversion);
    return {
      at: new Date().toISOString(),
      source: 'pyth-hermes',
      signal: 'momentum',
      status: signal.status,
      regime: signal.regime,
      lookbackSamples: strategyConfig.momentum.lookbackSamples,
      thresholdBps: strategyConfig.momentum.thresholdBps,
      momentumBps: signal.momentumBps,
      guardReason: signal.guardReason,
    };
  }

  if (activeStrategy === 'supertrend') {
    const tape = getMomentumTapeForMint(mint).map((sample) => ({
      sampledAt: sample.sampledAt,
      usdPrice: sample.usdPrice,
    }));
    const signal = computeSupertrendSignal(tape, strategyConfig.supertrend);
    return {
      at: new Date().toISOString(),
      source: 'pyth-hermes',
      signal: 'momentum',
      status: signal.status,
      regime: signal.regime,
      lookbackSamples: strategyConfig.momentum.lookbackSamples,
      thresholdBps: strategyConfig.momentum.thresholdBps,
      momentumBps: signal.momentumBps,
      guardReason: signal.guardReason,
    };
  }

  return buildMintMomentumSignal(mint, strategyConfig.momentum);
};

const applyTokenUniverseAutoSort = async () => {
  if (!TOKEN_UNIVERSE_AUTO_SORT_ENABLED) {
    return;
  }

  const now = Date.now();
  if ((now - lastTokenUniverseAutoSortAt) < TOKEN_UNIVERSE_AUTO_SORT_INTERVAL_MS) {
    return;
  }
  lastTokenUniverseAutoSortAt = now;

  if (!tokenUniverseTableMeta?.enabledColumn || !tokenUniverseTableMeta?.priorityColumn) {
    tokenUniverseActiveMints = [];
    await persistTokenUniverseMetadata({
      sourceTable: tokenUniverseSourceTable,
      status: 'skipped',
      reason: 'missing_enabled_or_priority_column',
      candidateCount: 0,
      enabledCount: 0,
      topTokens: [],
    });
    await persistTokenUniverseAutoSortState({
      status: 'skipped',
      reason: 'missing_enabled_or_priority_column',
      sourceTable: tokenUniverseSourceTable,
      lastRunAt: new Date().toISOString(),
    });
    logPriceEvent({
      provider: 'token-universe',
      autoSort: 'skipped',
      reason: 'missing_enabled_or_priority_column',
      sourceTable: tokenUniverseSourceTable,
    });
    return;
  }

  const candidateMints = dedupeMints(tokenUniverseMints)
    .filter((mint) => mint !== SOL_MINT && mint !== USDC_MINT)
    .slice(0, Math.max(1, TOKEN_UNIVERSE_AUTO_SORT_MAX_MINTS));

  if (candidateMints.length === 0) {
    tokenUniverseActiveMints = [];
    await persistTokenUniverseMetadata({
      sourceTable: tokenUniverseSourceTable,
      status: 'skipped',
      reason: 'no_candidates',
      candidateCount: 0,
      enabledCount: 0,
      topTokens: [],
    });
    await persistTokenUniverseAutoSortState({
      status: 'skipped',
      reason: 'no_candidates',
      sourceTable: tokenUniverseSourceTable,
      lastRunAt: new Date().toISOString(),
    });
    logPriceEvent({
      provider: 'token-universe',
      autoSort: 'skipped',
      reason: 'no_candidates',
      sourceTable: tokenUniverseSourceTable,
    });
    return;
  }

  const rankedSamples: TokenUniverseRankSample[] = [];
  const healthState = await loadTokenUniverseHealthState();
  tokenUniverseProbeFrozen = healthState.probeFrozen;
  const currentRun = healthState.run + 1;
  const nextHealthState: TokenUniverseHealthState = {
    run: currentRun,
    mints: { ...healthState.mints },
    probeFailureStreak: healthState.probeFailureStreak,
    probeHealthyStreak: healthState.probeHealthyStreak,
    probeFrozen: healthState.probeFrozen,
    probeFrozenAt: healthState.probeFrozenAt,
    lastSuccessfulProbeAt: healthState.lastSuccessfulProbeAt,
  };
  const pruneDecisions = new Map<string, { reason: string; deadRuns: number; crossedThreshold: boolean }>();
  const recoveredMints: string[] = [];
  let routeProbeUnavailableCount = 0;
  const currentlyEnabledUniverseMints = new Set(tokenUniverseActiveMints);
  const buildHealthEntry = (
    mint: string,
    previous: TokenUniverseHealthEntry | null,
    overrides: Partial<TokenUniverseHealthEntry> = {},
  ): TokenUniverseHealthEntry => {
    const dbEnabled = currentlyEnabledUniverseMints.has(mint);
    const trustedSeed = TRUSTED_ENTRY_UNIVERSE_MINT_SET.has(mint);
    const enabled = overrides.enabled ?? previous?.enabled ?? dbEnabled ?? trustedSeed;
    return {
      deadRuns: overrides.deadRuns ?? previous?.deadRuns ?? 0,
      admitRuns: overrides.admitRuns ?? previous?.admitRuns ?? 0,
      evictRuns: overrides.evictRuns ?? previous?.evictRuns ?? 0,
      enabled,
      enabledSinceRun: overrides.enabledSinceRun
        ?? previous?.enabledSinceRun
        ?? (enabled ? currentRun : null),
      lastReason: overrides.lastReason ?? previous?.lastReason ?? null,
      lastSeenAt: overrides.lastSeenAt ?? new Date().toISOString(),
    };
  };
  for (const mint of candidateMints) {
    const previous = nextHealthState.mints[mint] ?? null;
    const routeCheck = await apiPost<BuildRouteScoutResponse>('/jupiter/swap/build', {
      inputMint: USDC_MINT,
      outputMint: mint,
      amount: String(TOKEN_UNIVERSE_AUTO_SORT_NOTIONAL_USDC_ATOMIC),
      taker: universeSortProbeTaker,
      feeTokenSymbol: 'USDC',
      slippageBps: '50',
    });

    if (!routeCheck.ok && routeCheck.status >= 500) {
      routeProbeUnavailableCount += 1;
      if (previous) {
        nextHealthState.mints[mint] = {
          ...previous,
          lastReason: 'route_probe_unavailable',
          lastSeenAt: new Date().toISOString(),
        };
      }
      continue;
    }

    const outAmountAtomic = parseUnsignedNumeric(routeCheck.data?.build?.outAmount);
    const routeFound = routeCheck.ok && Boolean(outAmountAtomic && outAmountAtomic > 0);
    const priceImpactBps = parseQuotePriceImpactBps(routeCheck.data?.build?.priceImpactPct ?? null);
    const usdPrice = latestJupiterUsdByMint.get(mint) ?? null;
    const priorUsdPrice = previousJupiterUsdByMint.get(mint) ?? null;
    const momentumBps = computePriceMomentumBps(usdPrice, priorUsdPrice);

    rankedSamples.push({
      mint,
      usdPrice,
      priorUsdPrice,
      momentumBps,
      routeFound,
      priceImpactBps,
      score: buildUniverseSortScore({ momentumBps, routeFound, priceImpactBps }),
    });

    let deadReason: string | null = null;
    if (!routeFound) {
      deadReason = 'route_not_found';
    } else if (priceImpactBps !== null && priceImpactBps > (TOKEN_UNIVERSE_AUTO_SORT_MAX_PRICE_IMPACT_BPS * 2)) {
      deadReason = 'extreme_price_impact';
    }

    if (deadReason) {
      const deadRuns = (previous?.deadRuns ?? 0) + 1;
      nextHealthState.mints[mint] = {
        ...buildHealthEntry(mint, previous),
        deadRuns,
        lastReason: deadReason,
        lastSeenAt: new Date().toISOString(),
      };
      const crossedThreshold = (previous?.deadRuns ?? 0) < TOKEN_UNIVERSE_DEAD_RUN_THRESHOLD
        && deadRuns >= TOKEN_UNIVERSE_DEAD_RUN_THRESHOLD;
      pruneDecisions.set(mint, {
        reason: deadReason,
        deadRuns,
        crossedThreshold,
      });
    } else {
      if ((previous?.deadRuns ?? 0) >= TOKEN_UNIVERSE_DEAD_RUN_THRESHOLD) {
        recoveredMints.push(mint);
      }
      nextHealthState.mints[mint] = {
        ...buildHealthEntry(mint, previous),
        deadRuns: 0,
        lastReason: null,
        lastSeenAt: new Date().toISOString(),
      };
    }
  }

  const nowIso = new Date().toISOString();
  const hasProbeUnavailable = routeProbeUnavailableCount > 0;

  if (hasProbeUnavailable) {
    nextHealthState.probeFailureStreak = Math.max(1, nextHealthState.probeFailureStreak + 1);
    nextHealthState.probeHealthyStreak = 0;
  } else {
    nextHealthState.probeFailureStreak = 0;
    nextHealthState.probeHealthyStreak = Math.min(10_000, nextHealthState.probeHealthyStreak + 1);
    if (rankedSamples.length > 0) {
      nextHealthState.lastSuccessfulProbeAt = nowIso;
    }
  }

  if (!nextHealthState.probeFrozen
    && nextHealthState.probeFailureStreak >= Math.max(1, TOKEN_UNIVERSE_PROBE_FREEZE_FAILURE_STREAK)) {
    nextHealthState.probeFrozen = true;
    nextHealthState.probeFrozenAt = nowIso;
  }

  if (nextHealthState.probeFrozen
    && !hasProbeUnavailable
    && nextHealthState.probeHealthyStreak >= Math.max(1, TOKEN_UNIVERSE_PROBE_UNFREEZE_HEALTHY_STREAK)) {
    nextHealthState.probeFrozen = false;
    nextHealthState.probeFrozenAt = null;
    nextHealthState.probeFailureStreak = 0;
  }

  if (hasProbeUnavailable) {
    tokenUniverseActiveMints = [];
    const reason = nextHealthState.probeFrozen
      ? 'probe_health_frozen'
      : 'route_probe_unavailable';
    const trimmed = trimTokenUniverseHealthState(nextHealthState);
    await persistTokenUniverseHealthState(trimmed);
    tokenUniverseProbeFrozen = trimmed.probeFrozen;

    await persistTokenUniverseMetadata({
      sourceTable: tokenUniverseSourceTable,
      status: 'skipped',
      reason,
      candidateCount: rankedSamples.length,
      enabledCount: 0,
      topTokens: [],
    });

    await persistTokenUniverseAutoSortState({
      status: 'skipped',
      reason,
      sourceTable: tokenUniverseSourceTable,
      routeProbeUnavailableCount,
      probeFailureStreak: trimmed.probeFailureStreak,
      probeHealthyStreak: trimmed.probeHealthyStreak,
      probeFrozenAt: trimmed.probeFrozenAt,
      lastSuccessfulProbeAt: trimmed.lastSuccessfulProbeAt,
      lastRunAt: nowIso,
    });
    logPriceEvent({
      provider: 'token-universe',
      autoSort: 'skipped',
      reason,
      sourceTable: tokenUniverseSourceTable,
      routeProbeUnavailableCount,
      probeFailureStreak: trimmed.probeFailureStreak,
      probeHealthyStreak: trimmed.probeHealthyStreak,
      probeFrozenAt: trimmed.probeFrozenAt,
      lastSuccessfulProbeAt: trimmed.lastSuccessfulProbeAt,
    });
    return;
  }

  if (nextHealthState.probeFrozen) {
    tokenUniverseActiveMints = [];
    const trimmed = trimTokenUniverseHealthState(nextHealthState);
    await persistTokenUniverseHealthState(trimmed);
    tokenUniverseProbeFrozen = trimmed.probeFrozen;

    await persistTokenUniverseMetadata({
      sourceTable: tokenUniverseSourceTable,
      status: 'skipped',
      reason: 'probe_health_frozen',
      candidateCount: rankedSamples.length,
      enabledCount: 0,
      topTokens: [],
    });

    await persistTokenUniverseAutoSortState({
      status: 'skipped',
      reason: 'probe_health_frozen',
      sourceTable: tokenUniverseSourceTable,
      routeProbeUnavailableCount,
      probeFailureStreak: trimmed.probeFailureStreak,
      probeHealthyStreak: trimmed.probeHealthyStreak,
      probeFrozenAt: trimmed.probeFrozenAt,
      lastSuccessfulProbeAt: trimmed.lastSuccessfulProbeAt,
      lastRunAt: nowIso,
    });

    logPriceEvent({
      provider: 'token-universe',
      autoSort: 'skipped',
      reason: 'probe_health_frozen',
      sourceTable: tokenUniverseSourceTable,
      routeProbeUnavailableCount,
      probeFailureStreak: trimmed.probeFailureStreak,
      probeHealthyStreak: trimmed.probeHealthyStreak,
      probeFrozenAt: trimmed.probeFrozenAt,
      lastSuccessfulProbeAt: trimmed.lastSuccessfulProbeAt,
    });
    return;
  }

  if (rankedSamples.length === 0) {
    tokenUniverseActiveMints = [];
    const reason = 'no_candidates_after_probe';

    const trimmed = trimTokenUniverseHealthState(nextHealthState);
    await persistTokenUniverseHealthState(trimmed);
    tokenUniverseProbeFrozen = trimmed.probeFrozen;

    await persistTokenUniverseMetadata({
      sourceTable: tokenUniverseSourceTable,
      status: 'skipped',
      reason,
      candidateCount: 0,
      enabledCount: 0,
      topTokens: [],
    });

    await persistTokenUniverseAutoSortState({
      status: 'skipped',
      reason,
      sourceTable: tokenUniverseSourceTable,
      routeProbeUnavailableCount,
      probeFailureStreak: trimmed.probeFailureStreak,
      probeHealthyStreak: trimmed.probeHealthyStreak,
      probeFrozenAt: trimmed.probeFrozenAt,
      lastSuccessfulProbeAt: trimmed.lastSuccessfulProbeAt,
      lastRunAt: nowIso,
    });
    logPriceEvent({
      provider: 'token-universe',
      autoSort: 'skipped',
      reason,
      sourceTable: tokenUniverseSourceTable,
      routeProbeUnavailableCount,
      probeFailureStreak: trimmed.probeFailureStreak,
      probeHealthyStreak: trimmed.probeHealthyStreak,
      probeFrozenAt: trimmed.probeFrozenAt,
      lastSuccessfulProbeAt: trimmed.lastSuccessfulProbeAt,
    });
    return;
  }

  rankedSamples.sort((a, b) => b.score - a.score);
  const enabledTop = Math.max(1, TOKEN_UNIVERSE_AUTO_SORT_TOP_ENABLED);
  const admissionApprovedMints = new Set(tokenUniverseMints);

  const dbPool = getTokenUniversePool();
  const table = tokenUniverseTableMeta.tableName;
  const mintColumn = tokenUniverseTableMeta.mintColumn;
  const enabledColumn = tokenUniverseTableMeta.enabledColumn;
  const priorityColumn = tokenUniverseTableMeta.priorityColumn;
  const updatedAtColumn = tokenUniverseTableMeta.updatedAtColumn;
  const deadletterRows: Array<{
    mint: string;
    reason: string;
    deadRuns: number;
    score: number;
    momentumBps: number;
    priceImpactBps: number | null;
  }> = [];
  const admittedRows: string[] = [];
  const evictedRows: string[] = [];
  const enabledRuntimeMints: string[] = [];

  for (let index = 0; index < rankedSamples.length; index += 1) {
    const sample = rankedSamples[index];
    const trustedSeed = TRUSTED_ENTRY_UNIVERSE_MINT_SET.has(sample.mint);
    const admissionApproved = admissionApprovedMints.has(sample.mint);
    const entry = buildHealthEntry(sample.mint, nextHealthState.mints[sample.mint] ?? null);

    const enableByRank = index < enabledTop;
    const evictionRank = enabledTop + Math.max(1, TOKEN_UNIVERSE_EVICTION_RANK_BUFFER);
    const rankAllowsStay = index < evictionRank;
    const enableByImpact = sample.priceImpactBps === null || sample.priceImpactBps <= TOKEN_UNIVERSE_AUTO_SORT_MAX_PRICE_IMPACT_BPS;
    const qualityPass = sample.routeFound && enableByImpact;
    const strongCandidate = qualityPass && enableByRank;
    const weakCandidate = !qualityPass || !rankAllowsStay;
    const pruneDecision = pruneDecisions.get(sample.mint);
    const shouldPrune = TOKEN_UNIVERSE_DEAD_PRUNE_ENABLED
      && Boolean(pruneDecision)
      && !trustedSeed
      && (pruneDecision?.deadRuns ?? 0) >= TOKEN_UNIVERSE_DEAD_RUN_THRESHOLD;

    let shouldEnable = admissionApproved || entry.enabled || trustedSeed;
    let enabledSinceRun = entry.enabledSinceRun;
    let admitRuns = entry.admitRuns;
    let evictRuns = entry.evictRuns;

    if (shouldPrune) {
      shouldEnable = false;
      enabledSinceRun = null;
      admitRuns = 0;
      evictRuns = 0;
    } else if (trustedSeed || admissionApproved) {
      shouldEnable = true;
      enabledSinceRun = enabledSinceRun ?? currentRun;
      admitRuns = strongCandidate ? Math.min(admitRuns + 1, 10_000) : admitRuns;
      evictRuns = 0;
    } else if (!shouldEnable) {
      admitRuns = strongCandidate ? (admitRuns + 1) : 0;
      evictRuns = 0;
      if (admitRuns >= Math.max(1, TOKEN_UNIVERSE_ADMISSION_STREAK)) {
        shouldEnable = true;
        enabledSinceRun = currentRun;
        evictRuns = 0;
        admittedRows.push(sample.mint);
      }
    } else {
      admitRuns = strongCandidate ? Math.min(admitRuns + 1, 10_000) : admitRuns;
      const stayAge = enabledSinceRun === null ? 0 : (currentRun - enabledSinceRun);
      if (stayAge < Math.max(1, TOKEN_UNIVERSE_MIN_STAY_RUNS)) {
        evictRuns = 0;
      } else if (weakCandidate) {
        evictRuns += 1;
      } else {
        evictRuns = 0;
      }

      if (evictRuns >= Math.max(1, TOKEN_UNIVERSE_EVICTION_STREAK)) {
        shouldEnable = false;
        enabledSinceRun = null;
        admitRuns = 0;
        evictRuns = 0;
        evictedRows.push(sample.mint);
      }
    }

    nextHealthState.mints[sample.mint] = {
      ...entry,
      admitRuns,
      evictRuns,
      enabled: shouldEnable,
      enabledSinceRun,
      lastReason: shouldPrune
        ? (pruneDecision?.reason ?? entry.lastReason)
        : trustedSeed
          ? 'trusted_seed'
          : admissionApproved
            ? (strongCandidate ? 'route_qualified_active' : 'route_qualified_pool')
          : weakCandidate
          ? 'weak_candidate'
          : strongCandidate
            ? 'strong_candidate'
            : entry.lastReason,
      lastSeenAt: new Date().toISOString(),
    };

    if (shouldEnable) {
      enabledRuntimeMints.push(sample.mint);
    }

    const priority = shouldPrune ? 0 : Math.max(0, 1_000 - index);

    const updateSql = updatedAtColumn
      ? `UPDATE public.${table}
           SET ${enabledColumn} = $1,
               ${priorityColumn} = $2,
               ${updatedAtColumn} = NOW()
         WHERE ${mintColumn}::text = $3`
      : `UPDATE public.${table}
           SET ${enabledColumn} = $1,
               ${priorityColumn} = $2
         WHERE ${mintColumn}::text = $3`;

    await dbPool.query(updateSql, [shouldEnable, priority, sample.mint]);

    if (shouldPrune && pruneDecision?.crossedThreshold) {
      deadletterRows.push({
        mint: sample.mint,
        reason: pruneDecision.reason,
        deadRuns: pruneDecision.deadRuns,
        score: sample.score,
        momentumBps: sample.momentumBps,
        priceImpactBps: sample.priceImpactBps,
      });
    }
  }

  for (const token of DEFAULT_TOKEN_UNIVERSE_SEED) {
    if (!TRUSTED_ENTRY_UNIVERSE_MINT_SET.has(token.mint)) continue;
    if (!enabledRuntimeMints.includes(token.mint)) {
      enabledRuntimeMints.push(token.mint);
    }
    if (rankedSamples.some((sample) => sample.mint === token.mint)) continue;

    const updateSql = updatedAtColumn
      ? `UPDATE public.${table}
           SET ${enabledColumn} = TRUE,
               ${priorityColumn} = GREATEST(COALESCE(${priorityColumn}, 0), $1),
               ${updatedAtColumn} = NOW()
         WHERE ${mintColumn}::text = $2`
      : `UPDATE public.${table}
           SET ${enabledColumn} = TRUE,
               ${priorityColumn} = GREATEST(COALESCE(${priorityColumn}, 0), $1)
         WHERE ${mintColumn}::text = $2`;

    await dbPool.query(updateSql, [token.priority, token.mint]);
    nextHealthState.mints[token.mint] = buildHealthEntry(token.mint, nextHealthState.mints[token.mint] ?? null, {
      enabled: true,
      enabledSinceRun: nextHealthState.mints[token.mint]?.enabledSinceRun ?? currentRun,
      evictRuns: 0,
      lastReason: 'trusted_seed',
    });
  }

  if (deadletterRows.length > 0) {
    for (const row of deadletterRows) {
      try {
        await dbPool.query(
          `INSERT INTO public.rz_token_universe_deadletter (
             source_table, mint, symbol, reason, dead_runs, score,
             momentum_bps, price_impact_bps, details, dumped_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, now())`,
          [
            table,
            row.mint,
            null,
            row.reason,
            row.deadRuns,
            row.score,
            row.momentumBps,
            row.priceImpactBps,
            JSON.stringify({
              reason: row.reason,
              deadRuns: row.deadRuns,
              score: row.score,
              momentumBps: row.momentumBps,
              priceImpactBps: row.priceImpactBps,
            }),
          ],
        );
      } catch {
        // deadletter writes are best-effort only
      }
    }
  }

  if (recoveredMints.length > 0) {
    for (const mint of recoveredMints) {
      try {
        await dbPool.query(
          `UPDATE public.rz_token_universe_deadletter
              SET recovered_at = now(),
                  recovered_reason = 'route_and_impact_recovered'
            WHERE id = (
              SELECT id
                FROM public.rz_token_universe_deadletter
               WHERE mint = $1
                 AND recovered_at IS NULL
               ORDER BY dumped_at DESC
               LIMIT 1
            )`,
          [mint],
        );
      } catch {
        // best-effort only
      }
    }
  }

  const trimmed = trimTokenUniverseHealthState(nextHealthState);
  await persistTokenUniverseHealthState(trimmed);
  tokenUniverseProbeFrozen = trimmed.probeFrozen;
  tokenUniverseActiveMints = dedupeMints(enabledRuntimeMints);
  const routeAcceptedCount = rankedSamples.filter((sample, idx) => idx < enabledTop && sample.routeFound && (sample.priceImpactBps === null || sample.priceImpactBps <= TOKEN_UNIVERSE_AUTO_SORT_MAX_PRICE_IMPACT_BPS)).length;
  const enabledCount = tokenUniverseActiveMints.length;

  logPriceEvent({
    provider: 'token-universe',
    autoSort: 'applied',
    sourceTable: table,
    candidateCount: rankedSamples.length,
    enabledCount,
    routeAcceptedCount,
    deadDumpCount: deadletterRows.length,
    recoveredCount: recoveredMints.length,
    admittedCount: admittedRows.length,
    evictedCount: evictedRows.length,
    routeProbeUnavailableCount,
    probeFailureStreak: trimmed.probeFailureStreak,
    probeHealthyStreak: trimmed.probeHealthyStreak,
    probeFrozenAt: trimmed.probeFrozenAt,
    lastSuccessfulProbeAt: trimmed.lastSuccessfulProbeAt,
    top: rankedSamples.slice(0, 5).map((sample, idx) => ({
      rank: idx + 1,
      mint: sample.mint,
      score: sample.score,
      momentumBps: sample.momentumBps,
      priceImpactBps: sample.priceImpactBps,
      routeFound: sample.routeFound,
    })),
  });

  lastTokenUniverseEngineAppliedAt = Date.now();
  lastTokenUniverseEngineEnabledCount = enabledCount;

  const avgMomentumBps = rankedSamples.length > 0
    ? rankedSamples.reduce((sum, sample) => sum + sample.momentumBps, 0) / rankedSamples.length
    : 0;
  const impactSamples = rankedSamples
    .map((sample) => sample.priceImpactBps)
    .filter((value): value is number => value !== null);
  const avgPriceImpactBps = impactSamples.length > 0
    ? impactSamples.reduce((sum, value) => sum + value, 0) / impactSamples.length
    : null;

  await persistTokenUniverseMetadata({
    sourceTable: table,
    status: 'applied',
    reason: null,
    candidateCount: rankedSamples.length,
    enabledCount,
    avgMomentumBps,
    avgPriceImpactBps,
    topTokens: rankedSamples.slice(0, 10).map((sample, idx) => ({
      rank: idx + 1,
      mint: sample.mint,
      score: sample.score,
      momentumBps: sample.momentumBps,
      priceImpactBps: sample.priceImpactBps,
      routeFound: sample.routeFound,
    })),
  }, dbPool);

  try {
    await persistMarketScannerRun({
      sourceTable: table,
      status: 'applied',
      reason: null,
      samples: rankedSamples,
      enabledTop,
      dbPool,
    });
  } catch (err) {
    logPriceEvent({
      provider: 'market-scanner',
      persistFailed: true,
      error: String(err),
    });
  }

  await persistTokenUniverseAutoSortState({
    status: 'applied',
    reason: null,
    sourceTable: table,
    candidateCount: rankedSamples.length,
    enabledCount,
    deadDumpCount: deadletterRows.length,
    recoveredCount: recoveredMints.length,
    admittedCount: admittedRows.length,
    evictedCount: evictedRows.length,
    routeProbeUnavailableCount,
    probeFailureStreak: trimmed.probeFailureStreak,
    probeHealthyStreak: trimmed.probeHealthyStreak,
    probeFrozenAt: trimmed.probeFrozenAt,
    lastSuccessfulProbeAt: trimmed.lastSuccessfulProbeAt,
    top: rankedSamples.slice(0, 5).map((sample, idx) => ({
      rank: idx + 1,
      mint: sample.mint,
      score: sample.score,
      momentumBps: sample.momentumBps,
      priceImpactBps: sample.priceImpactBps,
      routeFound: sample.routeFound,
    })),
    lastRunAt: new Date().toISOString(),
  });
};

const ensureTokenUniverseTable = async () => {
  if (tokenUniverseBootstrapAttempted || !TOKEN_UNIVERSE_BOOTSTRAP_ENABLED) {
    return;
  }
  tokenUniverseBootstrapAttempted = true;

  try {
    const dbPool = getTokenUniversePool();
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS public.rz_token_universe (
        mint TEXT PRIMARY KEY,
        symbol TEXT,
        enabled BOOLEAN NOT NULL DEFAULT true,
        priority INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await dbPool.query(`
      ALTER TABLE public.rz_token_universe
        ADD COLUMN IF NOT EXISTS notes TEXT
    `);

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS public.rz_token_universe_metadata (
        id BIGSERIAL PRIMARY KEY,
        source_table TEXT,
        status TEXT NOT NULL,
        reason TEXT,
        candidate_count INTEGER,
        enabled_count INTEGER,
        avg_momentum_bps DOUBLE PRECISION,
        avg_price_impact_bps DOUBLE PRECISION,
        top_tokens JSONB,
        built_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS public.rz_token_universe_deadletter (
        id BIGSERIAL PRIMARY KEY,
        source_table TEXT,
        mint TEXT NOT NULL,
        symbol TEXT,
        reason TEXT NOT NULL,
        dead_runs INTEGER NOT NULL,
        score DOUBLE PRECISION,
        momentum_bps DOUBLE PRECISION,
        price_impact_bps DOUBLE PRECISION,
        dumped_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        details JSONB
      )
    `);

    await dbPool.query(`
      ALTER TABLE public.rz_token_universe_deadletter
      ADD COLUMN IF NOT EXISTS recovered_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS recovered_reason TEXT
    `);

    for (const token of DEFAULT_TOKEN_UNIVERSE_SEED) {
      await dbPool.query(
        `INSERT INTO public.rz_token_universe (mint, symbol, enabled, priority, notes)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (mint) DO NOTHING`,
        [
          token.mint,
          token.symbol,
          TRUSTED_ENTRY_UNIVERSE_MINT_SET.has(token.mint),
          token.priority,
          TRUSTED_ENTRY_UNIVERSE_MINT_SET.has(token.mint) ? 'core-seed' : 'disabled:legacy-static-seed',
        ],
      );
    }

    logPriceEvent({
      provider: 'token-universe',
      bootstrap: 'completed',
      table: 'rz_token_universe',
      seeded: DEFAULT_TOKEN_UNIVERSE_SEED.length,
    });
  } catch (err) {
    logPriceEvent({
      provider: 'token-universe',
      bootstrap: 'failed',
      error: String(err),
    });
  }
};

const refreshTokenUniverseMints = async (force = false) => {
  const now = Date.now();
  if (!force && (now - lastTokenUniverseRefreshAt) < TOKEN_UNIVERSE_REFRESH_MS) {
    return tokenUniverseMints;
  }
  lastTokenUniverseRefreshAt = now;

  if (TOKEN_UNIVERSE_TABLE_CANDIDATES.length === 0) {
    tokenUniverseMints = [];
    tokenUniverseActiveMints = [];
    tokenUniverseSymbolByMint.clear();
    tokenUniverseSourceTable = null;
    tokenUniverseTableMeta = null;
    return tokenUniverseMints;
  }

  try {
    await ensureTokenUniverseTable();
    const dbPool = getTokenUniversePool();
    const tableResult = await dbPool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])
        ORDER BY table_name`,
      [TOKEN_UNIVERSE_TABLE_CANDIDATES],
    );

    const existingTables = new Set(tableResult.rows.map((row) => row.table_name));
    const selectedTable = TOKEN_UNIVERSE_TABLE_CANDIDATES.find((candidate) => existingTables.has(candidate)) ?? null;

    if (!selectedTable || !isSafeSqlIdentifier(selectedTable)) {
      tokenUniverseMints = [];
      tokenUniverseActiveMints = [];
      tokenUniverseSymbolByMint.clear();
      tokenUniverseSourceTable = null;
      tokenUniverseTableMeta = null;
      return tokenUniverseMints;
    }

    const columnsResult = await dbPool.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1`,
      [selectedTable],
    );
    const columns = new Set(columnsResult.rows.map((row) => row.column_name));

    const mintColumn = ['mint', 'mint_address', 'token_mint', 'address'].find((column) => columns.has(column)) ?? null;
    if (!mintColumn || !isSafeSqlIdentifier(mintColumn)) {
      tokenUniverseMints = [];
      tokenUniverseActiveMints = [];
      tokenUniverseSymbolByMint.clear();
      tokenUniverseSourceTable = selectedTable;
      tokenUniverseTableMeta = null;
      return tokenUniverseMints;
    }

    const symbolColumn = ['symbol', 'ticker', 'token_symbol', 'name'].find((column) => columns.has(column)) ?? null;
    const enabledColumn = ['enabled', 'is_enabled', 'active'].find((column) => columns.has(column)) ?? null;
    const priorityColumn = ['priority', 'rank', 'score', 'weight'].find((column) => columns.has(column)) ?? null;
    const notesColumn = columns.has('notes') ? 'notes' : null;
    const updatedAtColumn = ['updated_at', 'updatedAt', 'modified_at'].find((column) => columns.has(column)) ?? null;

      const whereClause = enabledColumn && isSafeSqlIdentifier(enabledColumn) && !TOKEN_UNIVERSE_INCLUDE_DISABLED_CANDIDATES
      ? `WHERE COALESCE(${enabledColumn}, true) = true`
      : '';
    const orderClause = priorityColumn && isSafeSqlIdentifier(priorityColumn)
      ? `ORDER BY ${priorityColumn} DESC NULLS LAST`
      : '';

    const symbolSelect = symbolColumn && isSafeSqlIdentifier(symbolColumn)
      ? `, ${symbolColumn}::text AS symbol`
      : `, NULL::text AS symbol`;
    const enabledSelect = enabledColumn && isSafeSqlIdentifier(enabledColumn)
      ? `, COALESCE(${enabledColumn}, true)::boolean AS enabled`
      : `, true::boolean AS enabled`;
    const notesSelect = notesColumn && isSafeSqlIdentifier(notesColumn)
      ? `, ${notesColumn}::text AS notes`
      : `, NULL::text AS notes`;
    const query = `SELECT ${mintColumn}::text AS mint${symbolSelect}${enabledSelect}${notesSelect}
                     FROM public.${selectedTable}
                     ${whereClause}
                     ${orderClause}
                     LIMIT ${Math.max(1, TOKEN_UNIVERSE_MAX_MINTS)}`;

    const mintResult = await dbPool.query<TokenUniverseRow>(query);
    const approvedRows = mintResult.rows.filter(isApprovedUniverseRow);
    const trustedMints = TRUSTED_ENTRY_UNIVERSE_MINTS.filter((mint) => !TOKEN_UNIVERSE_HARD_BLOCKED_MINTS.has(mint));
    tokenUniverseMints = dedupeMints([
      ...trustedMints,
      ...(
      approvedRows
        .filter((row) => !isHardBlockedUniverseToken({ mint: row.mint ?? '', symbol: row.symbol }))
        .map((row) => row.mint ?? '')
      ),
    ]);
    tokenUniverseSymbolByMint.clear();
    for (const row of approvedRows) {
      const mint = row.mint ?? '';
      if (!solanaPublicKeyPattern.test(mint)) continue;
      if (isHardBlockedUniverseToken({ mint, symbol: row.symbol })) continue;
      const symbol = row.symbol?.trim();
      if (symbol && symbol.length > 0) {
        tokenUniverseSymbolByMint.set(mint, symbol.toUpperCase());
      }
    }
    tokenUniverseSourceTable = selectedTable;
    tokenUniverseTableMeta = {
      tableName: selectedTable,
      mintColumn,
      symbolColumn: symbolColumn && isSafeSqlIdentifier(symbolColumn) ? symbolColumn : null,
      enabledColumn: enabledColumn && isSafeSqlIdentifier(enabledColumn) ? enabledColumn : null,
      priorityColumn: priorityColumn && isSafeSqlIdentifier(priorityColumn) ? priorityColumn : null,
      updatedAtColumn: updatedAtColumn && isSafeSqlIdentifier(updatedAtColumn) ? updatedAtColumn : null,
    };

    // Seed active runtime mints from current DB-enabled rows immediately so
    // entry logic has a usable universe before autosort's next full pass.
    const enabledRuntimeSeed = dedupeMints([
      ...trustedMints,
      ...approvedRows
        .filter((row) => row.enabled)
        .filter((row) => !isHardBlockedUniverseToken({ mint: row.mint ?? '', symbol: row.symbol }))
        .map((row) => row.mint ?? ''),
    ]);

    if (enabledRuntimeSeed.length > 0) {
      tokenUniverseActiveMints = enabledRuntimeSeed;
      lastTokenUniverseEngineAppliedAt = Date.now();
      lastTokenUniverseEngineEnabledCount = tokenUniverseActiveMints.length;
      tokenUniverseProbeFrozen = false;
    }

    logPriceEvent({
      provider: 'token-universe',
      sourceTable: tokenUniverseSourceTable,
      mintCount: tokenUniverseMints.length,
      enabledMintCount: approvedRows.filter((row) => row.enabled).length,
      includeDisabledCandidates: TOKEN_UNIVERSE_INCLUDE_DISABLED_CANDIDATES,
    });
  } catch (err) {
    logPriceEvent({
      provider: 'token-universe',
      error: String(err),
    });
  }

  return tokenUniverseMints;
};

const fetchPythSolUsd = async (): Promise<PythSample> => {
  if (!pythPriceConfig) {
    throw new Error('pyth price config not initialised');
  }
  const url =
    `${pythPriceConfig.hermesBaseUrl}/v2/updates/price/latest` +
    `?ids%5B%5D=${pythPriceConfig.solUsdFeedId}`;
  const res = await fetch(url, {
    headers: pythPriceConfig.apiKey
      ? { Authorization: `Bearer ${pythPriceConfig.apiKey}` }
      : undefined,
  });
  if (!res.ok) {
    throw new Error(`pyth hermes ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as {
    parsed?: Array<{
      id: string;
      price: { price: string; conf: string; expo: number; publish_time: number };
      metadata?: { slot?: number };
    }>;
  };
  const parsed = body.parsed?.find((p) => p.id === pythPriceConfig!.solUsdFeedId);
  if (!parsed) {
    throw new Error(`pyth hermes response missing feed ${pythPriceConfig.solUsdFeedId}`);
  }
  const expo = parsed.price.expo;
  const scale = Math.pow(10, expo);
  const usdPrice = Number(parsed.price.price) * scale;
  const confidenceUsd = Number(parsed.price.conf) * scale;
  const confidenceBps = usdPrice > 0
    ? Math.round((confidenceUsd / usdPrice) * 10_000)
    : 0;
  return {
    source: 'pyth-hermes',
    feedId: parsed.id,
    usdPrice,
    confidenceUsd,
    confidenceBps,
    publishTime: parsed.price.publish_time,
    slot: parsed.metadata?.slot ?? 0,
    sampledAt: new Date().toISOString(),
  };
};

const fetchJupiterPricesUsd = async (
  mints: readonly string[],
): Promise<Record<string, JupiterPriceSample>> => {
  if (!jupiterPriceConfig) {
    throw new Error('jupiter price config not initialised');
  }

  const out: Record<string, JupiterPriceSample> = {};

  const batchSize = Math.max(1, Math.floor(WORKER_JUPITER_PRICE_BATCH_SIZE));
  for (let i = 0; i < mints.length; i += batchSize) {
    const batch = mints.slice(i, i + batchSize);
    if (batch.length === 0) continue;

    await reserveJupiterRequest();
    const url = `${jupiterPriceConfig.apiBaseUrl}?ids=${batch.join(',')}`;
    const res = await fetch(url, {
      headers: { 'x-api-key': (jupiterPriceApiKeySelector?.next() ?? jupiterPriceConfig.apiKey) },
    });
    if (!res.ok) {
      throw new Error(`jupiter price v3 ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as Record<
      string,
      { usdPrice: number; blockId: number; decimals: number } | null
    >;
    const sampledAt = new Date().toISOString();
    for (const mint of batch) {
      const entry = body[mint];
      if (entry && typeof entry.usdPrice === 'number') {
        out[mint] = {
          source: 'jupiter-price-v3',
          mint,
          usdPrice: entry.usdPrice,
          blockId: entry.blockId,
          decimals: entry.decimals,
          sampledAt,
        };
      }
    }
  }

  return out;
};

const computeDriftBps = (a: number, b: number): number => {
  if (!a || !b) return 0;
  return Math.round(((a - b) / b) * 10_000);
};

const runPythPollTick = async (): Promise<void> => {
  if (!pythPriceConfig) return;
  try {
    const sample = await fetchPythSolUsd();
    pythConsecutiveFailures = 0;
    const guardReason = getPythGuardReason(sample);

    if (guardReason) {
      lastSignalSnapshot = {
        at: new Date().toISOString(),
        source: 'pyth-hermes',
        signal: 'momentum',
        status: 'guarded_off',
        regime: null,
        lookbackSamples: signalPolicy.momentumLookbackSamples,
        thresholdBps: signalPolicy.momentumThresholdBps,
        momentumBps: null,
        guardReason,
      };
      logPriceEvent({
        provider: 'pyth-hermes',
        feed: 'SOL/USD',
        accepted: false,
        guardReason,
        usdPrice: sample.usdPrice,
        confidenceUsd: sample.confidenceUsd,
        confidenceBps: sample.confidenceBps,
        publishTime: sample.publishTime,
        ageSeconds: getPythSampleAgeSeconds(sample),
        slot: sample.slot,
      });
      logSignalEvent({
        source: 'pyth-hermes',
        signal: 'momentum',
        status: 'guarded_off',
        lookbackSamples: signalPolicy.momentumLookbackSamples,
        thresholdBps: signalPolicy.momentumThresholdBps,
        momentumBps: null,
        regime: null,
        guardReason,
        tapeDepth: sharedMarketTape.solUsdPyth.length,
      });
      return;
    }

    lastPythSolSample = sample;
    pushBounded(sharedMarketTape.solUsdPyth, {
      sampledAt: sample.sampledAt,
      usdPrice: sample.usdPrice,
      source: 'pyth-hermes',
    }, pricePollPolicy.sharedTapeSize);
    const momentumBps = computeMomentumBps(
      sharedMarketTape.solUsdPyth,
      signalPolicy.momentumLookbackSamples,
    );
    logPriceEvent({
      provider: 'pyth-hermes',
      feed: 'SOL/USD',
      accepted: true,
      usdPrice: sample.usdPrice,
      confidenceUsd: sample.confidenceUsd,
      confidenceBps: sample.confidenceBps,
      publishTime: sample.publishTime,
      ageSeconds: getPythSampleAgeSeconds(sample),
      slot: sample.slot,
      tapeDepth: sharedMarketTape.solUsdPyth.length,
    });
    lastSignalSnapshot = {
      at: new Date().toISOString(),
      source: 'pyth-hermes',
      signal: 'momentum',
      status: momentumBps === null ? 'warming_up' : 'ready',
      regime: momentumBps === null
        ? null
        : classifyMomentum(momentumBps, signalPolicy.momentumThresholdBps),
      lookbackSamples: signalPolicy.momentumLookbackSamples,
      thresholdBps: signalPolicy.momentumThresholdBps,
      momentumBps,
      guardReason: null,
    };
    logSignalEvent({
      source: 'pyth-hermes',
      signal: 'momentum',
      status: momentumBps === null ? 'warming_up' : 'ready',
      lookbackSamples: signalPolicy.momentumLookbackSamples,
      thresholdBps: signalPolicy.momentumThresholdBps,
      momentumBps,
      regime: momentumBps === null
        ? null
        : classifyMomentum(momentumBps, signalPolicy.momentumThresholdBps),
      guardReason: null,
      tapeDepth: sharedMarketTape.solUsdPyth.length,
    });

    await persistMarketTapeState();
  } catch (err) {
    pythConsecutiveFailures += 1;
    logPriceEvent({
      provider: 'pyth-hermes',
      feed: 'SOL/USD',
      error: String(err),
      consecutiveFailures: pythConsecutiveFailures,
    });
  }
};

const runJupiterPricePollTick = async (): Promise<void> => {
  if (!jupiterPriceConfig) return;
  try {
    await refreshTokenUniverseMints();
    const mints = dedupeMints([
      ...jupiterPriceConfig.defaultMints,
      ...tokenUniverseMints,
    ]);
    const samples = await fetchJupiterPricesUsd(mints);
    for (const mint of Object.keys(samples)) {
      const sample = samples[mint];
      const nextUsd = sample?.usdPrice;
      if (typeof nextUsd !== 'number' || !Number.isFinite(nextUsd) || nextUsd <= 0) {
        continue;
      }
      const nextDecimals = sample?.decimals;
      if (typeof nextDecimals === 'number' && Number.isFinite(nextDecimals) && nextDecimals >= 0) {
        latestJupiterDecimalsByMint.set(mint, Math.floor(nextDecimals));
      }
      const currentUsd = latestJupiterUsdByMint.get(mint);
      if (typeof currentUsd === 'number' && Number.isFinite(currentUsd) && currentUsd > 0) {
        previousJupiterUsdByMint.set(mint, currentUsd);
      }
      latestJupiterUsdByMint.set(mint, nextUsd);
      const mintTape = jupiterMomentumTapeByMint.get(mint) ?? [];
      pushBounded(mintTape, {
        sampledAt: sample?.sampledAt ?? new Date().toISOString(),
        usdPrice: nextUsd,
        source: 'jupiter-price-v3',
      }, pricePollPolicy.sharedTapeSize);
      jupiterMomentumTapeByMint.set(mint, mintTape);
    }
    const sol = samples[SOL_MINT];
    const usdc = samples[USDC_MINT];
    if (sol) {
      lastJupiterSolSample = sol;
      pushBounded(sharedMarketTape.solUsdJupiter, {
        sampledAt: sol.sampledAt,
        usdPrice: sol.usdPrice,
        source: 'jupiter-price-v3',
      }, pricePollPolicy.sharedTapeSize);
    }
    jupiterPriceConsecutiveFailures = 0;
    const driftBpsVsPyth =
      sol && lastPythSolSample
        ? computeDriftBps(sol.usdPrice, lastPythSolSample.usdPrice)
        : null;
    if (sol && lastPythSolSample && driftBpsVsPyth !== null) {
      pushBounded(sharedMarketTape.solUsdDrift, {
        sampledAt: new Date().toISOString(),
        pythUsd: lastPythSolSample.usdPrice,
        jupiterUsd: sol.usdPrice,
        driftBps: driftBpsVsPyth,
      }, pricePollPolicy.sharedTapeSize);
    }
    logPriceEvent({
      provider: 'jupiter-price-v3',
      trackedMintCount: mints.length,
      tokenUniverseMintCount: tokenUniverseMints.length,
      tokenUniverseSourceTable,
      solUsd: sol?.usdPrice ?? null,
      solBlockId: sol?.blockId ?? null,
      usdcUsd: usdc?.usdPrice ?? null,
      pythSolUsd: lastPythSolSample?.usdPrice ?? null,
      driftBpsJupiterMinusPyth: driftBpsVsPyth,
      tape: getSharedMarketTapeSummary(),
    });

    await applyTokenUniverseAutoSort();

    await persistMarketTapeState();
  } catch (err) {
    jupiterPriceConsecutiveFailures += 1;
    logPriceEvent({
      provider: 'jupiter-price-v3',
      error: String(err),
      consecutiveFailures: jupiterPriceConsecutiveFailures,
    });
  }
};

let pythTimer: NodeJS.Timeout | null = null;
let jupiterPriceTimer: NodeJS.Timeout | null = null;

const startPriceLoops = (): void => {
  if (!pythPriceConfig && !jupiterPriceConfig) {
    console.warn('[worker] price loops not started â€” no price provider configured');
    return;
  }
  const schedulePyth = () => {
    pythTimer = setTimeout(async () => {
      if (pythConsecutiveFailures >= pricePollPolicy.maxConsecutiveFailures) {
        logPriceEvent({
          provider: 'pyth-hermes',
          paused: true,
          reason: 'max_consecutive_failures',
        });
        return;
      }
      await runPythPollTick();
      schedulePyth();
    }, pricePollPolicy.pythPollMs);
  };
  const scheduleJupiter = () => {
    jupiterPriceTimer = setTimeout(async () => {
      if (jupiterPriceConsecutiveFailures >= pricePollPolicy.maxConsecutiveFailures) {
        logPriceEvent({
          provider: 'jupiter-price-v3',
          paused: true,
          reason: 'max_consecutive_failures',
        });
        return;
      }
      await runJupiterPricePollTick();
      scheduleJupiter();
    }, pricePollPolicy.jupiterPricePollMs);
  };
  // Fire first samples immediately so we have data within the first second.
  void runPythPollTick().then(schedulePyth);
  void runJupiterPricePollTick().then(scheduleJupiter);
};

// â”€â”€ Rate-limited Helius RPC helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const rlGetBalance = async (pubkey: PublicKey, commitment: 'processed' | 'confirmed' | 'finalized' = 'confirmed'): Promise<number> => {
  await reserveHeliusRpc();
  return getConnection().getBalance(pubkey, commitment);
};

const rlGetLatestBlockhash = async () => {
  await reserveHeliusRpc();
  return getConnection().getLatestBlockhash();
};

const rlGetMinimumBalanceForRentExemption = async (dataLength: number): Promise<number> => {
  await reserveHeliusRpc();
  return getConnection().getMinimumBalanceForRentExemption(dataLength);
};

const rlGetMint = async (address: PublicKey, programId: PublicKey): Promise<SplTokenMint> => {
  await reserveHeliusRpc();
  return getMint(getConnection(), address, 'confirmed', programId);
};

const rlGetAccountInfo = async (address: PublicKey) => {
  await reserveHeliusRpc();
  return getConnection().getAccountInfo(address, 'confirmed');
};

const rlGetTokenAccountsByOwner = async (
  owner: PublicKey,
  programId: PublicKey,
  commitment: 'processed' | 'confirmed' | 'finalized' = 'confirmed',
) => {
  await reserveHeliusRpc();
  return getConnection().getTokenAccountsByOwner(owner, { programId }, commitment);
};

const rlConfirmTransaction = async (args: { signature: string; blockhash: string; lastValidBlockHeight: number }) => {
  await reserveHeliusRpc();
  return getConnection().confirmTransaction(args);
};

const rlSendRawTransaction = async (serializedTransaction: Buffer | Uint8Array) => {
  await reserveHeliusRpc();
  return getConnection().sendRawTransaction(serializedTransaction, {
    skipPreflight: true,
    maxRetries: 0,
  });
};

// â”€â”€ API helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const apiPost = async <T>(
  path: string,
  body: unknown,
  opts: { limiter?: { acquire: () => Promise<void> } } = {},
): Promise<{ ok: boolean; status: number; data: T }> => {
  const MAX_ATTEMPTS = 5;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      if (opts.limiter) await opts.limiter.acquire();

      const res = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(WORKER_INTERNAL_SECRET ? { 'x-rz-internal-secret': WORKER_INTERNAL_SECRET } : {}),
        },
        body: JSON.stringify(body),
      });

      if ([429, 500, 502, 503, 504].includes(res.status) && attempt < MAX_ATTEMPTS) {
        const delayMs = getExponentialBackoffDelayMs(attempt);
        console.log(JSON.stringify({
          level: 'warn',
          service: 'roguezero-worker',
          msg: `${res.status} on ${path} â€” backing off ${delayMs}ms (attempt ${attempt}/${MAX_ATTEMPTS})`,
          ts: new Date().toISOString(),
        }));
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      const data = await res.json() as T;
      return { ok: res.ok, status: res.status, data };
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) {
        throw error;
      }

      const delayMs = getExponentialBackoffDelayMs(attempt);
      console.log(JSON.stringify({
        level: 'warn',
        service: 'roguezero-worker',
        msg: `network error on ${path} â€” backing off ${delayMs}ms (attempt ${attempt}/${MAX_ATTEMPTS}): ${String(error)}`,
        ts: new Date().toISOString(),
      }));
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // All retries exhausted â€” return synthetic 429
  return { ok: false, status: 429, data: { error: 'rate_limit_exhausted' } as T };
};

// â”€â”€ Funding check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const fundingSubscriptionIds = new Map<string, number>();
const lastFundingCheckAt = new Map<string, number>();
const fundingChecksInFlight = new Set<string>();

const failFundingSession = async (
  session: RawSession,
  balance: number,
  reason: string,
) => {
  await mergeFundingPatch(session, {
    startingBalanceAtomic: String(balance),
    currentBalanceAtomic: String(balance),
  });
  await setSessionStatus(
    session.id,
    'error',
    { stop_reason: 'runtime_error' },
    { expectedStatuses: ['awaiting_funding'] },
  );
  unsubscribeFundingSession(session.id);
  log('error', session.id, `${reason} -> error`);
};

const checkFunding = async (session: RawSession, observedBalance?: number): Promise<void> => {
  let balance = observedBalance;
  if (balance === undefined) {
    try {
      balance = await rlGetBalance(new PublicKey(session.session_wallet));
    } catch (err) {
      log('warn', session.id, `balance check failed: ${String(err)}`);
      return;
    }
  }
    const requestedFundingLamports = Math.max(
      MIN_TRADEABLE_LAMPORTS,
      Number(session.funding.requestedFundingLamports ?? 0) || 0,
    );
    const readyThresholdLamports = Math.max(0, requestedFundingLamports - FUNDING_READY_SLOP_LAMPORTS);


  lastFundingCheckAt.set(session.id, Date.now());

  const balanceAtomic = String(balance);
  if (session.funding.currentBalanceAtomic !== balanceAtomic) {
    try {
      await mergeFundingPatch(session, {
        currentBalanceAtomic: balanceAtomic,
      });
    } catch (err) {
      log('warn', session.id, `failed to persist awaiting-funding balance: ${String(err)}`);
    }
  }

  if (balance >= readyThresholdLamports) {
    const kp = await getKeypair(session.id);
    if (!kp) {
      await failFundingSession(
        session,
        balance,
        `funded session is missing its persisted keypair for wallet ${session.session_wallet}`,
      );
      return;
    }
    if (kp.publicKey.toBase58() !== session.session_wallet) {
      await failFundingSession(
        session,
        balance,
        `persisted keypair mismatch during funding check: stored=${kp.publicKey.toBase58()} session=${session.session_wallet}`,
      );
      return;
    }
    const markedAt = new Date().toISOString();
    const markedPriceUsd = lastPythSolSample?.usdPrice ?? null;
    await mergeFundingPatch(session, {
      startingBalanceAtomic: balanceAtomic,
      currentBalanceAtomic: balanceAtomic,
    });
    await persistPositionsState(session, {
      activePositionMint: null,
      positions: {},
    }, {
      lastMarkedPriceUsd: markedPriceUsd,
      lastMarkedAt: markedAt,
    });
    await setSessionStatus(session.id, 'ready', {}, { expectedStatuses: ['awaiting_funding'] });
    const listenerId = fundingSubscriptionIds.get(session.id);
    if (listenerId !== undefined) {
      getConnection().removeAccountChangeListener(listenerId).catch((err) => {
        log('warn', session.id, `failed to remove funding subscription: ${String(err)}`);
      });
      fundingSubscriptionIds.delete(session.id);
    }
    log('info', session.id, `funded (${balance}/${requestedFundingLamports} lamports, threshold=${readyThresholdLamports}) â†’ ready`);
  } else {
    log('info', session.id, `awaiting funding â€” balance: ${balance}/${requestedFundingLamports} lamports (threshold=${readyThresholdLamports})`);
  }
};

const runFundingCheck = async (sessionId: string, observedBalance?: number): Promise<void> => {
  if (fundingChecksInFlight.has(sessionId)) {
    return;
  }

  fundingChecksInFlight.add(sessionId);
  try {
    const session = await getSessionById(sessionId);
    if (!session || session.status !== 'awaiting_funding') {
      return;
    }

    await checkFunding(session, observedBalance);
  } finally {
    fundingChecksInFlight.delete(sessionId);
  }
};

const subscribeFundingSession = (session: RawSession) => {
  if (fundingSubscriptionIds.has(session.id)) {
    return;
  }

  const sessionWallet = new PublicKey(session.session_wallet);
  const listenerId = getConnection().onAccountChange(
    sessionWallet,
    (accountInfo) => {
      if (accountInfo.lamports < MIN_TRADEABLE_LAMPORTS) {
        return;
      }

      log('info', session.id, `funding subscription noticed ${accountInfo.lamports} lamports`);
      void runFundingCheck(session.id, accountInfo.lamports);
    },
    'confirmed',
  );

  fundingSubscriptionIds.set(session.id, listenerId);
  void runFundingCheck(session.id);
};

const unsubscribeFundingSession = (sessionId: string) => {
  const listenerId = fundingSubscriptionIds.get(sessionId);
  if (listenerId === undefined) {
    return;
  }

  getConnection().removeAccountChangeListener(listenerId).catch((err) => {
    log('warn', sessionId, `failed to remove funding subscription: ${String(err)}`);
  });
  fundingSubscriptionIds.delete(sessionId);
  lastFundingCheckAt.delete(sessionId);
};

const syncFundingSubscriptions = (sessions: RawSession[]) => {
  const awaitingFundingSessionIds = new Set(
    sessions
      .filter((session) => session.status === 'awaiting_funding')
      .map((session) => session.id),
  );

  for (const session of sessions) {
    if (session.status === 'awaiting_funding') {
      subscribeFundingSession(session);
    }
  }

  for (const sessionId of fundingSubscriptionIds.keys()) {
    if (!awaitingFundingSessionIds.has(sessionId)) {
      unsubscribeFundingSession(sessionId);
    }
  }
};

const shouldRunFundingFallbackCheck = (sessionId: string) => {
  const lastCheckAt = lastFundingCheckAt.get(sessionId) ?? 0;
  return (Date.now() - lastCheckAt) >= FUNDING_POLL_FALLBACK_MS;
};

// ── Active session-wallet balance cache (subscription-backed) ────────────────
// The session wallet is mutated only by the worker during active trading, so an
// onAccountChange subscription plus post-submit cache writes keep this coherent.
// Pre-trade reads use the cache; an RPC revalidation TTL guards against ws gaps.
const liveSessionBalances = new Map<string, { lamports: number; at: number }>();
const activeBalanceSubscriptionIds = new Map<string, number>();

const setCachedSessionBalance = (walletBase58: string, lamports: number) => {
  liveSessionBalances.set(walletBase58, { lamports, at: Date.now() });
};

const subscribeActiveSessionBalance = (session: RawSession) => {
  if (activeBalanceSubscriptionIds.has(session.id)) {
    return;
  }

  const sessionWallet = new PublicKey(session.session_wallet);
  const listenerId = getConnection().onAccountChange(
    sessionWallet,
    (accountInfo) => {
      setCachedSessionBalance(session.session_wallet, accountInfo.lamports);
    },
    'confirmed',
  );

  activeBalanceSubscriptionIds.set(session.id, listenerId);
};

const unsubscribeActiveSessionBalance = (sessionId: string, walletBase58?: string) => {
  const listenerId = activeBalanceSubscriptionIds.get(sessionId);
  if (listenerId !== undefined) {
    getConnection().removeAccountChangeListener(listenerId).catch((err) => {
      log('warn', sessionId, `failed to remove balance subscription: ${String(err)}`);
    });
    activeBalanceSubscriptionIds.delete(sessionId);
  }
  if (walletBase58) {
    liveSessionBalances.delete(walletBase58);
  }
};

const ACTIVE_BALANCE_SUB_STATUSES = new Set(['ready', 'starting', 'active', 'stopping']);

const syncActiveBalanceSubscriptions = (sessions: RawSession[]) => {
  const subscribableSessions = new Map<string, string>();
  for (const session of sessions) {
    if (ACTIVE_BALANCE_SUB_STATUSES.has(session.status)) {
      subscribableSessions.set(session.id, session.session_wallet);
      subscribeActiveSessionBalance(session);
    }
  }

  for (const sessionId of activeBalanceSubscriptionIds.keys()) {
    if (!subscribableSessions.has(sessionId)) {
      unsubscribeActiveSessionBalance(sessionId);
    }
  }
};

// Returns a session-wallet balance, preferring the subscription-backed cache when it is
// fresh, otherwise reading from RPC and seeding the cache. Use only for active session
// wallets; post-submit and sweep paths should read RPC directly for guaranteed freshness.
const getCachedSessionWalletBalance = async (pubkey: PublicKey): Promise<number> => {
  const walletBase58 = pubkey.toBase58();
  const cached = liveSessionBalances.get(walletBase58);
  if (cached && (Date.now() - cached.at) < BALANCE_CACHE_TTL_MS) {
    return cached.lamports;
  }

  const lamports = await rlGetBalance(pubkey);
  setCachedSessionBalance(walletBase58, lamports);
  return lamports;
};



const computeSolToUsdcConversionLamports = (solBalanceLamports: number): number => Math.max(
  0,
  Math.floor(solBalanceLamports - SOL_TO_USDC_CONVERSION_RESERVE_LAMPORTS),
);
// â”€â”€ Auto-start ready session â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const activateSession = async (session: RawSession): Promise<void> => {
  const keypair = await getKeypair(session.id);
  if (!keypair) {
    await setSessionStatus(session.id, 'error', { stop_reason: 'runtime_error' }, { expectedStatuses: ['ready', 'starting'] });
    log('error', session.id, 'ready activation failed: missing session keypair');
    return;
  }

  if (keypair.publicKey.toBase58() !== session.session_wallet) {
    await setSessionStatus(session.id, 'error', { stop_reason: 'runtime_error' }, { expectedStatuses: ['ready', 'starting'] });
    log('error', session.id, `ready activation failed: keypair mismatch stored=${keypair.publicKey.toBase58()} session=${session.session_wallet}`);
    return;
  }

  let solBalance = await rlGetBalance(keypair.publicKey).catch(() => 0);
  let usdcBalance = await getTokenBalanceAtomic(keypair.publicKey, USDC_MINT, TOKEN_PROGRAM_ID).catch(() => 0);

  if (usdcBalance < MIN_USDC_ENTRY_ATOMIC) {
    const lamportsToConvert = computeSolToUsdcConversionLamports(solBalance);
    if (lamportsToConvert < MIN_TRADEABLE_LAMPORTS) {
      log(
        'warn',
        session.id,
        `ready activation waiting for USDC base: SOL convertible=${lamportsToConvert} reserve=${SOL_TO_USDC_CONVERSION_RESERVE_LAMPORTS} min=${MIN_TRADEABLE_LAMPORTS}`,
      );
      return;
    }

    const converted = await convertSolToUsdc(session, keypair, lamportsToConvert);
    if (!converted) {
      log('warn', session.id, 'ready activation waiting: SOL→USDC base conversion did not complete');
      return;
    }
    usdcBalance = await getTokenBalanceAtomic(keypair.publicKey, USDC_MINT, TOKEN_PROGRAM_ID).catch(() => 0);
    solBalance = await rlGetBalance(keypair.publicKey).catch(() => solBalance);
  }

  if (solBalance < MIN_SOL_OPERATING_RESERVE_LAMPORTS) {
    log(
      'warn',
      session.id,
      `ready activation waiting for SOL fee reserve: ${solBalance}/${MIN_SOL_OPERATING_RESERVE_LAMPORTS} lamports`,
    );
    return;
  }

  const now = new Date().toISOString();
  await mergeFundingPatch(session, {
    fundingMint: USDC_MINT,
    fundingTokenSymbol: 'USDC',
    startingBalanceAtomic: String(usdcBalance),
    currentBalanceAtomic: String(usdcBalance),
  });
  await setSessionStatus(session.id, 'active', { started_at: now }, { expectedStatuses: ['starting'] });
  log('info', session.id, `starting → active, USDC base trading begins (usdc=${usdcBalance}, solReserve=${solBalance})`);
};

// â”€â”€ Trade execution â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

type PrepareResponse = {
  executionId?: string;
  preparedTransactionBase64?: string;
  blockhash?: string;
  lastValidBlockHeight?: number;
  quote?: {
    inAmount: string;
    outAmount: string;
    otherAmountThreshold: string;
    priceImpactPct: string | null;
  };
  costs?: {
    baseTxFeeLamports: number;
    priorityFeeMicroLamports: number | null;
    estimatedPriorityFeeLamports: number;
    senderTipLamports: number;
    estimatedNetworkCostLamports: number;
  };
  simulation?: { err: unknown; unitsConsumed: number | null };
  shortfall?: {
    availableLamports: number;
    requiredLamports: number;
    gapLamports: number;
  };
  error?: string;
};

type BuildRouteScoutResponse = {
  build?: {
    outAmount?: string;
    priceImpactPct?: string | null;
  };
  error?: string;
};

type UniverseScoutSample = {
  mint: string;
  routeFound: boolean;
  outAmountAtomic: number | null;
  priceImpactBps: number | null;
  signalStatus: 'warming_up' | 'ready' | 'guarded_off';
  regime: 'bullish' | 'bearish' | 'flat' | null;
  momentumBps: number | null;
  persistentBullish: boolean;
  score: number;
};

type SubmitResponse = {
  submitted?: boolean;
  signature?: string;
  status?: string;
  shortfall?: {
    availableLamports: number;
    requiredLamports: number;
    gapLamports: number;
  };
  error?: string;
};

type ReconcileResponse = {
  reconciled?: boolean;
  execution?: {
    id: string;
    status: 'prepared' | 'submitted' | 'confirmed' | 'failed';
    confirmationStatus?: 'processed' | 'confirmed' | 'finalized' | null;
  };
  error?: string;
};

type PreparedTradeEconomics = {
  remainingRiskBudgetUsd: number;
  tradeNotionalUsd: number;
  quotedOutAmountAtomic: number;
  minimumOutputAtomic: number;
  priceImpactPct: string | null;
  estimatedNetworkCostLamports: number;
  estimatedNetworkCostUsd: number;
  estimatedNetworkCostOutputAtomic: number;
  worstCaseSlippageUsd: number;
  worstCaseSlippageOutputAtomic: number;
  totalWorstCaseCostUsd: number;
  totalWorstCaseCostOutputAtomic: number;
  economicallyViable: boolean;
  withinRiskBudget: boolean;
  riskAdjustedAmountLamports: number | null;
};

const USDC_ATOMIC_PER_USD = 1_000_000;
const MIN_PROFIT_TRANSFER_USD = Number(process.env.WORKER_MIN_PROFIT_TRANSFER_USD ?? 0.25);

type TradeInventoryContext = {
  inputMint: string;
  inputSymbol: string;
  outputMint: string;
  outputSymbol: string;
  balanceAtomic: number;
  reserveAtomic: number;
  tradableAtomic: number;
  targetAtomic: number;
  minTradeAtomic: number;
  maxTradeAtomic: number;
  amountAtomic: number | null;
  riskAdjustedAmountAtomic: number | null;
};

type TradeExecutionPlan = {
  direction: 'exit_long' | 'enter_long';
  inventory: TradeInventoryContext;
  exitReason: SessionPositionState['exitReason'];
  signalSnapshot: NonNullable<Session['serviceControl']['lastSignal']>;
  scannerStrategy: StrategyKey;
  entryStrategy: StrategyKey | null;
  exitStrategy: StrategyKey | null;
  partialFractionBps?: number | null;
};

type ExitTriggerDecision = {
  shouldExit: boolean;
  reason: NonNullable<SessionPositionState['exitReason']>;
  markPriceUsd: number | null;
  pnlBps: number | null;
  trailingDrawdownBps: number | null;
  thresholds: DynamicExitThresholds;
};

type DynamicExitThresholds = {
  takeProfitBps: number;
  stopLossBps: number;
  trailingStopBps: number;
  atrBps: number | null;
  costFloorBps: number;
  mode: 'atr' | 'fallback';
};

type UsdcTradeSizingDecision = {
  skip: boolean;
  reason: string | null;
  balanceAtomic: number;
  reserveAtomic: number;
  tradableAtomic: number;
  targetAtomic: number;
  minTradeAtomic: number;
  maxTradeAtomic: number;
  amountAtomic: number;
};

const parseUnsignedNumeric = (value: string | null | undefined) => {
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

const getUtcDayKey = (date: Date = new Date()): string => date.toISOString().slice(0, 10);

const getSessionRiskState = (session: RawSession): NonNullable<Session['serviceControl']['riskState']> => {
  const dayKey = getUtcDayKey();
  const state = session.service_control.riskState;
  if (!state || state.dayKey !== dayKey) {
    return {
      dayKey,
      dailyRealizedPnlUsd: 0,
      consecutiveLosses: state?.consecutiveLosses ?? 0,
      badFillStreak: state?.badFillStreak ?? 0,
      lastLossAt: state?.lastLossAt ?? null,
      lastBadFillAt: state?.lastBadFillAt ?? null,
    };
  }

  return state;
};

const getRiskCircuitBreakerReason = (session: RawSession, sessionLossUsd: number): string | null => {
  const riskState = getSessionRiskState(session);
  const dailyLossUsd = Math.abs(Math.min(0, riskState.dailyRealizedPnlUsd));
  const lastLossAtMs = riskState.lastLossAt ? Date.parse(riskState.lastLossAt) : 0;
  const lastBadFillAtMs = riskState.lastBadFillAt ? Date.parse(riskState.lastBadFillAt) : 0;
  const lossCooldownActive = WORKER_SOFT_RISK_COOLDOWN_MS > 0
    && Number.isFinite(lastLossAtMs)
    && lastLossAtMs > 0
    && Date.now() - lastLossAtMs < WORKER_SOFT_RISK_COOLDOWN_MS;
  const badFillCooldownActive = WORKER_SOFT_RISK_COOLDOWN_MS > 0
    && Number.isFinite(lastBadFillAtMs)
    && lastBadFillAtMs > 0
    && Date.now() - lastBadFillAtMs < WORKER_SOFT_RISK_COOLDOWN_MS;

  if (sessionLossUsd >= session.risk_limits.maxSessionLossUsd) {
    return 'risk_limit_hit';
  }

  if (dailyLossUsd >= session.risk_limits.maxDailyLossUsd) {
    return 'daily_loss_limit_hit';
  }

  if (WORKER_MAX_CONSECUTIVE_LOSSES > 0 && riskState.consecutiveLosses >= WORKER_MAX_CONSECUTIVE_LOSSES && lossCooldownActive) {
    return 'consecutive_loss_limit_hit';
  }

  if (WORKER_MAX_BAD_FILL_STREAK > 0 && riskState.badFillStreak >= WORKER_MAX_BAD_FILL_STREAK && badFillCooldownActive) {
    return 'bad_fill_limit_hit';
  }

  return null;
};

const computeRecentVolatilityBps = (samples: readonly MarketTapePoint[], lookbackSamples: number): number | null => {
  const lookback = Math.max(2, Math.floor(lookbackSamples));
  if (samples.length < lookback + 1) {
    return null;
  }

  const recent = samples.slice(-(lookback + 1));
  const returns: number[] = [];
  for (let idx = 1; idx < recent.length; idx += 1) {
    const prev = recent[idx - 1];
    const next = recent[idx];
    if (!prev || !next || prev.usdPrice <= 0) continue;
    returns.push(Math.abs(((next.usdPrice - prev.usdPrice) / prev.usdPrice) * 10_000));
  }

  if (returns.length === 0) {
    return null;
  }

  const avgAbsReturn = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  return Math.round(avgAbsReturn);
};

const applyVolatilityEntrySizing = (params: {
  mint: string;
  inventory: TradeInventoryContext;
}): {
  blocked: boolean;
  reason: string | null;
  volatilityBps: number | null;
  sizeScaleBps: number;
  adjustedAmountAtomic: number | null;
} => {
  const baseAmount = params.inventory.amountAtomic ?? 0;
  if (!WORKER_VOLATILITY_SIZING_ENABLED || baseAmount <= 0) {
    return {
      blocked: false,
      reason: null,
      volatilityBps: null,
      sizeScaleBps: 10_000,
      adjustedAmountAtomic: baseAmount > 0 ? baseAmount : null,
    };
  }

  const volatilityBps = computeRecentVolatilityBps(
    getMomentumTapeForMint(params.mint),
    WORKER_VOLATILITY_LOOKBACK_SAMPLES,
  );
  if (volatilityBps === null || volatilityBps <= WORKER_VOLATILITY_TARGET_BPS) {
    return {
      blocked: false,
      reason: volatilityBps === null ? 'volatility_warming_up' : null,
      volatilityBps,
      sizeScaleBps: 10_000,
      adjustedAmountAtomic: baseAmount,
    };
  }

  const rawScaleBps = Math.floor((WORKER_VOLATILITY_TARGET_BPS / volatilityBps) * 10_000);
  const sizeScaleBps = Math.max(
    Math.min(10_000, WORKER_VOLATILITY_MIN_SIZE_BPS),
    Math.min(10_000, rawScaleBps),
  );
  const adjustedAmountAtomic = Math.floor((baseAmount * sizeScaleBps) / 10_000);
  if (adjustedAmountAtomic < params.inventory.minTradeAtomic) {
    return {
      blocked: true,
      reason: 'volatility_size_below_min_trade',
      volatilityBps,
      sizeScaleBps,
      adjustedAmountAtomic,
    };
  }

  return {
    blocked: false,
    reason: sizeScaleBps < 10_000 ? 'volatility_sized_down' : null,
    volatilityBps,
    sizeScaleBps,
    adjustedAmountAtomic,
  };
};

const assessEntryRouteStability = async (params: {
  inputMint: string;
  outputMint: string;
  amountAtomic: number;
  takerWallet: string;
  slippageBps: number;
}): Promise<{
  stable: boolean;
  reason: string;
  sampleCount: number;
  minOutAmountAtomic: number | null;
  maxOutAmountAtomic: number | null;
  outputDriftBps: number | null;
  minPriceImpactBps: number | null;
  maxPriceImpactBps: number | null;
  impactDriftBps: number | null;
}> => {
  const requestedSamples = Math.max(1, Math.floor(WORKER_ROUTE_STABILITY_SAMPLES));
  if (!WORKER_ROUTE_STABILITY_ENABLED || requestedSamples <= 1) {
    return {
      stable: true,
      reason: 'route_stability_disabled',
      sampleCount: 0,
      minOutAmountAtomic: null,
      maxOutAmountAtomic: null,
      outputDriftBps: null,
      minPriceImpactBps: null,
      maxPriceImpactBps: null,
      impactDriftBps: null,
    };
  }

  const outAmounts: number[] = [];
  const impacts: number[] = [];

  for (let sampleIdx = 0; sampleIdx < requestedSamples; sampleIdx += 1) {
    if (sampleIdx > 0) {
      await sleepMs(WORKER_ROUTE_STABILITY_DELAY_MS);
    }

    const build = await apiPost<BuildRouteScoutResponse>('/jupiter/swap/build', {
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: String(params.amountAtomic),
      taker: params.takerWallet,
      feeTokenSymbol: params.inputMint === USDC_MINT || params.outputMint === USDC_MINT ? 'USDC' : 'SOL',
      slippageBps: String(params.slippageBps),
    });

    const outAmountAtomic = parseUnsignedNumeric(build.data?.build?.outAmount);
    if (!build.ok || !build.data?.build || !outAmountAtomic || outAmountAtomic <= 0) {
      return {
        stable: false,
        reason: 'route_stability_no_route',
        sampleCount: sampleIdx + 1,
        minOutAmountAtomic: outAmounts.length > 0 ? Math.min(...outAmounts) : null,
        maxOutAmountAtomic: outAmounts.length > 0 ? Math.max(...outAmounts) : null,
        outputDriftBps: null,
        minPriceImpactBps: impacts.length > 0 ? Math.min(...impacts) : null,
        maxPriceImpactBps: impacts.length > 0 ? Math.max(...impacts) : null,
        impactDriftBps: null,
      };
    }

    outAmounts.push(outAmountAtomic);
    const impactBps = parseQuotePriceImpactBps(build.data.build.priceImpactPct ?? null);
    if (impactBps !== null) {
      impacts.push(impactBps);
    }
  }

  const minOutAmountAtomic = Math.min(...outAmounts);
  const maxOutAmountAtomic = Math.max(...outAmounts);
  const outputDriftBps = maxOutAmountAtomic > 0
    ? Math.round(((maxOutAmountAtomic - minOutAmountAtomic) / maxOutAmountAtomic) * 10_000)
    : null;
  const minPriceImpactBps = impacts.length > 0 ? Math.min(...impacts) : null;
  const maxPriceImpactBps = impacts.length > 0 ? Math.max(...impacts) : null;
  const impactDriftBps = minPriceImpactBps !== null && maxPriceImpactBps !== null
    ? maxPriceImpactBps - minPriceImpactBps
    : null;

  if (maxPriceImpactBps !== null && maxPriceImpactBps > WORKER_UNIVERSE_SCOUT_MAX_ENTRY_PRICE_IMPACT_BPS) {
    return {
      stable: false,
      reason: 'route_stability_impact_too_high',
      sampleCount: requestedSamples,
      minOutAmountAtomic,
      maxOutAmountAtomic,
      outputDriftBps,
      minPriceImpactBps,
      maxPriceImpactBps,
      impactDriftBps,
    };
  }

  if (outputDriftBps !== null && outputDriftBps > WORKER_ROUTE_STABILITY_MAX_OUTPUT_DRIFT_BPS) {
    return {
      stable: false,
      reason: 'route_stability_output_unstable',
      sampleCount: requestedSamples,
      minOutAmountAtomic,
      maxOutAmountAtomic,
      outputDriftBps,
      minPriceImpactBps,
      maxPriceImpactBps,
      impactDriftBps,
    };
  }

  if (impactDriftBps !== null && impactDriftBps > WORKER_ROUTE_STABILITY_MAX_IMPACT_DRIFT_BPS) {
    return {
      stable: false,
      reason: 'route_stability_impact_unstable',
      sampleCount: requestedSamples,
      minOutAmountAtomic,
      maxOutAmountAtomic,
      outputDriftBps,
      minPriceImpactBps,
      maxPriceImpactBps,
      impactDriftBps,
    };
  }

  return {
    stable: true,
    reason: 'route_stable',
    sampleCount: requestedSamples,
    minOutAmountAtomic,
    maxOutAmountAtomic,
    outputDriftBps,
    minPriceImpactBps,
    maxPriceImpactBps,
    impactDriftBps,
  };
};

const getUniverseScoutCandidateMints = (params: {
  excludedMints?: ReadonlySet<string>;
  excludedClusters?: ReadonlySet<string>;
  useTrustedFallback?: boolean;
} = {}) => {
  const baseCandidates = dedupeMints(
    params.useTrustedFallback || WORKER_ENTRY_CORE_UNIVERSE_ONLY
      ? TRUSTED_ENTRY_UNIVERSE_MINTS
      : [SOL_MINT, ...TRUSTED_ENTRY_UNIVERSE_MINTS, ...tokenUniverseActiveMints],
  );

  const qualityRank = (mint: string) => {
    if (mint === SOL_MINT) return 0;
    if (TRUSTED_ENTRY_UNIVERSE_MINT_SET.has(mint)) return 1;
    const symbol = tokenUniverseSymbolByMint.get(mint) ?? '';
    if (symbol && ['JUP', 'JTO', 'PYTH', 'KMNO', 'BONK', 'WIF', 'MEW', 'POPCAT', 'RAY', 'ORCA', 'DRIFT', 'SHDW', 'W', 'HNT'].includes(symbol)) {
      return 2;
    }
    return 3;
  };

  return baseCandidates
    .filter((mint) => {
      const symbol = tokenUniverseSymbolByMint.get(mint) ?? null;
      return !STABLE_ENTRY_TARGET_MINTS.has(mint)
        && !TOKEN_UNIVERSE_HARD_BLOCKED_MINTS.has(mint)
        && !isHardBlockedUniverseToken({ mint, symbol })
        && (!WORKER_ENTRY_CORE_UNIVERSE_ONLY || TRUSTED_ENTRY_UNIVERSE_MINT_SET.has(mint))
        && (!WORKER_BLOCK_PUMP_MINT_ENTRIES || !mint.toLowerCase().endsWith('pump'))
        && !(params.excludedMints?.has(mint) ?? false)
        && !(params.excludedClusters?.has(getClusterForMint(mint)) ?? false);
    })
    .sort((a, b) => qualityRank(a) - qualityRank(b))
    .slice(0, Math.max(1, WORKER_UNIVERSE_SCOUT_MAX_CANDIDATES));
};

const getUniverseScoutPreEntryBlockReason = (sample: UniverseScoutSample): string | null => {
  if (
    sample.priceImpactBps !== null
    && sample.priceImpactBps > WORKER_UNIVERSE_SCOUT_MAX_ENTRY_PRICE_IMPACT_BPS
  ) {
    return 'universe_scout_entry_impact_too_high';
  }

  const appliesTrendingShapeGate = WORKER_TRENDING_ENTRY_SHAPE_GATE_ENABLED
    && sample.mint !== SOL_MINT
    && !TRUSTED_ENTRY_UNIVERSE_MINT_SET.has(sample.mint);
  if (appliesTrendingShapeGate) {
    const shapeGate = computeTrendingEntryShapeGate({
      enabled: true,
      prices: getMomentumTapeForMint(sample.mint).map((tapeSample) => tapeSample.usdPrice),
      minSamples: WORKER_TRENDING_ENTRY_SHAPE_MIN_SAMPLES,
      chaseLookbackSamples: WORKER_TRENDING_ENTRY_CHASE_LOOKBACK_SAMPLES,
      maxRecentSurgeBps: WORKER_TRENDING_ENTRY_MAX_RECENT_SURGE_BPS,
      minPullbackFromHighBps: WORKER_TRENDING_ENTRY_MIN_PULLBACK_BPS,
      minReclaimFromLowBps: WORKER_TRENDING_ENTRY_MIN_RECLAIM_BPS,
      maxRangePositionBps: WORKER_TRENDING_ENTRY_MAX_RANGE_POSITION_BPS,
      maxNegativeWindowMomentumBps: WORKER_TRENDING_ENTRY_MAX_NEGATIVE_WINDOW_BPS,
    });

    if (!shapeGate.allowed) {
      return shapeGate.reason;
    }
  }

  return null;
};

const scoutEntryUniverse = async (params: {
  inputMint: string;
  inputSymbol: string;
  amountAtomic: number;
  takerWallet: string;
  slippageBps: number;
  activeStrategy: StrategyKey;
  strategyConfig: ReturnType<typeof getSessionStrategyConfig>;
  lookbackSamples: number;
  thresholdBps: number;
  requiredSignalSamples: number;
  excludedMints?: ReadonlySet<string>;
  excludedClusters?: ReadonlySet<string>;
  useTrustedFallback?: boolean;
}) => {
  const candidates = getUniverseScoutCandidateMints({
    excludedMints: params.excludedMints,
    excludedClusters: params.excludedClusters,
    useTrustedFallback: params.useTrustedFallback,
  });
  const samples: UniverseScoutSample[] = [];

  for (const candidateMint of candidates) {
    const tokenSignal = buildRuntimeSignalForMint(candidateMint, params.activeStrategy, params.strategyConfig);
    const persistentBullish = tokenSignal.status === 'ready'
      && tokenSignal.regime === 'bullish'
      && (params.activeStrategy !== 'momentum'
        || hasMomentumRegimePersistence({
          samples: getMomentumTapeForMint(candidateMint),
          lookbackSamples: params.lookbackSamples,
          thresholdBps: params.thresholdBps,
          regime: 'bullish',
          requiredSamples: params.requiredSignalSamples,
        }));

    if (candidateMint === params.inputMint) {
      samples.push({
        mint: candidateMint,
        routeFound: false,
        outAmountAtomic: null,
        priceImpactBps: null,
        signalStatus: tokenSignal.status,
        regime: tokenSignal.regime,
        momentumBps: tokenSignal.momentumBps,
        persistentBullish,
        score: Number.NEGATIVE_INFINITY,
      });
      continue;
    }

    const build = await apiPost<BuildRouteScoutResponse>('/jupiter/swap/build', {
      inputMint: params.inputMint,
      outputMint: candidateMint,
      amount: String(params.amountAtomic),
      taker: params.takerWallet,
      feeTokenSymbol: params.inputMint === USDC_MINT || candidateMint === USDC_MINT ? 'USDC' : 'SOL',
      slippageBps: String(params.slippageBps),
    });

    if (!build.ok || !build.data.build) {
      samples.push({
        mint: candidateMint,
        routeFound: false,
        outAmountAtomic: null,
        priceImpactBps: null,
        signalStatus: tokenSignal.status,
        regime: tokenSignal.regime,
        momentumBps: tokenSignal.momentumBps,
        persistentBullish,
        score: Number.NEGATIVE_INFINITY,
      });
      continue;
    }

    const outAmountAtomic = parseUnsignedNumeric(build.data.build.outAmount);
    const priceImpactBps = parseQuotePriceImpactBps(build.data.build.priceImpactPct ?? null);

    const effectiveImpactBps = priceImpactBps ?? Number.POSITIVE_INFINITY;
    const momentumScore = tokenSignal.momentumBps ?? -10_000;
    const persistenceBonus = persistentBullish ? 2_000 : 0;

    samples.push({
      mint: candidateMint,
      routeFound: Boolean(outAmountAtomic && outAmountAtomic > 0),
      outAmountAtomic,
      priceImpactBps,
      signalStatus: tokenSignal.status,
      regime: tokenSignal.regime,
      momentumBps: tokenSignal.momentumBps,
      persistentBullish,
      score: persistenceBonus + momentumScore - effectiveImpactBps,
    });
  }

  const ranked = samples
    .filter((sample) => sample.routeFound)
    .sort((a, b) => b.score - a.score);
  const selectableRanked = ranked.filter((sample) => getUniverseScoutPreEntryBlockReason(sample) === null);

  const bestBullishSample = selectableRanked.find((sample) => sample.persistentBullish)
    ?? (WORKER_UNIVERSE_SCOUT_REQUIRE_PERSISTENT_BULLISH
      ? null
      : selectableRanked.find((sample) => sample.signalStatus === 'ready' && sample.regime === 'bullish'))
    ?? null;
  const bestRoutedFallbackSample = WORKER_UNIVERSE_SCOUT_ALLOW_ROUTED_FALLBACK
    ? (selectableRanked[0] ?? null)
    : null;
  const bestSample = bestBullishSample ?? bestRoutedFallbackSample;

  return {
    candidates,
    ranked,
    selectableRanked,
    bestMint: bestSample?.mint ?? null,
    bestPriceImpactBps: bestSample?.priceImpactBps ?? null,
    bestOutAmountAtomic: bestSample?.outAmountAtomic ?? null,
    bestUsesRoutedFallback: bestSample !== null && bestBullishSample === null && bestSample === bestRoutedFallbackSample,
  };
};

const buildUniverseScoutGateSnapshot = (scout: Awaited<ReturnType<typeof scoutEntryUniverse>>): NonNullable<NonNullable<Session['serviceControl']['lastTradeGate']>['scout']> => {
  const bestSample = scout.ranked[0] ?? null;

  return {
    candidateCount: scout.candidates.length,
    routeFoundCount: scout.ranked.length,
    bullishRouteCount: scout.ranked.filter((sample) => sample.signalStatus === 'ready' && sample.regime === 'bullish').length,
    persistentBullishRouteCount: scout.ranked.filter((sample) => sample.persistentBullish).length,
    bestMint: bestSample?.mint ?? null,
    bestSymbol: bestSample ? resolveTokenSymbol(bestSample.mint) : null,
    bestMomentumBps: bestSample?.momentumBps ?? null,
    bestPriceImpactBps: bestSample?.priceImpactBps ?? null,
  };
};

const getUsdValueFromAtomicAmount = (mint: string, amountAtomic: number): number => {
  if (amountAtomic <= 0) {
    return 0;
  }

  if (mint === USDC_MINT) {
    return amountAtomic / USDC_ATOMIC_PER_USD;
  }

  const usdPrice = mint === SOL_MINT
    ? (lastPythSolSample?.usdPrice ?? lastJupiterSolSample?.usdPrice ?? 0)
    : (latestJupiterUsdByMint.get(mint) ?? 0);
  if (usdPrice <= 0) {
    return 0;
  }

  return toUiAmount(mint, amountAtomic) * usdPrice;
};

const computeUsdcTradeAmountAtomic = (params: {
  balanceAtomic: number;
  maxPositionUsd: number;
  maxOpenPositions: number;
  openPositionsCount: number;
}): UsdcTradeSizingDecision => {
  const balanceAtomic = Math.max(0, Math.floor(params.balanceAtomic));
  const reserveAtomic = Math.max(0, Math.floor(USDC_OPERATING_RESERVE_ATOMIC));
  const tradableAtomic = Math.max(0, balanceAtomic - reserveAtomic);
  const openSlots = Math.max(1, Math.floor(params.maxOpenPositions - params.openPositionsCount));
  const viableSlots = Math.max(
    1,
    Math.min(openSlots, Math.floor(tradableAtomic / Math.max(MIN_USDC_ENTRY_ATOMIC, MIN_USDC_POSITION_NOTIONAL_ATOMIC))),
  );
  const targetAtomic = Math.floor(tradableAtomic / viableSlots);
  const configuredMaxTradeAtomic = Math.max(0, Math.floor(params.maxPositionUsd * USDC_ATOMIC_PER_USD));
  // Earlier UI/schema defaults hard-coded maxPositionSizeUsd=20 while also
  // defaulting maxOpenPositions=10. That was not an intentional per-user risk
  // choice; it made small funded sessions economically untradeable. Preserve
  // explicit lower caps for newly configured sessions, but let legacy 20/10
  // sessions use the capital-aware target instead of staying stuck forever.
  const legacyStaticDefaultCap = params.maxPositionUsd <= 20 && params.maxOpenPositions >= 10;
  const maxTradeAtomic = legacyStaticDefaultCap
    ? Math.max(configuredMaxTradeAtomic, targetAtomic)
    : configuredMaxTradeAtomic;
  const amountAtomic = Math.min(targetAtomic, maxTradeAtomic);

  if (tradableAtomic < MIN_USDC_ENTRY_ATOMIC) {
    return {
      skip: true,
      reason: 'insufficient_usdc_inventory',
      balanceAtomic,
      reserveAtomic,
      tradableAtomic,
      targetAtomic,
      minTradeAtomic: MIN_USDC_ENTRY_ATOMIC,
      maxTradeAtomic,
      amountAtomic: 0,
    };
  }

  if (amountAtomic < MIN_USDC_ENTRY_ATOMIC) {
    return {
      skip: true,
      reason: 'below_min_usdc_trade',
      balanceAtomic,
      reserveAtomic,
      tradableAtomic,
      targetAtomic,
      minTradeAtomic: MIN_USDC_ENTRY_ATOMIC,
      maxTradeAtomic,
      amountAtomic,
    };
  }

  return {
    skip: false,
    reason: null,
    balanceAtomic,
    reserveAtomic,
    tradableAtomic,
    targetAtomic,
    minTradeAtomic: MIN_USDC_ENTRY_ATOMIC,
    maxTradeAtomic,
    amountAtomic,
  };
};

const rlGetTokenAccount = async (
  address: PublicKey,
  programId: PublicKey = TOKEN_PROGRAM_ID,
) => {
  await reserveHeliusRpc();
  return getAccount(getConnection(), address, 'confirmed', programId);
};

type TokenBalanceLookupSnapshot = {
  balanceAtomic: number;
  programId: string | null;
  tokenAccount: string | null;
  source: 'associated_token_account' | 'owner_scan' | 'none';
  attemptedPrograms: string[];
};

const getMintTokenProgramId = async (mint: PublicKey): Promise<PublicKey | null> => {
  const mintInfo = await rlGetAccountInfo(mint);
  if (mintInfo?.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  if (mintInfo?.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  return null;
};

const getTokenProgramCandidates = async (
  mint: PublicKey,
  preferredProgramId?: PublicKey,
): Promise<PublicKey[]> => {
  const programs = [
    preferredProgramId,
    preferredProgramId ? null : await getMintTokenProgramId(mint),
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
  ].filter((program): program is PublicKey => program instanceof PublicKey);

  const seen = new Set<string>();
  return programs.filter((program) => {
    const key = program.toBase58();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

let usdcTokenAccountRentLamportsPromise: Promise<number> | null = null;

const getUsdcTokenAccountRentLamports = async (): Promise<number> => {
  if (!usdcTokenAccountRentLamportsPromise) {
    usdcTokenAccountRentLamportsPromise = (async () => {
      const mint = await rlGetMint(new PublicKey(USDC_MINT), TOKEN_PROGRAM_ID);
      return rlGetMinimumBalanceForRentExemption(getAccountLenForMint(mint));
    })();
  }

  return usdcTokenAccountRentLamportsPromise;
};

const hasTokenAccount = async (
  owner: PublicKey,
  mint: string,
  programId: PublicKey = TOKEN_PROGRAM_ID,
): Promise<boolean> => {
  const ata = await getAssociatedTokenAddress(
    new PublicKey(mint),
    owner,
    false,
    programId,
  );

  try {
    await rlGetTokenAccount(ata, programId);
    return true;
  } catch {
    return false;
  }
};

const getTokenBalanceAtomic = async (
  owner: PublicKey,
  mint: string,
  programId?: PublicKey,
): Promise<number> => {
  const snapshot = await getTokenBalanceSnapshot(owner, mint, programId);
  return snapshot.balanceAtomic;
};

const getTokenBalanceSnapshot = async (
  owner: PublicKey,
  mint: string,
  programId?: PublicKey,
): Promise<TokenBalanceLookupSnapshot> => {
  const mintPublicKey = new PublicKey(mint);
  const programCandidates = await getTokenProgramCandidates(mintPublicKey, programId);
  const attemptedPrograms = programCandidates.map((program) => program.toBase58());
  let zeroAtaSnapshot: TokenBalanceLookupSnapshot | null = null;

  for (const candidateProgramId of programCandidates) {
    const ata = await getAssociatedTokenAddress(
      mintPublicKey,
      owner,
      false,
      candidateProgramId,
    );

    try {
      const account = await rlGetTokenAccount(ata, candidateProgramId);
      const balanceAtomic = Number(account.amount);
      const snapshot: TokenBalanceLookupSnapshot = {
        balanceAtomic,
        programId: candidateProgramId.toBase58(),
        tokenAccount: ata.toBase58(),
        source: 'associated_token_account',
        attemptedPrograms,
      };

      if (balanceAtomic > 0) return snapshot;
      zeroAtaSnapshot ??= snapshot;
    } catch {
      // Fall through to other token programs and owner scan before declaring zero inventory.
    }
  }

  for (const candidateProgramId of programCandidates) {
    try {
      const tokenAccounts = await rlGetTokenAccountsByOwner(owner, candidateProgramId);
      let totalBalanceAtomic = 0;
      let firstTokenAccount: string | null = null;

      for (const tokenAccount of tokenAccounts.value) {
        const account = unpackAccount(tokenAccount.pubkey, tokenAccount.account, candidateProgramId);
        if (!account.mint.equals(mintPublicKey)) continue;

        totalBalanceAtomic += Number(account.amount);
        firstTokenAccount ??= tokenAccount.pubkey.toBase58();
      }

      if (totalBalanceAtomic > 0 || firstTokenAccount) {
        return {
          balanceAtomic: totalBalanceAtomic,
          programId: candidateProgramId.toBase58(),
          tokenAccount: firstTokenAccount,
          source: 'owner_scan',
          attemptedPrograms,
        };
      }
    } catch {
      // Keep trying all candidate programs; some mints/accounts are valid under only one program.
    }
  }

  return zeroAtaSnapshot ?? {
    balanceAtomic: 0,
    programId: null,
    tokenAccount: null,
    source: 'none',
    attemptedPrograms,
  };
};

const getSessionProfitHandling = (session: RawSession) => (
  session.user_control?.profitHandling ?? {
    mode: 'send_to_owner' as const,
    payoutToken: 'USDC' as const,
  }
);

// Swap a fixed amount of the session wallet's SOL into USDC via the Jupiter prepare/sign/submit
// flow. Used for USDC-base activation and for USDC profit payouts. Returns true once the swap
// confirms and the USDC balance is available.
const convertSolToUsdc = async (
  session: RawSession,
  keypair: Keypair,
  lamportsToConvert: number,
): Promise<boolean> => {
  const slippageBps = Math.max(session.risk_limits.maxSlippageBps, 100);

  const prepare = await apiPost<PrepareResponse>('/jupiter/swap/prepare', {
    inputMint: SOL_MINT,
    outputMint: USDC_MINT,
    amount: String(lamportsToConvert),
    taker: session.session_wallet,
    feeTokenSymbol: 'SOL',
    slippageBps: String(slippageBps),
  });

  if (
    !prepare.ok
    || !prepare.data.preparedTransactionBase64
    || !prepare.data.executionId
    || prepare.data.simulation?.err
  ) {
    log(
      'warn',
      session.id,
      `SOL->USDC prepare failed: ${prepare.data.error ?? JSON.stringify(prepare.data.simulation?.err ?? prepare.status)}`,
    );
    if (prepare.data.executionId) {
      await apiPost(`/jupiter/swap/executions/${prepare.data.executionId}/cancel`, {
        stage: 'worker_cancel',
        reason: 'sol_to_usdc_conversion_prepare_failed',
      }).catch(() => {});
    }
    return false;
  }

  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(prepare.data.preparedTransactionBase64, 'base64'));
    tx.sign([keypair]);
  } catch (err) {
    log('warn', session.id, `SOL->USDC sign failed: ${String(err)}`);
    await apiPost(`/jupiter/swap/executions/${prepare.data.executionId}/cancel`, {
      stage: 'worker_cancel',
      reason: 'sol_to_usdc_conversion_sign_failed',
    }).catch(() => {});
    return false;
  }

  const submit = await apiPost<SubmitResponse>('/jupiter/swap/submit', {
    executionId: prepare.data.executionId,
    signedTransactionBase64: Buffer.from(tx.serialize()).toString('base64'),
    blockhash: prepare.data.blockhash,
    lastValidBlockHeight: prepare.data.lastValidBlockHeight,
  });

  if (!submit.ok) {
    log('warn', session.id, `SOL->USDC submit failed: ${submit.data.error ?? submit.status}`);
    return false;
  }

  log('info', session.id, `SOL->USDC swap submitted (${lamportsToConvert} lamports) · sig ${submit.data.signature ?? 'pending'}`);

  // Wait for the USDC to actually land before the caller transfers it to the owner.
  for (let attempt = 1; attempt <= 8; attempt++) {
    const usdc = await getTokenBalanceAtomic(keypair.publicKey, USDC_MINT, TOKEN_PROGRAM_ID).catch(() => 0);
    if (usdc > 0) {
      return true;
    }
    if (attempt === 8) {
      log('warn', session.id, 'SOL->USDC swap confirmed but USDC balance not yet visible');
      return false;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1500));
  }

  return false;
};

const convertUsdcToSol = async (
  session: RawSession,
  keypair: Keypair,
  usdcAtomicToConvert: number,
): Promise<boolean> => {
  const slippageBps = Math.max(session.risk_limits.maxSlippageBps, 100);

  const prepare = await apiPost<PrepareResponse>('/jupiter/swap/prepare', {
    inputMint: USDC_MINT,
    outputMint: SOL_MINT,
    amount: String(usdcAtomicToConvert),
    taker: session.session_wallet,
    feeTokenSymbol: 'USDC',
    slippageBps: String(slippageBps),
  });

  if (
    !prepare.ok
    || !prepare.data.preparedTransactionBase64
    || !prepare.data.executionId
    || prepare.data.simulation?.err
  ) {
    log(
      'warn',
      session.id,
      `USDC->SOL gas refill prepare failed: ${prepare.data.error ?? JSON.stringify(prepare.data.simulation?.err ?? prepare.status)}`,
    );
    if (prepare.data.executionId) {
      await apiPost(`/jupiter/swap/executions/${prepare.data.executionId}/cancel`, {
        stage: 'worker_cancel',
        reason: 'usdc_to_sol_gas_refill_prepare_failed',
      }).catch(() => {});
    }
    return false;
  }

  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(prepare.data.preparedTransactionBase64, 'base64'));
    tx.sign([keypair]);
  } catch (err) {
    log('warn', session.id, `USDC->SOL gas refill sign failed: ${String(err)}`);
    await apiPost(`/jupiter/swap/executions/${prepare.data.executionId}/cancel`, {
      stage: 'worker_cancel',
      reason: 'usdc_to_sol_gas_refill_sign_failed',
    }).catch(() => {});
    return false;
  }

  const submit = await apiPost<SubmitResponse>('/jupiter/swap/submit', {
    executionId: prepare.data.executionId,
    signedTransactionBase64: Buffer.from(tx.serialize()).toString('base64'),
    blockhash: prepare.data.blockhash,
    lastValidBlockHeight: prepare.data.lastValidBlockHeight,
  });

  if (!submit.ok) {
    log('warn', session.id, `USDC->SOL gas refill submit failed: ${submit.data.error ?? submit.status}`);
    return false;
  }

  log(
    'info',
    session.id,
    `USDC->SOL gas refill submitted (${usdcAtomicToConvert} usdc atomic) · sig ${submit.data.signature ?? 'pending'}`,
  );
  return true;
};

/**
 * SOL gas keep-alive. When the session's SOL fee reserve has drained toward the
 * floor while it still holds USDC working capital, convert a small USDC slice
 * back into SOL so the trade loop never stalls or stops with money in the wallet.
 * Returns the (possibly higher) SOL balance to continue the loop with.
 */
const maybeRefillGasFromUsdc = async (
  session: RawSession,
  keypair: Keypair,
  solBalanceLamports: number,
): Promise<number> => {
  const solUsd = lastPythSolSample?.usdPrice ?? lastJupiterSolSample?.usdPrice ?? 0;
  const usdcBalanceAtomic = await getTokenBalanceAtomic(keypair.publicKey, USDC_MINT, TOKEN_PROGRAM_ID).catch(() => 0);

  const plan = computeGasRefillPlan({
    solBalanceLamports,
    usdcBalanceAtomic,
    solUsd,
    triggerLamports: GAS_REFILL_TRIGGER_LAMPORTS,
    targetLamports: GAS_REFILL_TARGET_LAMPORTS,
    swapCostLamports: GAS_REFILL_SWAP_COST_LAMPORTS,
    minUsdcKeepAtomic: GAS_REFILL_MIN_USDC_KEEP_ATOMIC,
    minRefillUsdcAtomic: GAS_REFILL_MIN_USDC_ATOMIC,
    slippageHeadroom: GAS_REFILL_SLIPPAGE_HEADROOM,
    usdcAtomicPerUsd: USDC_ATOMIC_PER_USD,
    lamportsPerSol: 1_000_000_000,
  });

  if (!plan.shouldRefill) {
    // Only surface the actionable shortfalls; the common "plenty of SOL" and
    // "already topped up" cases stay quiet to avoid log spam every loop.
    if (plan.reason === 'sol_below_swap_cost' || plan.reason === 'no_spendable_usdc' || plan.reason === 'slice_below_min') {
      log(
        'info',
        session.id,
        `gas refill skipped (${plan.reason}): sol=${solBalanceLamports} usdc=${usdcBalanceAtomic} trigger=${GAS_REFILL_TRIGGER_LAMPORTS}`,
      );
    }
    return solBalanceLamports;
  }

  log(
    'info',
    session.id,
    `gas refill: SOL ${solBalanceLamports} <= trigger ${GAS_REFILL_TRIGGER_LAMPORTS}; converting ${plan.usdcToConvertAtomic} USDC atomic -> SOL (target ${GAS_REFILL_TARGET_LAMPORTS})`,
  );

  const swapped = await convertUsdcToSol(session, keypair, plan.usdcToConvertAtomic);
  if (!swapped) {
    log('warn', session.id, 'gas refill: USDC->SOL conversion did not complete this cycle');
    return solBalanceLamports;
  }

  // Wait for the refilled SOL to land before continuing the trade loop.
  let newSolBalance = solBalanceLamports;
  for (let attempt = 1; attempt <= 8; attempt++) {
    const sol = await rlGetBalance(keypair.publicKey).catch(() => newSolBalance);
    if (sol > solBalanceLamports) {
      newSolBalance = sol;
      break;
    }
    if (attempt === 8) {
      log('warn', session.id, 'gas refill submitted but SOL balance not yet visible');
    } else {
      await new Promise<void>((resolve) => setTimeout(resolve, 1500));
    }
  }

  setCachedSessionBalance(keypair.publicKey.toBase58(), newSolBalance);
  log('info', session.id, `gas refill complete: SOL ${solBalanceLamports} -> ${newSolBalance}`);
  return newSolBalance;
};

const maybeTransferRealizedProfit = async (
  session: RawSession,
  keypair: Keypair,
  solBalanceLamports: number,
  maxTransferUsd?: number,
): Promise<number> => {
  const handling = getSessionProfitHandling(session);
  if (handling.mode !== 'send_to_owner') {
    return 0;
  }

  const transferredProfitUsd = session.service_control.schedulingState?.transferredProfitUsd ?? 0;
  const cumulativeAvailableProfitUsd = session.funding.realizedPnlUsd - transferredProfitUsd;
  const availableProfitUsd = maxTransferUsd === undefined
    ? cumulativeAvailableProfitUsd
    : Math.min(cumulativeAvailableProfitUsd, maxTransferUsd);
  if (!Number.isFinite(availableProfitUsd) || availableProfitUsd < MIN_PROFIT_TRANSFER_USD) {
    return 0;
  }

  const solUsdForPrincipal = lastPythSolSample?.usdPrice ?? lastJupiterSolSample?.usdPrice ?? 0;
  if (!Number.isFinite(solUsdForPrincipal) || solUsdForPrincipal <= 0) {
    log('info', session.id, 'profit skim deferred: no SOL/USD price for principal-floor check');
    return 0;
  }

  const sessionUsdcForPrincipal = await getTokenBalanceAtomic(keypair.publicKey, USDC_MINT, TOKEN_PROGRAM_ID).catch(() => 0);
  const liquidWalletUsd = (Math.max(0, solBalanceLamports) / 1_000_000_000) * solUsdForPrincipal
    + (Math.max(0, sessionUsdcForPrincipal) / USDC_ATOMIC_PER_USD);
  const principalFloorUsd = session.funding.fundingMint === USDC_MINT
    ? Number(session.funding.startingBalanceAtomic) / USDC_ATOMIC_PER_USD
    : (Number(session.funding.startingBalanceAtomic) / 1_000_000_000) * solUsdForPrincipal;
  const principalSafeProfitUsd = Math.max(0, liquidWalletUsd - principalFloorUsd);
  const principalSafeAvailableProfitUsd = Math.min(availableProfitUsd, principalSafeProfitUsd);

  if (!Number.isFinite(principalSafeAvailableProfitUsd) || principalSafeAvailableProfitUsd < MIN_PROFIT_TRANSFER_USD) {
    log(
      'info',
      session.id,
      `profit skim deferred: principal floor not cleared (liquid=$${liquidWalletUsd.toFixed(4)} floor=$${principalFloorUsd.toFixed(4)} reportedProfit=$${availableProfitUsd.toFixed(4)})`,
    );
    return 0;
  }

  const ownerPubkey = new PublicKey(session.owner_wallet);
  const payerPubkey = keypair.publicKey;
  const nowIso = new Date().toISOString();
  let transferredUsd = 0;

  if (handling.payoutToken === 'USDC') {
    const desiredUsdcAtomic = Math.floor(principalSafeAvailableProfitUsd * USDC_ATOMIC_PER_USD);
    if (desiredUsdcAtomic <= 0) {
      return 0;
    }

    const sessionUsdcAta = await getAssociatedTokenAddress(new PublicKey(USDC_MINT), payerPubkey, false, TOKEN_PROGRAM_ID);
    const ownerUsdcAta = await getAssociatedTokenAddress(new PublicKey(USDC_MINT), ownerPubkey, false, TOKEN_PROGRAM_ID);
    let sessionUsdcBalance = sessionUsdcForPrincipal;

    // USDC-base exits usually leave realized profit in the wallet as USDC already. Legacy SOL-base
    // exits or SOL profit slices may still need conversion, so only swap the shortfall not already
    // held as USDC.
    if (sessionUsdcBalance < desiredUsdcAtomic) {
      const shortfallUsdcAtomic = desiredUsdcAtomic - sessionUsdcBalance;
      const solUsd = lastPythSolSample?.usdPrice ?? lastJupiterSolSample?.usdPrice ?? 0;

      if (!Number.isFinite(solUsd) || solUsd <= 0) {
        log('info', session.id, 'profit skim deferred: no SOL/USD price to size SOL->USDC profit conversion');
        return 0;
      }

      const shortfallUsd = shortfallUsdcAtomic / USDC_ATOMIC_PER_USD;
      // Add headroom for swap slippage/price impact so the swap yields at least the shortfall.
      const lamportsForShortfall = Math.ceil((shortfallUsd / solUsd) * 1_000_000_000 * 1.02);
      const convertibleCeilingLamports = Math.max(
        0,
        solBalanceLamports - MIN_SOL_OPERATING_RESERVE_LAMPORTS - TX_FEE_LAMPORTS,
      );
      const lamportsToConvert = Math.min(lamportsForShortfall, convertibleCeilingLamports);

      if (lamportsToConvert < MIN_TRADEABLE_LAMPORTS) {
        log('info', session.id, `profit skim deferred: SOL available for USDC conversion too small (${lamportsToConvert} lamports)`);
        return 0;
      }

      const swapped = await convertSolToUsdc(session, keypair, lamportsToConvert);
      if (!swapped) {
        log('info', session.id, 'profit skim deferred: SOL->USDC profit conversion did not complete this cycle');
        return 0;
      }

      sessionUsdcBalance = await getTokenBalanceAtomic(payerPubkey, USDC_MINT, TOKEN_PROGRAM_ID);
      solBalanceLamports = await rlGetBalance(payerPubkey).catch(() => solBalanceLamports);
    }

    const transferUsdcAtomic = Math.min(desiredUsdcAtomic, sessionUsdcBalance);

    if (transferUsdcAtomic <= 0) {
      return 0;
    }

    const ownerUsdcAtaExists = await hasTokenAccount(ownerPubkey, USDC_MINT, TOKEN_PROGRAM_ID);
    const requiredRent = ownerUsdcAtaExists ? 0 : await getUsdcTokenAccountRentLamports();
    const requiredLamports = TX_FEE_LAMPORTS + requiredRent + MIN_SOL_OPERATING_RESERVE_LAMPORTS;
    if (solBalanceLamports <= requiredLamports) {
      log('info', session.id, `profit skim deferred: insufficient SOL for USDC transfer fees/rent (${solBalanceLamports}/${requiredLamports})`);
      return 0;
    }

    const instructions: TransactionInstruction[] = [];
    if (!ownerUsdcAtaExists) {
      instructions.push(createAssociatedTokenAccountIdempotentInstruction(
        payerPubkey,
        ownerUsdcAta,
        ownerPubkey,
        new PublicKey(USDC_MINT),
        TOKEN_PROGRAM_ID,
      ));
    }

    instructions.push(createTransferInstruction(
      sessionUsdcAta,
      ownerUsdcAta,
      payerPubkey,
      BigInt(transferUsdcAtomic),
      [],
      TOKEN_PROGRAM_ID,
    ));

    const { blockhash, lastValidBlockHeight } = await rlGetLatestBlockhash();
    const tx = new VersionedTransaction(new TransactionMessage({
      payerKey: payerPubkey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message());
    tx.sign([keypair]);
    const sig = await rlSendRawTransaction(tx.serialize());
    const confirmation = await rlConfirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });
    if (confirmation.value.err) {
      throw new Error(`profit transfer failed: ${JSON.stringify(confirmation.value.err)}`);
    }

    transferredUsd = transferUsdcAtomic / USDC_ATOMIC_PER_USD;
    log('info', session.id, `profit skimmed to owner (USDC): ${transferredUsd.toFixed(4)} usd · sig ${sig}`);
  } else {
    const solUsd = lastPythSolSample?.usdPrice ?? lastJupiterSolSample?.usdPrice ?? 0;
    if (!Number.isFinite(solUsd) || solUsd <= 0) {
      return 0;
    }

    const desiredLamports = Math.floor((principalSafeAvailableProfitUsd / solUsd) * 1_000_000_000);
    if (desiredLamports <= 0) {
      return 0;
    }

    // Native SOL available for payout above the operating reserve + this transfer's fee.
    let spareLamports = Math.max(0, solBalanceLamports - MIN_SOL_OPERATING_RESERVE_LAMPORTS - TX_FEE_LAMPORTS);

    // USDC-base sessions realize profit as USDC, leaving native SOL at just the operating
    // reserve. Convert the USDC shortfall into SOL so a SOL payout actually pays out — mirrors
    // the USDC branch above which converts SOL->USDC for USDC payouts.
    if (spareLamports < desiredLamports) {
      const shortfallLamports = desiredLamports - spareLamports;
      const shortfallUsd = (shortfallLamports / 1_000_000_000) * solUsd;
      // Add headroom for swap slippage/price impact so the swap yields at least the shortfall.
      const desiredUsdcAtomic = Math.ceil(shortfallUsd * USDC_ATOMIC_PER_USD * 1.02);
      const sessionUsdcBalance = await getTokenBalanceAtomic(payerPubkey, USDC_MINT, TOKEN_PROGRAM_ID).catch(() => 0);
      const usdcToConvert = Math.min(desiredUsdcAtomic, sessionUsdcBalance);

      if (usdcToConvert >= GAS_REFILL_MIN_USDC_ATOMIC) {
        const swapped = await convertUsdcToSol(session, keypair, usdcToConvert);
        if (!swapped) {
          log('info', session.id, 'profit skim deferred: USDC->SOL profit conversion did not complete this cycle');
          return 0;
        }

        // Wait for the converted SOL to land before sizing the payout.
        for (let attempt = 1; attempt <= 8; attempt++) {
          const sol = await rlGetBalance(payerPubkey).catch(() => solBalanceLamports);
          if (sol > solBalanceLamports) {
            solBalanceLamports = sol;
            break;
          }
          if (attempt < 8) {
            await new Promise<void>((resolve) => setTimeout(resolve, 1500));
          }
        }
        setCachedSessionBalance(payerPubkey.toBase58(), solBalanceLamports);
        spareLamports = Math.max(0, solBalanceLamports - MIN_SOL_OPERATING_RESERVE_LAMPORTS - TX_FEE_LAMPORTS);
      }
    }

    const transferableLamports = Math.min(desiredLamports, spareLamports);

    if (transferableLamports <= 0) {
      return 0;
    }

    const { blockhash, lastValidBlockHeight } = await rlGetLatestBlockhash();
    const tx = new VersionedTransaction(new TransactionMessage({
      payerKey: payerPubkey,
      recentBlockhash: blockhash,
      instructions: [
        SystemProgram.transfer({
          fromPubkey: payerPubkey,
          toPubkey: ownerPubkey,
          lamports: transferableLamports,
        }),
      ],
    }).compileToV0Message());
    tx.sign([keypair]);
    const sig = await rlSendRawTransaction(tx.serialize());
    const confirmation = await rlConfirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });
    if (confirmation.value.err) {
      throw new Error(`profit transfer failed: ${JSON.stringify(confirmation.value.err)}`);
    }

    transferredUsd = (transferableLamports / 1_000_000_000) * solUsd;
    log('info', session.id, `profit skimmed to owner (SOL): ${transferredUsd.toFixed(4)} usd-equivalent · sig ${sig}`);
  }

  if (transferredUsd > 0) {
    await persistSchedulingState(session, {
      transferredProfitUsd: Math.max(0, Number((transferredProfitUsd + transferredUsd).toFixed(6))),
      lastProfitTransferAt: nowIso,
    });
  }

  return transferredUsd;
};

const EXIT_PROFIT_PAYOUT_REASONS = new Set<NonNullable<SessionPositionState['exitReason']>>([
  'take_profit',
  'trailing_stop',
]);

const maybeMarkPendingExitProfitPayout = async (
  session: RawSession,
  tradePlan: TradeExecutionPlan,
  executionId: string,
) => {
  if (tradePlan.direction !== 'exit_long' || !tradePlan.exitReason) {
    return;
  }

  if (!EXIT_PROFIT_PAYOUT_REASONS.has(tradePlan.exitReason)) {
    return;
  }

  await persistSchedulingState(session, {
    pendingProfitPayout: {
      executionId,
      submittedAt: new Date().toISOString(),
      preRealizedPnlUsd: session.funding.realizedPnlUsd,
      exitReason: tradePlan.exitReason,
      attempts: 0,
    },
  });
};

const clearPendingProfitPayout = async (session: RawSession) => {
  await persistSchedulingState(session, { pendingProfitPayout: null });
};

const attemptPendingExitProfitPayout = async (session: RawSession, keypair: Keypair): Promise<void> => {
  const pending = session.service_control.schedulingState?.pendingProfitPayout;
  if (!pending) {
    return;
  }

  const handling = getSessionProfitHandling(session);
  if (handling.mode !== 'send_to_owner') {
    await clearPendingProfitPayout(session);
    log('info', session.id, `exit profit payout cleared for ${pending.executionId}: profit mode is compound`);
    return;
  }

  const reconcile = await apiPost<ReconcileResponse>(`/jupiter/swap/executions/${pending.executionId}/reconcile`, {});
  if (!reconcile.ok) {
    await persistSchedulingState(session, {
      pendingProfitPayout: {
        ...pending,
        attempts: pending.attempts + 1,
      },
    });
    log('info', session.id, `exit profit payout waiting for reconcile (${pending.executionId}): ${reconcile.data.error ?? reconcile.status}`);
    return;
  }

  const executionStatus = reconcile.data.execution?.status ?? null;
  if (executionStatus === 'failed') {
    await clearPendingProfitPayout(session);
    log('warn', session.id, `exit profit payout cleared: execution ${pending.executionId} failed`);
    return;
  }

  if (executionStatus !== 'confirmed') {
    await persistSchedulingState(session, {
      pendingProfitPayout: {
        ...pending,
        attempts: pending.attempts + 1,
      },
    });
    log('info', session.id, `exit profit payout pending confirmation (${pending.executionId} status=${executionStatus ?? 'unknown'})`);
    return;
  }

  const latestSession = await getSessionById(session.id);
  if (!latestSession) {
    return;
  }

  const exitProfitUsd = Number((latestSession.funding.realizedPnlUsd - pending.preRealizedPnlUsd).toFixed(6));
  if (!Number.isFinite(exitProfitUsd) || exitProfitUsd < MIN_PROFIT_TRANSFER_USD) {
    await clearPendingProfitPayout(latestSession);
    log('info', session.id, `exit profit payout skipped: confirmed ${pending.exitReason} delta $${exitProfitUsd.toFixed(6)} below threshold`);
    return;
  }

  const latestBalance = await rlGetBalance(keypair.publicKey).catch(() => 0);
  const transferredUsd = await maybeTransferRealizedProfit(latestSession, keypair, latestBalance, exitProfitUsd);
  if (transferredUsd > 0) {
    const afterTransferSession = await getSessionById(session.id);
    await clearPendingProfitPayout(afterTransferSession ?? latestSession);
    log('info', session.id, `exit profit payout complete for ${pending.executionId}: $${transferredUsd.toFixed(6)} from ${pending.exitReason}`);
    return;
  }

  await persistSchedulingState(latestSession, {
    pendingProfitPayout: {
      ...pending,
      attempts: pending.attempts + 1,
    },
  });
};

const buildTradeEconomics = (params: {
  tradeAmountAtomic: number;
  inputMint: string;
  outputMint: string;
  remainingRiskBudgetUsd: number;
  quote?: PrepareResponse['quote'];
  costs?: PrepareResponse['costs'];
}): PreparedTradeEconomics | null => {
  const quotedOutAmountAtomic = parseUnsignedNumeric(params.quote?.outAmount);
  const minimumOutputAtomic = parseUnsignedNumeric(params.quote?.otherAmountThreshold);

  if (
    quotedOutAmountAtomic === null
    || minimumOutputAtomic === null
    || params.tradeAmountAtomic <= 0
  ) {
    return null;
  }

  const estimatedNetworkCostLamports = params.costs?.estimatedNetworkCostLamports ?? 0;
  const estimatedNetworkCostOutputAtomic = params.outputMint === SOL_MINT
    ? estimatedNetworkCostLamports
    : Math.ceil((estimatedNetworkCostLamports * quotedOutAmountAtomic) / params.tradeAmountAtomic);
  const worstCaseSlippageOutputAtomic = Math.max(0, quotedOutAmountAtomic - minimumOutputAtomic);
  const tradeNotionalUsd = getUsdValueFromAtomicAmount(params.inputMint, params.tradeAmountAtomic);
  const estimatedNetworkCostUsd = getUsdValueFromAtomicAmount(SOL_MINT, estimatedNetworkCostLamports);
  const worstCaseSlippageUsd = getUsdValueFromAtomicAmount(params.outputMint, worstCaseSlippageOutputAtomic);
  const totalWorstCaseCostUsd = estimatedNetworkCostUsd + worstCaseSlippageUsd;
  const totalWorstCaseCostOutputAtomic =
    estimatedNetworkCostOutputAtomic + worstCaseSlippageOutputAtomic;
  const minimumOutputUsd = getUsdValueFromAtomicAmount(params.outputMint, minimumOutputAtomic);
  const economicallyViable = minimumOutputUsd > estimatedNetworkCostUsd;
  const withinRiskBudget = totalWorstCaseCostUsd <= params.remainingRiskBudgetUsd;

  let riskAdjustedAmountLamports: number | null = null;
  if (!withinRiskBudget && worstCaseSlippageUsd > 0 && params.inputMint === SOL_MINT) {
    const slippageBudgetUsd = params.remainingRiskBudgetUsd - estimatedNetworkCostUsd;
    if (slippageBudgetUsd > 0) {
      const scale = Math.max(0, Math.min(1, (slippageBudgetUsd / worstCaseSlippageUsd) * 0.95));
      const candidate = Math.floor(params.tradeAmountAtomic * scale);
      riskAdjustedAmountLamports = candidate > 0 ? candidate : null;
    }
  }

  return {
    remainingRiskBudgetUsd: params.remainingRiskBudgetUsd,
    tradeNotionalUsd,
    quotedOutAmountAtomic,
    minimumOutputAtomic,
    priceImpactPct: params.quote?.priceImpactPct ?? null,
    estimatedNetworkCostLamports,
    estimatedNetworkCostUsd,
    estimatedNetworkCostOutputAtomic,
    worstCaseSlippageUsd,
    worstCaseSlippageOutputAtomic,
    totalWorstCaseCostUsd,
    totalWorstCaseCostOutputAtomic,
    economicallyViable,
    withinRiskBudget,
    riskAdjustedAmountLamports,
  };
};

const computeCostBpsFromUsd = (costUsd: number, notionalUsd: number): number => {
  if (notionalUsd <= 0 || costUsd <= 0) {
    return 0;
  }

  return Math.round((costUsd / notionalUsd) * 10_000);
};

const getLatestObservedDriftBps = () => Math.abs(sharedMarketTape.solUsdDrift.at(-1)?.driftBps ?? 0);

const assessTradeGate = (params: {
  direction: TradeDirection;
  signalSnapshot: NonNullable<Session['serviceControl']['lastSignal']>;
  economics: PreparedTradeEconomics;
  confidenceBps: number;
  driftBps: number;
  safetyBufferBps: number;
  entryCostCapBps: number;
}): TradeGateAssessment => {
  const signalMagnitudeBps = Math.abs(params.signalSnapshot.momentumBps ?? 0);
  const signalThresholdBps = params.signalSnapshot.strategy === 'momentum'
    ? params.signalSnapshot.thresholdBps
    : 0;
  const expectedEdgeBps = Math.max(0, signalMagnitudeBps - signalThresholdBps);
  const networkCostBps = computeCostBpsFromUsd(
    params.economics.estimatedNetworkCostUsd,
    params.economics.tradeNotionalUsd,
  );
  const routePriceImpactBps = parseQuotePriceImpactBps(params.economics.priceImpactPct) ?? 0;

  // Conviction-only entries. The bullish + persistence checks already ran before
  // this trade was prepared, and round-trip profitability is enforced on the EXIT
  // (take-profit is floored at the full cost floor in computeDynamicExitThresholds).
  // So the entry gate must NOT re-demand that an instantaneous ~6s momentum velocity
  // beat the full round-trip cost, and must NOT count oracle confidence/drift as a
  // spendable cost (those are measurement noise / freshness guards, not a fee paid).
  // It only guards the ENTRY LEG's own friction (network + route price impact)
  // against a sane cap; the exit then protects realized profit.
  if (params.direction === 'enter_long') {
    const entryLegCostBps = networkCostBps + routePriceImpactBps;
    const costWithinCap = entryLegCostBps <= params.entryCostCapBps;
    // EV gate: only enter when the signal's expected edge (velocity above the
    // strategy threshold) clears the entry-leg friction plus the safety buffer.
    // Without this the bot bought pure noise on a flat tape (momentum hovering at
    // 0-2 bps) and every fill just paid fees, building a bag of fee-bleed losers.
    // In a genuinely flat market the bot now correctly sits out instead.
    const edgeClearsCost = expectedEdgeBps > entryLegCostBps + params.safetyBufferBps;
    const allowed = costWithinCap && edgeClearsCost;
    const reason = !costWithinCap
      ? 'entry_leg_cost_too_high'
      : (edgeClearsCost ? 'entry_edge_exceeds_cost' : 'entry_edge_below_cost');
    return {
      allowed,
      reason,
      expectedEdgeBps,
      estimatedCostBps: entryLegCostBps,
      safetyBufferBps: params.safetyBufferBps,
    };
  }

  const estimatedCostBps =
    networkCostBps +
    routePriceImpactBps +
    Math.abs(params.driftBps) +
    Math.abs(params.confidenceBps);

  return {
    allowed: expectedEdgeBps > (estimatedCostBps + params.safetyBufferBps),
    reason: expectedEdgeBps > (estimatedCostBps + params.safetyBufferBps)
      ? 'edge_exceeds_cost_model'
      : 'edge_below_cost_model',
    expectedEdgeBps,
    estimatedCostBps,
    safetyBufferBps: params.safetyBufferBps,
  };
};

const buildSizingTradeContext = (inventory: TradeInventoryContext): NonNullable<NonNullable<Session['serviceControl']['lastSizing']>['tradeContext']> => ({
  inputMint: inventory.inputMint,
  inputSymbol: inventory.inputSymbol,
  outputMint: inventory.outputMint,
  outputSymbol: inventory.outputSymbol,
  balanceAtomic: String(inventory.balanceAtomic),
  reserveAtomic: String(inventory.reserveAtomic),
  tradableAtomic: String(inventory.tradableAtomic),
  targetAtomic: String(inventory.targetAtomic),
  minTradeAtomic: String(inventory.minTradeAtomic),
  maxTradeAtomic: String(inventory.maxTradeAtomic),
  amountAtomic: inventory.amountAtomic !== null ? String(inventory.amountAtomic) : null,
  riskAdjustedAmountAtomic: inventory.riskAdjustedAmountAtomic !== null ? String(inventory.riskAdjustedAmountAtomic) : null,
});

const computeReturnBps = (referencePriceUsd: number | null, currentPriceUsd: number | null): number | null => {
  if (!referencePriceUsd || !currentPriceUsd || referencePriceUsd <= 0) {
    return null;
  }

  return Math.round(((currentPriceUsd - referencePriceUsd) / referencePriceUsd) * 10_000);
};

const entryRejectCooldowns = new Map<string, { expiresAtMs: number; reason: string }>();
const ENTRY_REJECT_COOLDOWN_REASONS = new Set([
  'entry_edge_below_cost',
  'entry_leg_cost_too_high',
  'price_impact_too_high',
  'route_stability_impact_too_high',
  'route_stability_impact_unstable',
  'route_stability_output_unstable',
]);

const getEntryRejectCooldownKey = (sessionId: string, mint: string) => sessionId + ':' + mint;

const getActiveEntryRejectCooldownMints = (sessionId: string, nowMs: number): Set<string> => {
  const active = new Set<string>();
  for (const [key, cooldown] of entryRejectCooldowns.entries()) {
    const separatorIdx = key.indexOf(':');
    const keySessionId = separatorIdx >= 0 ? key.slice(0, separatorIdx) : '';
    const mint = separatorIdx >= 0 ? key.slice(separatorIdx + 1) : '';
    if (cooldown.expiresAtMs <= nowMs || !mint) {
      entryRejectCooldowns.delete(key);
      continue;
    }
    if (keySessionId === sessionId) {
      active.add(mint);
    }
  }
  return active;
};

const recordEntryRejectCooldown = (session: RawSession, mint: string | null | undefined, reason: string | null | undefined): void => {
  if (WORKER_ENTRY_REJECT_COOLDOWN_MS <= 0 || !mint || !reason || !ENTRY_REJECT_COOLDOWN_REASONS.has(reason)) {
    return;
  }
  if (mint === USDC_MINT || mint === SOL_MINT) {
    return;
  }
  const expiresAtMs = Date.now() + WORKER_ENTRY_REJECT_COOLDOWN_MS;
  entryRejectCooldowns.set(getEntryRejectCooldownKey(session.id, mint), { expiresAtMs, reason });
  log(
    'info',
    session.id,
    `entry candidate cooldown: ${resolveTokenSymbol(mint)} (${mint}) reason=${reason} ms=${WORKER_ENTRY_REJECT_COOLDOWN_MS}`,
  );
};

const recordTradePlanEntryRejectCooldown = (
  session: RawSession,
  tradePlan: TradeExecutionPlan | null,
  reason: string | null | undefined,
): void => {
  if (tradePlan?.direction !== 'enter_long') {
    return;
  }
  recordEntryRejectCooldown(session, tradePlan.inventory.outputMint, reason);
};

const computeExitCostFloorBps = (session: RawSession): number => Math.max(
  positionExitPolicy.exitCostFloorBps,
  session.risk_limits.maxSlippageBps + session.service_control.platformFeeBps + signalPolicy.edgeSafetyBufferBps,
);

const getTokenTradeClass = (mint: string, symbol?: string | null): TokenTradeClass => {
  if (mint === SOL_MINT || mint === USDC_MINT) {
    return 'major';
  }
  const normalizedSymbol = (symbol ?? '').toUpperCase();
  if (normalizedSymbol === 'JUP' || normalizedSymbol === 'JTO') {
    return 'sol_beta';
  }
  const cluster = getClusterForMint(mint);
  if (cluster === 'sol-core' || cluster === 'sol-lst') {
    return 'sol_beta';
  }
  if (TRUSTED_ENTRY_UNIVERSE_MINT_SET.has(mint)) {
    return 'trend_liquid';
  }
  return 'long_tail';
};

type TokenClassExitProfile = { takeProfitMult: number; stopLossMult: number; trailingStopMult: number };

// Per-class ATR exit multipliers. Baseline global was TP 1.8 / SL 1.0 / trail 0.8.
// long_tail = runners -> wide TP leash so a real move runs; slightly wider SL to ride noise; trailing locks.
// major / sol_beta / trend_liquid -> tighter TP so chop-prone names bank quicker. All floored downstream.
const getTokenClassExitProfile = (tokenClass: TokenTradeClass): TokenClassExitProfile => {
  switch (tokenClass) {
    case 'major':
      return { takeProfitMult: 1.4, stopLossMult: 1.0, trailingStopMult: 0.7 };
    case 'sol_beta':
      return { takeProfitMult: 1.6, stopLossMult: 1.0, trailingStopMult: 0.8 };
    case 'trend_liquid':
      return { takeProfitMult: 0.8, stopLossMult: 1.0, trailingStopMult: 0.8 };
    case 'long_tail':
    default:
      return { takeProfitMult: 2.6, stopLossMult: 1.2, trailingStopMult: 1.0 };
  }
};

const getTokenClassSizeMultiplierBps = (tokenClass: TokenTradeClass): number => {
  switch (tokenClass) {
    case 'major':
      return WORKER_CLASS_SIZE_MAJOR_BPS;
    case 'sol_beta':
      return WORKER_CLASS_SIZE_SOL_BETA_BPS;
    case 'trend_liquid':
      return WORKER_CLASS_SIZE_TREND_LIQUID_BPS;
    case 'long_tail':
    default:
      return WORKER_CLASS_SIZE_LONG_TAIL_BPS;
  }
};

// Computes the class-weighted entry size for a candidate token. Always runs (so the shadow
// line records what it WOULD do); the caller only applies the result when the flag is enabled
// and canary-scoped. Never blocks: if the down-sized amount would fall below the min trade,
// the base amount is left unchanged (we shrink effort on a weak class, we do not gate it out).
const computeClassEntrySizing = (params: {
  mint: string;
  symbol?: string | null;
  inventory: TradeInventoryContext;
}): {
  tokenClass: TokenTradeClass;
  multiplierBps: number;
  baseAmountAtomic: number;
  adjustedAmountAtomic: number;
  belowMinTrade: boolean;
} => {
  const tokenClass = getTokenTradeClass(params.mint, params.symbol);
  const multiplierBps = getTokenClassSizeMultiplierBps(tokenClass);
  const baseAmountAtomic = params.inventory.amountAtomic ?? 0;
  const adjustedAmountAtomic = Math.floor((baseAmountAtomic * multiplierBps) / 10_000);
  const belowMinTrade = adjustedAmountAtomic < params.inventory.minTradeAtomic;
  return { tokenClass, multiplierBps, baseAmountAtomic, adjustedAmountAtomic, belowMinTrade };
};

const isCanaryShadowEnabled = (session: RawSession, enabled: boolean): boolean => {
  if (!enabled) return false;
  // No scoping configured at all => shadow applies to every session.
  if (WORKER_ADAPTIVE_EXIT_CANARY_SESSION_ID === null && WORKER_ADAPTIVE_EXIT_CANARY_OWNER_WALLET === null) {
    return true;
  }
  // Stable owner-wallet match: every ephemeral Noah session funded by this wallet enrolls
  // automatically, so we never have to repoint a session id + redeploy per session.
  if (WORKER_ADAPTIVE_EXIT_CANARY_OWNER_WALLET !== null && session.owner_wallet === WORKER_ADAPTIVE_EXIT_CANARY_OWNER_WALLET) {
    return true;
  }
  // Exact session-id pin still works for one-off precision targeting.
  return WORKER_ADAPTIVE_EXIT_CANARY_SESSION_ID !== null && WORKER_ADAPTIVE_EXIT_CANARY_SESSION_ID === session.id;
};

const computeDynamicExitThresholds = (
  session: RawSession,
  positionState: NonNullable<Session['serviceControl']['positionState']>,
  signalSnapshot: NonNullable<Session['serviceControl']['lastSignal']>,
): DynamicExitThresholds => {
  const costFloorBps = computeExitCostFloorBps(session);
  const atrBps = positionState.lastComputedAtrBps ?? null;
  // Token-class exit profile (flag-gated, Noah-scoped). OFF => exact global multipliers as before.
  const exitProfilesActive = isCanaryShadowEnabled(session, WORKER_TOKEN_CLASS_EXIT_PROFILES_ENABLED);
  const exitProfile: TokenClassExitProfile = exitProfilesActive
    ? getTokenClassExitProfile(getTokenTradeClass(positionState.positionMint ?? '', positionState.positionSymbol))
    : {
        takeProfitMult: positionExitPolicy.atrTakeProfitMultiplier,
        stopLossMult: positionExitPolicy.atrStopLossMultiplier,
        trailingStopMult: positionExitPolicy.atrTrailingStopMultiplier,
      };

  // Time-decay take-profit ladder: a fresh position must clear its full target,
  // but as it ages the required take-profit decays linearly toward the cost
  // floor (breakeven + fees). This frees capital from stale positions that are
  // green-but-stuck without ever realizing a take-profit below cost. Stop-loss
  // and trailing thresholds are unaffected.
  const entryAtMs = positionState.entryAt ? Date.parse(positionState.entryAt) : NaN;
  const positionAgeMs = Number.isFinite(entryAtMs) ? Math.max(0, Date.now() - entryAtMs) : 0;
  const decayStartMs = positionExitPolicy.takeProfitTimeDecayStartMs;
  const decayFullMs = positionExitPolicy.takeProfitTimeDecayFullMs;
  const applyTakeProfitTimeDecay = (rawTakeProfitBps: number): number => {
    if (!WORKER_TP_TIME_DECAY_ENABLED || decayFullMs <= decayStartMs || positionAgeMs <= decayStartMs || rawTakeProfitBps <= costFloorBps) {
      return rawTakeProfitBps;
    }
    const progress = Math.min(1, (positionAgeMs - decayStartMs) / (decayFullMs - decayStartMs));
    const decayed = Math.round(rawTakeProfitBps - (rawTakeProfitBps - costFloorBps) * progress);
    return Math.max(costFloorBps, decayed);
  };

  if (!atrBps || atrBps <= 0) {
    return {
      takeProfitBps: applyTakeProfitTimeDecay(Math.max(positionExitPolicy.takeProfitBps, costFloorBps)),
      stopLossBps: Math.max(positionExitPolicy.stopLossBps, costFloorBps),
      trailingStopBps: Math.max(positionExitPolicy.trailingStopBps, costFloorBps),
      atrBps: null,
      costFloorBps,
      mode: 'fallback',
    };
  }

  const signalStrengthBps = Math.abs(signalSnapshot.momentumBps ?? 0);
  const signalStrengthBoost = Math.min(0.5, signalStrengthBps / 200);
  return {
    takeProfitBps: applyTakeProfitTimeDecay(Math.max(
      costFloorBps,
      Math.round(atrBps * exitProfile.takeProfitMult * (1 + signalStrengthBoost)),
    )),
    stopLossBps: Math.max(
      costFloorBps,
      Math.round(atrBps * exitProfile.stopLossMult),
    ),
    trailingStopBps: Math.max(
      costFloorBps,
      Math.round(atrBps * exitProfile.trailingStopMult),
    ),
    atrBps,
    costFloorBps,
    mode: 'atr',
  };
};

const refreshPositionsMarks = async (
  session: RawSession,
  positionsState: SessionPositionsState,
) => {
  const normalized = normalizePositionsState(positionsState);
  const nextPositions: SessionPositionsState['positions'] = {};
  let changed = false;
  let totalUnrealizedPnlUsd = 0;
  const strategyConfig = getSessionStrategyConfig(session);

  for (const [mint, positionState] of Object.entries(normalized.positions)) {
    const markedPriceUsd = mint === SOL_MINT
      ? (lastPythSolSample?.usdPrice ?? lastJupiterSolSample?.usdPrice ?? null)
      : (latestJupiterUsdByMint.get(mint) ?? null);
    const atr = computeAtrFromTape(
      mint === SOL_MINT
        ? sharedMarketTape.solUsdPyth
        : getMomentumTapeForMint(mint),
      strategyConfig.supertrend,
    );
    const markedAt = new Date().toISOString();
    const pnlBps = markedPriceUsd
      ? computeReturnBps(positionState.entryPriceUsd, markedPriceUsd)
      : null;
    const nextMaxFavorableBps = pnlBps === null
      ? positionState.maxFavorableBps ?? null
      : Math.max(positionState.maxFavorableBps ?? pnlBps, pnlBps);
    const nextMaxAdverseBps = pnlBps === null
      ? positionState.maxAdverseBps ?? null
      : Math.min(positionState.maxAdverseBps ?? pnlBps, pnlBps);

    const nextPositionState: SessionPositionState = !markedPriceUsd
      ? clonePositionState(positionState)
      : {
          ...positionState,
          highWaterPriceUsd: isLongPositionStatus(positionState.status)
            ? (positionState.highWaterPriceUsd === null
              ? markedPriceUsd
              : Math.max(positionState.highWaterPriceUsd, markedPriceUsd))
            : null,
          lastMarkedPriceUsd: markedPriceUsd,
          lastMarkedAt: markedAt,
          lastComputedAtrUsd: atr?.atrUsd ?? positionState.lastComputedAtrUsd ?? null,
          lastComputedAtrBps: atr?.atrBps ?? positionState.lastComputedAtrBps ?? null,
          atrComputedAt: atr ? markedAt : (positionState.atrComputedAt ?? null),
          maxFavorableBps: nextMaxFavorableBps,
          maxFavorableAt: nextMaxFavorableBps !== (positionState.maxFavorableBps ?? null)
            ? markedAt
            : (positionState.maxFavorableAt ?? null),
          maxAdverseBps: nextMaxAdverseBps,
          maxAdverseAt: nextMaxAdverseBps !== (positionState.maxAdverseBps ?? null)
            ? markedAt
            : (positionState.maxAdverseAt ?? null),
        };

    if (
      nextPositionState.highWaterPriceUsd !== positionState.highWaterPriceUsd
      || nextPositionState.lastMarkedPriceUsd !== positionState.lastMarkedPriceUsd
      || nextPositionState.lastMarkedAt !== positionState.lastMarkedAt
      || nextPositionState.lastComputedAtrUsd !== positionState.lastComputedAtrUsd
      || nextPositionState.lastComputedAtrBps !== positionState.lastComputedAtrBps
      || nextPositionState.atrComputedAt !== positionState.atrComputedAt
      || nextPositionState.maxFavorableBps !== (positionState.maxFavorableBps ?? null)
      || nextPositionState.maxFavorableAt !== (positionState.maxFavorableAt ?? null)
      || nextPositionState.maxAdverseBps !== (positionState.maxAdverseBps ?? null)
      || nextPositionState.maxAdverseAt !== (positionState.maxAdverseAt ?? null)
    ) {
      changed = true;
    }

    nextPositions[mint] = nextPositionState;

    if (
      isLongPositionStatus(nextPositionState.status)
      && nextPositionState.entryPriceUsd !== null
      && nextPositionState.quantityAtomic !== null
      && nextPositionState.lastMarkedPriceUsd !== null
      && nextPositionState.lastMarkedPriceUsd > 0
    ) {
      const qty = toUiAmount(mint, Number(nextPositionState.quantityAtomic), nextPositionState.tokenDecimals ?? undefined);
      totalUnrealizedPnlUsd += (nextPositionState.lastMarkedPriceUsd - nextPositionState.entryPriceUsd) * qty;
    }
  }

  const nextState = normalizePositionsState({
    activePositionMint: normalized.activePositionMint,
    positions: nextPositions,
  });

  if (
    changed
    || nextState.activePositionMint !== normalized.activePositionMint
  ) {
    await persistPositionsState(session, nextState);
  }

  const roundedUnrealized = Number(totalUnrealizedPnlUsd.toFixed(6));
  if (roundedUnrealized !== session.funding.unrealizedPnlUsd) {
    await mergeFundingPatch(session, { unrealizedPnlUsd: roundedUnrealized });
  }

  return nextState;
};

const evaluateExitTrigger = (
  session: RawSession,
  positionState: NonNullable<Session['serviceControl']['positionState']>,
  signalSnapshot: NonNullable<Session['serviceControl']['lastSignal']>,
): ExitTriggerDecision => {
  const markPriceUsd = positionState.lastMarkedPriceUsd ?? null;
  const pnlBps = computeReturnBps(positionState.entryPriceUsd, markPriceUsd);
  const trailingDrawdownBps = computeReturnBps(positionState.highWaterPriceUsd, markPriceUsd);
  const thresholds = computeDynamicExitThresholds(session, positionState, signalSnapshot);

  if (pnlBps !== null && pnlBps >= thresholds.takeProfitBps) {
    return {
      shouldExit: true,
      reason: 'take_profit',
      markPriceUsd,
      pnlBps,
      trailingDrawdownBps,
      thresholds,
    };
  }

  if (pnlBps !== null && pnlBps <= -thresholds.stopLossBps) {
    return {
      shouldExit: true,
      reason: 'stop_loss',
      markPriceUsd,
      pnlBps,
      trailingDrawdownBps,
      thresholds,
    };
  }

  if (
    pnlBps !== null
    && pnlBps > 0
    && trailingDrawdownBps !== null
    && trailingDrawdownBps <= -thresholds.trailingStopBps
  ) {
    return {
      shouldExit: true,
      reason: 'trailing_stop',
      markPriceUsd,
      pnlBps,
      trailingDrawdownBps,
      thresholds,
    };
  }

  // Signal-reversal exits LOCK IN profit when the trend flips against an open
  // position. They must never dump an underwater bag at a fee loss -- that path
  // booked a small realized loss on every reversal. When the position is not yet
  // profitable we hold and let stop_loss own the downside (it only fires past the
  // full round-trip cost floor) and take_profit own the upside.
  if (signalSnapshot.regime === 'bearish' && pnlBps !== null && pnlBps > 0) {
    return {
      shouldExit: true,
      reason: 'signal_reversal',
      markPriceUsd,
      pnlBps,
      trailingDrawdownBps,
      thresholds,
    };
  }

  return {
    shouldExit: false,
    reason: 'signal_reversal',
    markPriceUsd,
    pnlBps,
    trailingDrawdownBps,
    thresholds,
  };
};


const buildAdaptiveExitShadow = (params: {
  session: RawSession;
  evaluations: Array<Record<string, unknown>>;
}) => {
  const enabled = isCanaryShadowEnabled(params.session, WORKER_ADAPTIVE_EXIT_SHADOW_ENABLED);
  const decisions = enabled
    ? params.evaluations.map((evaluation) => {
        const pnlBps = typeof evaluation.pnlBps === 'number' ? evaluation.pnlBps : null;
        const maxFavorableBps = typeof evaluation.maxFavorableBps === 'number' ? evaluation.maxFavorableBps : null;
        const maxAdverseBps = typeof evaluation.maxAdverseBps === 'number' ? evaluation.maxAdverseBps : null;
        const tokenClass = evaluation.tokenClass as TokenTradeClass;
        const symbol = String(evaluation.symbol ?? 'UNKNOWN');
        if (typeof evaluation.shouldExit === 'boolean' && evaluation.shouldExit) {
          return {
            mint: String(evaluation.mint),
            symbol,
            tokenClass,
            action: 'full_exit' as const,
            reason: `current_policy_${String(evaluation.reason ?? 'exit')}`,
            pnlBps,
            maxFavorableBps,
            maxAdverseBps,
            suggestedSellBps: 10000,
            suggestedStopBps: null,
          };
        }

        if (pnlBps !== null && pnlBps >= (tokenClass === 'long_tail' ? 60 : 85)) {
          const costFloorBps = typeof evaluation.thresholds === 'object' && evaluation.thresholds !== null && 'costFloorBps' in evaluation.thresholds
            ? Number((evaluation.thresholds as { costFloorBps?: unknown }).costFloorBps ?? 0)
            : 0;
          return {
            mint: String(evaluation.mint),
            symbol,
            tokenClass,
            action: 'partial_take_profit' as const,
            reason: tokenClass === 'long_tail' ? 'fast_partial_for_long_tail_profit' : 'first_partial_profit_zone',
            pnlBps,
            maxFavorableBps,
            maxAdverseBps,
            suggestedSellBps: tokenClass === 'long_tail' ? 5000 : 3000,
            suggestedStopBps: Math.max(-10, -costFloorBps),
          };
        }

        if ((maxFavorableBps ?? 0) >= 80 && pnlBps !== null && pnlBps > 0) {
          return {
            mint: String(evaluation.mint),
            symbol,
            tokenClass,
            action: 'protect_breakeven' as const,
            reason: 'position_was_profitable_protect_remaining_risk',
            pnlBps,
            maxFavorableBps,
            maxAdverseBps,
            suggestedSellBps: 0,
            suggestedStopBps: 0,
          };
        }

        return {
          mint: String(evaluation.mint),
          symbol,
          tokenClass,
          action: 'hold' as const,
          reason: 'no_adaptive_profit_or_protection_trigger',
          pnlBps,
          maxFavorableBps,
          maxAdverseBps,
          suggestedSellBps: 0,
          suggestedStopBps: null,
        };
      })
    : [];

  return {
    at: new Date().toISOString(),
    enabled,
    mode: 'shadow' as const,
    canarySessionId: WORKER_ADAPTIVE_EXIT_CANARY_SESSION_ID,
    decisions,
  };
};

// Virtual-grid band thresholds (shadow now; future exec). A valid range must oscillate enough to
// clear round-trip fees but not be so wide that it's really a trend. Band edges (bottom/top pct of
// the range) define buy/sell zones; the breakout/breakdown guards stop the grid from chasing a
// vertical move up or averaging down into a breakdown — both explicit doc requirements.
const GRID_RANGE_MIN_WIDTH_BPS = Number(process.env.WORKER_GRID_RANGE_MIN_WIDTH_BPS ?? 25);
const GRID_RANGE_MAX_WIDTH_BPS = Number(process.env.WORKER_GRID_RANGE_MAX_WIDTH_BPS ?? 800);
const GRID_BAND_EDGE_PCT = Number(process.env.WORKER_GRID_BAND_EDGE_PCT ?? 30);
const GRID_BREAKOUT_MOVE_BPS = Number(process.env.WORKER_GRID_BREAKOUT_MOVE_BPS ?? 40);
const GRID_MIN_SAMPLES = Number(process.env.WORKER_GRID_MIN_SAMPLES ?? 8);
const GRID_RANGE_WINDOW = Number(process.env.WORKER_GRID_RANGE_WINDOW ?? 450);
const GRID_RECENT_MOVE_LOOKBACK = Number(process.env.WORKER_GRID_RECENT_MOVE_LOOKBACK ?? 15);
// Safety margin (bps) required ON TOP of the derived round-trip break-even before a grid
// range is considered tradeable. Keeps grid signals honestly above worst-case cost.
const GRID_PROFIT_MARGIN_BPS = Number(process.env.WORKER_GRID_PROFIT_MARGIN_BPS ?? 15);

type GridBandDecision = {
  action:
    | 'grid_disabled'
    | 'grid_warmup'
    | 'grid_range_too_tight'
    | 'grid_range_too_wide_trending'
    | 'grid_buy_zone'
    | 'grid_sell_zone'
    | 'grid_hold'
    | 'grid_breakout_no_chase'
    | 'grid_breakdown_no_buy';
  reason: string;
  rangeWidthBps: number | null;
  pricePositionPct: number | null;
  recentMoveBps: number | null;
  sampleCount: number;
  rangeLow: number | null;
  rangeHigh: number | null;
};

const computeVirtualGridBand = (mint: string, isChop: boolean, minProfitableWidthBps: number): GridBandDecision => {
  const empty = { rangeWidthBps: null, pricePositionPct: null, recentMoveBps: null, rangeLow: null, rangeHigh: null };
  if (!isChop) {
    return { action: 'grid_disabled', reason: 'not_chop_regime', sampleCount: 0, ...empty };
  }
  const prices = getMomentumTapeForMint(mint)
    .slice(-GRID_RANGE_WINDOW)
    .map((point) => point.usdPrice)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
  const sampleCount = prices.length;
  if (sampleCount < GRID_MIN_SAMPLES) {
    return { action: 'grid_warmup', reason: 'insufficient_range_samples', sampleCount, ...empty };
  }
  const rangeHigh = Math.max(...prices);
  const rangeLow = Math.min(...prices);
  const current = prices[prices.length - 1];
  const rangeMid = (rangeHigh + rangeLow) / 2;
  const rangeWidthBps = rangeMid > 0 ? Math.round(((rangeHigh - rangeLow) / rangeMid) * 10000) : 0;
  const span = rangeHigh - rangeLow;
  const pricePositionPct = span > 0 ? Math.round(((current - rangeLow) / span) * 100) : 50;
  const lookbackIdx = Math.max(0, prices.length - 1 - GRID_RECENT_MOVE_LOOKBACK);
  const refPrice = prices[lookbackIdx];
  const recentMoveBps = refPrice > 0 ? Math.round(((current - refPrice) / refPrice) * 10000) : 0;
  const diag = { sampleCount, rangeWidthBps, pricePositionPct, recentMoveBps, rangeLow, rangeHigh };

  // Honest break-even: a round trip must clear cost on BOTH legs, and the bands only let us
  // capture the fraction of the range between the buy edge and the sell edge. minProfitableWidthBps
  // is derived from the session's real round-trip cost at the call site. GRID_RANGE_MIN_WIDTH_BPS
  // acts only as an env-tunable absolute floor that can RAISE (never lower) the economic threshold.
  const effectiveMinWidthBps = Math.max(GRID_RANGE_MIN_WIDTH_BPS, minProfitableWidthBps);
  if (rangeWidthBps < effectiveMinWidthBps) {
    return { action: 'grid_range_too_tight', reason: `range_below_breakeven_${effectiveMinWidthBps}bps`, ...diag };
  }
  if (rangeWidthBps > GRID_RANGE_MAX_WIDTH_BPS) {
    return { action: 'grid_range_too_wide_trending', reason: 'range_too_wide_likely_trending', ...diag };
  }
  // Lower band -> buy the pullback, unless price is breaking DOWN (falling-knife guard).
  if (pricePositionPct <= GRID_BAND_EDGE_PCT) {
    if (recentMoveBps <= -GRID_BREAKOUT_MOVE_BPS) {
      return { action: 'grid_breakdown_no_buy', reason: 'range_breakdown_falling_knife', ...diag };
    }
    return { action: 'grid_buy_zone', reason: 'range_lower_pullback', ...diag };
  }
  // Upper band -> sell the rip, unless price is breaking OUT (don't chase the vertical move).
  if (pricePositionPct >= 100 - GRID_BAND_EDGE_PCT) {
    if (recentMoveBps >= GRID_BREAKOUT_MOVE_BPS) {
      return { action: 'grid_breakout_no_chase', reason: 'range_breakout_no_chase', ...diag };
    }
    return { action: 'grid_sell_zone', reason: 'range_upper_profit', ...diag };
  }
  return { action: 'grid_hold', reason: 'inside_grid_neutral_zone', ...diag };
};

const buildGridChopShadow = (params: {
  session: RawSession;
  evaluations: Array<Record<string, unknown>>;
  sessionIsChop: boolean;
}) => {
  const enabled = isCanaryShadowEnabled(params.session, WORKER_GRID_CHOP_SHADOW_ENABLED);
  // Chop detection keys off the SESSION-level strategy signal regime (the momentum /
  // mean-reversion tape read), NOT the per-position exit signalRegime. The latter
  // never reported 'flat' even in obvious chop, so the virtual grid stayed disabled
  // in the exact ranging conditions it exists for. params.sessionIsChop is computed
  // from the live session strategy signals at the call site.
  const marketRegime = !enabled
    ? 'unknown' as const
    : params.sessionIsChop
      ? 'chop' as const
      : 'trend' as const;

  // Derive the grid's economic break-even from the session's REAL round-trip cost:
  //   one-way  = expected slippage + platform fee (the same honest floor used for partial-TP)
  //   round    = 2 x one-way (buy leg + sell leg)
  //   capture  = fraction of range we can actually bank between the band edges (worst case:
  //              buy at the buy-band edge, sell at the sell-band edge) = (100 - 2*edgePct)/100
  //   minWidth = ceil(round / capture) + safety margin
  // Below this width a buy-low/sell-high round trip cannot net positive, so the grid sits out.
  const gridPlatformFeeBps = Number(params.session.service_control.platformFeeBps ?? 0);
  const gridRoundTripCostBps = (WORKER_EXIT_EXPECTED_SLIPPAGE_BPS + gridPlatformFeeBps) * 2;
  const gridCaptureFraction = Math.max(0.1, (100 - 2 * GRID_BAND_EDGE_PCT) / 100);
  const gridMinProfitableWidthBps = Math.ceil(gridRoundTripCostBps / gridCaptureFraction) + GRID_PROFIT_MARGIN_BPS;

  return {
    at: new Date().toISOString(),
    enabled,
    mode: 'shadow' as const,
    canarySessionId: WORKER_ADAPTIVE_EXIT_CANARY_SESSION_ID,
    marketRegime,
    reason: enabled
      ? (marketRegime === 'chop' ? 'flat_signal_present_virtual_grid_observation' : 'trend_signal_present_grid_disabled')
      : 'grid_chop_shadow_disabled',
    candidates: enabled
      ? params.evaluations.map((evaluation) => {
          const pnlBps = typeof evaluation.pnlBps === 'number' ? evaluation.pnlBps : null;
          const drawdownBps = typeof evaluation.trailingDrawdownBps === 'number' ? evaluation.trailingDrawdownBps : null;
          const tokenClass = evaluation.tokenClass as TokenTradeClass;
          const band = computeVirtualGridBand(String(evaluation.mint), marketRegime === 'chop', gridMinProfitableWidthBps);
          return {
            mint: String(evaluation.mint),
            symbol: String(evaluation.symbol ?? 'UNKNOWN'),
            tokenClass,
            action: band.action,
            pnlBps,
            drawdownBps,
            reason: band.reason,
            rangeWidthBps: band.rangeWidthBps,
            pricePositionPct: band.pricePositionPct,
            recentMoveBps: band.recentMoveBps,
            sampleCount: band.sampleCount,
            rangeLow: band.rangeLow,
            rangeHigh: band.rangeHigh,
          };
        })
      : [],
  };
};

let exitShadowHistoryReadyPromise: Promise<void> | null = null;

const ensureExitShadowHistoryReady = async () => {
  if (!exitShadowHistoryReadyPromise) {
    const dbPool = getPool();
    exitShadowHistoryReadyPromise = dbPool.query(`
      CREATE TABLE IF NOT EXISTS exit_shadow_decisions (
        id UUID PRIMARY KEY,
        session_id UUID NOT NULL,
        owner_wallet TEXT,
        mint TEXT NOT NULL,
        symbol TEXT,
        token_class TEXT,
        current_should_exit BOOLEAN,
        current_reason TEXT,
        adaptive_action TEXT,
        adaptive_reason TEXT,
        adaptive_suggested_sell_bps INTEGER,
        adaptive_suggested_stop_bps INTEGER,
        grid_regime TEXT,
        grid_action TEXT,
        grid_reason TEXT,
        pnl_bps INTEGER,
        max_favorable_bps INTEGER,
        max_adverse_bps INTEGER,
        trailing_drawdown_bps INTEGER,
        honest_floor_bps INTEGER,
        net_after_partial_bps INTEGER,
        partial_trigger_bps INTEGER,
        partial_sell_bps INTEGER,
        partial_fired BOOLEAN,
        partial_net_bps INTEGER,
        grid_range_width_bps INTEGER,
        grid_price_position_pct INTEGER,
        grid_recent_move_bps INTEGER,
        thresholds JSONB,
        evaluation JSONB,
        decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
      .then(() => dbPool.query(`
        ALTER TABLE exit_shadow_decisions
          ADD COLUMN IF NOT EXISTS honest_floor_bps INTEGER,
          ADD COLUMN IF NOT EXISTS net_after_partial_bps INTEGER,
          ADD COLUMN IF NOT EXISTS partial_trigger_bps INTEGER,
          ADD COLUMN IF NOT EXISTS partial_sell_bps INTEGER,
          ADD COLUMN IF NOT EXISTS partial_fired BOOLEAN,
          ADD COLUMN IF NOT EXISTS partial_net_bps INTEGER,
          ADD COLUMN IF NOT EXISTS grid_range_width_bps INTEGER,
          ADD COLUMN IF NOT EXISTS grid_price_position_pct INTEGER,
          ADD COLUMN IF NOT EXISTS grid_recent_move_bps INTEGER
      `))
      .then(() => dbPool.query(`
        CREATE INDEX IF NOT EXISTS exit_shadow_decisions_session_time_idx
        ON exit_shadow_decisions (session_id, decided_at DESC)
      `))
      .then(() => dbPool.query(`
        CREATE INDEX IF NOT EXISTS exit_shadow_decisions_session_mint_time_idx
        ON exit_shadow_decisions (session_id, mint, decided_at DESC)
      `))
      .then(() => undefined);
  }
  return exitShadowHistoryReadyPromise;
};

// Throttle: persist a fresh history row per (session, mint) only when the adaptive
// action changes OR a heartbeat interval elapses, so the table samples the PnL path
// without exploding to one row per position every cycle.
const exitShadowHistoryLastWrite = new Map<string, { at: number; action: string }>();
const EXIT_SHADOW_HISTORY_HEARTBEAT_MS = 30000;

// Phase 3 move 2 (shadow-only): token-class partial-TP that must CLEAR the honest break-even.
// Faster/larger partials for runner-prone classes, slower/smaller for majors. The trigger is
// honest break-even + a class margin so the sold fraction nets clearly positive. NO execution;
// this records what a per-class partial WOULD bank so we can validate it before flipping exec.
const computePartialTpShadow = (
  tokenClass: TokenTradeClass,
  pnlBps: number | null,
  honestFloorBps: number,
): { triggerBps: number; sellBps: number; fired: boolean; netBps: number | null } => {
  const profile =
    tokenClass === 'major'
      ? { marginBps: 7, sellBps: 4000 }
      : tokenClass === 'sol_beta'
        ? { marginBps: 8, sellBps: 3500 }
        : tokenClass === 'trend_liquid'
          ? { marginBps: 15, sellBps: 4000 }
          : { marginBps: 10, sellBps: 5000 };
  const triggerBps = honestFloorBps + profile.marginBps;
  const fired = pnlBps !== null && pnlBps >= triggerBps;
  const netBps = fired ? (pnlBps as number) - honestFloorBps : null;
  return { triggerBps, sellBps: profile.sellBps, fired, netBps };
};

const appendExitShadowHistory = async (
  session: RawSession,
  evaluations: Array<Record<string, unknown>>,
  adaptiveShadow: ReturnType<typeof buildAdaptiveExitShadow>,
  gridShadow: ReturnType<typeof buildGridChopShadow>,
): Promise<void> => {
  if (!WORKER_EXIT_SHADOW_HISTORY_ENABLED) return;
  // Canary-scoped: only accrue history where the shadow itself is active.
  if (!adaptiveShadow.enabled) return;
  if (evaluations.length === 0) return;

  const adaptiveByMint = new Map<string, Record<string, unknown>>();
  for (const decision of adaptiveShadow.decisions) {
    adaptiveByMint.set(String(decision.mint), decision as Record<string, unknown>);
  }
  const gridByMint = new Map<string, Record<string, unknown>>();
  for (const candidate of gridShadow.candidates) {
    gridByMint.set(String(candidate.mint), candidate as Record<string, unknown>);
  }

  const intOrNull = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;

  const now = Date.now();
  // Honest marginal sell-side cost a partial-TP must clear to net positive: REAL expected slippage
  // plus the session's platform fee (taken on the sell output). This is the corrected break-even.
  const honestFloorBps = WORKER_EXIT_EXPECTED_SLIPPAGE_BPS + Number(session.service_control.platformFeeBps ?? 0);
  const rows: Array<unknown[]> = [];
  for (const evaluation of evaluations) {
    const mint = String(evaluation.mint);
    const adaptive = adaptiveByMint.get(mint);
    const grid = gridByMint.get(mint);
    const adaptiveAction = adaptive ? String(adaptive.action ?? 'hold') : 'hold';
    const key = `${session.id}:${mint}`;
    const last = exitShadowHistoryLastWrite.get(key);
    const actionChanged = !last || last.action !== adaptiveAction;
    const heartbeatDue = !last || now - last.at >= EXIT_SHADOW_HISTORY_HEARTBEAT_MS;
    if (!actionChanged && !heartbeatDue) continue;
    exitShadowHistoryLastWrite.set(key, { at: now, action: adaptiveAction });

    const pnlForPartial = intOrNull(evaluation.pnlBps);
    const partialShadow = computePartialTpShadow(
      (evaluation.tokenClass as TokenTradeClass) ?? 'long_tail',
      pnlForPartial,
      honestFloorBps,
    );

    rows.push([
      randomUUID(),
      session.id,
      session.owner_wallet ?? null,
      mint,
      evaluation.symbol ? String(evaluation.symbol) : null,
      evaluation.tokenClass ? String(evaluation.tokenClass) : null,
      typeof evaluation.shouldExit === 'boolean' ? evaluation.shouldExit : null,
      evaluation.reason ? String(evaluation.reason) : null,
      adaptiveAction,
      adaptive?.reason ? String(adaptive.reason) : null,
      intOrNull(adaptive?.suggestedSellBps),
      intOrNull(adaptive?.suggestedStopBps),
      gridShadow.marketRegime ?? null,
      grid?.action ? String(grid.action) : null,
      grid?.reason ? String(grid.reason) : null,
      intOrNull(evaluation.pnlBps),
      intOrNull(evaluation.maxFavorableBps),
      intOrNull(evaluation.maxAdverseBps),
      intOrNull(evaluation.trailingDrawdownBps),
      JSON.stringify(evaluation.thresholds ?? null),
      JSON.stringify(evaluation),
      honestFloorBps,
      pnlForPartial === null ? null : pnlForPartial - honestFloorBps,
      partialShadow.triggerBps,
      partialShadow.sellBps,
      partialShadow.fired,
      partialShadow.netBps,
      intOrNull(grid?.rangeWidthBps),
      intOrNull(grid?.pricePositionPct),
      intOrNull(grid?.recentMoveBps),
    ]);
  }

  if (rows.length === 0) return;

  try {
    await ensureExitShadowHistoryReady();
    const dbPool = getPool();
    const cols = 30;
    const columnCasts = [
      '::uuid', '::uuid', '::text', '::text', '::text', '::text',
      '::boolean', '::text',
      '::text', '::text', '::int', '::int',
      '::text', '::text', '::text',
      '::int', '::int', '::int', '::int',
      '::jsonb', '::jsonb',
      '::int', '::int',
      '::int', '::int', '::boolean', '::int',
      '::int', '::int', '::int',
    ];
    const valuesSql = rows
      .map((_, rowIndex) => {
        const base = rowIndex * cols;
        const placeholders = Array.from({ length: cols }, (_, c) => `$${base + c + 1}${columnCasts[c]}`);
        return `(${placeholders.join(', ')})`;
      })
      .join(', ');
    await dbPool.query(
      `
        INSERT INTO exit_shadow_decisions (
          id, session_id, owner_wallet, mint, symbol, token_class,
          current_should_exit, current_reason,
          adaptive_action, adaptive_reason, adaptive_suggested_sell_bps, adaptive_suggested_stop_bps,
          grid_regime, grid_action, grid_reason,
          pnl_bps, max_favorable_bps, max_adverse_bps, trailing_drawdown_bps,
          thresholds, evaluation,
          honest_floor_bps, net_after_partial_bps,
          partial_trigger_bps, partial_sell_bps, partial_fired, partial_net_bps,
          grid_range_width_bps, grid_price_position_pct, grid_recent_move_bps
        ) VALUES ${valuesSql}
      `,
      rows.flat(),
    );
  } catch (error) {
    console.warn('[exit-shadow-history] append failed', error instanceof Error ? error.message : error);
  }
};

const getSessionStrategyConfig = (session: RawSession) => {
  const configured = session.service_control.strategyConfig;
  const configuredMomentum = configured?.momentum;

  const resolvedMomentumLookbackSamples = Math.max(
    signalPolicy.momentumLookbackSamples,
    Number(configuredMomentum?.lookbackSamples ?? signalPolicy.momentumLookbackSamples),
  );
  const resolvedMomentumThresholdBps = Math.max(
    signalPolicy.momentumThresholdBps,
    Number(configuredMomentum?.thresholdBps ?? signalPolicy.momentumThresholdBps),
  );
  const resolvedMomentumEdgeSafetyBufferBps = Math.max(
    signalPolicy.edgeSafetyBufferBps,
    Number(configuredMomentum?.edgeSafetyBufferBps ?? signalPolicy.edgeSafetyBufferBps),
  );

  const momentum = {
    lookbackSamples: resolvedMomentumLookbackSamples,
    thresholdBps: resolvedMomentumThresholdBps,
    edgeSafetyBufferBps: resolvedMomentumEdgeSafetyBufferBps,
  };

  const meanReversion: BollingerConfig = {
    length: configured?.meanReversion?.length ?? DEFAULT_BOLLINGER_CONFIG.length,
    stdMultiplier: configured?.meanReversion?.stdMultiplier ?? DEFAULT_BOLLINGER_CONFIG.stdMultiplier,
    minBandWidthFraction: configured?.meanReversion?.minBandWidthFraction ?? DEFAULT_BOLLINGER_CONFIG.minBandWidthFraction,
    entryThreshold: configured?.meanReversion?.entryThreshold ?? DEFAULT_BOLLINGER_CONFIG.entryThreshold,
    exitThreshold: configured?.meanReversion?.exitThreshold ?? DEFAULT_BOLLINGER_CONFIG.exitThreshold,
  };

  const supertrend: SupertrendConfig = {
    candleSamples: configured?.supertrend?.candleSamples ?? DEFAULT_SUPERTREND_CONFIG.candleSamples,
    atrPeriod: configured?.supertrend?.atrPeriod ?? DEFAULT_SUPERTREND_CONFIG.atrPeriod,
    multiplier: configured?.supertrend?.multiplier ?? DEFAULT_SUPERTREND_CONFIG.multiplier,
  };

  return {
    autoRotationEnabled: configured?.autoRotationEnabled ?? true,
    momentum,
    meanReversion,
    supertrend,
  };
};

const buildSessionSignalForStrategy = (
  strategy: StrategyKey,
  pythTape: PriceSample[],
  strategyConfig: ReturnType<typeof getSessionStrategyConfig>,
): NonNullable<Session['serviceControl']['lastSignal']> => {
  if (strategy === 'mean_reversion') {
    const bbSignal = computeBollingerSignal(pythTape, strategyConfig.meanReversion);
    logSignalEvent({ ...bbSignal.meta, strategy: 'mean_reversion', regime: bbSignal.regime, status: bbSignal.status });
    return {
      at: new Date().toISOString(),
      source: 'pyth-hermes',
      signal: 'momentum',
      strategy: 'mean_reversion',
      status: bbSignal.status,
      regime: bbSignal.regime,
      lookbackSamples: strategyConfig.momentum.lookbackSamples,
      thresholdBps: strategyConfig.momentum.thresholdBps,
      momentumBps: bbSignal.momentumBps,
      guardReason: bbSignal.guardReason,
    };
  }

  if (strategy === 'supertrend') {
    const stSignal = computeSupertrendSignal(pythTape, strategyConfig.supertrend);
    logSignalEvent({ ...stSignal.meta, strategy: 'supertrend', regime: stSignal.regime, status: stSignal.status });
    return {
      at: new Date().toISOString(),
      source: 'pyth-hermes',
      signal: 'momentum',
      strategy: 'supertrend',
      status: stSignal.status,
      regime: stSignal.regime,
      lookbackSamples: strategyConfig.momentum.lookbackSamples,
      thresholdBps: strategyConfig.momentum.thresholdBps,
      momentumBps: stSignal.momentumBps,
      guardReason: stSignal.guardReason,
    };
  }

  if (!lastPythSolSample) {
    return {
      at: new Date().toISOString(),
      source: 'pyth-hermes',
      signal: 'momentum',
      strategy: 'momentum',
      status: 'warming_up',
      regime: null,
      lookbackSamples: strategyConfig.momentum.lookbackSamples,
      thresholdBps: strategyConfig.momentum.thresholdBps,
      momentumBps: null,
      guardReason: null,
    };
  }

  const guardReason = getPythGuardReason(lastPythSolSample);
  const momentumBps = computeMomentumBps(
    sharedMarketTape.solUsdPyth,
    strategyConfig.momentum.lookbackSamples,
  );

  return {
    at: new Date().toISOString(),
    source: 'pyth-hermes',
    signal: 'momentum',
    strategy: 'momentum',
    status: guardReason
      ? 'guarded_off'
      : momentumBps === null
        ? 'warming_up'
        : 'ready',
    regime: guardReason || momentumBps === null
      ? null
      : classifyMomentum(momentumBps, strategyConfig.momentum.thresholdBps),
    lookbackSamples: strategyConfig.momentum.lookbackSamples,
    thresholdBps: strategyConfig.momentum.thresholdBps,
    momentumBps,
    guardReason,
  };
};

const executeTrade = async (session: RawSession): Promise<void> => {
  // Dedup guard: skip if there's an in-flight execution for this wallet.
  // Prevents double-submit if worker restarts between prepare and confirm.
  const dbPool = getPool();
  const inflightCheck = await dbPool.query<{ cnt: string }>(
    `SELECT count(*) AS cnt FROM swap_executions
     WHERE taker = $1 AND status IN ('prepared', 'submitted')`,
    [session.session_wallet],
  );
  const inflightCount = Number(inflightCheck.rows[0]?.cnt ?? 0);
  if (inflightCount > 0) {
    await persistTradeDecision(session, 'blocked', 'in_flight_execution');
    log('info', session.id, `skipping trade â€” ${inflightCount} in-flight execution(s) pending reconciliation`);
    return;
  }

  const keypair = await getKeypair(session.id);
  if (!keypair) {
    await persistTradeDecision(session, 'blocked', 'missing_session_keypair');
    log('warn', session.id, 'no keypair found â€” skipping trade');
    return;
  }

  let positionsState = await refreshPositionsMarks(session, getPositionsState(session));
  let positionState = summarizePositionsState(positionsState, session.service_control.positionState ?? undefined);

  // Recovery guard: older funding flow could incorrectly mark a session as
  // long position before any submitted trade exists. Reset to flat so entry logic
  // can run normally.
  if (
    countOpenPositions(positionsState) > 0
    && !session.service_control.schedulingState?.lastTradeSubmittedAt
  ) {
    const markedAt = new Date().toISOString();
    const markedPriceUsd = positionState.lastMarkedPriceUsd ?? lastPythSolSample?.usdPrice ?? null;

    positionsState = await persistPositionsState(session, {
      activePositionMint: null,
      positions: {},
    }, {
      lastMarkedPriceUsd: markedPriceUsd,
      lastMarkedAt: markedAt,
    });

    positionState = summarizePositionsState(positionsState, {
      lastMarkedPriceUsd: markedPriceUsd,
      lastMarkedAt: markedAt,
    });
    log('warn', session.id, 'recovered inconsistent bootstrap position state (long without submitted trade)');
  }

  const strategyConfig = getSessionStrategyConfig(session);

  // Resolve which strategy this session should use (respect enabled flags)
  const strategyUniverse = session.service_control.strategyUniverse ?? [];
  const enabledStrategies = strategyUniverse
    .filter((strategy) => strategy.enabled)
    .map((strategy) => strategy.key as StrategyKey);

  const configuredActiveStrategy = (session.service_control.rotationState?.activeStrategy ?? 'momentum') as StrategyKey;
  const fallbackStrategy = enabledStrategies[0] ?? 'momentum';
  const activeStrategy = enabledStrategies.includes(configuredActiveStrategy)
    ? configuredActiveStrategy
    : fallbackStrategy;

  if (activeStrategy !== configuredActiveStrategy) {
    await persistServiceControl(session, {
      rotationState: {
        activeStrategy,
        queuedStrategy: activeStrategy,
      },
    } as any);
    log('info', session.id, `strategy override: ${configuredActiveStrategy} disabled → ${activeStrategy}`);
  }

  const pythTape: PriceSample[] = sharedMarketTape.solUsdPyth.map(p => ({
    usdPrice: p.usdPrice,
    sampledAt: p.sampledAt,
  }));

  const strategyScanOrder = strategyConfig.autoRotationEnabled
    ? getStrategyScanOrder(activeStrategy, enabledStrategies)
    : [activeStrategy];
  const strategySignalByKey = new Map<StrategyKey, NonNullable<Session['serviceControl']['lastSignal']>>();
  let runtimeSignal = buildSessionSignalForStrategy(activeStrategy, pythTape, strategyConfig);
  let selectedEntryStrategy: StrategyKey | null = null;
  let selectedEntrySignal: NonNullable<Session['serviceControl']['lastSignal']> | null = null;

  for (const strategy of strategyScanOrder) {
    const signal = strategy === activeStrategy
      ? runtimeSignal
      : buildSessionSignalForStrategy(strategy, pythTape, strategyConfig);
    strategySignalByKey.set(strategy, signal);

    if (signal.status === 'ready' && signal.regime === 'bullish') {
      selectedEntryStrategy = strategy;
      selectedEntrySignal = signal;
      runtimeSignal = signal;
      break;
    }
  }

  await persistLastSignal(session, selectedEntrySignal ?? runtimeSignal);

  const lastTradeSubmittedMs = getLastTradeSubmittedMs(session);
  const msSinceLastSubmit = lastTradeSubmittedMs > 0 ? (Date.now() - lastTradeSubmittedMs) : Number.POSITIVE_INFINITY;
  if (msSinceLastSubmit < POST_SUBMIT_RECONCILE_GRACE_MS) {
    await persistTradeDecision(session, 'blocked', 'post_submit_reconcile_grace');
    log(
      'info',
      session.id,
      `waiting for execution reconcile: ${msSinceLastSubmit}ms/${POST_SUBMIT_RECONCILE_GRACE_MS}ms since submit`,
    );
    return;
  }

  // Verify keypair matches session wallet
  if (keypair.publicKey.toBase58() !== session.session_wallet) {
    await persistTradeDecision(session, 'error', 'session_keypair_mismatch');
    log('warn', session.id, `keypair mismatch: stored=${keypair.publicKey.toBase58()} session=${session.session_wallet}`);
    return;
  }

  // Check session wallet balance (subscription-backed cache with RPC revalidation TTL)
  let balance: number;
  try {
    balance = await getCachedSessionWalletBalance(keypair.publicKey);
  } catch {
    await persistTradeDecision(session, 'error', 'balance_check_failed');
    log('warn', session.id, 'balance check failed before trade');
    return;
  }

  try {
    const fundingBalanceAtomic = session.funding.fundingMint === USDC_MINT
      ? String(await getTokenBalanceAtomic(keypair.publicKey, USDC_MINT, TOKEN_PROGRAM_ID).catch(() => 0))
      : String(balance);
    await mergeFundingPatch(session, {
      currentBalanceAtomic: fundingBalanceAtomic,
    });
  } catch (err) {
    log('warn', session.id, `failed to persist live balance snapshot: ${String(err)}`);
  }

  try {
    await attemptPendingExitProfitPayout(session, keypair);
  } catch (err) {
    log('warn', session.id, `pending exit profit payout skipped: ${String(err)}`);
  }

  let openPositions = listOpenPositions(positionsState);

  if (openPositions.length > 0) {
    const reconciledPositions = { ...positionsState.positions };
    const droppedMints: string[] = [];

    for (const { mint, position } of openPositions) {
      const trackedQuantityAtomic = Number(position.quantityAtomic ?? 0);
      if (!Number.isFinite(trackedQuantityAtomic) || trackedQuantityAtomic <= 0) {
        continue;
      }

      const walletInventoryAtomic = mint === SOL_MINT
        ? Math.max(0, balance - MIN_SOL_OPERATING_RESERVE_LAMPORTS)
        : await getTokenBalanceAtomic(keypair.publicKey, mint, TOKEN_PROGRAM_ID).catch(() => 0);
      const minimumExpectedInventoryAtomic = Math.max(1, Math.floor(trackedQuantityAtomic * 0.1));

      if (walletInventoryAtomic < minimumExpectedInventoryAtomic) {
        delete reconciledPositions[mint];
        droppedMints.push(`${getPositionSymbol(position)}:${walletInventoryAtomic}/${trackedQuantityAtomic}`);
      }
    }

    if (droppedMints.length > 0) {
      positionsState = await persistPositionsState(session, {
        activePositionMint: positionsState.activePositionMint && reconciledPositions[positionsState.activePositionMint]
          ? positionsState.activePositionMint
          : null,
        positions: reconciledPositions,
      });
      positionState = summarizePositionsState(positionsState, session.service_control.positionState ?? undefined);
      openPositions = listOpenPositions(positionsState);
      log('warn', session.id, `reconciled stale position inventory; dropped ${droppedMints.join(', ')}`);
    }
  }

  const openPositionMints = new Set(openPositions.map(({ mint }) => mint));

  // Gas keep-alive: if SOL has drained toward the fee floor while the session
  // still holds USDC working capital, top the tank back up from a small USDC
  // slice instead of stalling (`insufficient_sol_fee_reserve`) or stopping
  // (`depleted`) with money still in the wallet. Runs before the depletion gate
  // below so a refilled session keeps trading this same cycle.
  balance = await maybeRefillGasFromUsdc(session, keypair, balance);

  // SOL depletion only stops a FLAT session. In the USDC-base model an active
  // session's capital lives in USDC + open token positions, while SOL is only a
  // fee reserve. When positions are open we just need enough SOL to pay exit
  // fees (operating reserve), never the full tradeable size — otherwise a healthy
  // multi-position session gets killed as "depleted" the moment its SOL is just a
  // fee reserve. Exit management must stay alive instead of sweeping mid-position.
  const minimumRequiredLamports = MIN_SOL_OPERATING_RESERVE_LAMPORTS;

  if (openPositions.length === 0 && balance < minimumRequiredLamports) {
    await persistTradeDecision(session, 'stopped', 'insufficient_balance');
    log('warn', session.id, `insufficient balance for trade: ${balance}/${minimumRequiredLamports} lamports`);
    await setSessionStatus(session.id, 'stopping', { stop_reason: 'depleted' }, { expectedStatuses: ['active'] });
    log('info', session.id, 'balance depleted â†’ stopping (sweep will run)');
    return;
  }

  let tradePlan: TradeExecutionPlan | null = null;
  let useBasicPairEntryFallback = false;
  let basicPairEntryFallbackReason: string | null = null;

  if (openPositions.length > 0) {
    const exitReasonPriority = {
      stop_loss: 0,
      trailing_stop: 1,
      signal_reversal: 2,
      take_profit: 3,
    } satisfies Record<NonNullable<SessionPositionState['exitReason']>, number>;
    const nextPositions = { ...positionsState.positions };
    let positionsChanged = false;
    const exitEvaluations: Array<Record<string, unknown>> = [];
    const exitCandidates: Array<{
      mint: string;
      position: SessionPositionState;
      signal: NonNullable<Session['serviceControl']['lastSignal']>;
      trigger: ExitTriggerDecision;
      partialFractionBps?: number | null;
    }> = [];
    // Step 4 partial-TP (Noah-only, flag-gated). Collected during the exit scan; only promoted
    // into an exit when NO hard exit competes this cycle (hard exits always win).
    const partialTpActive = isCanaryShadowEnabled(session, WORKER_PARTIAL_TP_ENABLED);
    const partialCandidates: Array<{
      mint: string;
      position: SessionPositionState;
      signal: NonNullable<Session['serviceControl']['lastSignal']>;
      trigger: ExitTriggerDecision;
      sellBps: number;
    }> = [];

    for (const { mint, position } of openPositions) {
      const positionStrategy = position.entryStrategy && enabledStrategies.includes(position.entryStrategy)
        ? position.entryStrategy
        : activeStrategy;
      const signalForPosition = mint === SOL_MINT
        ? (strategySignalByKey.get(positionStrategy) ?? buildSessionSignalForStrategy(positionStrategy, pythTape, strategyConfig))
        : buildRuntimeSignalForMint(mint, positionStrategy, strategyConfig);
      const exitTrigger = evaluateExitTrigger(session, position, signalForPosition);
      exitEvaluations.push({
        at: new Date().toISOString(),
        mint,
        symbol: getPositionSymbol(position),
        tokenClass: getTokenTradeClass(mint, getPositionSymbol(position)),
        strategy: positionStrategy,
        shouldExit: exitTrigger.shouldExit,
        reason: exitTrigger.reason,
        pnlBps: exitTrigger.pnlBps,
        trailingDrawdownBps: exitTrigger.trailingDrawdownBps,
        maxFavorableBps: position.maxFavorableBps ?? null,
        maxAdverseBps: position.maxAdverseBps ?? null,
        entryPriceUsd: position.entryPriceUsd,
        markPriceUsd: exitTrigger.markPriceUsd,
        highWaterPriceUsd: position.highWaterPriceUsd,
        thresholds: exitTrigger.thresholds,
        signalStatus: signalForPosition.status,
        signalRegime: signalForPosition.regime,
        signalMomentumBps: signalForPosition.momentumBps,
        pendingExitReason: position.pendingExitReason,
      });

      if (!exitTrigger.shouldExit) {
        if (position.pendingExitReason !== null) {
          nextPositions[mint] = {
            ...position,
            pendingExitReason: null,
          };
          positionsChanged = true;
        }
        if (partialTpActive && !position.partialExitDone) {
          const partialTokenClass = getTokenTradeClass(mint, getPositionSymbol(position));
          const partialHonestFloorBps = WORKER_EXIT_EXPECTED_SLIPPAGE_BPS + Number(session.service_control.platformFeeBps ?? 0);
          const partialEval = computePartialTpShadow(partialTokenClass, exitTrigger.pnlBps, partialHonestFloorBps);
          if (partialEval.fired) {
            partialCandidates.push({ mint, position, signal: signalForPosition, trigger: exitTrigger, sellBps: partialEval.sellBps });
          }
        }
        continue;
      }

      exitCandidates.push({
        mint,
        position,
        signal: signalForPosition,
        trigger: exitTrigger,
      });
    }

    if (WORKER_EXIT_TELEMETRY_ENABLED && exitEvaluations.length > 0) {
      // Session-level chop read: any active/scanned strategy signal reporting a flat
      // (ranging) regime means the market is chopping, which is when the virtual grid
      // shadow should observe. Sourced from the live session signals, not per-position.
      const sessionIsChop = Array.from(strategySignalByKey.values()).some((signal) => signal.regime === 'flat');
      const adaptiveExitShadow = buildAdaptiveExitShadow({ session, evaluations: exitEvaluations });
      const gridChopShadow = buildGridChopShadow({ session, evaluations: exitEvaluations, sessionIsChop });
      await persistServiceControl(session, {
        lastExitEvaluations: exitEvaluations,
        lastExitEvaluation: exitEvaluations,
        adaptiveExitShadow,
        gridChopShadow,
      } as any);
      await appendExitShadowHistory(session, exitEvaluations, adaptiveExitShadow, gridChopShadow);
    }

    if (positionsChanged) {
      positionsState = await persistPositionsState(session, {
        activePositionMint: positionsState.activePositionMint,
        positions: nextPositions,
      });
      positionState = summarizePositionsState(positionsState, session.service_control.positionState ?? undefined);
    }

    if (exitCandidates.length === 0 && partialTpActive && partialCandidates.length > 0) {
      partialCandidates.sort((a, b) => (b.trigger.pnlBps ?? 0) - (a.trigger.pnlBps ?? 0));
      const bestPartial = partialCandidates[0];
      exitCandidates.push({
        mint: bestPartial.mint,
        position: bestPartial.position,
        signal: bestPartial.signal,
        trigger: { ...bestPartial.trigger, reason: 'take_profit' },
        partialFractionBps: bestPartial.sellBps,
      });
      log(
        'info',
        session.id,
        `partial-tp candidate promoted: ${getPositionSymbol(bestPartial.position)} pnl=${bestPartial.trigger.pnlBps} sellBps=${bestPartial.sellBps}`,
      );
    }

    if (exitCandidates.length > 0) {
      exitCandidates.sort((left, right) => {
        const priorityDiff = exitReasonPriority[left.trigger.reason] - exitReasonPriority[right.trigger.reason];
        if (priorityDiff !== 0) return priorityDiff;
        return (right.trigger.pnlBps ?? Number.NEGATIVE_INFINITY) - (left.trigger.pnlBps ?? Number.NEGATIVE_INFINITY);
      });

      const selectedExit = exitCandidates[0];
      // Post-stop-loss cooldown: lock the stopped token's correlation cluster
      // from new entries so the bot does not immediately re-buy what it just
      // stopped out of (e.g. SOL stops out -> don't rebuy JitoSOL/mSOL/bSOL).
      if (selectedExit.trigger.reason === 'stop_loss') {
        try {
          await recordStopLossClusterLock(session, selectedExit.mint, Date.now());
        } catch (err) {
          log('warn', session.id, `failed to record stop-loss cluster lock for ${selectedExit.mint}: ${String(err)}`);
        }
      }
      const nextSelectedPosition: SessionPositionState = {
        ...selectedExit.position,
        pendingExitReason: selectedExit.trigger.reason,
      };

      if (
        positionsState.activePositionMint !== selectedExit.mint
        || selectedExit.position.pendingExitReason !== selectedExit.trigger.reason
      ) {
        positionsState = await persistPositionsState(session, {
          activePositionMint: selectedExit.mint,
          positions: {
            ...positionsState.positions,
            [selectedExit.mint]: nextSelectedPosition,
          },
        });
      }

      positionState = positionsState.positions[selectedExit.mint] ?? nextSelectedPosition;

      const positionMint = getPositionMint(positionState);
      const positionSymbol = getPositionSymbol(positionState);
      const sizing = computeTradeAmountLamports({
        balanceLamports: balance,
        thresholds: fundingThresholds,
        policy: sizingPolicy,
      });
      const exitReserveAtomic = positionMint === SOL_MINT ? sizing.reserveLamports : 0;
      const exitTokenBalanceSnapshot = positionMint === SOL_MINT
        ? null
        : await getTokenBalanceSnapshot(keypair.publicKey, positionMint);
      const exitWalletBalanceAtomic = positionMint === SOL_MINT
        ? sizing.balanceLamports
        : exitTokenBalanceSnapshot?.balanceAtomic ?? 0;
      if (exitTokenBalanceSnapshot && exitWalletBalanceAtomic <= 0 && Number(positionState.quantityAtomic ?? 0) > 0) {
        log(
          'warn',
          session.id,
          `exit inventory lookup returned zero for ${positionSymbol} (${positionMint}) despite tracked quantity=${positionState.quantityAtomic}; source=${exitTokenBalanceSnapshot.source} tokenAccount=${exitTokenBalanceSnapshot.tokenAccount ?? 'none'} program=${exitTokenBalanceSnapshot.programId ?? 'none'} attemptedPrograms=${exitTokenBalanceSnapshot.attemptedPrograms.join(',')}`,
        );
      }
      const exitTradableAtomic = Math.max(0, exitWalletBalanceAtomic - exitReserveAtomic);
      const fullExitAmountLamports = computeFullExitAmountAtomic({
        walletBalanceAtomic: exitWalletBalanceAtomic,
        reserveAtomic: exitReserveAtomic,
        positionQuantityAtomic: positionState.quantityAtomic,
      });
      const exitAmountLamports = selectedExit.partialFractionBps != null
        ? Math.max(0, Math.floor((fullExitAmountLamports * Math.min(selectedExit.partialFractionBps, WORKER_PARTIAL_TP_MAX_FRACTION_BPS)) / 10000))
        : fullExitAmountLamports;

      const sellInventory: TradeInventoryContext = {
        inputMint: positionMint,
        inputSymbol: positionSymbol,
        outputMint: USDC_MINT,
        outputSymbol: 'USDC',
        balanceAtomic: exitWalletBalanceAtomic,
        reserveAtomic: exitReserveAtomic,
        tradableAtomic: exitTradableAtomic,
        targetAtomic: exitAmountLamports,
        minTradeAtomic: exitAmountLamports,
        maxTradeAtomic: exitAmountLamports,
        amountAtomic: exitAmountLamports > 0 ? exitAmountLamports : null,
        riskAdjustedAmountAtomic: null,
      };

      if (exitAmountLamports <= 0) {
        try {
          await persistLastSizing(session, {
            at: new Date().toISOString(),
            decision: 'skipped',
            reason: 'no_exit_inventory',
            balanceLamports: String(exitWalletBalanceAtomic),
            reserveLamports: String(exitReserveAtomic),
            tradableLamports: String(exitTradableAtomic),
            fractionBps: 10000,
            targetLamports: String(exitAmountLamports),
            minTradeLamports: String(exitAmountLamports),
            maxTradeLamports: String(exitAmountLamports),
            amountLamports: null,
            remainingRiskBudgetUsd: null,
            quotedOutAmountAtomic: null,
            minimumOutputAtomic: null,
            priceImpactPct: null,
            estimatedNetworkCostLamports: null,
            estimatedNetworkCostOutputAtomic: null,
            worstCaseSlippageOutputAtomic: null,
            totalWorstCaseCostOutputAtomic: null,
            riskAdjustedAmountLamports: null,
            tradeContext: buildSizingTradeContext(sellInventory),
          });
        } catch (err) {
          log('warn', session.id, `failed to persist lastSizing: ${String(err)}`);
        }

        log(
          'info',
          session.id,
          `sizing skip (no_exit_inventory): ${positionSymbol} balance=${exitWalletBalanceAtomic} reserve=${exitReserveAtomic} tradable=${exitTradableAtomic} exitAmount=${exitAmountLamports}`,
        );
        return;
      }

      if (positionMint === SOL_MINT && sizing.skip) {
        log(
          'info',
          session.id,
          `forced SOL exit bypassing entry sizing skip (${sizing.reason}): ${positionSymbol} balance=${exitWalletBalanceAtomic} reserve=${exitReserveAtomic} tradable=${exitTradableAtomic} exitAmount=${exitAmountLamports}`,
        );
      }

      tradePlan = {
        direction: 'exit_long',
        inventory: sellInventory,
        exitReason: selectedExit.trigger.reason,
        signalSnapshot: selectedExit.signal,
        scannerStrategy: activeStrategy,
        entryStrategy: selectedExit.position.entryStrategy ?? null,
        exitStrategy: selectedExit.position.entryStrategy ?? activeStrategy,
        partialFractionBps: selectedExit.partialFractionBps ?? null,
      };
    }
  }

  if (!tradePlan) {
    const { realizedPnlUsd } = session.funding;
    const sessionLoss = Math.abs(Math.min(0, realizedPnlUsd));
    const circuitBreakerReason = getRiskCircuitBreakerReason(session, sessionLoss);
    if (circuitBreakerReason) {
      const riskState = getSessionRiskState(session);
      await persistTradeDecision(session, 'blocked', circuitBreakerReason);
      await persistLastTradeGate(session, {
        at: new Date().toISOString(),
        decision: 'blocked',
        reason: circuitBreakerReason,
        expectedEdgeBps: runtimeSignal.momentumBps,
        estimatedCostBps: null,
        safetyBufferBps: null,
      });
      log(
        'info',
        session.id,
        `risk entry gate blocked new entry (${circuitBreakerReason}): sessionLoss=$${sessionLoss.toFixed(2)} dailyPnl=$${riskState.dailyRealizedPnlUsd.toFixed(4)} consecutiveLosses=${riskState.consecutiveLosses} badFillStreak=${riskState.badFillStreak}; session remains active for scanning, holding, and exits`,
      );
      return;
    }

    if (!liveEntriesEnabled) {
      const reason = 'deployment_entries_disabled';
      await persistTradeDecision(session, 'blocked', reason);
      await persistLastTradeGate(session, {
        at: new Date().toISOString(),
        decision: 'blocked',
        reason,
        expectedEdgeBps: runtimeSignal.momentumBps,
        estimatedCostBps: null,
        safetyBufferBps: null,
      });
      log(
        'info',
        session.id,
        `entry blocked: deployment entry lock active${liveMaintenanceReason ? ` (${liveMaintenanceReason})` : ''}`,
      );
      return;
    }

    // Fleet-mode position cap can only tighten the session's own risk limit, never loosen it.
    // Surge (maxOpenPositions === null) applies no extra clamp.
    const fleetMaxOpenPositions = getLiveSpeedProfile().maxOpenPositions;
    const effectiveMaxOpenPositions = fleetMaxOpenPositions === null
      ? session.risk_limits.maxOpenPositions
      : Math.min(session.risk_limits.maxOpenPositions, fleetMaxOpenPositions);

    if (openPositions.length >= effectiveMaxOpenPositions) {
      const limitedByFleet = fleetMaxOpenPositions !== null
        && fleetMaxOpenPositions < session.risk_limits.maxOpenPositions;
      await persistTradeDecision(
        session,
        'blocked',
        limitedByFleet ? 'fleet_mode_position_cap' : 'max_open_positions_reached',
      );
      await persistLastTradeGate(session, {
        at: new Date().toISOString(),
        decision: 'blocked',
        reason: 'max_open_positions_reached',
        expectedEdgeBps: runtimeSignal.momentumBps,
        estimatedCostBps: null,
        safetyBufferBps: strategyConfig.momentum.edgeSafetyBufferBps,
      });
      log(
        'info',
        session.id,
        `entry blocked: ${openPositions.length}/${effectiveMaxOpenPositions} positions already open`
          + (limitedByFleet ? ` (fleet ${getLiveSpeedProfile().name} cap ${fleetMaxOpenPositions})` : ''),
      );
      return;
    }

    const universeEngineAgeMs = lastTokenUniverseEngineAppliedAt > 0
      ? (Date.now() - lastTokenUniverseEngineAppliedAt)
      : Number.POSITIVE_INFINITY;
    const universeEngineFresh = universeEngineAgeMs <= TOKEN_UNIVERSE_ENGINE_MAX_STALE_MS;
    const universeEngineEmpty = lastTokenUniverseEngineEnabledCount <= 0;
    basicPairEntryFallbackReason = !universeEngineFresh
      ? 'universe_engine_stale'
      : tokenUniverseProbeFrozen
        ? 'probe_health_frozen'
        : universeEngineEmpty
          ? 'universe_engine_empty'
          : null;
    useBasicPairEntryFallback = basicPairEntryFallbackReason !== null;

    if (useBasicPairEntryFallback) {
      log(
        'info',
        session.id,
        `entry fallback active: basic_pairs_only (${basicPairEntryFallbackReason}) ageMs=${Number.isFinite(universeEngineAgeMs) ? universeEngineAgeMs : -1} enabledCount=${lastTokenUniverseEngineEnabledCount} probeFrozen=${tokenUniverseProbeFrozen}`,
      );
    }

    if (balance < MIN_SOL_OPERATING_RESERVE_LAMPORTS) {
      await persistTradeDecision(session, 'blocked', 'insufficient_sol_fee_reserve');
      await persistLastTradeGate(session, {
        at: new Date().toISOString(),
        decision: 'blocked',
        reason: 'insufficient_sol_fee_reserve',
        expectedEdgeBps: runtimeSignal.momentumBps,
        estimatedCostBps: null,
        safetyBufferBps: null,
      });
      log('info', session.id, `inventory skip: flat session has only ${balance} lamports, below fee reserve ${MIN_SOL_OPERATING_RESERVE_LAMPORTS}`);
      return;
    }

    const usdcBalanceAtomic = await getTokenBalanceAtomic(keypair.publicKey, USDC_MINT, TOKEN_PROGRAM_ID);
    const usdcSizing = computeUsdcTradeAmountAtomic({
      balanceAtomic: usdcBalanceAtomic,
      maxPositionUsd: session.risk_limits.maxPositionSizeUsd,
      maxOpenPositions: effectiveMaxOpenPositions,
      openPositionsCount: openPositions.length,
    });
    const solSizing = computeTradeAmountLamports({
      balanceLamports: balance,
      thresholds: fundingThresholds,
      policy: sizingPolicy,
    });
    const canUseUsdcEntry = !usdcSizing.skip;
    const canUseSolEntry = !openPositionMints.has(SOL_MINT) && !solSizing.skip;

    // Honor the session's base-capital (funding) mint when picking entry inventory,
    // but do not let idle USDC sit unused. A SOL-funded session deploys its SOL
    // capital first (SOL->token via the scout); once SOL capital is already working
    // in an open position, leftover USDC becomes a SECOND inventory that funds an
    // additional concurrent position instead of sitting idle. This both puts the
    // "dust" to work and enables genuine multi-position behaviour.
    //
    // The old failure mode (a $1.10 micro-trade whose ~$0.0137 fee is ~124bps and
    // can never clear a 30bps take-profit) only occurred when USDC was split across
    // every open slot while the session was FLAT (0 open -> 3-way split). Gating USDC
    // entry on `openPositions.length > 0` means the split denominator is small
    // (<= remaining slots), so each USDC chunk is a viable size, and the conviction
    // entry gate remains the final viability arbiter for true micro-dust.
    const fundingIsUsdc = session.funding.fundingMint === USDC_MINT;
    const useUsdcEntry = canUseUsdcEntry && (
      fundingIsUsdc
      || !canUseSolEntry
      || openPositions.length > 0
    );

    if (usdcSizing.skip && openPositionMints.has(SOL_MINT)) {
      log(
        'info',
        session.id,
        `entry base conversion blocked: SOL is an open position; not converting tracked SOL to USDC (usdc=${usdcBalanceAtomic}/${MIN_USDC_ENTRY_ATOMIC})`,
      );
    }

    const entryInventory: TradeInventoryContext = {
      inputMint: useUsdcEntry ? USDC_MINT : SOL_MINT,
      inputSymbol: useUsdcEntry ? 'USDC' : 'SOL',
      outputMint: useUsdcEntry ? SOL_MINT : USDC_MINT,
      outputSymbol: useUsdcEntry ? 'SOL' : 'USDC',
      balanceAtomic: useUsdcEntry ? usdcSizing.balanceAtomic : solSizing.balanceLamports,
      reserveAtomic: useUsdcEntry ? usdcSizing.reserveAtomic : solSizing.reserveLamports,
      tradableAtomic: useUsdcEntry ? usdcSizing.tradableAtomic : solSizing.tradableLamports,
      targetAtomic: useUsdcEntry ? usdcSizing.targetAtomic : solSizing.targetLamports,
      minTradeAtomic: useUsdcEntry ? usdcSizing.minTradeAtomic : sizingPolicy.minTradeLamports,
      maxTradeAtomic: useUsdcEntry ? usdcSizing.maxTradeAtomic : sizingPolicy.maxTradeLamports,
      amountAtomic: useUsdcEntry ? usdcSizing.amountAtomic : (canUseSolEntry ? solSizing.amountLamports : null),
      riskAdjustedAmountAtomic: null,
    };

    if (!canUseUsdcEntry && !canUseSolEntry && openPositionMints.has(SOL_MINT) && openPositions.length < effectiveMaxOpenPositions) {
      const solPosition = positionsState.positions[SOL_MINT] ?? null;
      const trackedSolAtomic = Number(solPosition?.quantityAtomic ?? 0);
      const targetSolAtomic = Math.floor(solSizing.tradableLamports / Math.max(1, effectiveMaxOpenPositions));
      const maxSellableTrackedSolAtomic = Math.max(0, Math.min(trackedSolAtomic, solSizing.tradableLamports));
      const rebalanceAmountLamports = Math.max(
        0,
        Math.min(maxSellableTrackedSolAtomic, trackedSolAtomic - targetSolAtomic),
      );

      if (solPosition && rebalanceAmountLamports >= sizingPolicy.minTradeLamports) {
        positionsState = await persistPositionsState(session, {
          activePositionMint: SOL_MINT,
          positions: {
            ...positionsState.positions,
            [SOL_MINT]: {
              ...solPosition,
              pendingExitReason: 'signal_reversal',
            },
          },
        });
        positionState = positionsState.positions[SOL_MINT] ?? solPosition;

        const rebalanceInventory: TradeInventoryContext = {
          inputMint: SOL_MINT,
          inputSymbol: 'SOL',
          outputMint: USDC_MINT,
          outputSymbol: 'USDC',
          balanceAtomic: solSizing.balanceLamports,
          reserveAtomic: solSizing.reserveLamports,
          tradableAtomic: solSizing.tradableLamports,
          targetAtomic: rebalanceAmountLamports,
          minTradeAtomic: sizingPolicy.minTradeLamports,
          maxTradeAtomic: rebalanceAmountLamports,
          amountAtomic: rebalanceAmountLamports,
          riskAdjustedAmountAtomic: null,
        };

        tradePlan = {
          direction: 'exit_long',
          inventory: rebalanceInventory,
          exitReason: 'signal_reversal',
          signalSnapshot: selectedEntrySignal ?? runtimeSignal,
          scannerStrategy: selectedEntryStrategy ?? activeStrategy,
          entryStrategy: solPosition.entryStrategy ?? null,
          exitStrategy: solPosition.entryStrategy ?? selectedEntryStrategy ?? activeStrategy,
        };

        log(
          'info',
          session.id,
          `portfolio rebalance: selling ${rebalanceAmountLamports} SOL lamports to restore USDC entry inventory (tracked=${trackedSolAtomic}, targetSol=${targetSolAtomic}, open=${openPositions.length}/${effectiveMaxOpenPositions})`,
        );
      }
    }

    if (!tradePlan && (!selectedEntryStrategy || !selectedEntrySignal)) {
      await persistTradeDecision(session, 'blocked', 'no_strategy_entry_signal');
      await persistLastTradeGate(session, {
        at: new Date().toISOString(),
        decision: 'blocked',
        reason: 'no_strategy_entry_signal',
        expectedEdgeBps: runtimeSignal.momentumBps,
        estimatedCostBps: null,
        safetyBufferBps: null,
      });
      log(
        'info',
        session.id,
        `strategy scan blocked entry: no bullish trigger order=${strategyScanOrder.join('>')} last=${runtimeSignal.regime}/${runtimeSignal.momentumBps}`,
      );
      return;
    }

    if (!tradePlan && !canUseUsdcEntry && !canUseSolEntry) {
      const blockedReason = openPositionMints.has(SOL_MINT)
        ? 'entry_inventory_allocated_to_open_sol_position'
        : (usdcSizing.reason ?? (solSizing.skip ? solSizing.reason : null) ?? 'entry_inventory_blocked');
      await persistTradeDecision(session, 'blocked', blockedReason);
      await persistLastTradeGate(session, {
        at: new Date().toISOString(),
        decision: 'blocked',
        reason: blockedReason,
        expectedEdgeBps: runtimeSignal.momentumBps,
        estimatedCostBps: null,
        safetyBufferBps: null,
      });
      try {
        await persistLastSizing(session, {
          at: new Date().toISOString(),
          decision: 'skipped',
          reason: usdcSizing.reason,
          balanceLamports: String(balance),
          reserveLamports: String(MIN_SOL_OPERATING_RESERVE_LAMPORTS),
          tradableLamports: String(Math.max(0, balance - MIN_SOL_OPERATING_RESERVE_LAMPORTS)),
          fractionBps: 10000,
          targetLamports: '0',
          minTradeLamports: '0',
          maxTradeLamports: '0',
          amountLamports: null,
          remainingRiskBudgetUsd: null,
          quotedOutAmountAtomic: null,
          minimumOutputAtomic: null,
          priceImpactPct: null,
          estimatedNetworkCostLamports: null,
          estimatedNetworkCostOutputAtomic: null,
          worstCaseSlippageOutputAtomic: null,
          totalWorstCaseCostOutputAtomic: null,
          riskAdjustedAmountLamports: null,
          tradeContext: buildSizingTradeContext(entryInventory),
        });
      } catch (err) {
        log('warn', session.id, `failed to persist lastSizing: ${String(err)}`);
      }
      log(
        'info',
        session.id,
        `entry sizing skip (${blockedReason}): usdcBalance=${usdcSizing.balanceAtomic} solBalance=${solSizing.balanceLamports} usdcTarget=${usdcSizing.targetAtomic} solTarget=${solSizing.targetLamports}`,
      );
      return;
    }

    if (!tradePlan) {
      const entryStrategyForPlan = selectedEntryStrategy;
      const entrySignalForPlan = selectedEntrySignal;
      if (!entryStrategyForPlan || !entrySignalForPlan) {
        await persistTradeDecision(session, 'blocked', 'no_strategy_entry_signal');
        await persistLastTradeGate(session, {
          at: new Date().toISOString(),
          decision: 'blocked',
          reason: 'no_strategy_entry_signal',
          expectedEdgeBps: runtimeSignal.momentumBps,
          estimatedCostBps: null,
          safetyBufferBps: null,
        });
        log(
          'info',
          session.id,
          `strategy scan blocked entry: no bullish trigger order=${strategyScanOrder.join('>')} last=${runtimeSignal.regime}/${runtimeSignal.momentumBps}`,
        );
        return;
      }

      let selectedEntryMint = entryInventory.inputMint === SOL_MINT ? USDC_MINT : SOL_MINT;
      let tokenEntrySignal = entrySignalForPlan;
    // Note: selectedEntrySignal may be updated if universe scout selects a different token,
    // but it maintains the strategy-specific signal basis (momentum/Bollinger/Supertrend) for SOL.
    // For alt tokens, we separately check if they are bullish via buildMintMomentumSignal.
    if (WORKER_UNIVERSE_SCOUT_ENABLED) {
      // Diversification + post-loss cooldown: exclude any correlation cluster
      // that is already at its open-position cap, and any cluster still locked
      // from a recent stop_loss, before the scout ranks candidates.
      const cappedClusters = new Set<string>();
      const clusterOpenCounts = new Map<string, number>();
      for (const { mint } of openPositions) {
        const clusterId = getClusterForMint(mint);
        const nextCount = (clusterOpenCounts.get(clusterId) ?? 0) + 1;
        clusterOpenCounts.set(clusterId, nextCount);
        if (nextCount >= WORKER_MAX_OPEN_PER_CLUSTER) {
          cappedClusters.add(clusterId);
        }
      }
      const lockedClusters = getActiveStopLossLockedClusters(session, Date.now());
      const excludedClusters = new Set<string>([...cappedClusters, ...lockedClusters]);
      const entryRejectCooldownMints = getActiveEntryRejectCooldownMints(session.id, Date.now());
      const excludedScoutMints = new Set<string>([...openPositionMints, ...entryRejectCooldownMints]);
      if (entryRejectCooldownMints.size > 0) {
        log(
          'info',
          session.id,
          `universe scout excluding ${entryRejectCooldownMints.size} recent rejected candidate(s): ${[...entryRejectCooldownMints].map((mint) => resolveTokenSymbol(mint)).join(',')}`,
        );
      }

      const scout = await scoutEntryUniverse({
        inputMint: entryInventory.inputMint,
        inputSymbol: entryInventory.inputSymbol,
        amountAtomic: entryInventory.amountAtomic ?? 0,
        takerWallet: session.session_wallet,
        slippageBps: session.risk_limits.maxSlippageBps,
        activeStrategy: entryStrategyForPlan,
        strategyConfig,
        lookbackSamples: strategyConfig.momentum.lookbackSamples,
        thresholdBps: strategyConfig.momentum.thresholdBps,
        requiredSignalSamples: MIN_ENTRY_SIGNAL_PERSISTENCE_SAMPLES,
        excludedMints: excludedScoutMints,
        excludedClusters,
        useTrustedFallback: useBasicPairEntryFallback,
      });

      if (!scout.bestMint) {
        const scoutSnapshot = buildUniverseScoutGateSnapshot(scout);
        const scoutBlockedReason = scoutSnapshot.routeFoundCount > 0
          ? (scout.selectableRanked.length > 0
            ? 'universe_scout_no_bullish_candidate'
            : 'universe_scout_no_preentry_eligible_candidate')
          : 'universe_scout_no_route';
        await persistTradeDecision(session, 'blocked', scoutBlockedReason);
        await persistLastTradeGate(session, {
          at: new Date().toISOString(),
          decision: 'blocked',
          reason: scoutBlockedReason,
          expectedEdgeBps: runtimeSignal.momentumBps,
          estimatedCostBps: null,
          safetyBufferBps: strategyConfig.momentum.edgeSafetyBufferBps,
          scout: scoutSnapshot,
        });
        log(
          'info',
          session.id,
          scoutBlockedReason === 'universe_scout_no_bullish_candidate'
            ? `universe scout blocked entry: no bullish candidate (routes=${scoutSnapshot.routeFoundCount}/${scoutSnapshot.candidateCount}, bullish=${scoutSnapshot.bullishRouteCount})`
            : scoutBlockedReason === 'universe_scout_no_preentry_eligible_candidate'
              ? `universe scout blocked entry: no pre-entry eligible candidate (routes=${scoutSnapshot.routeFoundCount}/${scoutSnapshot.candidateCount}, bullish=${scoutSnapshot.bullishRouteCount})`
              : `universe scout blocked entry: no route (candidates=${scout.candidates.length})`,
        );
        return;
      }

      if (
        scout.bestPriceImpactBps !== null
        && scout.bestPriceImpactBps > WORKER_UNIVERSE_SCOUT_MAX_ENTRY_PRICE_IMPACT_BPS
      ) {
        await persistTradeDecision(session, 'blocked', 'universe_scout_entry_impact_too_high');
        await persistLastTradeGate(session, {
          at: new Date().toISOString(),
          decision: 'blocked',
          reason: 'universe_scout_entry_impact_too_high',
          expectedEdgeBps: runtimeSignal.momentumBps,
          estimatedCostBps: scout.bestPriceImpactBps,
          safetyBufferBps: strategyConfig.momentum.edgeSafetyBufferBps,
          scout: buildUniverseScoutGateSnapshot(scout),
        });
        log(
          'info',
          session.id,
          `universe scout blocked entry: impact=${scout.bestPriceImpactBps}bps max=${WORKER_UNIVERSE_SCOUT_MAX_ENTRY_PRICE_IMPACT_BPS}bps best=${scout.bestMint}`,
        );
        return;
      }

      // Flat-regime suppression: when the only viable pick is a routed-fallback
      // candidate (no persistent bullish signal anywhere), the tape is flat and
      // any entry would be momentum noise. Skip it instead of buying chop.
      if (scout.bestUsesRoutedFallback && WORKER_FLAT_REGIME_SUPPRESS_FALLBACK) {
        await persistTradeDecision(session, 'blocked', 'flat_regime_routed_fallback_suppressed');
        await persistLastTradeGate(session, {
          at: new Date().toISOString(),
          decision: 'blocked',
          reason: 'flat_regime_routed_fallback_suppressed',
          expectedEdgeBps: runtimeSignal.momentumBps,
          estimatedCostBps: scout.bestPriceImpactBps,
          safetyBufferBps: strategyConfig.momentum.edgeSafetyBufferBps,
          scout: buildUniverseScoutGateSnapshot(scout),
        });
        log(
          'info',
          session.id,
          `flat regime: suppressed routed-fallback entry for ${resolveTokenSymbol(scout.bestMint)} (${scout.bestMint}); no persistent bullish candidate`,
        );
        return;
      }

      selectedEntryMint = scout.bestMint;
      const scoutUsedRoutedFallback = scout.bestUsesRoutedFallback;
      if (selectedEntryMint !== SOL_MINT) {
        const candidateSignal = buildRuntimeSignalForMint(selectedEntryMint, entryStrategyForPlan, strategyConfig);
        tokenEntrySignal = scoutUsedRoutedFallback
          && (candidateSignal.status !== 'ready' || candidateSignal.regime !== 'bullish')
          ? entrySignalForPlan
          : candidateSignal;
        if (scoutUsedRoutedFallback && tokenEntrySignal === entrySignalForPlan) {
          log(
            'info',
            session.id,
            `universe scout using routed fallback for ${resolveTokenSymbol(selectedEntryMint)} (${selectedEntryMint}); token signal=${candidateSignal.status}/${candidateSignal.regime ?? 'none'} sessionSignal=${entrySignalForPlan.status}/${entrySignalForPlan.regime ?? 'none'}`,
          );
        }
      }
    }

    if (selectedEntryMint === entryInventory.inputMint) {
      await persistTradeDecision(session, 'blocked', 'entry_same_input_output');
      await persistLastTradeGate(session, {
        at: new Date().toISOString(),
        decision: 'blocked',
        reason: 'entry_same_input_output',
        expectedEdgeBps: tokenEntrySignal.momentumBps,
        estimatedCostBps: null,
        safetyBufferBps: strategyConfig.momentum.edgeSafetyBufferBps,
      });
      log('info', session.id, `entry blocked: selected mint equals input mint ${entryInventory.inputSymbol}`);
      return;
    }

    if (openPositionMints.has(selectedEntryMint)) {
      await persistTradeDecision(session, 'blocked', 'entry_mint_already_open');
      await persistLastTradeGate(session, {
        at: new Date().toISOString(),
        decision: 'blocked',
        reason: 'entry_mint_already_open',
        expectedEdgeBps: tokenEntrySignal.momentumBps,
        estimatedCostBps: null,
        safetyBufferBps: strategyConfig.momentum.edgeSafetyBufferBps,
      });
      log('info', session.id, `entry blocked: ${resolveTokenSymbol(selectedEntryMint)} already open in portfolio`);
      return;
    }

    if (tokenEntrySignal.status !== 'ready' || tokenEntrySignal.regime !== 'bullish') {
      await persistTradeDecision(session, 'blocked', 'entry_token_signal_not_bullish');
      await persistLastTradeGate(session, {
        at: new Date().toISOString(),
        decision: 'blocked',
        reason: 'entry_token_signal_not_bullish',
        expectedEdgeBps: tokenEntrySignal.momentumBps,
        estimatedCostBps: null,
        safetyBufferBps: strategyConfig.momentum.edgeSafetyBufferBps,
      });
      log('info', session.id, `entry blocked: token signal not bullish for ${resolveTokenSymbol(selectedEntryMint)} (${selectedEntryMint})`);
      return;
    }

    const persistentBullishRegime = selectedEntryStrategy !== 'momentum' || hasMomentumRegimePersistence({
      samples: getMomentumTapeForMint(selectedEntryMint),
      lookbackSamples: strategyConfig.momentum.lookbackSamples,
      thresholdBps: strategyConfig.momentum.thresholdBps,
      regime: 'bullish',
      requiredSamples: MIN_ENTRY_SIGNAL_PERSISTENCE_SAMPLES,
    });
    if (!persistentBullishRegime) {
      await persistTradeDecision(session, 'blocked', 'entry_token_regime_not_persistent');
      await persistLastTradeGate(session, {
        at: new Date().toISOString(),
        decision: 'blocked',
        reason: 'entry_token_regime_not_persistent',
        expectedEdgeBps: tokenEntrySignal.momentumBps,
        estimatedCostBps: null,
        safetyBufferBps: strategyConfig.momentum.edgeSafetyBufferBps,
      });
      log(
        'info',
        session.id,
        `entry blocked: ${resolveTokenSymbol(selectedEntryMint)} momentum not persistent (${MIN_ENTRY_SIGNAL_PERSISTENCE_SAMPLES} samples required)`,
      );
      return;
    }

    const appliesTrendingShapeGate = WORKER_TRENDING_ENTRY_SHAPE_GATE_ENABLED
      && selectedEntryMint !== SOL_MINT
      && !TRUSTED_ENTRY_UNIVERSE_MINT_SET.has(selectedEntryMint);
    if (appliesTrendingShapeGate) {
      const shapeGate = computeTrendingEntryShapeGate({
        enabled: true,
        prices: getMomentumTapeForMint(selectedEntryMint).map((sample) => sample.usdPrice),
        minSamples: WORKER_TRENDING_ENTRY_SHAPE_MIN_SAMPLES,
        chaseLookbackSamples: WORKER_TRENDING_ENTRY_CHASE_LOOKBACK_SAMPLES,
        maxRecentSurgeBps: WORKER_TRENDING_ENTRY_MAX_RECENT_SURGE_BPS,
        minPullbackFromHighBps: WORKER_TRENDING_ENTRY_MIN_PULLBACK_BPS,
        minReclaimFromLowBps: WORKER_TRENDING_ENTRY_MIN_RECLAIM_BPS,
        maxRangePositionBps: WORKER_TRENDING_ENTRY_MAX_RANGE_POSITION_BPS,
        maxNegativeWindowMomentumBps: WORKER_TRENDING_ENTRY_MAX_NEGATIVE_WINDOW_BPS,
      });

      if (!shapeGate.allowed) {
        await persistTradeDecision(session, 'blocked', shapeGate.reason);
        await persistLastTradeGate(session, {
          at: new Date().toISOString(),
          decision: 'blocked',
          reason: shapeGate.reason,
          expectedEdgeBps: tokenEntrySignal.momentumBps,
          estimatedCostBps: shapeGate.metrics?.recentSurgeBps ?? null,
          safetyBufferBps: strategyConfig.momentum.edgeSafetyBufferBps,
        });
        log(
          'info',
          session.id,
          `entry blocked: trending shape gate for ${resolveTokenSymbol(selectedEntryMint)} (${selectedEntryMint}) reason=${shapeGate.reason} samples=${shapeGate.metrics?.sampleCount ?? 'n/a'} window=${shapeGate.metrics?.windowMomentumBps ?? 'n/a'}bps surge=${shapeGate.metrics?.recentSurgeBps ?? 'n/a'}bps pullback=${shapeGate.metrics?.pullbackFromHighBps ?? 'n/a'}bps reclaim=${shapeGate.metrics?.reclaimFromLowBps ?? 'n/a'}bps rangePos=${shapeGate.metrics?.rangePositionBps ?? 'n/a'}bps`,
        );
        return;
      }
    }

    entryInventory.outputMint = selectedEntryMint;
    entryInventory.outputSymbol = resolveTokenSymbol(selectedEntryMint);

    const volatilitySizing = applyVolatilityEntrySizing({
      mint: selectedEntryMint,
      inventory: entryInventory,
    });

    if (volatilitySizing.blocked) {
      await persistTradeDecision(session, 'blocked', volatilitySizing.reason ?? 'volatility_sizing_blocked');
      await persistLastTradeGate(session, {
        at: new Date().toISOString(),
        decision: 'blocked',
        reason: volatilitySizing.reason ?? 'volatility_sizing_blocked',
        expectedEdgeBps: tokenEntrySignal.momentumBps,
        estimatedCostBps: volatilitySizing.volatilityBps,
        safetyBufferBps: strategyConfig.momentum.edgeSafetyBufferBps,
      });
      try {
        await persistLastSizing(session, {
          at: new Date().toISOString(),
          decision: 'skipped',
          reason: volatilitySizing.reason,
          balanceLamports: String(balance),
          reserveLamports: String(MIN_SOL_OPERATING_RESERVE_LAMPORTS),
          tradableLamports: String(Math.max(0, balance - MIN_SOL_OPERATING_RESERVE_LAMPORTS)),
          fractionBps: volatilitySizing.sizeScaleBps,
          targetLamports: String(entryInventory.targetAtomic),
          minTradeLamports: String(entryInventory.minTradeAtomic),
          maxTradeLamports: String(entryInventory.maxTradeAtomic),
          amountLamports: null,
          remainingRiskBudgetUsd: null,
          quotedOutAmountAtomic: null,
          minimumOutputAtomic: null,
          priceImpactPct: null,
          estimatedNetworkCostLamports: null,
          estimatedNetworkCostOutputAtomic: null,
          worstCaseSlippageOutputAtomic: null,
          totalWorstCaseCostOutputAtomic: null,
          riskAdjustedAmountLamports: volatilitySizing.adjustedAmountAtomic !== null ? String(volatilitySizing.adjustedAmountAtomic) : null,
          tradeContext: buildSizingTradeContext(entryInventory),
        });
      } catch (err) {
        log('warn', session.id, `failed to persist lastSizing: ${String(err)}`);
      }
      log(
        'info',
        session.id,
        `entry blocked: volatility sizing below minimum for ${entryInventory.outputSymbol} vol=${volatilitySizing.volatilityBps}bps scale=${volatilitySizing.sizeScaleBps}bps adjusted=${volatilitySizing.adjustedAmountAtomic}`,
      );
      return;
    }

    if (
      volatilitySizing.adjustedAmountAtomic !== null
      && volatilitySizing.adjustedAmountAtomic > 0
      && volatilitySizing.adjustedAmountAtomic < (entryInventory.amountAtomic ?? 0)
    ) {
      const originalAmount = entryInventory.amountAtomic ?? 0;
      entryInventory.amountAtomic = volatilitySizing.adjustedAmountAtomic;
      entryInventory.riskAdjustedAmountAtomic = volatilitySizing.adjustedAmountAtomic;
      log(
        'info',
        session.id,
        `entry size reduced by volatility: ${entryInventory.outputSymbol} amount ${originalAmount} â†’ ${volatilitySizing.adjustedAmountAtomic} scale=${volatilitySizing.sizeScaleBps}bps vol=${volatilitySizing.volatilityBps}bps`,
      );
    }

    const classSizing = computeClassEntrySizing({
      mint: selectedEntryMint,
      symbol: entryInventory.outputSymbol,
      inventory: entryInventory,
    });
    const classSizingActive = isCanaryShadowEnabled(session, WORKER_CLASS_ENTRY_SIZING_ENABLED);
    if (classSizing.multiplierBps !== 10_000) {
      log(
        'info',
        session.id,
        `class-sizing ${classSizingActive ? 'apply' : 'shadow'}: ${entryInventory.outputSymbol} class=${classSizing.tokenClass} mult=${(classSizing.multiplierBps / 10_000).toFixed(2)}x base=${classSizing.baseAmountAtomic} would=${classSizing.adjustedAmountAtomic}${classSizing.belowMinTrade ? ' (below_min_trade=kept_base)' : ''}`,
      );
    }
    if (
      classSizingActive
      && classSizing.multiplierBps !== 10_000
      && !classSizing.belowMinTrade
      && classSizing.adjustedAmountAtomic > 0
      && classSizing.adjustedAmountAtomic < (entryInventory.amountAtomic ?? 0)
    ) {
      const preClassAmount = entryInventory.amountAtomic ?? 0;
      entryInventory.amountAtomic = classSizing.adjustedAmountAtomic;
      entryInventory.riskAdjustedAmountAtomic = classSizing.adjustedAmountAtomic;
      log(
        'info',
        session.id,
        `entry size adjusted by class: ${entryInventory.outputSymbol} class=${classSizing.tokenClass} amount ${preClassAmount} -> ${classSizing.adjustedAmountAtomic} mult=${(classSizing.multiplierBps / 10_000).toFixed(2)}x`,
      );
    }

    const routeStability = await assessEntryRouteStability({
      inputMint: entryInventory.inputMint,
      outputMint: entryInventory.outputMint,
      amountAtomic: entryInventory.amountAtomic ?? 0,
      takerWallet: session.session_wallet,
      slippageBps: session.risk_limits.maxSlippageBps,
    });

    if (!routeStability.stable) {
      recordEntryRejectCooldown(session, selectedEntryMint, routeStability.reason);
      await persistTradeDecision(session, 'blocked', routeStability.reason);
      await persistLastTradeGate(session, {
        at: new Date().toISOString(),
        decision: 'blocked',
        reason: routeStability.reason,
        expectedEdgeBps: tokenEntrySignal.momentumBps,
        estimatedCostBps: routeStability.maxPriceImpactBps,
        safetyBufferBps: strategyConfig.momentum.edgeSafetyBufferBps,
      });
      log(
        'info',
        session.id,
        `entry blocked: route unstable for ${entryInventory.outputSymbol} reason=${routeStability.reason} samples=${routeStability.sampleCount} outDrift=${routeStability.outputDriftBps ?? 'n/a'}bps impactDrift=${routeStability.impactDriftBps ?? 'n/a'}bps maxImpact=${routeStability.maxPriceImpactBps ?? 'n/a'}bps`,
      );
      return;
    }

    positionsState = await persistPositionsState(session, {
      activePositionMint: selectedEntryMint,
      positions: positionsState.positions,
    });
    positionState = summarizePositionsState(positionsState, session.service_control.positionState ?? undefined);

      tradePlan = {
        direction: 'enter_long',
        inventory: entryInventory,
        exitReason: null,
        signalSnapshot: tokenEntrySignal,
        scannerStrategy: entryStrategyForPlan,
        entryStrategy: entryStrategyForPlan,
        exitStrategy: null,
      };
    }
  }

  if (!tradePlan) {
    return;
  }

  const remainingRiskBudgetUsd = Math.max(
    0,
    session.risk_limits.maxSessionLossUsd - Math.abs(Math.min(0, session.funding.realizedPnlUsd)),
  );
  const baseTradeAmount = tradePlan.inventory.amountAtomic ?? 0;
  let tradeAmount = baseTradeAmount;
  let prepare: { ok: boolean; status: number; data: PrepareResponse } | null = null;
  let economics: PreparedTradeEconomics | null = null;
  let tradeGate: TradeGateAssessment | null = null;
  let sizingReason: string | null = null;
  let observedPriceImpactBps: number | null = null;
  const forceExitExecution = shouldForceExitExecution(tradePlan.direction, tradePlan.exitReason);

  const prePrepareEntryGate = computePrePrepareEntryGate({
    direction: tradePlan.direction,
    signalMomentumBps: tradePlan.signalSnapshot.momentumBps,
    signalThresholdBps: tradePlan.signalSnapshot.strategy === 'momentum'
      ? Math.max(
        Number(tradePlan.signalSnapshot.thresholdBps ?? 0),
        strategyConfig.momentum.thresholdBps,
      )
      : 0,
    safetyBufferBps: strategyConfig.momentum.edgeSafetyBufferBps,
  });

  if (tradePlan.direction === 'enter_long') {
    log(
      'info',
      session.id,
      `pre-prepare entry gate v3: sourceRev=${WORKER_SOURCE_REV} momentumBps=${tradePlan.signalSnapshot.momentumBps ?? 'null'} signalThresholdBps=${tradePlan.signalSnapshot.thresholdBps ?? 'null'} configThresholdBps=${strategyConfig.momentum.thresholdBps} safetyBufferBps=${strategyConfig.momentum.edgeSafetyBufferBps} blocked=${prePrepareEntryGate ? 'true' : 'false'}`,
    );
  }

  if (prePrepareEntryGate && !prePrepareEntryGate.allowed) {
    recordTradePlanEntryRejectCooldown(session, tradePlan, prePrepareEntryGate.reason);
    await persistTradeDecision(session, 'blocked', prePrepareEntryGate.reason);
    await persistLastTradeGate(session, {
      at: new Date().toISOString(),
      decision: 'blocked',
      reason: prePrepareEntryGate.reason,
      expectedEdgeBps: prePrepareEntryGate.expectedEdgeBps,
      estimatedCostBps: prePrepareEntryGate.estimatedCostBps,
      safetyBufferBps: prePrepareEntryGate.safetyBufferBps,
    });
    try {
      await persistLastSizing(session, {
        at: new Date().toISOString(),
        decision: 'skipped',
        reason: prePrepareEntryGate.reason,
        balanceLamports: String(balance),
        reserveLamports: String(positionState.status === 'flat' ? MIN_SOL_OPERATING_RESERVE_LAMPORTS : tradePlan.inventory.reserveAtomic),
        tradableLamports: String(positionState.status === 'flat' ? Math.max(0, balance - MIN_SOL_OPERATING_RESERVE_LAMPORTS) : tradePlan.inventory.tradableAtomic),
        fractionBps: tradePlan.direction === 'enter_long' || tradePlan.direction === 'exit_long' ? 10000 : sizingPolicy.tradeFractionBps,
        targetLamports: String(positionState.status === 'flat' ? 0 : tradePlan.inventory.targetAtomic),
        minTradeLamports: String(positionState.status === 'flat' ? 0 : tradePlan.inventory.minTradeAtomic),
        maxTradeLamports: String(positionState.status === 'flat' ? 0 : tradePlan.inventory.maxTradeAtomic),
        amountLamports: null,
        remainingRiskBudgetUsd,
        quotedOutAmountAtomic: null,
        minimumOutputAtomic: null,
        priceImpactPct: null,
        estimatedNetworkCostLamports: null,
        estimatedNetworkCostOutputAtomic: null,
        worstCaseSlippageOutputAtomic: null,
        totalWorstCaseCostOutputAtomic: null,
        riskAdjustedAmountLamports: null,
        tradeContext: buildSizingTradeContext(tradePlan.inventory),
      });
    } catch (err) {
      log('warn', session.id, `failed to persist lastSizing: ${String(err)}`);
    }
    log(
      'info',
      session.id,
      `pre-prepare trade gate blocked v3 (${prePrepareEntryGate.reason}): sourceRev=${WORKER_SOURCE_REV} expectedEdgeBps=${prePrepareEntryGate.expectedEdgeBps} estimatedCostBps=${prePrepareEntryGate.estimatedCostBps} safetyBufferBps=${prePrepareEntryGate.safetyBufferBps}`,
    );
    return;
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    log(
      'info',
      session.id,
      `preparing swap: ${tradeAmount} ${tradePlan.inventory.inputSymbol} atomic ${tradePlan.inventory.inputSymbol} â†’ ${tradePlan.inventory.outputSymbol} (tradable=${tradePlan.inventory.tradableAtomic} fraction=${tradePlan.direction === 'enter_long' ? 10000 : sizingPolicy.tradeFractionBps}bps attempt=${attempt})`,
    );

    prepare = await apiPost<PrepareResponse>('/jupiter/swap/prepare', {
      inputMint:      tradePlan.inventory.inputMint,
      outputMint:     tradePlan.inventory.outputMint,
      amount:         String(tradeAmount),
      taker:          session.session_wallet,
      feeTokenSymbol: tradePlan.inventory.inputMint === USDC_MINT || tradePlan.inventory.outputMint === USDC_MINT ? 'USDC' : 'SOL',
      slippageBps:    String(session.risk_limits.maxSlippageBps),
      scannerStrategy: tradePlan.scannerStrategy,
      entryStrategy:   tradePlan.entryStrategy ?? undefined,
      exitStrategy:    tradePlan.exitStrategy ?? undefined,
      exitReason:      tradePlan.exitReason ?? undefined,
    });
    // USDC-base entries/exits capture platform fees in the USDC fee account; stop liquidation still uses SOL.

    if (!prepare.ok || !prepare.data.preparedTransactionBase64 || !prepare.data.executionId) {
      break;
    }

    if (prepare.data.simulation?.err) {
      break;
    }

    // Post-exit SOL reserve protection only applies when the INPUT being sold is
    // SOL: trimming the SOL amount sold is what preserves gas. For a token->USDC
    // exit, gas is paid separately in SOL and the position must fully liquidate,
    // so trimming the token amount does nothing for the SOL reserve (it only
    // strands the position). Worse, the API's estimatedNetworkCostLamports bakes
    // in worst-case new-account (ATA) rent (~2.04M lamports) even when the output
    // token account already exists, producing a false "reserve shortfall" that
    // cancel-retries forever and traps the position. Let on-chain simulation be
    // the real affordability arbiter for token exits instead of pre-cancelling.
    if (shouldApplyPostExitSolReserveProtection({
      direction: tradePlan.direction,
      inputMint: tradePlan.inventory.inputMint,
      solMint: SOL_MINT,
    })) {
      const setupReserveLamports = Math.max(
        0,
        tradePlan.inventory.reserveAtomic - MIN_SOL_OPERATING_RESERVE_LAMPORTS,
      );
      const estimatedNetworkCostLamports = prepare.data.costs?.estimatedNetworkCostLamports ?? 0;
      const inputLamportsSpent = tradePlan.inventory.inputMint === SOL_MINT ? tradeAmount : 0;
      const expectedPostExitLamports =
        balance - inputLamportsSpent - setupReserveLamports - estimatedNetworkCostLamports;
      const reserveShortfallLamports = Math.max(
        0,
        MIN_SOL_OPERATING_RESERVE_LAMPORTS - expectedPostExitLamports,
      );

      if (reserveShortfallLamports > 0) {
        const adjustedAmount = tradeAmount - reserveShortfallLamports;

        if (adjustedAmount < sizingPolicy.minTradeLamports || adjustedAmount <= 0) {
          sizingReason = 'post_exit_reserve_shortfall';
          break;
        }

        tradeAmount = adjustedAmount;
        tradePlan.inventory.amountAtomic = adjustedAmount;
        tradePlan.inventory.riskAdjustedAmountAtomic = adjustedAmount;
        sizingReason = 'post_exit_reserve_shortfall';
        // Cancel the execution we just prepared before re-preparing with the
        // reduced amount. The API enforces a single in-flight execution per
        // taker, so skipping this leaves an orphaned `prepared` row that blocks
        // every future cycle with `in_flight_execution`.
        if (prepare.data.executionId) {
          try {
            await apiPost(`/jupiter/swap/executions/${prepare.data.executionId}/cancel`, {
              stage: 'worker_cancel',
              reason: 'post_exit_reserve_shortfall_retry',
            });
          } catch (err) {
            log('warn', session.id, `cancel prepared execution before retry failed: ${String(err)}`);
          }
        }
        continue;
      }
    }

    economics = buildTradeEconomics({
      tradeAmountAtomic: tradeAmount,
      inputMint: tradePlan.inventory.inputMint,
      outputMint: tradePlan.inventory.outputMint,
      remainingRiskBudgetUsd,
      quote: prepare.data.quote,
      costs: prepare.data.costs,
    });

    if (!economics) {
      break;
    }

    observedPriceImpactBps = parseQuotePriceImpactBps(economics.priceImpactPct);
    if (
      !forceExitExecution
      && observedPriceImpactBps !== null
      && observedPriceImpactBps > MAX_QUOTE_PRICE_IMPACT_BPS
    ) {
      sizingReason = 'price_impact_too_high';
      break;
    }

    tradeGate = resolveTradeGateAssessment({
      direction: tradePlan.direction,
      exitReason: tradePlan.exitReason,
      assessment: assessTradeGate({
      direction: tradePlan.direction,
      signalSnapshot: tradePlan.signalSnapshot,
      economics,
      confidenceBps: lastPythSolSample?.confidenceBps ?? signalPolicy.maxPythConfidenceBps,
      driftBps: getLatestObservedDriftBps(),
      safetyBufferBps: strategyConfig.momentum.edgeSafetyBufferBps,
      entryCostCapBps: MAX_QUOTE_PRICE_IMPACT_BPS,
      }),
    });

    if (!tradeGate.allowed) {
      sizingReason = tradeGate.reason;
      break;
    }

    if (!forceExitExecution && !economics.economicallyViable) {
      sizingReason = 'not_economically_viable';
      break;
    }

    if (forceExitExecution || economics.withinRiskBudget) {
      if (tradeAmount !== baseTradeAmount) {
        sizingReason = 'risk_budget_capped';
      }
      break;
    }

    const adjustedAmount = economics.riskAdjustedAmountLamports;
    if (
      !adjustedAmount
      || adjustedAmount < sizingPolicy.minTradeLamports
      || adjustedAmount >= tradeAmount
    ) {
      sizingReason = 'risk_budget_exhausted';
      break;
    }

    tradeAmount = Math.min(sizingPolicy.maxTradeLamports, adjustedAmount);
    tradePlan.inventory.amountAtomic = tradeAmount;
    tradePlan.inventory.riskAdjustedAmountAtomic = tradeAmount;
    sizingReason = 'risk_budget_capped';
  }

  if (!forceExitExecution && economics && (!economics.economicallyViable || !economics.withinRiskBudget)) {
    recordTradePlanEntryRejectCooldown(session, tradePlan, sizingReason ?? 'economics_blocked');
    await persistTradeDecision(session, 'blocked', sizingReason ?? 'economics_blocked');
    await persistLastTradeGate(session, {
      at: new Date().toISOString(),
      decision: 'blocked',
      reason: sizingReason ?? 'economics_blocked',
      expectedEdgeBps: tradeGate?.expectedEdgeBps ?? runtimeSignal.momentumBps ?? null,
      estimatedCostBps: tradeGate?.estimatedCostBps ?? null,
      safetyBufferBps: tradeGate?.safetyBufferBps ?? strategyConfig.momentum.edgeSafetyBufferBps,
    });
    try {
      await persistLastSizing(session, {
        at: new Date().toISOString(),
        decision: 'skipped',
        reason: sizingReason,
        balanceLamports: String(balance),
        reserveLamports: String(positionState.status === 'flat' ? MIN_SOL_OPERATING_RESERVE_LAMPORTS : tradePlan.inventory.reserveAtomic),
        tradableLamports: String(positionState.status === 'flat' ? Math.max(0, balance - MIN_SOL_OPERATING_RESERVE_LAMPORTS) : tradePlan.inventory.tradableAtomic),
        fractionBps: tradePlan.direction === 'enter_long' || tradePlan.direction === 'exit_long' ? 10000 : sizingPolicy.tradeFractionBps,
        targetLamports: String(positionState.status === 'flat' ? 0 : tradePlan.inventory.targetAtomic),
        minTradeLamports: String(positionState.status === 'flat' ? 0 : tradePlan.inventory.minTradeAtomic),
        maxTradeLamports: String(positionState.status === 'flat' ? 0 : tradePlan.inventory.maxTradeAtomic),
        amountLamports: null,
        remainingRiskBudgetUsd: economics.remainingRiskBudgetUsd,
        quotedOutAmountAtomic: String(economics.quotedOutAmountAtomic),
        minimumOutputAtomic: String(economics.minimumOutputAtomic),
        priceImpactPct: economics.priceImpactPct,
        estimatedNetworkCostLamports: String(economics.estimatedNetworkCostLamports),
        estimatedNetworkCostOutputAtomic: String(economics.estimatedNetworkCostOutputAtomic),
        worstCaseSlippageOutputAtomic: String(economics.worstCaseSlippageOutputAtomic),
        totalWorstCaseCostOutputAtomic: String(economics.totalWorstCaseCostOutputAtomic),
        riskAdjustedAmountLamports: economics.riskAdjustedAmountLamports !== null
          ? String(economics.riskAdjustedAmountLamports)
          : null,
        tradeContext: buildSizingTradeContext(tradePlan.inventory),
      });
    } catch (err) {
      log('warn', session.id, `failed to persist lastSizing: ${String(err)}`);
    }

    log(
      'info',
      session.id,
      `sizing skip (${sizingReason}): amount=${tradeAmount} out=${economics.quotedOutAmountAtomic} minOut=${economics.minimumOutputAtomic} networkLamports=${economics.estimatedNetworkCostLamports} worstCaseAtomic=${economics.totalWorstCaseCostOutputAtomic} remainingRiskUsd=${economics.remainingRiskBudgetUsd.toFixed(4)}`,
    );
    if (prepare?.data?.executionId) {
      try {
        await apiPost(`/jupiter/swap/executions/${prepare.data.executionId}/cancel`, {
          stage: 'worker_cancel',
          reason: sizingReason ?? 'economics_blocked',
        });
      } catch (err) {
        log('warn', session.id, `cancel prepared execution failed: ${String(err)}`);
      }
    }
    return;
  }

  if (tradeGate && !tradeGate.allowed) {
    recordTradePlanEntryRejectCooldown(session, tradePlan, tradeGate.reason);
    await persistTradeDecision(session, 'blocked', tradeGate.reason);
    await persistLastTradeGate(session, {
      at: new Date().toISOString(),
      decision: 'blocked',
      reason: tradeGate.reason,
      expectedEdgeBps: tradeGate.expectedEdgeBps,
      estimatedCostBps: tradeGate.estimatedCostBps,
      safetyBufferBps: tradeGate.safetyBufferBps,
    });
    try {
      await persistLastSizing(session, {
        at: new Date().toISOString(),
        decision: 'skipped',
        reason: tradeGate.reason,
        balanceLamports: String(balance),
        reserveLamports: String(positionState.status === 'flat' ? MIN_SOL_OPERATING_RESERVE_LAMPORTS : tradePlan.inventory.reserveAtomic),
        tradableLamports: String(positionState.status === 'flat' ? Math.max(0, balance - MIN_SOL_OPERATING_RESERVE_LAMPORTS) : tradePlan.inventory.tradableAtomic),
        fractionBps: tradePlan.direction === 'enter_long' || tradePlan.direction === 'exit_long' ? 10000 : sizingPolicy.tradeFractionBps,
        targetLamports: String(positionState.status === 'flat' ? 0 : tradePlan.inventory.targetAtomic),
        minTradeLamports: String(positionState.status === 'flat' ? 0 : tradePlan.inventory.minTradeAtomic),
        maxTradeLamports: String(positionState.status === 'flat' ? 0 : tradePlan.inventory.maxTradeAtomic),
        amountLamports: null,
        remainingRiskBudgetUsd: economics?.remainingRiskBudgetUsd ?? remainingRiskBudgetUsd,
        quotedOutAmountAtomic: economics ? String(economics.quotedOutAmountAtomic) : null,
        minimumOutputAtomic: economics ? String(economics.minimumOutputAtomic) : null,
        priceImpactPct: economics?.priceImpactPct ?? null,
        estimatedNetworkCostLamports: economics ? String(economics.estimatedNetworkCostLamports) : null,
        estimatedNetworkCostOutputAtomic: economics ? String(economics.estimatedNetworkCostOutputAtomic) : null,
        worstCaseSlippageOutputAtomic: economics ? String(economics.worstCaseSlippageOutputAtomic) : null,
        totalWorstCaseCostOutputAtomic: economics ? String(economics.totalWorstCaseCostOutputAtomic) : null,
        riskAdjustedAmountLamports: null,
        tradeContext: buildSizingTradeContext(tradePlan.inventory),
      });
    } catch (err) {
      log('warn', session.id, `failed to persist lastSizing: ${String(err)}`);
    }
    log(
      'info',
      session.id,
      `trade gate blocked (${tradeGate.reason}): expectedEdgeBps=${tradeGate.expectedEdgeBps} estimatedCostBps=${tradeGate.estimatedCostBps} safetyBufferBps=${tradeGate.safetyBufferBps}`,
    );
    if (prepare?.data?.executionId) {
      try {
        await apiPost(`/jupiter/swap/executions/${prepare.data.executionId}/cancel`, {
          stage: 'worker_cancel',
          reason: tradeGate.reason,
        });
      } catch (err) {
        log('warn', session.id, `cancel prepared execution failed: ${String(err)}`);
      }
    }
    return;
  }

  if (sizingReason === 'price_impact_too_high') {
    recordTradePlanEntryRejectCooldown(session, tradePlan, sizingReason);
    await persistTradeDecision(session, 'blocked', sizingReason);
    await persistLastTradeGate(session, {
      at: new Date().toISOString(),
      decision: 'blocked',
      reason: sizingReason,
      expectedEdgeBps: tradeGate?.expectedEdgeBps ?? runtimeSignal.momentumBps ?? null,
      estimatedCostBps: tradeGate?.estimatedCostBps ?? null,
      safetyBufferBps: tradeGate?.safetyBufferBps ?? strategyConfig.momentum.edgeSafetyBufferBps,
    });

    log(
      'info',
      session.id,
      `trade gate blocked (${sizingReason}): quoteImpactBps=${observedPriceImpactBps} maxAllowedBps=${MAX_QUOTE_PRICE_IMPACT_BPS}`,
    );

    if (prepare?.data?.executionId) {
      try {
        await apiPost(`/jupiter/swap/executions/${prepare.data.executionId}/cancel`, {
          stage: 'worker_cancel',
          reason: sizingReason,
        });
      } catch (err) {
        log('warn', session.id, `cancel prepared execution failed: ${String(err)}`);
      }
    }
    return;
  }

  if (!prepare) {
    throw new Error('trade preparation did not run');
  }

  if (!prepare.ok || !prepare.data.preparedTransactionBase64 || !prepare.data.executionId) {
    await persistTradeDecision(session, 'blocked', 'prepare_failed');
    log('warn', session.id, `prepare failed (${prepare.status}): ${prepare.data.error ?? JSON.stringify(prepare.data)}`);
    if (prepare.data.shortfall) {
      await releaseTradeWindowReservation(session);
      await persistTradeDecision(session, 'blocked', 'route_setup_shortfall');
      await persistLastTradeGate(session, {
        at: new Date().toISOString(),
        decision: 'blocked',
        reason: 'route_setup_shortfall',
        expectedEdgeBps: tradeGate?.expectedEdgeBps ?? runtimeSignal.momentumBps ?? null,
        estimatedCostBps: tradeGate?.estimatedCostBps ?? null,
        safetyBufferBps: tradeGate?.safetyBufferBps ?? strategyConfig.momentum.edgeSafetyBufferBps,
      });
      log(
        'info',
        session.id,
        `route setup shortfall: have ${prepare.data.shortfall.availableLamports}, need ${prepare.data.shortfall.requiredLamports} (gap ${prepare.data.shortfall.gapLamports}) â†’ blocked; preserving session funds`,
      );
      return;
    }
    const freshBal = await rlGetBalance(keypair.publicKey).catch(() => 0);
    if (openPositions.length === 0 && freshBal < minimumRequiredLamports) {
      await setSessionStatus(session.id, 'stopping', { stop_reason: 'depleted' }, { expectedStatuses: ['active'] });
      log('info', session.id, `balance ${freshBal} lamports after prepare failure â†’ stopping (sweep will run)`);
    } else {
      const fails = (consecutiveSimFailures.get(session.id) ?? 0) + 1;
      consecutiveSimFailures.set(session.id, fails);
      if (fails >= 3) {
        await setSessionStatus(session.id, 'stopping', { stop_reason: 'repeated_simulation_failures' }, { expectedStatuses: ['active'] });
        log('warn', session.id, `${fails} consecutive prepare failures â†’ stopping`);
      }
    }
    return;
  }

  if (prepare.data.simulation?.err) {
    await persistTradeDecision(session, 'blocked', 'simulation_error');
    log('warn', session.id, `simulation error: ${JSON.stringify(prepare.data.simulation.err)}`);
    if (prepare.data.shortfall) {
      await releaseTradeWindowReservation(session);
      await persistTradeDecision(session, 'blocked', 'route_setup_shortfall');
      await persistLastTradeGate(session, {
        at: new Date().toISOString(),
        decision: 'blocked',
        reason: 'route_setup_shortfall',
        expectedEdgeBps: tradeGate?.expectedEdgeBps ?? runtimeSignal.momentumBps ?? null,
        estimatedCostBps: tradeGate?.estimatedCostBps ?? null,
        safetyBufferBps: tradeGate?.safetyBufferBps ?? strategyConfig.momentum.edgeSafetyBufferBps,
      });
      log(
        'info',
        session.id,
        `simulation exposed route shortfall: have ${prepare.data.shortfall.availableLamports}, need ${prepare.data.shortfall.requiredLamports} (gap ${prepare.data.shortfall.gapLamports}) â†’ blocked; preserving session funds` ,
      );
      return;
    }
    const freshBal = await rlGetBalance(keypair.publicKey).catch(() => 0);
    if (openPositions.length === 0 && freshBal < minimumRequiredLamports) {
      await setSessionStatus(session.id, 'stopping', { stop_reason: 'depleted' }, { expectedStatuses: ['active'] });
      log('info', session.id, `balance ${freshBal} lamports after simulation error â†’ stopping (sweep will run)`);
    } else {
      const fails = (consecutiveSimFailures.get(session.id) ?? 0) + 1;
      consecutiveSimFailures.set(session.id, fails);
      if (fails >= 3) {
        await setSessionStatus(session.id, 'stopping', { stop_reason: 'repeated_simulation_failures' }, { expectedStatuses: ['active'] });
        log('warn', session.id, `${fails} consecutive simulation failures â†’ stopping`);
      }
    }
    return;
  }

  try {
    if (tradeGate) {
      await persistLastTradeGate(session, {
        at: new Date().toISOString(),
        decision: 'allowed',
        reason: tradeGate.reason,
        expectedEdgeBps: tradeGate.expectedEdgeBps,
        estimatedCostBps: tradeGate.estimatedCostBps,
        safetyBufferBps: tradeGate.safetyBufferBps,
      });
    }
    await persistLastSizing(session, {
      at: new Date().toISOString(),
      decision: 'traded',
      reason: sizingReason,
      balanceLamports: String(balance),
      reserveLamports: String(positionState.status === 'flat' ? MIN_SOL_OPERATING_RESERVE_LAMPORTS : tradePlan.inventory.reserveAtomic),
      tradableLamports: String(positionState.status === 'flat' ? Math.max(0, balance - MIN_SOL_OPERATING_RESERVE_LAMPORTS) : tradePlan.inventory.tradableAtomic),
      fractionBps: tradePlan.direction === 'enter_long' || tradePlan.direction === 'exit_long' ? 10000 : sizingPolicy.tradeFractionBps,
      targetLamports: String(positionState.status === 'flat' ? 0 : tradePlan.inventory.targetAtomic),
      minTradeLamports: String(positionState.status === 'flat' ? 0 : tradePlan.inventory.minTradeAtomic),
      maxTradeLamports: String(positionState.status === 'flat' ? 0 : tradePlan.inventory.maxTradeAtomic),
      amountLamports: isLongPositionStatus(positionState.status) ? String(tradeAmount) : null,
      remainingRiskBudgetUsd: economics?.remainingRiskBudgetUsd ?? remainingRiskBudgetUsd,
      quotedOutAmountAtomic: economics ? String(economics.quotedOutAmountAtomic) : null,
      minimumOutputAtomic: economics ? String(economics.minimumOutputAtomic) : null,
      priceImpactPct: economics?.priceImpactPct ?? null,
      estimatedNetworkCostLamports: economics ? String(economics.estimatedNetworkCostLamports) : null,
      estimatedNetworkCostOutputAtomic: economics ? String(economics.estimatedNetworkCostOutputAtomic) : null,
      worstCaseSlippageOutputAtomic: economics ? String(economics.worstCaseSlippageOutputAtomic) : null,
      totalWorstCaseCostOutputAtomic: economics ? String(economics.totalWorstCaseCostOutputAtomic) : null,
      riskAdjustedAmountLamports: isLongPositionStatus(positionState.status) && tradeAmount !== baseTradeAmount
        ? String(tradeAmount)
        : null,
      tradeContext: buildSizingTradeContext({
        ...tradePlan.inventory,
        amountAtomic: tradeAmount,
        riskAdjustedAmountAtomic: tradeAmount !== baseTradeAmount ? tradeAmount : null,
      }),
    });
  } catch (err) {
    log('warn', session.id, `failed to persist lastSizing: ${String(err)}`);
  }

  // Step 2: Sign the prepared transaction
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(
      Buffer.from(prepare.data.preparedTransactionBase64, 'base64'),
    );
    tx.sign([keypair]);
  } catch (err) {
    log('warn', session.id, `sign failed: ${String(err)}`);
    try {
      await apiPost(`/jupiter/swap/executions/${prepare.data.executionId}/cancel`, {
        stage: 'worker_cancel',
        reason: 'sign_failed',
      });
    } catch (cancelErr) {
      log('warn', session.id, `cancel prepared execution failed after sign error: ${String(cancelErr)}`);
    }
    return;
  }

  const signedBase64 = Buffer.from(tx.serialize()).toString('base64');

  // Step 3: Submit
  const submit = await apiPost<SubmitResponse>('/jupiter/swap/submit', {
    executionId:            prepare.data.executionId,
    signedTransactionBase64: signedBase64,
    blockhash:              prepare.data.blockhash,
    lastValidBlockHeight:   prepare.data.lastValidBlockHeight,
  });

  if (!submit.ok) {
    await persistTradeDecision(session, 'blocked', 'submit_failed');
    log('warn', session.id, `submit failed (${submit.status}): ${submit.data.error ?? JSON.stringify(submit.data)}`);
    const submitErrorText = submit.data.error ?? '';
    const submitBlockhashExpired = submit.status === 409 && /blockhash|expired/i.test(submitErrorText);

    if (submitBlockhashExpired) {
      await releaseTradeWindowReservation(session);
      log('info', session.id, 'submit blockhash expired â†’ released cooldown for immediate rebuild');
    }

    if (submit.data.shortfall) {
      await releaseTradeWindowReservation(session);
      await persistTradeDecision(session, 'blocked', 'route_setup_shortfall');
      await persistLastTradeGate(session, {
        at: new Date().toISOString(),
        decision: 'blocked',
        reason: 'route_setup_shortfall',
        expectedEdgeBps: tradeGate?.expectedEdgeBps ?? runtimeSignal.momentumBps ?? null,
        estimatedCostBps: tradeGate?.estimatedCostBps ?? null,
        safetyBufferBps: tradeGate?.safetyBufferBps ?? strategyConfig.momentum.edgeSafetyBufferBps,
      });
      log(
        'info',
        session.id,
        `submit exposed route shortfall: have ${submit.data.shortfall.availableLamports}, need ${submit.data.shortfall.requiredLamports} (gap ${submit.data.shortfall.gapLamports}) â†’ blocked; preserving session funds`,
      );
    }
    return;
  }

  log('info', session.id, `trade submitted â€” sig: ${submit.data.signature ?? 'pending'} status: ${submit.data.status}`);
  consecutiveSimFailures.delete(session.id);

  await persistTradeDecision(session, 'submitted', submit.data.status ?? 'submitted');

  if (tradePlan.direction === 'exit_long' && tradePlan.partialFractionBps != null) {
    try {
      const partialMint = tradePlan.inventory.inputMint;
      const existingPartialPosition = positionsState.positions[partialMint];
      if (existingPartialPosition) {
        positionsState = await persistPositionsState(session, {
          activePositionMint: positionsState.activePositionMint,
          positions: {
            ...positionsState.positions,
            [partialMint]: { ...existingPartialPosition, partialExitDone: true, pendingExitReason: null },
          },
        });
      }
      log('info', session.id, `partial-tp marked done: ${tradePlan.inventory.inputSymbol} fraction=${tradePlan.partialFractionBps}bps`);
    } catch (err) {
      log('warn', session.id, `failed to mark partial-tp done: ${String(err)}`);
    }
  }

  if (tradePlan.direction === 'enter_long') {
    const nextScannerStrategy = getNextStrategyInSequence(
      tradePlan.entryStrategy ?? tradePlan.scannerStrategy,
      enabledStrategies,
    );
    await persistServiceControl(session, {
      rotationState: {
        activeStrategy: nextScannerStrategy,
        queuedStrategy: nextScannerStrategy,
        rotationIntervalMinutes: session.service_control.rotationState?.rotationIntervalMinutes ?? DEFAULT_ROTATION_INTERVAL_MINUTES,
        lastRotatedAt: new Date().toISOString(),
        lockedUntil: null,
      },
    } as any);
    log('info', session.id, `strategy scanner advanced after entry: ${tradePlan.entryStrategy ?? tradePlan.scannerStrategy} → ${nextScannerStrategy}`);
  }

  await maybeMarkPendingExitProfitPayout(session, tradePlan, prepare.data.executionId);

  try {
    await persistSchedulingState(session, {
      lastTradeSubmittedAt: new Date().toISOString(),
    });
  } catch (err) {
    log('warn', session.id, `failed to persist trade submit timestamp: ${String(err)}`);
  }

  const postSubmitBalance = await rlGetBalance(keypair.publicKey).catch(() => balance - tradeAmount);
  // Keep the subscription-backed cache coherent with the post-trade balance immediately,
  // rather than waiting for the onAccountChange notification on the next cycle.
  setCachedSessionBalance(keypair.publicKey.toBase58(), postSubmitBalance);

  const postSubmitFundingBalanceAtomic = session.funding.fundingMint === USDC_MINT
    ? String(await getTokenBalanceAtomic(keypair.publicKey, USDC_MINT, TOKEN_PROGRAM_ID).catch(() => 0))
    : String(postSubmitBalance);

  // Update session funding (rough balance tracking — exact PnL will be reconciled later)
  await mergeFundingPatch(session, {
    currentBalanceAtomic: postSubmitFundingBalanceAtomic,
  });
};

// â”€â”€ Cooldown tracker â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const lastTradedAt = new Map<string, number>();
const consecutiveSimFailures = new Map<string, number>();
const sessionStatusPriority: Record<string, number> = {
  stopping: 0,
  awaiting_funding: 1,
  ready: 2,
  starting: 3,
  active: 4,
};

const getPersistedTradeAttemptMs = (session: RawSession): number => {
  const persisted = session.service_control.schedulingState?.lastTradeAttemptedAt;
  if (!persisted) return 0;
  const parsed = Date.parse(persisted);
  return Number.isFinite(parsed) ? parsed : 0;
};

const getLastTradeAttemptMs = (session: RawSession): number => {
  const inMemory = lastTradedAt.get(session.id);
  if (inMemory !== undefined) return inMemory;

  const persisted = getPersistedTradeAttemptMs(session);
  if (persisted > 0) {
    lastTradedAt.set(session.id, persisted);
  }
  return persisted;
};

const hasExceededTargetDuration = (session: RawSession): boolean => {
  const targetDurationMinutes = Number(session.user_control?.targetDurationMinutes);
  if (!Number.isFinite(targetDurationMinutes) || targetDurationMinutes < 1) return false;

  const startedAtMs = session.started_at?.getTime() ?? session.requested_at.getTime();
  return Date.now() - startedAtMs >= targetDurationMinutes * 60_000;
};

const getLastTradeSubmittedMs = (session: RawSession): number => {
  const submittedAt = session.service_control.schedulingState?.lastTradeSubmittedAt;
  if (!submittedAt) return 0;

  const parsed = Date.parse(submittedAt);
  return Number.isFinite(parsed) ? parsed : 0;
};

const persistSchedulingState = async (
  session: RawSession,
  schedulingStatePatch: Partial<NonNullable<Session['serviceControl']['schedulingState']>>,
) => {
  const latestSession = await getSessionById(session.id);
  const baseServiceControl = latestSession?.service_control ?? session.service_control;
  const baseSchedulingState = baseServiceControl.schedulingState;
  const schedulingState = {
    lastTradeAttemptedAt: baseSchedulingState?.lastTradeAttemptedAt ?? null,
    lastTradeSubmittedAt: baseSchedulingState?.lastTradeSubmittedAt ?? null,
    lastDecisionAt: baseSchedulingState?.lastDecisionAt ?? null,
    lastDecisionOutcome: baseSchedulingState?.lastDecisionOutcome ?? null,
    lastDecisionReason: baseSchedulingState?.lastDecisionReason ?? null,
    lastBlockedAt: baseSchedulingState?.lastBlockedAt ?? null,
    lastBlockedReason: baseSchedulingState?.lastBlockedReason ?? null,
    blockedReasonCounts: baseSchedulingState?.blockedReasonCounts ?? {},
    lastProfitTransferAt: baseSchedulingState?.lastProfitTransferAt ?? null,
    transferredProfitUsd: baseSchedulingState?.transferredProfitUsd ?? 0,
    pendingProfitPayout: baseSchedulingState?.pendingProfitPayout ?? null,
    recentStopLossLocks: baseSchedulingState?.recentStopLossLocks ?? {},
    ...schedulingStatePatch,
  };

  await mergeServiceControlPatch(session, { schedulingState });
};

// Returns the set of correlation-cluster ids currently locked from new entries
// because of a recent stop_loss. Expired locks are ignored.
const getActiveStopLossLockedClusters = (session: RawSession, nowMs: number): Set<string> => {
  const locks = session.service_control.schedulingState?.recentStopLossLocks ?? {};
  const active = new Set<string>();
  for (const [clusterId, expiryIso] of Object.entries(locks)) {
    const expiryMs = Date.parse(expiryIso);
    if (Number.isFinite(expiryMs) && expiryMs > nowMs) {
      active.add(clusterId);
    }
  }
  return active;
};

// Records a post-stop-loss cooldown lock for the stopped token's correlation
// cluster and prunes any expired locks so the map stays bounded.
const recordStopLossClusterLock = async (session: RawSession, mint: string, nowMs: number) => {
  if (WORKER_STOP_LOSS_LOCK_MS <= 0) {
    return;
  }
  const clusterId = getClusterForMint(mint);
  const existing = { ...(session.service_control.schedulingState?.recentStopLossLocks ?? {}) };
  for (const [key, expiryIso] of Object.entries(existing)) {
    const expiryMs = Date.parse(expiryIso);
    if (!(Number.isFinite(expiryMs) && expiryMs > nowMs)) {
      delete existing[key];
    }
  }
  existing[clusterId] = new Date(nowMs + WORKER_STOP_LOSS_LOCK_MS).toISOString();
  await persistSchedulingState(session, { recentStopLossLocks: existing });
};

const BLOCKED_REASON_COUNTER_LIMIT = 20;

const trimBlockedReasonCounts = (counts: Record<string, number>) => {
  const nextEntries = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, BLOCKED_REASON_COUNTER_LIMIT);

  return Object.fromEntries(nextEntries);
};

type SessionHealthPatch = NonNullable<SessionServiceControlPatch['healthState']>;

const marketWaitReasons = new Set([
  'flat_regime_routed_fallback_suppressed',
  'no_strategy_entry_signal',
  'universe_scout_no_bullish_candidate',
  'universe_scout_no_route',
  'entry_token_signal_not_bullish',
  'entry_token_regime_not_persistent',
]);

const gasDangerReasons = new Set([
  'insufficient_sol_fee_reserve',
  'route_setup_shortfall',
]);

const exitBlockedReasons = new Set([
  'prepare_failed',
  'simulation_error',
  'submit_failed',
  'post_exit_reserve_shortfall',
  'post_exit_reserve_shortfall_retry',
]);

const buildSessionHealthState = ({
  session,
  outcome,
  reason,
  blockedReasonCounts,
  updatedAt,
}: {
  session: RawSession;
  outcome: NonNullable<NonNullable<Session['serviceControl']['schedulingState']>['lastDecisionOutcome']>;
  reason: string | null;
  blockedReasonCounts: Record<string, number>;
  updatedAt: string;
}): SessionHealthPatch => {
  const blockerCount = reason ? (blockedReasonCounts[reason] ?? 0) : 0;
  const hasOpenPositions = listOpenPositions(getPositionsState(session)).length > 0;

  if (session.service_control.residualRecovery) {
    return {
      state: 'recovery_required',
      severity: 'error',
      reason: 'residual_recovery_required',
      detail: 'Session stopped with residual token account(s) that require fee-sponsored recovery.',
      updatedAt,
      blockerCount,
    };
  }

  if (session.status === 'stopping') {
    return { state: 'stopping', severity: 'warn', reason, detail: 'Stop requested; worker is unwinding and sweeping funds.', updatedAt, blockerCount };
  }

  if (session.status === 'stopped') {
    return { state: 'stopped', severity: 'info', reason, detail: 'Session is closed.', updatedAt, blockerCount };
  }

  if (outcome === 'error') {
    return { state: 'error', severity: 'error', reason, detail: 'Worker hit an execution/runtime error.', updatedAt, blockerCount };
  }

  if (outcome === 'stopped') {
    return { state: 'stopping', severity: 'warn', reason, detail: 'Worker requested session stop.', updatedAt, blockerCount };
  }

  if (outcome === 'submitted') {
    return { state: 'active_trading', severity: 'info', reason, detail: 'Trade submitted; awaiting reconciliation.', updatedAt, blockerCount };
  }

  if (outcome === 'attempted') {
    return { state: 'active_trading', severity: 'info', reason, detail: 'Worker is attempting a trade decision.', updatedAt, blockerCount };
  }

  if (reason && gasDangerReasons.has(reason)) {
    return {
      state: 'gas_danger',
      severity: 'error',
      reason,
      detail: 'Session fee reserve is too low for safe trading/exits. Entries are unsafe until gas is restored or session is stopped.',
      updatedAt,
      blockerCount,
    };
  }

  if (reason && (exitBlockedReasons.has(reason) || hasOpenPositions)) {
    return {
      state: 'exit_blocked',
      severity: blockerCount >= 3 ? 'error' : 'warn',
      reason,
      detail: 'Exit or execution path is blocked; user controls and recovery should stay prioritized over new entries.',
      updatedAt,
      blockerCount,
    };
  }

  if (reason && marketWaitReasons.has(reason)) {
    return {
      state: 'waiting_market',
      severity: blockerCount >= 50 ? 'warn' : 'info',
      reason,
      detail: 'Bot is intentionally not entering because market/signal conditions are not acceptable.',
      updatedAt,
      blockerCount,
    };
  }

  return {
    state: 'blocked',
    severity: blockerCount >= 20 ? 'error' : blockerCount >= 5 ? 'warn' : 'info',
    reason,
    detail: 'Worker is active but trading is blocked by a risk, queue, route, or provider condition.',
    updatedAt,
    blockerCount,
  };
};

const persistTradeDecision = async (
  session: RawSession,
  outcome: NonNullable<NonNullable<Session['serviceControl']['schedulingState']>['lastDecisionOutcome']>,
  reason: string | null,
) => {
  const nowIso = new Date().toISOString();

  if (outcome === 'blocked' && reason) {
    const latestSession = await getSessionById(session.id);
    const currentCounts = latestSession?.service_control?.schedulingState?.blockedReasonCounts ?? {};
    const nextCounts = trimBlockedReasonCounts({
      ...currentCounts,
      [reason]: (currentCounts[reason] ?? 0) + 1,
    });

    await persistSchedulingState(session, {
      lastDecisionAt: nowIso,
      lastDecisionOutcome: outcome,
      lastDecisionReason: reason,
      lastBlockedAt: nowIso,
      lastBlockedReason: reason,
      blockedReasonCounts: nextCounts,
    });
    await mergeServiceControlPatch(session, {
      healthState: buildSessionHealthState({ session, outcome, reason, blockedReasonCounts: nextCounts, updatedAt: nowIso }),
    });
    return;
  }

  const latestSession = await getSessionById(session.id);
  const currentCounts = latestSession?.service_control?.schedulingState?.blockedReasonCounts
    ?? session.service_control.schedulingState?.blockedReasonCounts
    ?? {};
  await persistSchedulingState(session, {
    lastDecisionAt: nowIso,
    lastDecisionOutcome: outcome,
    lastDecisionReason: reason,
  });
  await mergeServiceControlPatch(session, {
    healthState: buildSessionHealthState({ session, outcome, reason, blockedReasonCounts: currentCounts, updatedAt: nowIso }),
  });
};

const releaseTradeWindowReservation = async (session: RawSession) => {
  lastTradedAt.delete(session.id);

  try {
    await persistSchedulingState(session, {
      lastTradeAttemptedAt: null,
      lastTradeSubmittedAt: null,
    });
  } catch (err) {
    log('warn', session.id, `failed to release trade window reservation: ${String(err)}`);
  }
};

const persistLastSizing = async (
  session: RawSession,
  lastSizing: NonNullable<Session['serviceControl']['lastSizing']>,
) => {
  await mergeServiceControlPatch(session, { lastSizing });
};

const persistLastSignal = async (
  session: RawSession,
  lastSignal: NonNullable<Session['serviceControl']['lastSignal']>,
) => {
  await mergeServiceControlPatch(session, { lastSignal });
};

const persistLastTradeGate = async (
  session: RawSession,
  lastTradeGate: NonNullable<Session['serviceControl']['lastTradeGate']>,
) => {
  await mergeServiceControlPatch(session, { lastTradeGate });
};

const getPositionState = (session: RawSession): SessionPositionState =>
  summarizePositionsState(getPositionsState(session), session.service_control.positionState ?? undefined);

const buildStoppedPositionState = (
  positionState: SessionPositionState,
): SessionPositionState => buildFlatSessionPositionState({
  lastMarkedPriceUsd: positionState.lastMarkedPriceUsd,
  lastMarkedAt: positionState.lastMarkedAt,
  exitReason: positionState.pendingExitReason ?? positionState.exitReason,
});

const buildStoppedPositionsState = (): SessionPositionsState => ({
  activePositionMint: null,
  positions: {},
});

const nextSessionEvaluationAt = new Map<string, number>();
let lastCadenceTelemetryLogMs = 0;

const applyCadenceJitter = (delayMs: number): number => {
  const bounded = Math.max(MIN_LOOP_MS, delayMs);
  const jitter = Math.max(0, LOOP_JITTER_RATIO);
  if (jitter === 0) return bounded;

  const jitterFactor = 1 - jitter + (Math.random() * jitter * 2);
  return Math.max(MIN_LOOP_MS, Math.round(bounded * jitterFactor));
};

const getSessionCadenceMs = (session: RawSession): number => {
  const cadence = getLiveSpeedProfile().cadenceMs;
  switch (session.status) {
    case 'awaiting_funding':
      return FUNDING_POLL_FALLBACK_MS;
    case 'ready':
    case 'starting':
      return cadence.readyStarting;
    case 'stopping':
      return cadence.stopping;
    case 'active': {
      const lastSubmittedMs = getLastTradeSubmittedMs(session);
      if (lastSubmittedMs > 0 && (Date.now() - lastSubmittedMs) < POST_SUBMIT_RECONCILE_GRACE_MS) {
        return cadence.postSubmitFast;
      }

      const positionState = getPositionState(session);
      if (isLongPositionStatus(positionState.status)) {
        return cadence.activeInPosition;
      }

      const signalStatus = session.service_control.lastSignal?.status;
      if (signalStatus === 'guarded_off' || signalStatus === 'warming_up') {
        return cadence.activeGuarded;
      }

      return cadence.activeFlat;
    }
    default:
      return POLL_MS;
  }
};

const reserveTradeWindow = async (session: RawSession): Promise<boolean> => {
  const last = getLastTradeAttemptMs(session);
  const elapsed = Date.now() - last;
  if (elapsed < session.risk_limits.cooldownMs) return false;

  const now = Date.now();
  lastTradedAt.set(session.id, now);

  try {
    const nowIso = new Date(now).toISOString();
    await persistSchedulingState(session, {
      lastTradeAttemptedAt: nowIso,
      lastDecisionAt: nowIso,
      lastDecisionOutcome: 'attempted',
      lastDecisionReason: null,
    });
  } catch (err) {
    log('warn', session.id, `failed to persist scheduling state: ${String(err)}`);
  }

  return true;
};

const orderSessionsForTick = (sessions: RawSession[]): RawSession[] =>
  [...sessions].sort((a, b) => {
    const priorityDiff = (sessionStatusPriority[a.status] ?? 99) - (sessionStatusPriority[b.status] ?? 99);
    if (priorityDiff !== 0) return priorityDiff;

    if (a.status === 'active' && b.status === 'active') {
      const lastTradeDiff = getLastTradeAttemptMs(a) - getLastTradeAttemptMs(b);
      if (lastTradeDiff !== 0) return lastTradeDiff;
    }

    const requestedAtDiff = a.requested_at.getTime() - b.requested_at.getTime();
    if (requestedAtDiff !== 0) return requestedAtDiff;

    return a.id.localeCompare(b.id);
  });

const processExecutionQueue = async () => {
  const claimedItems = await claimExecutionQueueItems();
  if (claimedItems.length === 0) {
    return 0;
  }

  console.log(JSON.stringify({
    service: 'roguezero-worker',
    kind: 'execution_queue_claim',
    workerInstanceId: WORKER_INSTANCE_ID,
    count: claimedItems.length,
    ts: new Date().toISOString(),
  }));

  for (const item of claimedItems) {
    const session = await getSessionById(item.session_id);
    if (!session || session.status !== 'active') {
      await completeExecutionQueueItem(item.id);
      continue;
    }

    try {
      await executeTrade(session);
      await completeExecutionQueueItem(item.id);
    } catch (err) {
      log('error', item.session_id, `queued execution failed: ${String(err)}`);
      await failExecutionQueueItem(item.id, err);
    }
  }

  return claimedItems.length;
};

// â”€â”€ Sweep funds back to owner on session stop â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

type SessionTokenAccount = {
  address: PublicKey;
  programId: PublicKey;
  account: SplTokenAccount;
  mint: SplTokenMint;
};

type SweepResult = {
  solBalance: number;
  tokenProgramAccounts: string[];
  token2022Accounts: string[];
};

const SWEEP_SNAPSHOT_MAX_ATTEMPTS = 10;
const SWEEP_SNAPSHOT_WAIT_MS = 500;

const getSessionTokenAccounts = async (owner: PublicKey): Promise<SessionTokenAccount[]> => {
  const tokenPrograms = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
  const mintCache = new Map<string, SplTokenMint>();
  const accounts: SessionTokenAccount[] = [];

  for (const programId of tokenPrograms) {
    const tokenAccounts = await rlGetTokenAccountsByOwner(owner, programId);

    for (const tokenAccount of tokenAccounts.value) {
      const account = unpackAccount(tokenAccount.pubkey, tokenAccount.account, programId);
      const mintCacheKey = `${programId.toBase58()}:${account.mint.toBase58()}`;

      let mint = mintCache.get(mintCacheKey);
      if (!mint) {
        mint = await rlGetMint(account.mint, programId);
        mintCache.set(mintCacheKey, mint);
      }

      accounts.push({
        address: tokenAccount.pubkey,
        programId,
        account,
        mint,
      });
    }
  }

  return accounts;
};

const getWalletSweepSnapshot = async (
  owner: PublicKey,
  commitment: 'processed' | 'confirmed' | 'finalized' = 'confirmed',
): Promise<SweepResult> => {
  const solBalance = await rlGetBalance(owner, commitment);
  const tokenProgramAccounts = await rlGetTokenAccountsByOwner(owner, TOKEN_PROGRAM_ID, commitment);
  const token2022Accounts = await rlGetTokenAccountsByOwner(owner, TOKEN_2022_PROGRAM_ID, commitment);

  return {
    solBalance,
    tokenProgramAccounts: tokenProgramAccounts.value.map(({ pubkey }) => pubkey.toBase58()),
    token2022Accounts: token2022Accounts.value.map(({ pubkey }) => pubkey.toBase58()),
  };
};

const sweepSnapshotChanged = (before: SweepResult, after: SweepResult): boolean =>
  before.solBalance !== after.solBalance
  || before.tokenProgramAccounts.length !== after.tokenProgramAccounts.length
  || before.token2022Accounts.length !== after.token2022Accounts.length;

const isConfirmationExpiryError = (error: unknown): boolean =>
  error instanceof Error
  && (
    error.name === 'TransactionExpiredBlockheightExceededError'
    || error.message.includes('block height exceeded')
    || error.message.includes('has expired')
  );

const waitForPostSweepSnapshot = async (
  sessionId: string,
  owner: PublicKey,
  preSweepSnapshot: SweepResult,
): Promise<SweepResult> => {
  let latestSnapshot = await getWalletSweepSnapshot(owner, 'finalized');

  for (let attempt = 1; attempt <= SWEEP_SNAPSHOT_MAX_ATTEMPTS; attempt++) {
    if (sweepSnapshotChanged(preSweepSnapshot, latestSnapshot)) {
      return latestSnapshot;
    }

    if (attempt < SWEEP_SNAPSHOT_MAX_ATTEMPTS) {
      log('info', sessionId, `waiting for post-sweep snapshot to settle (${attempt}/${SWEEP_SNAPSHOT_MAX_ATTEMPTS})`);
      await new Promise<void>((resolve) => setTimeout(resolve, SWEEP_SNAPSHOT_WAIT_MS));
      latestSnapshot = await getWalletSweepSnapshot(owner, 'finalized');
    }
  }

  log('warn', sessionId, `post-sweep snapshot still matched pre-sweep state after ${SWEEP_SNAPSHOT_MAX_ATTEMPTS} attempts`);

  const confirmedSnapshot = await getWalletSweepSnapshot(owner, 'confirmed');
  if (sweepSnapshotChanged(preSweepSnapshot, confirmedSnapshot)) {
    log('info', sessionId, 'confirmed post-sweep snapshot changed after finalized lag');
    return confirmedSnapshot;
  }

  return latestSnapshot;
};

const sweepFunds = async (session: RawSession): Promise<SweepResult> => {
  const ownerWallet = session.owner_wallet;

  // Refuse to sweep to the SOL mint placeholder
  if (ownerWallet === SOL_MINT) {
    log('warn', session.id, 'owner_wallet is SOL mint placeholder â€” skipping sweep');
    return getWalletSweepSnapshot(new PublicKey(session.session_wallet));
  }

  const keypair = await getKeypair(session.id);
  if (!keypair) {
    log('warn', session.id, 'no keypair found â€” cannot sweep funds');
    return getWalletSweepSnapshot(new PublicKey(session.session_wallet));
  }

  const conn = getConnection();
  const ownerPubkey = new PublicKey(ownerWallet);
  const sessionPubkey = keypair.publicKey;

  // Fetch SOL balance first â€” needed to decide if we can afford ATA creation
  const solBalance = await rlGetBalance(sessionPubkey);

  if (solBalance < TX_FEE_LAMPORTS) {
    log('warn', session.id, `solBalance ${solBalance} < tx fee â€” cannot sweep`);
    return getWalletSweepSnapshot(sessionPubkey);
  }

  const ixs: TransactionInstruction[] = [];
  let ownerAtaCreationCost = 0;
  let mayLeaveResidualState = false;
  const ownerAtaCreationRentByMint = new Map<string, number>();
  const sessionTokenAccounts = await getSessionTokenAccounts(sessionPubkey);
  const preSweepSnapshot: SweepResult = {
    solBalance,
    tokenProgramAccounts: sessionTokenAccounts
      .filter(({ programId }) => programId.equals(TOKEN_PROGRAM_ID))
      .map(({ address }) => address.toBase58()),
    token2022Accounts: sessionTokenAccounts
      .filter(({ programId }) => programId.equals(TOKEN_2022_PROGRAM_ID))
      .map(({ address }) => address.toBase58()),
  };

  for (const tokenAccount of sessionTokenAccounts) {
    const tokenProgramLabel = tokenAccount.programId.equals(TOKEN_2022_PROGRAM_ID) ? 'Token-2022' : 'Token';

    if (tokenAccount.account.closeAuthority && !tokenAccount.account.closeAuthority.equals(sessionPubkey)) {
      log('warn', session.id, `skipping ${tokenProgramLabel} account ${tokenAccount.address.toBase58()} â€” close authority is ${tokenAccount.account.closeAuthority.toBase58()}`);
      mayLeaveResidualState = true;
      continue;
    }

    if (tokenAccount.account.isNative) {
      ixs.push(createCloseAccountInstruction(
        tokenAccount.address,
        ownerPubkey,
        sessionPubkey,
        [],
        tokenAccount.programId,
      ));
      log('info', session.id, `queuing native ${tokenProgramLabel} account close: ${tokenAccount.address.toBase58()} â†’ ${ownerWallet}`);
      continue;
    }

    if (tokenAccount.account.amount === 0n) {
      ixs.push(createCloseAccountInstruction(
        tokenAccount.address,
        ownerPubkey,
        sessionPubkey,
        [],
        tokenAccount.programId,
      ));
      log('info', session.id, `queuing empty ${tokenProgramLabel} account close: ${tokenAccount.address.toBase58()} (${tokenAccount.account.mint.toBase58()}) â†’ ${ownerWallet}`);
      continue;
    }

    if (tokenAccount.account.isFrozen) {
      log('warn', session.id, `skipping frozen ${tokenProgramLabel} account ${tokenAccount.address.toBase58()} (${tokenAccount.account.mint.toBase58()}) with balance ${tokenAccount.account.amount}`);
      mayLeaveResidualState = true;
      continue;
    }

    const ownerTokenAta = await getAssociatedTokenAddress(
      tokenAccount.account.mint,
      ownerPubkey,
      false,
      tokenAccount.programId,
    );

    let ownerTokenAtaExists = false;
    try {
      await getAccount(conn, ownerTokenAta, 'confirmed', tokenAccount.programId);
      ownerTokenAtaExists = true;
    } catch {
      // missing ATA, create below if affordable
    }

    if (!ownerTokenAtaExists) {
      const mintCacheKey = `${tokenAccount.programId.toBase58()}:${tokenAccount.account.mint.toBase58()}`;
      let requiredRent = ownerAtaCreationRentByMint.get(mintCacheKey);

      if (requiredRent === undefined) {
        requiredRent = await rlGetMinimumBalanceForRentExemption(getAccountLenForMint(tokenAccount.mint));
        ownerAtaCreationRentByMint.set(mintCacheKey, requiredRent);
      }

      const projectedLamportsAfterCreation = solBalance - ownerAtaCreationCost - requiredRent - TX_FEE_LAMPORTS;
      if (projectedLamportsAfterCreation < 0) {
        log('warn', session.id, `solBalance ${solBalance} too low to create owner ${tokenProgramLabel} ATA for mint ${tokenAccount.account.mint.toBase58()} â€” skipping token sweep of ${tokenAccount.account.amount}`);
        mayLeaveResidualState = true;
        continue;
      }

      ownerAtaCreationCost += requiredRent;
      ixs.push(createAssociatedTokenAccountIdempotentInstruction(
        sessionPubkey,
        ownerTokenAta,
        ownerPubkey,
        tokenAccount.account.mint,
        tokenAccount.programId,
      ));
      log('info', session.id, `queuing owner ${tokenProgramLabel} ATA create for mint ${tokenAccount.account.mint.toBase58()} (${requiredRent} lamports rent)`);
    }

    ixs.push(createTransferInstruction(
      tokenAccount.address,
      ownerTokenAta,
      sessionPubkey,
      tokenAccount.account.amount,
      [],
      tokenAccount.programId,
    ));
    ixs.push(createCloseAccountInstruction(
      tokenAccount.address,
      ownerPubkey,
      sessionPubkey,
      [],
      tokenAccount.programId,
    ));
    log('info', session.id, `queuing ${tokenProgramLabel} sweep: mint ${tokenAccount.account.mint.toBase58()} amount ${tokenAccount.account.amount} â†’ ${ownerWallet}`);
  }

  // â”€â”€ SOL sweep â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Base fee for 1-signature versioned tx = 5,000 lamports (no priority fee).
  //
  // FUND-SAFETY INVARIANT: never drain the session wallet's SOL to zero while a
  // VALUED token position remains unswept (mayLeaveResidualState). The session
  // wallet is the fee payer for every future recovery action (liquidation swap,
  // token transfer, ATA creation). A 0-SOL wallet is bricked: the orphaned token
  // can then only be recovered by re-funding the wallet with SOL. Instead, retain
  // the remaining SOL in place as recovery gas so a later sweep/liquidation (once
  // the owner ATA exists or the route is affordable) can complete the return path.
  // Only drain to exactly zero when nothing valued is being left behind.
  // Solana caps a serialized transaction at 1232 bytes. A full session sweep can
  // queue dozens of instructions (per-token ATA-create + transfer + close), which
  // overruns a single transaction and previously threw `RangeError: encoding
  // overruns Uint8Array` at serialize time -- bricking the entire return flow and
  // stranding user funds. Pack the token instructions into size-bounded batches and
  // send each sequentially, then sweep the remaining SOL last, so funds always
  // return home (fail toward return).
  const TX_SERIALIZED_SIZE_TARGET = 1180;

  const probeBlockhash = (await rlGetLatestBlockhash()).blockhash;
  const measureBatchSize = (instructions: TransactionInstruction[]): number =>
    new VersionedTransaction(
      new TransactionMessage({
        payerKey: sessionPubkey,
        recentBlockhash: probeBlockhash,
        instructions,
      }).compileToV0Message(),
    ).serialize().length;

  const tokenBatches: TransactionInstruction[][] = [];
  for (const ix of ixs) {
    const current = tokenBatches[tokenBatches.length - 1];
    if (current && measureBatchSize([...current, ix]) <= TX_SERIALIZED_SIZE_TARGET) {
      current.push(ix);
    } else {
      tokenBatches.push([ix]);
    }
  }

  // Reserve the base fee for every transaction we are about to send (each token
  // batch plus one final SOL-sweep tx) so the SOL sweep cannot overdraw the fee
  // payer across multiple sequential transactions.
  const totalSweepTxCount = tokenBatches.length + 1;
  const solToSend = computeSessionSolSweepLamports({
    solBalance,
    ownerAtaCreationCost,
    txFeeLamports: TX_FEE_LAMPORTS * totalSweepTxCount,
    mayLeaveResidualState,
  });

  if (mayLeaveResidualState) {
    log(
      'warn',
      session.id,
      `retaining ${Math.max(0, solBalance - ownerAtaCreationCost - TX_FEE_LAMPORTS * totalSweepTxCount)} lamports as recovery gas -- a valued token position could not be swept home; not draining SOL to zero to avoid orphaning it`,
    );
  }

  if (tokenBatches.length === 0 && solToSend <= 0) {
    log('info', session.id, 'session wallet empty -- nothing to sweep');
    return getWalletSweepSnapshot(sessionPubkey);
  }

  const sendSweepBatch = async (instructions: TransactionInstruction[], label: string): Promise<boolean> => {
    const { blockhash, lastValidBlockHeight } = await rlGetLatestBlockhash();
    const message = new TransactionMessage({
      payerKey: sessionPubkey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();

    const sweepTx = new VersionedTransaction(message);
    sweepTx.sign([keypair]);

    const sig = await rlSendRawTransaction(sweepTx.serialize());
    try {
      const confirmation = await rlConfirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });
      if (confirmation.value.err) {
        throw new Error(`sweep transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      }
      log('info', session.id, `sweep ${label} confirmed: ${sig}`);
      return true;
    } catch (error) {
      if (isConfirmationExpiryError(error)) {
        log('warn', session.id, `sweep ${label} confirmation expired for ${sig}; verifying wallet state directly`);
        return false;
      }
      throw error;
    }
  };

  let confirmationSettled = false;
  for (let batchIndex = 0; batchIndex < tokenBatches.length; batchIndex += 1) {
    const settled = await sendSweepBatch(
      tokenBatches[batchIndex],
      `token batch ${batchIndex + 1}/${tokenBatches.length}`,
    );
    confirmationSettled = confirmationSettled || settled;
  }

  if (solToSend > 0) {
    log('info', session.id, `queuing SOL sweep: ${solToSend} lamports -> ${ownerWallet}`);
    const settled = await sendSweepBatch(
      [SystemProgram.transfer({ fromPubkey: sessionPubkey, toPubkey: ownerPubkey, lamports: solToSend })],
      'SOL sweep',
    );
    confirmationSettled = confirmationSettled || settled;
  }

  const postSweepSnapshot = await waitForPostSweepSnapshot(session.id, sessionPubkey, preSweepSnapshot);
  if (!confirmationSettled && !sweepSnapshotChanged(preSweepSnapshot, postSweepSnapshot)) {
    throw new Error('sweep expired before confirmation and wallet state did not change');
  }

  if (!mayLeaveResidualState && hasResidualWalletState(postSweepSnapshot)) {
    log(
      'warn',
      session.id,
      `post-sweep verification found unexpected residual wallet state: SOL=${postSweepSnapshot.solBalance} token=${postSweepSnapshot.tokenProgramAccounts.length} token2022=${postSweepSnapshot.token2022Accounts.length}`,
    );
  }

  return postSweepSnapshot;
};

// â”€â”€ Stopping â†’ stopped â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const LIQUIDATION_MIN_SLIPPAGE_BPS = 300;
const LIQUIDATION_CONFIRM_ATTEMPTS = 8;
const LIQUIDATION_CONFIRM_WAIT_MS = 1500;

const getSessionStopDisposition = (session: RawSession): 'return_tokens' | 'liquidate' =>
  session.user_control?.stopDisposition === 'liquidate' ? 'liquidate' : 'return_tokens';

// Sell every open (non-SOL) SPL position held by the session wallet back to SOL before the final
// sweep. Used when the user chooses to prematurely close positions on stop. Best-effort: any leg
// that cannot be liquidated is left in place and swept home as a raw token, so funds always
// return to the owner (fail toward return).
const liquidateOpenPositionsToBase = async (session: RawSession): Promise<void> => {
  const keypair = await getKeypair(session.id);
  if (!keypair) {
    log('warn', session.id, 'liquidation skipped â€” no keypair found; positions will be swept as raw tokens');
    return;
  }

  const sessionPubkey = keypair.publicKey;
  const tokenAccounts = await getSessionTokenAccounts(sessionPubkey);
  const liquidatable = tokenAccounts.filter((acct) => (
    !acct.account.isNative
    && !acct.account.isFrozen
    && acct.account.amount > 0n
    && acct.account.mint.toBase58() !== SOL_MINT
    && (!acct.account.closeAuthority || acct.account.closeAuthority.equals(sessionPubkey))
  ));

  if (liquidatable.length === 0) {
    log('info', session.id, 'liquidation: no open token positions to close â€” proceeding to sweep');
    return;
  }

  const slippageBps = Math.max(session.risk_limits.maxSlippageBps, LIQUIDATION_MIN_SLIPPAGE_BPS);

  for (const acct of liquidatable) {
    const mint = acct.account.mint.toBase58();
    const symbol = resolveTokenSymbol(mint);
    const amount = acct.account.amount.toString();

    try {
      const prepare = await apiPost<PrepareResponse>('/jupiter/swap/prepare', {
        inputMint: mint,
        outputMint: SOL_MINT,
        amount,
        taker: session.session_wallet,
        feeTokenSymbol: 'SOL',
        slippageBps: String(slippageBps),
      });

      if (
        !prepare.ok
        || !prepare.data.preparedTransactionBase64
        || !prepare.data.executionId
        || prepare.data.simulation?.err
      ) {
        log(
          'warn',
          session.id,
          `liquidation prepare failed for ${symbol} (${mint}): ${prepare.data.error ?? JSON.stringify(prepare.data.simulation?.err ?? prepare.status)} â€” will sweep as raw token`,
        );
        if (prepare.data.executionId) {
          await apiPost(`/jupiter/swap/executions/${prepare.data.executionId}/cancel`, {
            stage: 'worker_cancel',
            reason: 'liquidation_prepare_failed',
          }).catch(() => {});
        }
        continue;
      }

      let tx: VersionedTransaction;
      try {
        tx = VersionedTransaction.deserialize(Buffer.from(prepare.data.preparedTransactionBase64, 'base64'));
        tx.sign([keypair]);
      } catch (err) {
        log('warn', session.id, `liquidation sign failed for ${symbol}: ${String(err)} â€” will sweep as raw token`);
        await apiPost(`/jupiter/swap/executions/${prepare.data.executionId}/cancel`, {
          stage: 'worker_cancel',
          reason: 'liquidation_sign_failed',
        }).catch(() => {});
        continue;
      }

      const submit = await apiPost<SubmitResponse>('/jupiter/swap/submit', {
        executionId: prepare.data.executionId,
        signedTransactionBase64: Buffer.from(tx.serialize()).toString('base64'),
        blockhash: prepare.data.blockhash,
        lastValidBlockHeight: prepare.data.lastValidBlockHeight,
      });

      if (!submit.ok) {
        log(
          'warn',
          session.id,
          `liquidation submit failed for ${symbol}: ${submit.data.error ?? submit.status} â€” will sweep as raw token`,
        );
        continue;
      }

      log(
        'info',
        session.id,
        `liquidation submitted for ${symbol} (${mint}) amount ${amount} â†’ SOL, sig ${submit.data.signature ?? 'pending'}`,
      );

      // Wait for the token balance to actually clear before sweeping, otherwise the sweep would
      // grab the still-held token as a raw transfer and defeat the liquidation.
      for (let attempt = 1; attempt <= LIQUIDATION_CONFIRM_ATTEMPTS; attempt++) {
        const remaining = await getTokenBalanceAtomic(sessionPubkey, mint, acct.programId).catch(() => 0);
        if (remaining === 0) {
          log('info', session.id, `liquidation confirmed for ${symbol} â€” position closed to SOL`);
          break;
        }
        if (attempt === LIQUIDATION_CONFIRM_ATTEMPTS) {
          log(
            'warn',
            session.id,
            `liquidation for ${symbol} not confirmed after ${LIQUIDATION_CONFIRM_ATTEMPTS} checks (remaining ${remaining}) â€” will sweep remainder as raw token`,
          );
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, LIQUIDATION_CONFIRM_WAIT_MS));
      }
    } catch (err) {
      log('warn', session.id, `liquidation error for ${symbol} (${mint}): ${String(err)} â€” will sweep as raw token`);
    }
  }
};

const finalizeStop = async (session: RawSession): Promise<void> => {
  if (getSessionStopDisposition(session) === 'liquidate') {
    log('info', session.id, 'stop disposition = liquidate â€” closing open positions to SOL before sweep');
    try {
      await liquidateOpenPositionsToBase(session);
    } catch (err) {
      log('warn', session.id, `liquidation pass failed: ${String(err)} â€” falling back to raw token sweep`);
    }
  }

  const sweepResult = await sweepFunds(session);
  const latestSession = await getSessionById(session.id);
  const latestPositionState = getPositionState(latestSession ?? session);

  // A residual remains if any token account or SOL is still in the session wallet.
  // There are two very different cases:
  //   1) RETRYABLE: solBalance >= TX_FEE_LAMPORTS â€” the wallet can still pay a fee,
  //      so a future sweep tick may clear the residual (transient RPC/route failure,
  //      owner ATA created later, etc). Stay in `stopping` and retry.
  //   2) BRICKED/UNRECOVERABLE: solBalance < TX_FEE_LAMPORTS while tokens remain â€”
  //      the session wallet is the fee payer for any move and has no gas, so NO
  //      sweep can EVER succeed. Looping in `stopping` forever traps the session and
  //      hides the trapped funds. Finalize to `stopped`, record the residual token
  //      accounts for owner/admin-sponsored recovery, and stop looping.
  if (hasResidualWalletState(sweepResult)) {
    const residualTokens = getResidualTokenAccounts(sweepResult);
    const walletBricked = isBrickedResidualWallet(sweepResult, TX_FEE_LAMPORTS);

    if (!walletBricked) {
      const updatedFunding: Session['funding'] = {
        ...(latestSession?.funding ?? session.funding),
        currentBalanceAtomic: String(sweepResult.solBalance),
      };

      await setSessionStatus(session.id, 'stopping', {
        funding: updatedFunding,
      }, { expectedStatuses: ['stopping'] });

      log(
        'warn',
        session.id,
        `residual wallet state remains after sweep attempt â€” staying in stopping: SOL=${sweepResult.solBalance} token=${sweepResult.tokenProgramAccounts.length} token2022=${sweepResult.token2022Accounts.length}`,
      );
      return;
    }

    // Bricked wallet: finalize to stopped and flag residual for recovery so the
    // session is no longer stuck and the trapped funds are visible to admin/owner.
    const updatedFunding: Session['funding'] = {
      ...(latestSession?.funding ?? session.funding),
      currentBalanceAtomic: String(sweepResult.solBalance),
    };
    const detectedAt = new Date().toISOString();
    const updatedServiceControl = mergeSessionServiceControl(
      latestSession?.service_control ?? session.service_control,
      {
        positionsState: buildStoppedPositionsState(),
        positionState: buildStoppedPositionState(latestPositionState),
        healthState: {
          state: 'recovery_required',
          severity: 'error',
          reason: 'residual_recovery_required',
          detail: 'Session stopped with residual token account(s) and insufficient SOL to self-recover.',
          updatedAt: detectedAt,
          blockerCount: residualTokens.length,
        },
        residualRecovery: {
          state: 'unrecoverable_zero_gas',
          sessionWallet: session.session_wallet,
          ownerWallet: session.owner_wallet,
          solBalance: sweepResult.solBalance,
          residualTokenAccounts: residualTokens,
          detectedAt,
          note: 'Session wallet has insufficient SOL to pay any transaction fee; residual token(s) require owner/admin fee-sponsored recovery.',
        },
      },
    );

    await setSessionStatus(session.id, 'stopped', {
      ended_at: new Date().toISOString(),
      stop_reason: 'operator_stop',
      funding: updatedFunding,
      service_control: updatedServiceControl,
    }, { expectedStatuses: ['stopping'] });

    log(
      'error',
      session.id,
      `session wallet bricked (SOL=${sweepResult.solBalance} < tx fee) with residual tokens [${residualTokens.join(', ')}] â€” finalized to stopped and flagged for fee-sponsored recovery instead of looping`,
    );
    return;
  }

  const updatedFunding: Session['funding'] = {
    ...(latestSession?.funding ?? session.funding),
    currentBalanceAtomic: String(sweepResult.solBalance),
  };
  const updatedServiceControl = mergeSessionServiceControl(
    latestSession?.service_control ?? session.service_control,
    {
      positionsState: buildStoppedPositionsState(),
      positionState: buildStoppedPositionState(latestPositionState),
    },
  );

  await setSessionStatus(session.id, 'stopped', {
    ended_at: new Date().toISOString(),
    stop_reason: session.stop_reason ?? 'worker_stop',
    funding: updatedFunding,
    service_control: updatedServiceControl,
  }, { expectedStatuses: ['stopping'] });

  log('info', session.id, 'stopping â†’ stopped');
};

// â”€â”€ Main poll loop â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const log = (level: 'info' | 'warn' | 'error', sessionId: string, msg: string) => {
  console.log(JSON.stringify({
    level,
    service: 'roguezero-worker',
    sessionId,
    msg,
    ts: new Date().toISOString(),
  }));
};

const tick = async (): Promise<number> => {
  await refreshLiveRuntimeControl();
  await evaluateFleetAutoShift();
  let sessions: RawSession[];
  try {
    sessions = await querySessions(['awaiting_funding', 'ready', 'starting', 'active', 'stopping']);
  } catch (err) {
    console.error('[worker] DB query failed:', String(err));
    return POLL_MS;
  }

  syncFundingSubscriptions(sessions);
  syncActiveBalanceSubscriptions(sessions);

  sessions = orderSessionsForTick(sessions);

  const tickStartedAtMs = Date.now();
  const activeSessionIds = new Set(sessions.map((session) => session.id));
  const cadenceTelemetry = {
    processed: 0,
    deferred: 0,
    byStatus: {
      awaiting_funding: { processed: 0, deferred: 0 },
      ready: { processed: 0, deferred: 0 },
      starting: { processed: 0, deferred: 0 },
      active: { processed: 0, deferred: 0 },
      stopping: { processed: 0, deferred: 0 },
    } as Record<string, { processed: number; deferred: number }>,
  };

  for (const session of sessions) {
    const dueAtMs = nextSessionEvaluationAt.get(session.id) ?? 0;
    const nowMs = Date.now();
    const statusTelemetry = cadenceTelemetry.byStatus[session.status] ?? { processed: 0, deferred: 0 };
    cadenceTelemetry.byStatus[session.status] = statusTelemetry;

    if (nowMs < dueAtMs) {
      cadenceTelemetry.deferred += 1;
      statusTelemetry.deferred += 1;
      continue;
    }

    cadenceTelemetry.processed += 1;
    statusTelemetry.processed += 1;
    let nextCadenceMs = getSessionCadenceMs(session);

    try {
      switch (session.status) {
        case 'awaiting_funding':
          {
            const waitingMs = Date.now() - session.requested_at.getTime();
            const waitingLimitMs = Math.max(1, AWAITING_FUNDING_TIMEOUT_MINUTES) * 60_000;
            if (waitingMs > waitingLimitMs) {
              await setSessionStatus(
                session.id,
                'stopping',
                { stop_reason: 'funding_timeout' },
                { expectedStatuses: ['awaiting_funding'] },
              );
              unsubscribeFundingSession(session.id);
              log(
                'warn',
                session.id,
                `awaiting funding timeout (${AWAITING_FUNDING_TIMEOUT_MINUTES}min) exceeded → stopping`,
              );
              nextCadenceMs = Math.min(nextCadenceMs, getLiveSpeedProfile().cadenceMs.stopping);
              break;
            }
          }

          if (shouldRunFundingFallbackCheck(session.id)) {
            await runFundingCheck(session.id);
          }
          break;
        case 'ready':
          log('info', session.id, 'funded and ready; waiting for user start/profit-mode confirmation');
          break;
        case 'starting':
          await activateSession(session);
          break;
        case 'active': {
          if (hasExceededTargetDuration(session)) {
            await setSessionStatus(session.id, 'stopping', { stop_reason: 'duration_exceeded' }, { expectedStatuses: ['active'] });
            log('warn', session.id, `target duration ${session.user_control.targetDurationMinutes}min exceeded → stopping`);
            nextCadenceMs = Math.min(nextCadenceMs, getLiveSpeedProfile().cadenceMs.stopping);
            break;
          }

          // Auto-stop: stale session (no trade attempt for too long)
          const lastAttemptMs = getLastTradeAttemptMs(session);
          const staleLimitMs = STALE_SESSION_MINUTES * 60_000;
          if (STALE_SESSION_MINUTES > 0 && lastAttemptMs > 0 && (Date.now() - lastAttemptMs) > staleLimitMs) {
            await setSessionStatus(session.id, 'stopping', { stop_reason: 'stale_no_trade_attempts' }, { expectedStatuses: ['active'] });
            log('warn', session.id, `no trade attempt for ${STALE_SESSION_MINUTES}min â†’ stale auto-stop`);
            nextCadenceMs = Math.min(nextCadenceMs, getLiveSpeedProfile().cadenceMs.stopping);
            break;
          }

          if (await reserveTradeWindow(session)) {
            const queued = await enqueueExecutionIntent(session, {
              priority: isLongPositionStatus(getPositionState(session).status) ? 50 : 0,
              reason: 'active_trade_window',
            });

            if (!queued) {
              await persistTradeDecision(session, 'blocked', 'execution_already_queued');
            }
          } else {
            const last = getLastTradeAttemptMs(session);
            const remainingCooldown = Math.max(0, session.risk_limits.cooldownMs - (Date.now() - last));
            nextCadenceMs = Math.max(MIN_LOOP_MS, Math.min(nextCadenceMs, remainingCooldown));
          }
          break;
        }
        case 'stopping':
          await finalizeStop(session);
          break;
      }
    } catch (err) {
      log('error', session.id, `unhandled error: ${String(err)}`);
    } finally {
      nextSessionEvaluationAt.set(session.id, Date.now() + applyCadenceJitter(nextCadenceMs));
    }
  }

  const claimedExecutionCount = await processExecutionQueue();

  for (const sessionId of [...nextSessionEvaluationAt.keys()]) {
    if (!activeSessionIds.has(sessionId)) {
      nextSessionEvaluationAt.delete(sessionId);
    }
  }

  let nextDelayMs = POLL_MS;
  const nowMs = Date.now();
  for (const dueAtMs of nextSessionEvaluationAt.values()) {
    nextDelayMs = Math.min(nextDelayMs, Math.max(MIN_LOOP_MS, dueAtMs - nowMs));
  }

  if ((tickStartedAtMs - lastCadenceTelemetryLogMs) >= 60_000) {
    lastCadenceTelemetryLogMs = tickStartedAtMs;
    console.log(JSON.stringify({
      service: 'roguezero-worker',
      kind: 'loop_cadence',
      ts: new Date().toISOString(),
      sessions: sessions.length,
      processed: cadenceTelemetry.processed,
      deferred: cadenceTelemetry.deferred,
      queuedExecutionsClaimed: claimedExecutionCount,
      nextDelayMs,
      byStatus: cadenceTelemetry.byStatus,
    }));
  }

  return nextDelayMs;
};

let shuttingDown = false;
let activeTickPromise: Promise<number> | null = null;
let nextTickTimer: NodeJS.Timeout | null = null;

const scheduleNextTick = (delayMs: number) => {
  if (shuttingDown) return;
  nextTickTimer = setTimeout(() => {
    nextTickTimer = null;
    void runLoop();
  }, delayMs);
};

const runLoop = async (): Promise<void> => {
  if (shuttingDown) return;
  try {
    activeTickPromise = tick();
    const nextDelayMs = await activeTickPromise;
    scheduleNextTick(nextDelayMs);
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error',
      service: 'roguezero-worker',
      kind: 'loop_error',
      msg: String(err),
      retryDelayMs: POLL_MS,
      ts: new Date().toISOString(),
    }));
    scheduleNextTick(POLL_MS);
  } finally {
    activeTickPromise = null;
  }
};

// â”€â”€ Graceful shutdown â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// On redeploy/restart Railway sends SIGTERM before SIGKILL. We stop scheduling
// new ticks, let the in-flight tick finish (so an active swap submit + its DB
// write are not severed mid-flight), then requeue our own in-flight execution
// locks so the next worker picks them up immediately instead of waiting out the
// stale-lock TTL. Session rows already live in Postgres and resume on boot, so
// active trading sessions survive the deploy.
const SHUTDOWN_DRAIN_TIMEOUT_MS = Number(process.env.WORKER_SHUTDOWN_DRAIN_TIMEOUT_MS ?? 8_000);

const releaseOwnExecutionQueueLocksOnShutdown = async () => {
  await ensureExecutionQueueReady();
  const result = await getPool().query<{ id: string }>(
    `
      UPDATE execution_queue
         SET status = 'queued',
             locked_by = NULL,
             locked_until = NULL,
             last_error = 'worker_graceful_shutdown_released_lock',
             available_at = NOW(),
             updated_at = NOW()
       WHERE status = 'running'
         AND locked_by = $1
      RETURNING id
    `,
    [WORKER_INSTANCE_ID],
  );
  if ((result.rowCount ?? 0) > 0) {
    console.warn(JSON.stringify({
      service: 'roguezero-worker',
      kind: 'execution_queue_release_on_shutdown',
      workerInstanceId: WORKER_INSTANCE_ID,
      released: result.rowCount,
      ids: result.rows.map((row) => row.id),
      ts: new Date().toISOString(),
    }));
  }
};

let shutdownInFlight = false;
const gracefulShutdown = async (signal: string) => {
  if (shutdownInFlight) return;
  shutdownInFlight = true;
  shuttingDown = true;
  const startedAt = Date.now();
  console.log(JSON.stringify({
    service: 'roguezero-worker',
    kind: 'graceful_shutdown',
    phase: 'begin',
    signal,
    ts: new Date().toISOString(),
  }));

  if (nextTickTimer) {
    clearTimeout(nextTickTimer);
    nextTickTimer = null;
  }

  // Let the in-flight tick finish (bounded by the drain timeout) so a mid-flight
  // swap submit and its DB write complete before we tear down.
  if (activeTickPromise) {
    const drainTimeout = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_TIMEOUT_MS));
    try {
      await Promise.race([activeTickPromise.then(() => undefined), drainTimeout]);
    } catch {
      // tick errors are already logged by runLoop; continue shutdown regardless.
    }
  }

  try {
    await releaseOwnExecutionQueueLocksOnShutdown();
  } catch (err) {
    console.error('[worker] graceful shutdown lock release failed:', String(err));
  }

  try {
    await getPool().end();
  } catch {
    // pool may already be closing; ignore.
  }

  console.log(JSON.stringify({
    service: 'roguezero-worker',
    kind: 'graceful_shutdown',
    phase: 'complete',
    signal,
    durationMs: Date.now() - startedAt,
    ts: new Date().toISOString(),
  }));
  process.exit(0);
};

process.once('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.once('SIGINT', () => void gracefulShutdown('SIGINT'));
console.log(JSON.stringify({
  service: 'roguezero-worker',
  kind: 'graceful_shutdown_handlers_registered',
  pid: process.pid,
  ppid: process.ppid,
  isPid1: process.pid === 1,
  ts: new Date().toISOString(),
}));

// â”€â”€ Boot â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

console.log(JSON.stringify({
  service: 'roguezero-worker',
  status: 'starting',
  deployCanary: DEPLOY_CANARY,
  sourceRev: WORKER_SOURCE_REV,
  configReady: configReport.readyForLiveIntegration,
  missingLiveValues: configReport.missingLiveValues,
  pollIntervalMs: POLL_MS,
  minLoopIntervalMs: MIN_LOOP_MS,
  speedProfile: liveSpeedProfile.name,
  concurrentCapacity: liveSpeedProfile.concurrentCapacity,
  cadenceMs: {
    readyStarting: liveSpeedProfile.cadenceMs.readyStarting,
    activeInPosition: liveSpeedProfile.cadenceMs.activeInPosition,
    activeFlat: liveSpeedProfile.cadenceMs.activeFlat,
    activeGuarded: liveSpeedProfile.cadenceMs.activeGuarded,
    stopping: liveSpeedProfile.cadenceMs.stopping,
    postSubmitFast: liveSpeedProfile.cadenceMs.postSubmitFast,
    jitterRatio: LOOP_JITTER_RATIO,
  },
  apiBase: API_BASE,
  limits: {
    jupiterGeneralRps: JUPITER_GENERAL_RPS,
    jupiterGeneralBurst: JUPITER_GENERAL_BURST,
    heliusRpcRps: HELIUS_RPC_RPS,
    heliusRpcBurst: HELIUS_RPC_BURST,
    awaitingFundingTimeoutMinutes: AWAITING_FUNDING_TIMEOUT_MINUTES,
    fundingPollFallbackMs: FUNDING_POLL_FALLBACK_MS,
    minTradeableLamports: MIN_TRADEABLE_LAMPORTS,
    maxRouteSetupLamports: MAX_ROUTE_SETUP_LAMPORTS,
    operatingBufferLamports: OPERATING_BUFFER_LAMPORTS,
  },
  priceFeeds: {
    pythPollMs: pricePollPolicy.pythPollMs,
    jupiterPricePollMs: pricePollPolicy.jupiterPricePollMs,
    maxConsecutiveFailures: pricePollPolicy.maxConsecutiveFailures,
    sharedTapeSize: pricePollPolicy.sharedTapeSize,
    pythHermesBaseUrl: pythPriceConfig?.hermesBaseUrl ?? null,
    pythApiKeyConfigured: !!pythPriceConfig?.apiKey,
    pythConfigured: !!pythPriceConfig,
    jupiterPriceConfigured: !!jupiterPriceConfig,
  },
  signal: {
    momentumLookbackSamples: signalPolicy.momentumLookbackSamples,
    momentumThresholdBps: signalPolicy.momentumThresholdBps,
    maxPythAgeSeconds: signalPolicy.maxPythAgeSeconds,
    maxPythConfidenceBps: signalPolicy.maxPythConfidenceBps,
    edgeSafetyBufferBps: signalPolicy.edgeSafetyBufferBps,
    minEntrySignalPersistenceSamples: MIN_ENTRY_SIGNAL_PERSISTENCE_SAMPLES,
    maxQuotePriceImpactBps: MAX_QUOTE_PRICE_IMPACT_BPS,
    tokenUniverseAutoSortEnabled: TOKEN_UNIVERSE_AUTO_SORT_ENABLED,
    tokenUniverseAutoSortIntervalMs: TOKEN_UNIVERSE_AUTO_SORT_INTERVAL_MS,
    tokenUniverseAutoSortTopEnabled: TOKEN_UNIVERSE_AUTO_SORT_TOP_ENABLED,
    tokenUniverseAutoSortNotionalUsdcAtomic: TOKEN_UNIVERSE_AUTO_SORT_NOTIONAL_USDC_ATOMIC,
    tokenUniverseAutoSortMaxPriceImpactBps: TOKEN_UNIVERSE_AUTO_SORT_MAX_PRICE_IMPACT_BPS,
    tokenUniverseEngineMaxStaleMs: TOKEN_UNIVERSE_ENGINE_MAX_STALE_MS,
    tokenUniverseDeadPruneEnabled: TOKEN_UNIVERSE_DEAD_PRUNE_ENABLED,
    tokenUniverseDeadRunThreshold: TOKEN_UNIVERSE_DEAD_RUN_THRESHOLD,
    tokenUniverseAdmissionStreak: TOKEN_UNIVERSE_ADMISSION_STREAK,
    tokenUniverseEvictionStreak: TOKEN_UNIVERSE_EVICTION_STREAK,
    tokenUniverseMinStayRuns: TOKEN_UNIVERSE_MIN_STAY_RUNS,
    tokenUniverseEvictionRankBuffer: TOKEN_UNIVERSE_EVICTION_RANK_BUFFER,
    universeScoutEnabled: WORKER_UNIVERSE_SCOUT_ENABLED,
    universeScoutMaxCandidates: WORKER_UNIVERSE_SCOUT_MAX_CANDIDATES,
    universeScoutCoreOnlyEntries: WORKER_ENTRY_CORE_UNIVERSE_ONLY,
    universeScoutBlockPumpMintEntries: WORKER_BLOCK_PUMP_MINT_ENTRIES,
    universeScoutRequirePersistentBullish: WORKER_UNIVERSE_SCOUT_REQUIRE_PERSISTENT_BULLISH,
    universeScoutMaxEntryPriceImpactBps: WORKER_UNIVERSE_SCOUT_MAX_ENTRY_PRICE_IMPACT_BPS,
    trendingEntryShapeGateEnabled: WORKER_TRENDING_ENTRY_SHAPE_GATE_ENABLED,
    trendingEntryShapeMinSamples: WORKER_TRENDING_ENTRY_SHAPE_MIN_SAMPLES,
    trendingEntryChaseLookbackSamples: WORKER_TRENDING_ENTRY_CHASE_LOOKBACK_SAMPLES,
    trendingEntryMaxRecentSurgeBps: WORKER_TRENDING_ENTRY_MAX_RECENT_SURGE_BPS,
    trendingEntryMinPullbackBps: WORKER_TRENDING_ENTRY_MIN_PULLBACK_BPS,
    trendingEntryMinReclaimBps: WORKER_TRENDING_ENTRY_MIN_RECLAIM_BPS,
    trendingEntryMaxRangePositionBps: WORKER_TRENDING_ENTRY_MAX_RANGE_POSITION_BPS,
    trendingEntryMaxNegativeWindowBps: WORKER_TRENDING_ENTRY_MAX_NEGATIVE_WINDOW_BPS,
    maxConsecutiveLosses: WORKER_MAX_CONSECUTIVE_LOSSES,
    maxBadFillStreak: WORKER_MAX_BAD_FILL_STREAK,
    volatilitySizingEnabled: WORKER_VOLATILITY_SIZING_ENABLED,
    volatilityLookbackSamples: WORKER_VOLATILITY_LOOKBACK_SAMPLES,
    volatilityTargetBps: WORKER_VOLATILITY_TARGET_BPS,
    volatilityMinSizeBps: WORKER_VOLATILITY_MIN_SIZE_BPS,
    routeStabilityEnabled: WORKER_ROUTE_STABILITY_ENABLED,
    routeStabilitySamples: WORKER_ROUTE_STABILITY_SAMPLES,
    routeStabilityDelayMs: WORKER_ROUTE_STABILITY_DELAY_MS,
    routeStabilityMaxOutputDriftBps: WORKER_ROUTE_STABILITY_MAX_OUTPUT_DRIFT_BPS,
    routeStabilityMaxImpactDriftBps: WORKER_ROUTE_STABILITY_MAX_IMPACT_DRIFT_BPS,
  },
  exits: {
    takeProfitBps: positionExitPolicy.takeProfitBps,
    stopLossBps: positionExitPolicy.stopLossBps,
    trailingStopBps: positionExitPolicy.trailingStopBps,
  },
  timestamp: new Date().toISOString(),
}));

if (!configReport.readyForLiveIntegration) {
  console.warn('[worker] config not fully live â€” missing:', configReport.missingLiveValues.join(', '));
}

// Verify DB connection on startup
getPool().query('SELECT 1').then(() => {
  console.log('[worker] DB connected');
}).catch((err: unknown) => {
  console.error('[worker] DB connection failed:', String(err));
});

let tokenAdmissionRunInFlight = false;

const resolveTokenAdmissionScriptPath = (): string | null => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // dist runtime: services/worker/dist -> repo root is three levels up
    path.resolve(here, '../../../scripts/admit-token-candidates.mjs'),
    // tsx/dev runtime: services/worker/src -> repo root is three levels up
    path.resolve(here, '../../../scripts/admit-token-candidates.mjs'),
    // fallback to current working directory (Railway sets cwd to repo root)
    path.resolve(process.cwd(), 'scripts/admit-token-candidates.mjs'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
};

const runTokenAdmissionDiscovery = async (): Promise<void> => {
  if (tokenAdmissionRunInFlight) {
    console.warn('[worker] token-admission run skipped: previous run still in flight');
    return;
  }
  const scriptPath = resolveTokenAdmissionScriptPath();
  if (!scriptPath) {
    console.error('[worker] token-admission feeder script not found in deploy; scheduled discovery disabled');
    return;
  }
  tokenAdmissionRunInFlight = true;
  const startedAt = Date.now();
  console.log('[worker] token-admission discovery starting (additive-only)', JSON.stringify({ scriptPath }));
  await new Promise<void>((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: path.dirname(path.dirname(path.dirname(scriptPath))),
      env: {
        ...process.env,
        // Additive-only: add/enable new admits, never disable existing rows.
        TOKEN_ADMISSION_APPLY_TO_UNIVERSE: 'true',
        TOKEN_ADMISSION_ADDITIVE_ONLY: 'true',
        // Allow pump-origin memes through (same as the vetted manual refresh); the
        // script's safety screens (verified, liquidity, holders, exit routes) still apply.
        TOKEN_ADMISSION_BLOCK_PUMP_MINTS: 'false',
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', (err) => {
      console.error('[worker] token-admission discovery spawn error:', String(err));
      resolve();
    });
    child.on('close', (code) => {
      console.log('[worker] token-admission discovery finished', JSON.stringify({
        exitCode: code,
        durationMs: Date.now() - startedAt,
      }));
      resolve();
    });
  });
  tokenAdmissionRunInFlight = false;
};

const startTokenAdmissionSchedule = (): void => {
  if (!TOKEN_ADMISSION_SCHEDULE_ENABLED) {
    console.log('[worker] token-admission schedule disabled by env');
    return;
  }
  console.log('[worker] token-admission schedule enabled', JSON.stringify({
    intervalMs: TOKEN_ADMISSION_SCHEDULE_INTERVAL_MS,
    initialDelayMs: TOKEN_ADMISSION_SCHEDULE_INITIAL_DELAY_MS,
  }));
  setTimeout(() => {
    void runTokenAdmissionDiscovery();
    setInterval(() => {
      void runTokenAdmissionDiscovery();
    }, Math.max(60_000, TOKEN_ADMISSION_SCHEDULE_INTERVAL_MS));
  }, Math.max(0, TOKEN_ADMISSION_SCHEDULE_INITIAL_DELAY_MS));
};

const boot = async () => {
  try {
    await refreshLiveRuntimeControl(true);
    await ensureWorkerRuntimeStateStore();
    await reclaimOwnExecutionQueueLocksOnBoot();
    await loadPersistedMarketTapeState();
    await refreshTokenUniverseMints(true);
  } catch (err) {
    console.error('[worker] market tape restore failed:', String(err));
  }

  startPriceLoops();
  startTokenAdmissionSchedule();
  await runLoop();
};

void boot();
