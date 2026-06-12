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
  getPerformanceFeeConfig,
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
  computeRetryMinimumTradeAmountAtomic,
  computeStopLossThresholdBps,
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
  recommendStrategy,
  type BollingerConfig,
  type PriceSample,
  type StrategyKey,
  type SupertrendConfig,
} from './strategies.js';
import {
  createGeckoTerminalCandleFeed,
  type GeckoTerminalCandleFeed,
} from './geckoTerminalCandles.js';

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
const WORKER_ENABLE_DURATION_AUTOSTOP = process.env.WORKER_ENABLE_DURATION_AUTOSTOP === 'true';
const WORKER_ENABLE_STALE_AUTOSTOP = process.env.WORKER_ENABLE_STALE_AUTOSTOP === 'true';
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
const performanceFeeConfig = getPerformanceFeeConfig(process.env);
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
// Economic entry floor: a trade must be large enough that the fixed per-swap
// cost (base fee + Sender tip ~200k lamports + priority fee ≈ $0.03) amortizes
// under the entry cost cap (WORKER_MAX_QUOTE_PRICE_IMPACT_BPS, default 120 bps).
// At $1.00 the fixed cost alone is ~178 bps → every entry was rejected by the
// cost gate (entry_leg_cost_too_high) and cancelled. At $5.00 the fixed cost is
// ~64 bps, leaving headroom for route price impact. Below-floor sizes are blocked
// before prepare, which also stops the prepare→cancel churn.
const MIN_USDC_ENTRY_ATOMIC = Number(process.env.WORKER_MIN_USDC_ENTRY_ATOMIC ?? 5_000_000);
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
// AFFORDABILITY FLOOR for executing the refill swap itself — the SOL below which
// the conversion truly cannot be paid for. A USDC->SOL refill outputs NATIVE SOL,
// which per Solana's account model is NOT a rent-bearing token account: no SPL
// associated-token-account rent (~2.04M lamports = getMinimumBalanceForRentExemption(165))
// applies, unlike a token ENTRY which must fund a new ATA. The temporary
// wrapped-SOL account Jupiter uses is opened and closed in the same transaction,
// so its rent is reclaimed. The real cost is therefore just the base fee (fixed at
// 5,000 lamports/signature per Solana fee docs) plus priority-fee and Sender-tip
// headroom. The API additionally SIMULATES the actual refill tx in /prepare, so
// on-chain affordability is the final gate; this floor only rejects the trivially
// unaffordable case. It must NOT inherit MAX_ROUTE_SETUP (ATA rent) — doing so set
// the floor equal to the trigger and made the refill window empty (death spiral:
// SOL drains on entry ATA rent, drops to the trigger, and the refill that could
// top it back up refuses because it demanded entry-sized SOL it no longer had).
const GAS_REFILL_SWAP_COST_LAMPORTS = Number(
  process.env.WORKER_GAS_REFILL_SWAP_COST_LAMPORTS
  ?? (TX_FEE_LAMPORTS + 200_000),
);
// TRIGGER a refill while SOL can still fund a new-token ENTRY (which DOES need the
// ~2.04M ATA rent). Keyed to route-setup rent, NOT the refill swap cost, so the
// refill fires with a wide healthy window ABOVE the affordability floor.
const GAS_REFILL_TRIGGER_LAMPORTS = Number(
  process.env.WORKER_GAS_REFILL_TRIGGER_LAMPORTS
  ?? (MIN_SOL_OPERATING_RESERVE_LAMPORTS + MAX_ROUTE_SETUP_LAMPORTS),
);
// Refill back up to a comfortable multi-entry buffer so we do not refill every loop.
const GAS_REFILL_BUFFER_SWAPS = Number(process.env.WORKER_GAS_REFILL_BUFFER_SWAPS ?? 4);
const GAS_REFILL_TARGET_LAMPORTS = Number(
  process.env.WORKER_GAS_REFILL_TARGET_LAMPORTS
  ?? (MIN_SOL_OPERATING_RESERVE_LAMPORTS + (GAS_REFILL_BUFFER_SWAPS * MAX_ROUTE_SETUP_LAMPORTS)),
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
// EXIT-side liquidity gate. The entry path only ever measured ENTRY price impact
// (USDC->token), which is cheap on thin pump.fun tokens (~0.04%), while the EXIT
// (token->USDC) costs 10-20x more (~0.5-2%). We are the exit liquidity. Proven
// root cause of systematic negative PnL: the bot enters tokens it cannot exit
// cleanly. Before committing an entry we now request a REVERSE Jupiter quote
// (token->input) sized to the position and read its real priceImpactPct +
// outAmount (Jupiter's own size-aware depth measure, per dev.jup.ag docs) — no
// guessed slippage numbers. Default cap reuses MAX_QUOTE_PRICE_IMPACT_BPS so the
// exit must be at least as liquid as we already require the entry to be.
const WORKER_EXIT_LIQUIDITY_GATE_ENABLED = process.env.WORKER_EXIT_LIQUIDITY_GATE_ENABLED !== 'false';
const WORKER_MAX_EXIT_PRICE_IMPACT_BPS = Number(
  process.env.WORKER_MAX_EXIT_PRICE_IMPACT_BPS ?? MAX_QUOTE_PRICE_IMPACT_BPS,
);
// Round-trip profitability gate. The measured round-trip friction (entry impact +
// exit impact + both platform/AMM fees, all from real Jupiter quotes) is the
// floor the signal's expected edge must clear, plus the safety buffer. This
// replaces the old entry-only cost check that let the bot buy tokens whose exit
// cost alone exceeded any plausible edge.
const WORKER_ROUND_TRIP_GATE_ENABLED = process.env.WORKER_ROUND_TRIP_GATE_ENABLED !== 'false';
// Give-back fix: exit take-profit/stop-loss thresholds must clear the REAL exit
// toll, not an assumed slippage number. The old exit cost floor used
// risk_limits.maxSlippageBps (~50bps) as its slippage term, but the measured
// token->input exit impact is routinely 70-83bps. That gap let "take profit"
// fire when the mid-price gain had not actually cleared what we pay to get out,
// realizing net losses (the give-back). We cache the entry-time reverse-quote
// exit impact (already measured by assessExitLiquidity) per mint and feed it
// into the exit cost floor so take-profit only fires when the round trip is
// genuinely green. Falls back to the assumed slippage when no measurement
// exists (e.g. right after a worker restart).
const WORKER_MEASURED_EXIT_COST_FLOOR_ENABLED = process.env.WORKER_MEASURED_EXIT_COST_FLOOR_ENABLED !== 'false';
// Market-level downtrend gate ("stop fighting the tape"). Per-token momentum can
// flash bullish for a few samples while the broad market is trending down, and
// our universe is long-only (shorts are unavailable for these tokens). Opening
// new longs into a falling market is where the multi-second sign->submit slippage
// and give-back losses cluster. When the broad SOL tape shows a persistent
// downtrend over a longer lookback than the per-strategy signal, we stop opening
// NEW longs and sit in USDC; existing positions are still managed and exited
// normally. Capital preservation is the win in a downtrend.
const WORKER_DOWNTREND_GATE_ENABLED = process.env.WORKER_DOWNTREND_GATE_ENABLED !== 'false';
// Broad-trend lookback in tape samples (longer than per-strategy momentum so it
// captures the market trend, not short-term noise).
const WORKER_DOWNTREND_LOOKBACK_SAMPLES = Number(process.env.WORKER_DOWNTREND_LOOKBACK_SAMPLES ?? 30);
// Minimum negative broad momentum (bps) to classify the market as a downtrend.
const WORKER_DOWNTREND_THRESHOLD_BPS = Number(process.env.WORKER_DOWNTREND_THRESHOLD_BPS ?? 15);
// How many consecutive recent samples must agree the market is bearish before we
// gate entries, so a single dip does not block trading.
const WORKER_DOWNTREND_PERSISTENCE_SAMPLES = Number(process.env.WORKER_DOWNTREND_PERSISTENCE_SAMPLES ?? 3);
const WORKER_UNIVERSE_SCOUT_ENABLED = process.env.WORKER_UNIVERSE_SCOUT_ENABLED !== 'false';
const WORKER_UNIVERSE_SCOUT_MAX_CANDIDATES = Number(process.env.WORKER_UNIVERSE_SCOUT_MAX_CANDIDATES ?? 20);
const WORKER_UNIVERSE_SCOUT_REQUIRE_PERSISTENT_BULLISH = process.env.WORKER_UNIVERSE_SCOUT_REQUIRE_PERSISTENT_BULLISH === 'true';
const WORKER_UNIVERSE_SCOUT_ALLOW_ROUTED_FALLBACK = process.env.WORKER_UNIVERSE_SCOUT_ALLOW_ROUTED_FALLBACK !== 'false';
const WORKER_ENTRY_CORE_UNIVERSE_ONLY = process.env.WORKER_ENTRY_CORE_UNIVERSE_ONLY === 'true';
const WORKER_BLOCK_PUMP_MINT_ENTRIES = process.env.WORKER_BLOCK_PUMP_MINT_ENTRIES !== 'false';
// Restrict entries to these token classes (comma or space separated). Empty = all allowed.
// SOL signal only predicts SOL-correlated tokens — restrict to 'major,sol_beta' to stop bleeding.
const WORKER_ALLOWED_TOKEN_CLASSES: ReadonlySet<string> | null = (() => {
  const raw = process.env.WORKER_ALLOWED_TOKEN_CLASSES?.trim();
  if (!raw) return null;
  return new Set(raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean));
})();
const WORKER_UNIVERSE_SCOUT_MAX_ENTRY_PRICE_IMPACT_BPS = Number(
  process.env.WORKER_UNIVERSE_SCOUT_MAX_ENTRY_PRICE_IMPACT_BPS
  ?? process.env.WORKER_UNIVERSE_SCOUT_MAX_SOL_PRICE_IMPACT_BPS
  ?? 50,
);
// Extra shape gate for non-core Jupiter 1h/trending candidates. Token admission
// proves a token is routeable/safe enough to consider; this prevents buying the
// top of a vertical candle by requiring a pullback plus confirmed reclaim before
// the worker prepares an entry. Core/trusted assets keep the normal gates.
const WORKER_TRENDING_ENTRY_SHAPE_GATE_ENABLED = process.env.WORKER_TRENDING_ENTRY_SHAPE_GATE_ENABLED !== 'false';
const WORKER_TRENDING_ENTRY_SHAPE_MIN_SAMPLES = Number(process.env.WORKER_TRENDING_ENTRY_SHAPE_MIN_SAMPLES ?? 12);
const WORKER_TRENDING_ENTRY_CHASE_LOOKBACK_SAMPLES = Number(process.env.WORKER_TRENDING_ENTRY_CHASE_LOOKBACK_SAMPLES ?? 4);
const WORKER_TRENDING_ENTRY_MAX_RECENT_SURGE_BPS = Number(process.env.WORKER_TRENDING_ENTRY_MAX_RECENT_SURGE_BPS ?? 80);
const WORKER_TRENDING_ENTRY_MIN_PULLBACK_BPS = Number(process.env.WORKER_TRENDING_ENTRY_MIN_PULLBACK_BPS ?? 35);
const WORKER_TRENDING_ENTRY_MIN_RECLAIM_BPS = Number(process.env.WORKER_TRENDING_ENTRY_MIN_RECLAIM_BPS ?? 20);
const WORKER_TRENDING_ENTRY_MAX_RANGE_POSITION_BPS = Number(process.env.WORKER_TRENDING_ENTRY_MAX_RANGE_POSITION_BPS ?? 8500);
const WORKER_TRENDING_ENTRY_MAX_NEGATIVE_WINDOW_BPS = Number(process.env.WORKER_TRENDING_ENTRY_MAX_NEGATIVE_WINDOW_BPS ?? 250);
// ENTRY QUALITY GATE. The single honest "is this token tradeable for profit"
// test, and the decisive filter that keeps us in liquid, tradeable names. Every
// other entry gate checks the ENTRY leg (cheap to buy) or a price-shape signal,
// but profitability is governed by one relationship neither of those captures:
// the move the token can REALISTICALLY reach vs. the cost to round-trip it. We
// require the take-profit the token can plausibly hit (its measured ATR x the
// take-profit ATR multiplier) to clear the measured round-trip cost (entry +
// exit impact + platform fee) by a safety ratio. Liquid majors with cheap exits
// pass at modest volatility; post-pump micro-caps whose exit toll dwarfs their
// remaining volatility are rejected here instead of being bought and then
// force-sold at a loss.
const WORKER_ENTRY_QUALITY_GATE_ENABLED = process.env.WORKER_ENTRY_QUALITY_GATE_ENABLED !== 'false';
const WORKER_ENTRY_QUALITY_TP_COST_RATIO = Number(process.env.WORKER_ENTRY_QUALITY_TP_COST_RATIO ?? 1.2);
// Cost-floor gate for majors (SOL, JUP). Their ATR-based take-profit must clear
// the round-trip cost floor. Prevents entries in flat markets where TP is unreachable.
const WORKER_MAJOR_COST_FLOOR_GATE_ENABLED = process.env.WORKER_MAJOR_COST_FLOOR_GATE_ENABLED !== 'false';
// When the candidate's ATR cannot be computed yet (tape still warming) we cannot
// prove its reachable move beats its cost, so we block rather than gamble on an
// unmeasured token. Set false to allow entries on tokens with no ATR yet.
const WORKER_ENTRY_QUALITY_REQUIRE_ATR = process.env.WORKER_ENTRY_QUALITY_REQUIRE_ATR !== 'false';
// FORCED-SELL BRAKE. The time-decay take-profit ladder lowers a position's take-
// profit target toward the cost floor as it ages, which DUMPS green-but-stuck
// bags near breakeven-minus-fees -- a forced loss exit. Disabled by default so
// winners ride the trailing stop instead of being force-sold flat. Set true to
// re-enable the decay ladder.
const WORKER_TP_TIME_DECAY_ENABLED = process.env.WORKER_TP_TIME_DECAY_ENABLED === 'true';
const WORKER_EXIT_TELEMETRY_ENABLED = process.env.WORKER_EXIT_TELEMETRY_ENABLED !== 'false';
const WORKER_ADAPTIVE_EXIT_SHADOW_ENABLED = process.env.WORKER_ADAPTIVE_EXIT_SHADOW_ENABLED === 'true';
const WORKER_GRID_CHOP_SHADOW_ENABLED = process.env.WORKER_GRID_CHOP_SHADOW_ENABLED === 'true';
const WORKER_INVENTORY_RECONCILE_ENABLED = process.env.WORKER_INVENTORY_RECONCILE_ENABLED !== 'false';
const WORKER_INVENTORY_RECONCILE_MS = Number(process.env.WORKER_INVENTORY_RECONCILE_MS ?? 60_000);
const WORKER_ADAPTIVE_EXIT_CANARY_SESSION_ID = process.env.WORKER_ADAPTIVE_EXIT_CANARY_SESSION_ID?.trim() || null;
// Sessions are ephemeral (a fresh session_wallet + session id every funding cycle), so
// pinning the canary to a single session id forces an env change + redeploy every time a
// new Noah session is created. Scoping by the stable OWNER wallet (the DaLordsForce test
// wallet that funds Noah) lets every new ephemeral Noah session auto-enroll as the canary
// with zero redeploy. Real customer wallets never match, so they are never shadow-scoped.
const WORKER_ADAPTIVE_EXIT_CANARY_OWNER_WALLET = process.env.WORKER_ADAPTIVE_EXIT_CANARY_OWNER_WALLET?.trim() || null;
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
    performanceFeeEnabled?: boolean;
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
  if (status === 'stopping' && !(opts.expectedStatuses?.length === 1 && opts.expectedStatuses[0] === 'stopping')) {
    throw new Error(`worker is not allowed to request session stop for ${id}; only user API stop may move sessions to stopping`);
  }
  if (status === 'stopped' && !(opts.expectedStatuses?.length === 1 && opts.expectedStatuses[0] === 'stopping')) {
    throw new Error(`worker is not allowed to close ${id} unless it is finalizing an existing user-requested stopping session`);
  }

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
const lastInventoryReconcileAtBySession = new Map<string, number>();

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

// ── GeckoTerminal shared 1-min candle feed ───────────────────────────────────
// One fleet-wide feed (never one fetch per bot). Routed through its own governor
// bucket so the free ~30 req/min GeckoTerminal ceiling is never breached. Feeds
// real 1-min candle history into the ATR cost gate, the entry scorer, and the
// ATR exit stops -- all of which were previously blind on the thin live tape.
const GECKO_CANDLES_ENABLED = process.env.WORKER_GECKO_CANDLES_ENABLED !== 'false';
const GECKO_CANDLE_REFRESH_MS = Math.max(60_000, Number(process.env.WORKER_GECKO_CANDLE_REFRESH_MS ?? 300_000));
const GECKO_CANDLE_RPM = Math.max(1, Math.min(28, Number(process.env.WORKER_GECKO_CANDLE_RPM ?? 20)));
const GECKO_CANDLE_MIN_SAMPLES = Math.max(5, Number(process.env.WORKER_GECKO_CANDLE_MIN_SAMPLES ?? 30));
// Freshness gate: block non-SOL entries when the token has no fresh candle data.
const GECKO_CANDLES_REQUIRED_FOR_ENTRY = GECKO_CANDLES_ENABLED
  && process.env.WORKER_GECKO_CANDLES_REQUIRED_FOR_ENTRY !== 'false';

const geckoCandleLimiter = createSharedTokenBucket({
  pool: sharedRatePool,
  key: 'geckoterminal-ohlcv',
  // Small burst: GeckoTerminal 429s after ~4 rapid calls, so cap burst at 2
  // and let the refill rate (RPM/60) carry the steady-state spacing.
  maxTokens: 2,
  refillRatePerSec: GECKO_CANDLE_RPM / 60,
});

const geckoFeed: GeckoTerminalCandleFeed = createGeckoTerminalCandleFeed({
  acquire: () => geckoCandleLimiter.acquire(),
  fetchJson: async (url: string) => {
    // Retry on 429 with linear backoff (cloud egress IPs get rate-limited more
    // aggressively than residential). Non-429 errors fail fast → null → the
    // feed falls back to the live tape for that mint.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const res = await fetch(url, { headers: { accept: 'application/json' } });
        if (res.status === 429) {
          console.log(JSON.stringify({
            level: 'warn', service: 'roguezero-worker', kind: 'gecko_429',
            url: url.slice(0, 120), attempt, ts: new Date().toISOString(),
          }));
          await new Promise((resolve) => setTimeout(resolve, 3000 * (attempt + 1)));
          continue;
        }
        if (!res.ok) {
          console.log(JSON.stringify({
            level: 'warn', service: 'roguezero-worker', kind: 'gecko_http_error',
            status: res.status, url: url.slice(0, 120), ts: new Date().toISOString(),
          }));
          return null;
        }
        return await res.json();
      } catch {
        return null;
      }
    }
    return null;
  },
  log: (entry) => console.warn(JSON.stringify({
    level: 'warn', service: 'roguezero-worker', ...entry, ts: new Date().toISOString(),
  })),
});

// RVOL (relative volume) computation for a mint: current candle volume / avg volume.
// Returns null if insufficient data. RVOL > 1.0 = above-average volume.
const computeRelativeVolume = (mint: string, lookback = 20): number | null => {
  const volumes = geckoFeed.getVolumes(mint);
  if (volumes.length < lookback + 1) return null;
  const currentVolume = volumes[volumes.length - 1];
  const avgVolume = volumes.slice(-lookback - 1, -1).reduce((s, v) => s + v, 0) / lookback;
  if (avgVolume <= 0) return null;
  return currentVolume / avgVolume;
};

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

// Candle-backed tape: prefer GeckoTerminal 1-min candles when fresh (real ATR),
// fall back to Jupiter ~12s tape when candles are missing/stale. SOL always
// uses the Pyth tape (sub-second, always fresh). This is the tape the entry-
// quality, shape, and cost-floor gates should use.
const getCandleBackedPriceTape = (mint: string): readonly MarketTapePoint[] => {
  if (mint === SOL_MINT) {
    return sharedMarketTape.solUsdPyth;
  }
  if (GECKO_CANDLES_ENABLED && geckoFeed.hasFreshCandles(mint)) {
    const candles = geckoFeed.getTape(mint);
    if (candles.length >= GECKO_CANDLE_MIN_SAMPLES) {
      return candles.map((candle) => ({
        sampledAt: candle.sampledAt,
        usdPrice: candle.usdPrice,
        source: 'jupiter-price-v3' as const,
      }));
    }
  }
  return getMomentumTapeForMint(mint);
};

const getSharedMarketTapeSummary = () => ({
  pythDepth: sharedMarketTape.solUsdPyth.length,
  jupiterDepth: sharedMarketTape.solUsdJupiter.length,
  driftDepth: sharedMarketTape.solUsdDrift.length,
  latestPythUsd: sharedMarketTape.solUsdPyth.at(-1)?.usdPrice ?? null,
  latestJupiterUsd: sharedMarketTape.solUsdJupiter.at(-1)?.usdPrice ?? null,
  latestDriftBps: sharedMarketTape.solUsdDrift.at(-1)?.driftBps ?? null,
});

// ── Signal observation harness (measurement-only, no trade behavior) ──────────
//
// Records the signal + liquidity state of every token we COMMIT to enter, then
// samples that token's forward price return at +1/+5/+15m. This isolates SIGNAL
// quality (does the picked token actually go up?) from EXIT/friction quality
// (the realized PnL in swap_executions, which is confounded by our exit timing
// and round-trip toll). Purely additive: it never gates, blocks, or changes any
// trade decision. Disable with WORKER_SIGNAL_OBSERVATIONS_ENABLED=false.
const WORKER_SIGNAL_OBSERVATIONS_ENABLED =
  (process.env.WORKER_SIGNAL_OBSERVATIONS_ENABLED ?? 'true').toLowerCase() !== 'false';
const SIGNAL_OBS_MAX_AGE_MS = 1_800_000; // 30 min — force-complete stragglers
const SIGNAL_OBS_SAMPLE_THROTTLE_MS = 15_000;

const getObservationPriceUsd = (mint: string): number | null => {
  if (mint === SOL_MINT) {
    return lastPythSolSample?.usdPrice ?? lastJupiterSolSample?.usdPrice ?? null;
  }
  const price = latestJupiterUsdByMint.get(mint);
  return typeof price === 'number' && Number.isFinite(price) && price > 0 ? price : null;
};

let signalObservationsReadyPromise: Promise<void> | null = null;

const ensureSignalObservationsReady = async () => {
  if (!signalObservationsReadyPromise) {
    const dbPool = getPool();
    signalObservationsReadyPromise = dbPool.query(`
      CREATE TABLE IF NOT EXISTS signal_observations (
        id UUID PRIMARY KEY,
        session_id UUID NOT NULL,
        observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        mint TEXT NOT NULL,
        symbol TEXT,
        entry_strategy TEXT NOT NULL,
        signal_regime TEXT,
        signal_status TEXT,
        momentum_bps DOUBLE PRECISION,
        recommended_strategy TEXT,
        recommended_reason TEXT,
        entry_price_usd DOUBLE PRECISION NOT NULL,
        entry_impact_bps DOUBLE PRECISION,
        exit_impact_bps DOUBLE PRECISION,
        round_trip_friction_bps DOUBLE PRECISION,
        entry_amount_atomic NUMERIC,
        ret_1m_bps DOUBLE PRECISION,
        ret_5m_bps DOUBLE PRECISION,
        ret_15m_bps DOUBLE PRECISION,
        price_1m_usd DOUBLE PRECISION,
        price_5m_usd DOUBLE PRECISION,
        price_15m_usd DOUBLE PRECISION,
        sampled_1m_at TIMESTAMPTZ,
        sampled_5m_at TIMESTAMPTZ,
        sampled_15m_at TIMESTAMPTZ,
        complete BOOLEAN NOT NULL DEFAULT FALSE
      )
    `)
      .then(() => dbPool.query(`
        CREATE INDEX IF NOT EXISTS signal_observations_pending_idx
        ON signal_observations (complete, observed_at)
        WHERE complete = FALSE
      `))
      .then(() => undefined);
  }

  return signalObservationsReadyPromise;
};

const recordSignalObservation = async (params: {
  session: RawSession;
  mint: string;
  symbol: string | null;
  entryStrategy: StrategyKey;
  signal: NonNullable<Session['serviceControl']['lastSignal']>;
  entryImpactBps: number | null;
  exitImpactBps: number | null;
  roundTripFrictionBps: number | null;
  entryAmountAtomic: number | null;
}): Promise<void> => {
  if (!WORKER_SIGNAL_OBSERVATIONS_ENABLED) return;
  try {
    const entryPriceUsd = getObservationPriceUsd(params.mint);
    if (entryPriceUsd === null) return; // cannot measure a forward return without a price anchor

    const tape: PriceSample[] = getMomentumTapeForMint(params.mint).map((sample) => ({
      usdPrice: sample.usdPrice,
      sampledAt: sample.sampledAt,
    }));
    const recommendation = recommendStrategy(tape);

    await ensureSignalObservationsReady();
    await getPool().query(
      `
        INSERT INTO signal_observations (
          id, session_id, mint, symbol, entry_strategy,
          signal_regime, signal_status, momentum_bps,
          recommended_strategy, recommended_reason,
          entry_price_usd, entry_impact_bps, exit_impact_bps,
          round_trip_friction_bps, entry_amount_atomic
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8,
          $9, $10,
          $11, $12, $13,
          $14, $15
        )
      `,
      [
        randomUUID(),
        params.session.id,
        params.mint,
        params.symbol,
        params.entryStrategy,
        params.signal.regime ?? null,
        params.signal.status ?? null,
        params.signal.momentumBps ?? null,
        recommendation.recommended,
        recommendation.reason,
        entryPriceUsd,
        params.entryImpactBps,
        params.exitImpactBps,
        params.roundTripFrictionBps,
        params.entryAmountAtomic,
      ],
    );
  } catch (err) {
    log('warn', params.session.id, `signal observation record skipped: ${String(err)}`);
  }
};

let lastSignalObsSampleMs = 0;

const sampleSignalObservationForwardReturns = async (): Promise<void> => {
  if (!WORKER_SIGNAL_OBSERVATIONS_ENABLED) return;
  const now = Date.now();
  if (now - lastSignalObsSampleMs < SIGNAL_OBS_SAMPLE_THROTTLE_MS) return;
  lastSignalObsSampleMs = now;

  try {
    await ensureSignalObservationsReady();
    const dbPool = getPool();
    const { rows } = await dbPool.query<{
      id: string;
      mint: string;
      age_ms: string;
      entry_price_usd: string;
      s1: boolean;
      s5: boolean;
      s15: boolean;
    }>(`
      SELECT
        id,
        mint,
        EXTRACT(EPOCH FROM (NOW() - observed_at)) * 1000 AS age_ms,
        entry_price_usd,
        sampled_1m_at IS NOT NULL AS s1,
        sampled_5m_at IS NOT NULL AS s5,
        sampled_15m_at IS NOT NULL AS s15
      FROM signal_observations
      WHERE complete = FALSE
      ORDER BY observed_at ASC
      LIMIT 300
    `);

    for (const row of rows) {
      const ageMs = Number(row.age_ms);
      const entryPrice = Number(row.entry_price_usd);
      const currentPrice = getObservationPriceUsd(row.mint);
      const sets: string[] = [];
      const vals: unknown[] = [];
      let idx = 1;

      const addWindow = (
        alreadySampled: boolean,
        dueMs: number,
        priceCol: string,
        retCol: string,
        atCol: string,
      ): boolean => {
        if (alreadySampled) return true;
        if (ageMs < dueMs) return false;
        if (currentPrice === null || entryPrice <= 0) return false;
        const retBps = Math.round(((currentPrice - entryPrice) / entryPrice) * 10_000);
        sets.push(`${priceCol} = $${idx++}`);
        vals.push(currentPrice);
        sets.push(`${retCol} = $${idx++}`);
        vals.push(retBps);
        sets.push(`${atCol} = NOW()`);
        return true;
      };

      addWindow(row.s1, 60_000, 'price_1m_usd', 'ret_1m_bps', 'sampled_1m_at');
      addWindow(row.s5, 300_000, 'price_5m_usd', 'ret_5m_bps', 'sampled_5m_at');
      const have15 = addWindow(row.s15, 900_000, 'price_15m_usd', 'ret_15m_bps', 'sampled_15m_at');

      const tooOld = ageMs >= SIGNAL_OBS_MAX_AGE_MS;
      if (have15 || tooOld) {
        sets.push('complete = TRUE');
      }

      if (sets.length === 0) continue;
      vals.push(row.id);
      await dbPool.query(`UPDATE signal_observations SET ${sets.join(', ')} WHERE id = $${idx}`, vals);
    }
  } catch (err) {
    console.warn(`[worker] signal observation sampler error: ${String(err)}`);
  }
};

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

// Market-level downtrend detector for the long-only entry gate. Reads the broad
// SOL tape over a longer lookback than the per-strategy signal and requires the
// bearish read to persist across several recent samples, so a single dip does not
// block trading. Returns bearish=false when there is not enough tape yet (we do
// not gate on missing data).
const assessMarketDowntrend = (): { bearish: boolean; momentumBps: number | null } => {
  const samples = sharedMarketTape.solUsdPyth;
  const momentumBps = computeMomentumBpsAtOffset(samples, WORKER_DOWNTREND_LOOKBACK_SAMPLES, 0);
  if (momentumBps === null) {
    return { bearish: false, momentumBps: null };
  }
  const bearish = classifyMomentum(momentumBps, WORKER_DOWNTREND_THRESHOLD_BPS) === 'bearish'
    && hasMomentumRegimePersistence({
      samples,
      lookbackSamples: WORKER_DOWNTREND_LOOKBACK_SAMPLES,
      thresholdBps: WORKER_DOWNTREND_THRESHOLD_BPS,
      regime: 'bearish',
      requiredSamples: WORKER_DOWNTREND_PERSISTENCE_SAMPLES,
    });
  return { bearish, momentumBps };
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

const logSignalEvent = (event: object) => {
  console.log(JSON.stringify({
    service: 'roguezero-worker',
    kind: 'signal',
    ts: new Date().toISOString(),
    ...event,
  }));
};

const logPriceEvent = (event: object) => {
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

type TokenTradeClass = 'major' | 'sol_beta' | 'trend_liquid' | 'long_tail';

const getTokenTradeClass = (mint: string, symbol = resolveTokenSymbol(mint)): TokenTradeClass => {
  const cluster = getClusterForMint(mint);
  if (cluster === 'sol_beta') return 'sol_beta';
  if (mint === SOL_MINT || symbol === 'SOL' || symbol === 'JUP') return 'major';
  if (TRUSTED_ENTRY_UNIVERSE_MINT_SET.has(mint)) return 'trend_liquid';
  return 'long_tail';
};

const isCanaryShadowEnabled = (session: RawSession, enabled: boolean): boolean => {
  if (!enabled) return false;
  return !WORKER_ADAPTIVE_EXIT_CANARY_SESSION_ID || WORKER_ADAPTIVE_EXIT_CANARY_SESSION_ID === session.id;
};

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

    // Measurement-only: sample forward returns for committed-entry observations.
    // Fire-and-forget; never blocks the price loop and swallows its own errors.
    void sampleSignalObservationForwardReturns();
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

// ── Dedicated GeckoTerminal candle refresh loop ──────────────────────────────
// Only refreshes trusted liquid majors: these are the mints the entry-quality /
// shape / ATR gates actually apply to, AND the only ones GeckoTerminal reliably
// indexes with real 1-min OHLCV. Feeding the full universe (incl. pump.fun)
// just burns the rate budget on tokens that always return no_pool.
const runGeckoCandleRefreshTick = async (): Promise<void> => {
  if (!GECKO_CANDLES_ENABLED) return;
  const mints = TRUSTED_ENTRY_UNIVERSE_MINTS
    .filter((mint) => mint && mint !== SOL_MINT && !STABLE_ENTRY_TARGET_MINTS.has(mint));
  if (mints.length === 0) return;
  try {
    const result = await geckoFeed.refreshMints(mints);
    const coverage = geckoFeed.getCoverage();
    console.log(JSON.stringify({
      level: 'info', service: 'roguezero-worker', kind: 'gecko_candle_refresh',
      requested: mints.length, refreshed: result.refreshed, failed: result.failed,
      freshMints: coverage.freshMints, ts: new Date().toISOString(),
    }));
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn', service: 'roguezero-worker', kind: 'gecko_candle_refresh_failed',
      error: error instanceof Error ? error.message : String(error), ts: new Date().toISOString(),
    }));
  }
};

const startGeckoCandleLoop = (): void => {
  if (!GECKO_CANDLES_ENABLED) {
    console.log('[worker] gecko candle feed disabled by env');
    return;
  }
  console.log('[worker] gecko candle feed enabled', JSON.stringify({
    refreshMs: GECKO_CANDLE_REFRESH_MS, rpm: GECKO_CANDLE_RPM,
  }));
  setTimeout(() => {
    void runGeckoCandleRefreshTick();
    setInterval(() => { void runGeckoCandleRefreshTick(); }, GECKO_CANDLE_REFRESH_MS);
  }, 10_000);
};

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
  await persistServiceControl(session, {
    healthState: {
      state: 'error',
      severity: 'error',
      reason: 'runtime_error',
      detail: `${reason}; preserving session status because only the user may stop the session.`,
      updatedAt: new Date().toISOString(),
      blockerCount: 1,
    },
  });
  log('error', session.id, `${reason} — preserving session; only user stop may close`);
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
    await persistServiceControl(session, {
      healthState: {
        state: 'error',
        severity: 'error',
        reason: 'runtime_error',
        detail: 'Activation failed: missing session keypair; preserving session status because only the user may stop the session.',
        updatedAt: new Date().toISOString(),
        blockerCount: 1,
      },
    });
    log('error', session.id, 'ready activation failed: missing session keypair — preserving session; only user stop may close');
    return;
  }

  if (keypair.publicKey.toBase58() !== session.session_wallet) {
    await persistServiceControl(session, {
      healthState: {
        state: 'error',
        severity: 'error',
        reason: 'runtime_error',
        detail: `Activation failed: keypair mismatch stored=${keypair.publicKey.toBase58()} session=${session.session_wallet}; preserving session status because only the user may stop the session.`,
        updatedAt: new Date().toISOString(),
        blockerCount: 1,
      },
    });
    log('error', session.id, `ready activation failed: keypair mismatch stored=${keypair.publicKey.toBase58()} session=${session.session_wallet} — preserving session; only user stop may close`);
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
  // Measured round-trip friction (entry impact + exit impact + fees) from a real
  // reverse Jupiter quote taken at entry time. Null for exits and when the gate
  // is disabled. Used by assessTradeGate to make the entry EV check round-trip
  // aware instead of pricing only the entry leg.
  entryRoundTripFrictionBps?: number | null;
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

// EXIT-side liquidity / round-trip probe. Before committing an entry we ask
// Jupiter what it would cost to sell the position straight back out (token ->
// entry input mint) at the size we would receive. The reverse quote's
// priceImpactPct is Jupiter's own size-aware depth measure, and the round-trip
// friction = (inputSpent - inputRecoveredImmediately) / inputSpent is the real,
// measured cost the signal must overcome. No guessed slippage constants.
const assessExitLiquidity = async (params: {
  entryInputMint: string;
  entryOutputMint: string;
  entryInputAmountAtomic: number;
  entryOutAmountAtomic: number | null;
  takerWallet: string;
  slippageBps: number;
}): Promise<{
  ok: boolean;
  reason: string;
  exitImpactBps: number | null;
  inputRecoveredAtomic: number | null;
  roundTripFrictionBps: number | null;
}> => {
  if (!WORKER_EXIT_LIQUIDITY_GATE_ENABLED) {
    return {
      ok: true,
      reason: 'exit_liquidity_gate_disabled',
      exitImpactBps: null,
      inputRecoveredAtomic: null,
      roundTripFrictionBps: null,
    };
  }

  // Discover the token amount we would receive on entry if the caller did not
  // already have it (route-stability sampling provides it for free otherwise).
  let exitTokenAmountAtomic = params.entryOutAmountAtomic;
  if (!exitTokenAmountAtomic || exitTokenAmountAtomic <= 0) {
    const entryBuild = await apiPost<BuildRouteScoutResponse>('/jupiter/swap/build', {
      inputMint: params.entryInputMint,
      outputMint: params.entryOutputMint,
      amount: String(params.entryInputAmountAtomic),
      taker: params.takerWallet,
      feeTokenSymbol: params.entryInputMint === USDC_MINT || params.entryOutputMint === USDC_MINT ? 'USDC' : 'SOL',
      slippageBps: String(params.slippageBps),
    });
    exitTokenAmountAtomic = parseUnsignedNumeric(entryBuild.data?.build?.outAmount);
    if (!entryBuild.ok || !exitTokenAmountAtomic || exitTokenAmountAtomic <= 0) {
      return {
        ok: false,
        reason: 'exit_probe_entry_route_not_found',
        exitImpactBps: null,
        inputRecoveredAtomic: null,
        roundTripFrictionBps: null,
      };
    }
  }

  const exitBuild = await apiPost<BuildRouteScoutResponse>('/jupiter/swap/build', {
    inputMint: params.entryOutputMint,
    outputMint: params.entryInputMint,
    amount: String(exitTokenAmountAtomic),
    taker: params.takerWallet,
    feeTokenSymbol: params.entryInputMint === USDC_MINT || params.entryOutputMint === USDC_MINT ? 'USDC' : 'SOL',
    slippageBps: String(params.slippageBps),
  });

  const inputRecoveredAtomic = parseUnsignedNumeric(exitBuild.data?.build?.outAmount);
  if (!exitBuild.ok || !exitBuild.data?.build || !inputRecoveredAtomic || inputRecoveredAtomic <= 0) {
    return {
      ok: false,
      reason: 'exit_route_not_found',
      exitImpactBps: null,
      inputRecoveredAtomic: null,
      roundTripFrictionBps: null,
    };
  }

  const exitImpactBps = parseQuotePriceImpactBps(exitBuild.data.build.priceImpactPct ?? null);
  if (exitImpactBps !== null && exitImpactBps > WORKER_MAX_EXIT_PRICE_IMPACT_BPS) {
    return {
      ok: false,
      reason: 'exit_impact_too_high',
      exitImpactBps,
      inputRecoveredAtomic,
      roundTripFrictionBps: null,
    };
  }

  const roundTripFrictionBps = params.entryInputAmountAtomic > 0
    ? Math.round(((params.entryInputAmountAtomic - inputRecoveredAtomic) / params.entryInputAmountAtomic) * 10_000)
    : null;

  return {
    ok: true,
    reason: 'exit_liquid',
    exitImpactBps,
    inputRecoveredAtomic,
    roundTripFrictionBps,
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
        && (!WORKER_ALLOWED_TOKEN_CLASSES || WORKER_ALLOWED_TOKEN_CLASSES.has(getTokenTradeClass(mint, symbol ?? undefined)))
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

type WalletTokenInventory = {
  mint: string;
  symbol: string;
  balanceAtomic: number;
  tokenDecimals: number | null;
  programId: string;
  tokenAccounts: string[];
};

type RecoveredEntryBasis = {
  entryPriceUsd: number | null;
  entryStrategy: SessionPositionState['entryStrategy'];
  entryAt: string | null;
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

const getOnChainMintDecimals = async (mint: PublicKey, programId: PublicKey): Promise<number | null> => {
  const cached = latestJupiterDecimalsByMint.get(mint.toBase58());
  if (typeof cached === 'number' && Number.isFinite(cached)) {
    return cached;
  }

  try {
    const mintAccount = await rlGetMint(mint, programId);
    return mintAccount.decimals;
  } catch {
    return null;
  }
};

const listWalletTokenInventory = async (owner: PublicKey): Promise<WalletTokenInventory[]> => {
  const byMint = new Map<string, WalletTokenInventory>();
  const programs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];

  for (const programId of programs) {
    let tokenAccounts: Awaited<ReturnType<typeof rlGetTokenAccountsByOwner>>;
    try {
      tokenAccounts = await rlGetTokenAccountsByOwner(owner, programId);
    } catch {
      continue;
    }

    for (const tokenAccount of tokenAccounts.value) {
      let account: SplTokenAccount;
      try {
        account = unpackAccount(tokenAccount.pubkey, tokenAccount.account, programId);
      } catch {
        continue;
      }

      const balanceAtomic = Number(account.amount);
      if (!Number.isFinite(balanceAtomic) || balanceAtomic <= 0) {
        continue;
      }

      const mint = account.mint.toBase58();
      if (mint === USDC_MINT) {
        continue;
      }

      const existing = byMint.get(mint);
      if (existing) {
        existing.balanceAtomic += balanceAtomic;
        existing.tokenAccounts.push(tokenAccount.pubkey.toBase58());
        continue;
      }

      byMint.set(mint, {
        mint,
        symbol: resolveTokenSymbol(mint),
        balanceAtomic,
        tokenDecimals: await getOnChainMintDecimals(account.mint, programId),
        programId: programId.toBase58(),
        tokenAccounts: [tokenAccount.pubkey.toBase58()],
      });
    }
  }

  return [...byMint.values()];
};

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' ? value as Record<string, unknown> : null
);

const getExecutionAmountAtomic = (row: { amount?: unknown; build_response?: unknown }, key: 'inAmount' | 'outAmount') => {
  const build = asRecord(row.build_response);
  const fromBuild = build?.[key];
  const parsedBuild = typeof fromBuild === 'string' || typeof fromBuild === 'number'
    ? Number(fromBuild)
    : NaN;
  if (Number.isFinite(parsedBuild) && parsedBuild > 0) {
    return parsedBuild;
  }

  if (key === 'inAmount') {
    const amount = Number(row.amount ?? 0);
    return Number.isFinite(amount) && amount > 0 ? amount : 0;
  }

  return 0;
};

const getConfirmationTokenDeltaAtomic = (
  confirmation: unknown,
  params: { mint: string; owner: string },
): number | null => {
  const snapshot = asRecord(confirmation);
  if (!snapshot) return null;
  const meta = asRecord(snapshot.meta);
  const preTokenBalances = Array.isArray(snapshot.preTokenBalances)
    ? snapshot.preTokenBalances
    : (Array.isArray(meta?.preTokenBalances) ? meta.preTokenBalances : []);
  const postTokenBalances = Array.isArray(snapshot.postTokenBalances)
    ? snapshot.postTokenBalances
    : (Array.isArray(meta?.postTokenBalances) ? meta.postTokenBalances : []);
  const matchingIndexes = new Set<number>();

  const matches = (entry: unknown) => {
    const record = asRecord(entry);
    if (!record || record.mint !== params.mint) return false;
    if (typeof record.owner === 'string' && record.owner !== params.owner) return false;
    return Number.isInteger(record.accountIndex);
  };

  for (const entry of preTokenBalances) {
    if (matches(entry)) matchingIndexes.add(Number(asRecord(entry)?.accountIndex));
  }
  for (const entry of postTokenBalances) {
    if (matches(entry)) matchingIndexes.add(Number(asRecord(entry)?.accountIndex));
  }

  if (matchingIndexes.size === 0) return null;

  const amountOf = (entry: unknown) => {
    const record = asRecord(entry);
    const uiTokenAmount = asRecord(record?.uiTokenAmount);
    const amount = Number(uiTokenAmount?.amount ?? '0');
    return Number.isFinite(amount) ? amount : 0;
  };

  let delta = 0;
  for (const accountIndex of matchingIndexes) {
    const pre = preTokenBalances.find((entry) => Number(asRecord(entry)?.accountIndex) === accountIndex);
    const post = postTokenBalances.find((entry) => Number(asRecord(entry)?.accountIndex) === accountIndex);
    delta += amountOf(post) - amountOf(pre);
  }

  return delta;
};

const parseExecutionStrategy = (value: unknown): SessionPositionState['entryStrategy'] => (
  value === 'momentum' || value === 'mean_reversion' || value === 'supertrend' ? value : null
);

const findRecoveredEntryBasis = async (
  session: RawSession,
  inventory: WalletTokenInventory,
): Promise<RecoveredEntryBasis> => {
  const result = await getPool().query<{
    input_mint: string;
    output_mint: string;
    amount: string | number | null;
    build_response: unknown;
    confirmation: unknown;
    metadata: unknown;
    confirmed_at: Date | null;
    created_at: Date;
  }>(
    `SELECT input_mint, output_mint, amount, build_response, confirmation, metadata, confirmed_at, created_at
       FROM swap_executions
      WHERE taker = $1
        AND status = 'confirmed'
        AND output_mint = $2
        AND input_mint IN ($3, $4)
      ORDER BY confirmed_at DESC NULLS LAST, created_at DESC
      LIMIT 10`,
    [session.session_wallet, inventory.mint, USDC_MINT, SOL_MINT],
  );

  for (const row of result.rows) {
    const observedOutAtomic = getConfirmationTokenDeltaAtomic(row.confirmation, {
      mint: inventory.mint,
      owner: session.session_wallet,
    });
    const outAtomic = observedOutAtomic !== null && observedOutAtomic > 0
      ? observedOutAtomic
      : getExecutionAmountAtomic(row, 'outAmount');
    const outUi = toUiAmount(inventory.mint, outAtomic, inventory.tokenDecimals);
    if (!(outUi > 0)) continue;

    let inputUsd: number | null = null;
    if (row.input_mint === USDC_MINT) {
      inputUsd = getExecutionAmountAtomic(row, 'inAmount') / 1_000_000;
    } else if (row.input_mint === SOL_MINT) {
      const solUsd = lastPythSolSample?.usdPrice ?? lastJupiterSolSample?.usdPrice ?? null;
      const inLamports = getExecutionAmountAtomic(row, 'inAmount');
      inputUsd = solUsd && solUsd > 0 ? (inLamports / 1_000_000_000) * solUsd : null;
    }

    const metadata = asRecord(row.metadata);
    const entryPriceUsd = inputUsd && inputUsd > 0 ? inputUsd / outUi : null;
    if (entryPriceUsd && entryPriceUsd > 0) {
      return {
        entryPriceUsd,
        entryStrategy: parseExecutionStrategy(metadata?.entryStrategy ?? metadata?.scannerStrategy),
        entryAt: (row.confirmed_at ?? row.created_at)?.toISOString?.() ?? null,
      };
    }
  }

  return {
    entryPriceUsd: null,
    entryStrategy: null,
    entryAt: new Date().toISOString(),
  };
};

const reconcileWalletInventoryPositions = async (
  session: RawSession,
  owner: PublicKey,
  positionsState: SessionPositionsState,
): Promise<SessionPositionsState> => {
  if (!WORKER_INVENTORY_RECONCILE_ENABLED) return positionsState;

  const now = Date.now();
  const lastRunAt = lastInventoryReconcileAtBySession.get(session.id) ?? 0;
  if (now - lastRunAt < WORKER_INVENTORY_RECONCILE_MS) {
    return positionsState;
  }
  lastInventoryReconcileAtBySession.set(session.id, now);

  const inventory = await listWalletTokenInventory(owner);
  if (inventory.length === 0) return positionsState;

  const nextPositions = { ...positionsState.positions };
  const recovered: string[] = [];
  const quantitySynced: string[] = [];

  for (const holding of inventory) {
    const existing = nextPositions[holding.mint] ?? null;
    const markPriceUsd = latestJupiterUsdByMint.get(holding.mint) ?? existing?.lastMarkedPriceUsd ?? null;

    if (existing && isLongPositionStatus(existing.status)) {
      const trackedQuantityAtomic = Number(existing.quantityAtomic ?? 0);
      if (Number.isFinite(trackedQuantityAtomic) && trackedQuantityAtomic !== holding.balanceAtomic) {
        nextPositions[holding.mint] = {
          ...existing,
          quantityAtomic: String(holding.balanceAtomic),
          tokenDecimals: existing.tokenDecimals ?? holding.tokenDecimals,
          positionSymbol: existing.positionSymbol ?? holding.symbol,
          lastMarkedPriceUsd: markPriceUsd,
          lastMarkedAt: markPriceUsd ? new Date().toISOString() : existing.lastMarkedAt,
        };
        quantitySynced.push(`${holding.symbol}:${trackedQuantityAtomic}->${holding.balanceAtomic}`);
      }
      continue;
    }

    const basis = await findRecoveredEntryBasis(session, holding);
    nextPositions[holding.mint] = {
      status: holding.mint === SOL_MINT ? 'long_sol' : 'long',
      positionMint: holding.mint,
      positionSymbol: holding.symbol,
      entryStrategy: basis.entryStrategy,
      entryPriceUsd: basis.entryPriceUsd,
      entryAt: basis.entryAt,
      quantityAtomic: String(holding.balanceAtomic),
      tokenDecimals: holding.tokenDecimals,
      highWaterPriceUsd: markPriceUsd ?? basis.entryPriceUsd,
      lastMarkedPriceUsd: markPriceUsd ?? basis.entryPriceUsd,
      lastMarkedAt: markPriceUsd || basis.entryPriceUsd ? new Date().toISOString() : null,
      lastComputedAtrUsd: null,
      lastComputedAtrBps: null,
      atrComputedAt: null,
      maxFavorableBps: null,
      maxFavorableAt: null,
      maxAdverseBps: null,
      maxAdverseAt: null,
      entryQualityScore: null,
      entryQualityBand: null,
      entryCostBps: pendingEntryCostBpsByMint.get(holding.mint) ?? null,
      measuredExitImpactBps: measuredExitImpactBpsByMint.get(holding.mint) ?? null,
      pendingExitReason: basis.entryPriceUsd === null ? 'stop_loss' : null,
      exitReason: null,
      partialExitDone: false,
    };
    recovered.push(`${holding.symbol}:${holding.balanceAtomic}`);
  }

  // Remove phantom positions: tracked in DB but no longer on-chain.
  // This can happen when the API exit-confirm path fails to remove the position
  // or when the race between worker recovery and API reconcile leaves stale data.
  const inventoryMints = new Set(inventory.map((h) => h.mint));
  const phantomRemoved: string[] = [];
  for (const [mint, pos] of Object.entries(nextPositions)) {
    if (isLongPositionStatus(pos.status) && !inventoryMints.has(mint)) {
      delete nextPositions[mint];
      phantomRemoved.push(`${pos.positionSymbol ?? mint}`);
    }
  }

  if (recovered.length === 0 && quantitySynced.length === 0 && phantomRemoved.length === 0) {
    return positionsState;
  }

  const reconciled = await persistPositionsState(session, {
    activePositionMint: positionsState.activePositionMint && nextPositions[positionsState.activePositionMint]
      ? positionsState.activePositionMint
      : (Object.keys(nextPositions)[0] ?? null),
    positions: nextPositions,
  });

  log(
    'warn',
    session.id,
    `wallet inventory reconciled into positionsState recovered=[${recovered.join(',')}] quantitySynced=[${quantitySynced.join(',')}] phantomRemoved=[${phantomRemoved.join(',')}]`,
  );

  return reconciled;
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
  roundTripFrictionBps: number | null;
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

  // Entry EV gate is now ROUND-TRIP aware. The old design enforced only the entry
  // leg's friction and deferred round-trip profitability "to the exit" — but the
  // exit cannot protect profit when the token is illiquid: paired-trade evidence
  // showed exit price impact 10-20x the entry's, so even take-profits realized
  // net losses. We now require the signal's expected edge to clear the MEASURED
  // round-trip friction (entry impact + exit impact + both legs' fees, taken from
  // a real reverse Jupiter quote at entry time) plus network cost and the safety
  // buffer. When the reverse-quote probe is unavailable we fall back to the
  // entry-leg-only cost so the gate degrades safely rather than blocking blindly.
  if (params.direction === 'enter_long') {
    const entryLegCostBps = networkCostBps + routePriceImpactBps;
    const costWithinCap = entryLegCostBps <= params.entryCostCapBps;
    // Round-trip friction already includes the entry route impact, so use it as
    // the dominant cost term when present; otherwise price only the entry leg.
    const roundTripCostBps = params.roundTripFrictionBps !== null
      ? networkCostBps + Math.max(routePriceImpactBps, params.roundTripFrictionBps)
      : entryLegCostBps;
    const edgeClearsCost = expectedEdgeBps > roundTripCostBps + params.safetyBufferBps;
    const allowed = costWithinCap && edgeClearsCost;
    const reason = !costWithinCap
      ? 'entry_leg_cost_too_high'
      : (edgeClearsCost ? 'entry_edge_exceeds_cost' : 'entry_edge_below_round_trip_cost');
    return {
      allowed,
      reason,
      expectedEdgeBps,
      estimatedCostBps: roundTripCostBps,
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

// Caches the entry-time measured exit price impact (token -> input, bps) per mint
// from assessExitLiquidity's reverse Jupiter probe. Read by the exit cost floor so
// take-profit/stop-loss thresholds reflect the REAL toll to get out, not an
// assumed slippage number. Best-effort: cleared on restart, falls back to assumed.
const measuredExitImpactBpsByMint = new Map<string, number>();

// Entry-leg round-trip friction captured at trade plan commit time, keyed by
// output mint. Used to populate entryCostBps on position state after on-chain
// confirmation so the exit cost floor can account for the REAL entry cost.
const pendingEntryCostBpsByMint = new Map<string, number>();

const entryRejectCooldowns = new Map<string, { expiresAtMs: number; reason: string }>();
const ENTRY_REJECT_COOLDOWN_REASONS = new Set([
  'entry_edge_below_cost',
  'entry_leg_cost_too_high',
  'entry_quality_below_threshold',
  'exit_impact_too_high',
  'exit_route_not_found',
  'exit_probe_entry_route_not_found',
  'price_impact_too_high',
  'route_stability_impact_too_high',
  'route_stability_impact_unstable',
  'route_stability_output_unstable',
]);

const getEntryRejectCooldownKey = (sessionId: string, mint: string) => `${sessionId}:${mint}`;

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

const computeExitCostFloorBps = (
  session: RawSession,
  positionState?: NonNullable<Session['serviceControl']['positionState']> | null,
): number => {
  // Prefer persisted measuredExitImpactBps from position state (survives restart),
  // fall back to in-memory cache, then to null (uses maxSlippageBps assumption).
  const persistedExitImpact = positionState?.measuredExitImpactBps ?? null;
  const inMemoryExitImpact = WORKER_MEASURED_EXIT_COST_FLOOR_ENABLED && positionState
    ? measuredExitImpactBpsByMint.get(getPositionMint(positionState)) ?? null
    : null;
  const measuredExitImpactBps = persistedExitImpact ?? inMemoryExitImpact;
  // Use the measured exit impact when it is HIGHER than the assumed slippage:
  // the floor must never under-price the real exit toll, but we also never let a
  // (rarely) cheaper measurement loosen the configured slippage assumption.
  const slippageComponentBps = measuredExitImpactBps !== null
    ? Math.max(measuredExitImpactBps, session.risk_limits.maxSlippageBps)
    : session.risk_limits.maxSlippageBps;
  // Round-trip cost: entry-leg cost (from position state if tracked, else mirror
  // the exit cost as a conservative estimate) + exit-leg cost. The take-profit
  // target must clear the TOTAL friction, not just the exit leg.
  const entryCostBps = positionState?.entryCostBps ?? slippageComponentBps;
  const exitOnlyCostBps = Math.max(
    positionExitPolicy.exitCostFloorBps,
    slippageComponentBps + session.service_control.platformFeeBps + signalPolicy.edgeSafetyBufferBps,
  );
  return exitOnlyCostBps + entryCostBps;
};

const computeDynamicExitThresholds = (
  session: RawSession,
  positionState: NonNullable<Session['serviceControl']['positionState']>,
  signalSnapshot: NonNullable<Session['serviceControl']['lastSignal']>,
): DynamicExitThresholds => {
  const costFloorBps = computeExitCostFloorBps(session, positionState);
  const atrBps = positionState.lastComputedAtrBps ?? null;

  // ── B4: Regime-based exit scaling ─────────────────────────────────────────
  // Trending market → widen TP and trailing stop (let profits run)
  // Ranging market → tighten TP and trailing stop (take quick profits)
  // Default/choppy → no adjustment
  const regime = recommendStrategy(sharedMarketTape.solUsdPyth);
  let regimeTpScale = 1.0;
  let regimeTrailingScale = 1.0;
  if (regime.reason === 'expanding_bands_steep_slope') {
    // Trending: widen targets 30% — let winners ride
    regimeTpScale = 1.3;
    regimeTrailingScale = 1.2;
  } else if (regime.reason === 'narrow_bands_flat_slope') {
    // Ranging: tighten targets 20% — take quick profits, avoid chop reversals
    regimeTpScale = 0.8;
    regimeTrailingScale = 0.8;
  }

  // ── C2: Token-class exit profile adjustment ───────────────────────────────
  // Majors: tighter TP (less volatile, take what the market gives)
  // sol_beta/trend_liquid: standard multipliers
  // long_tail: widen TP (+20%), tighten trailing (-20%) (high vol, capture spikes but protect gains)
  const mint = getPositionMint(positionState);
  const tokenClass = getTokenTradeClass(mint, getPositionSymbol(positionState));
  let classTpScale = 1.0;
  let classTrailingScale = 1.0;
  if (tokenClass === 'major') {
    classTpScale = 0.85;
    classTrailingScale = 0.9;
  } else if (tokenClass === 'long_tail') {
    classTpScale = 1.2;
    classTrailingScale = 0.8;
  }

  // Combine regime + class scales
  const combinedTpScale = regimeTpScale * classTpScale;
  const combinedTrailingScale = regimeTrailingScale * classTrailingScale;

  // Time-decay take-profit ladder: a fresh position must clear its full target,
  // but as it ages the required take-profit decays linearly toward the cost
  // floor (breakeven + fees). This frees capital from stale positions that are
  // green-but-stuck without ever realizing a take-profit below cost. Stop-loss
  // must stay independent from the cost floor so loss caps remain hard caps.
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
      takeProfitBps: applyTakeProfitTimeDecay(Math.max(
        Math.round(positionExitPolicy.takeProfitBps * combinedTpScale),
        costFloorBps,
      )),
      stopLossBps: computeStopLossThresholdBps({
        configuredStopLossBps: positionExitPolicy.stopLossBps,
        atrBps: null,
        atrStopLossMultiplier: positionExitPolicy.atrStopLossMultiplier,
      }),
      trailingStopBps: Math.max(
        Math.round(positionExitPolicy.trailingStopBps * combinedTrailingScale),
        costFloorBps,
      ),
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
      Math.round(atrBps * positionExitPolicy.atrTakeProfitMultiplier * (1 + signalStrengthBoost) * combinedTpScale),
    )),
    stopLossBps: computeStopLossThresholdBps({
      configuredStopLossBps: positionExitPolicy.stopLossBps,
      atrBps,
      atrStopLossMultiplier: positionExitPolicy.atrStopLossMultiplier,
    }),
    trailingStopBps: Math.max(
      costFloorBps,
      Math.round(atrBps * positionExitPolicy.atrTrailingStopMultiplier * combinedTrailingScale),
    ),
    atrBps,
    costFloorBps,
    mode: 'atr',
  };
};

// Telemetry marker: exit intelligence shadow layer v1.
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

  // Compute total portfolio value: base balance + all position values at mark
  const solPriceForPortfolio = lastPythSolSample?.usdPrice ?? lastJupiterSolSample?.usdPrice ?? 0;
  let totalPortfolioValueUsd = 0;
  // Add base balance value
  const baseBalanceAtomic = Number(session.funding.currentBalanceAtomic ?? '0');
  if (session.funding.fundingMint === USDC_MINT) {
    // USDC-based session: base balance is USDC
    totalPortfolioValueUsd += baseBalanceAtomic / USDC_ATOMIC_PER_USD;
  } else {
    // SOL-based session: base balance is SOL lamports
    totalPortfolioValueUsd += (baseBalanceAtomic / 1_000_000_000) * solPriceForPortfolio;
  }
  // Add position values at mark price
  for (const [pMint, pPos] of Object.entries(nextPositions)) {
    if (isLongPositionStatus(pPos.status) && pPos.lastMarkedPriceUsd && pPos.quantityAtomic) {
      const pQty = toUiAmount(pMint, Number(pPos.quantityAtomic), pPos.tokenDecimals ?? undefined);
      totalPortfolioValueUsd += pPos.lastMarkedPriceUsd * pQty;
    }
  }
  // Also compute starting value in USD for PnL comparison
  const startAtomic = Number(session.funding.startingBalanceAtomic ?? '0');
  const startingValueUsd = session.funding.fundingMint === USDC_MINT
    ? startAtomic / USDC_ATOMIC_PER_USD
    : (startAtomic / 1_000_000_000) * solPriceForPortfolio;
  const roundedPortfolio = Number(totalPortfolioValueUsd.toFixed(6));
  const roundedStartingValue = Number(startingValueUsd.toFixed(6));

  const roundedUnrealized = Number(totalUnrealizedPnlUsd.toFixed(6));
  const fundingPatchObj: Record<string, unknown> = {};
  if (roundedUnrealized !== session.funding.unrealizedPnlUsd) {
    fundingPatchObj.unrealizedPnlUsd = roundedUnrealized;
  }
  if (roundedPortfolio !== (session.funding as any).totalPortfolioValueUsd) {
    fundingPatchObj.totalPortfolioValueUsd = roundedPortfolio;
  }
  if (roundedStartingValue !== (session.funding as any).startingValueUsd) {
    fundingPatchObj.startingValueUsd = roundedStartingValue;
  }
  if (Object.keys(fundingPatchObj).length > 0) {
    await mergeFundingPatch(session, fundingPatchObj);
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

  if (positionState.pendingExitReason && (positionState.entryPriceUsd === null || markPriceUsd === null)) {
    return {
      shouldExit: true,
      reason: positionState.pendingExitReason,
      markPriceUsd,
      pnlBps,
      trailingDrawdownBps,
      thresholds,
    };
  }

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
  // position. They must never dump a position at a gross gain that is actually a
  // NET loss after the round-trip toll -- the old `pnlBps > 0` gate fired on any
  // positive mark, so every reversal that closed between +1bps and the cost floor
  // realized a small net loss (fees + exit impact exceeded the tiny gross gain).
  // This was the single most frequent exit in production and the dominant bleed.
  // Require the gross mark gain to clear the measured exit cost floor (exit impact
  // + platform fee + safety buffer) so a reversal exit only triggers when it
  // genuinely locks in NET profit; otherwise we hold and let stop_loss own the
  // downside and take_profit own the upside.
  if (signalSnapshot.regime === 'bearish' && pnlBps !== null && pnlBps > thresholds.costFloorBps) {
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
            maxAdverseBps: typeof evaluation.maxAdverseBps === 'number' ? evaluation.maxAdverseBps : null,
            suggestedSellBps: 10000,
            suggestedStopBps: null,
          };
        }

        if (pnlBps !== null && pnlBps >= (tokenClass === 'long_tail' ? 60 : 85)) {
          return {
            mint: String(evaluation.mint),
            symbol,
            tokenClass,
            action: 'partial_take_profit' as const,
            reason: tokenClass === 'long_tail' ? 'fast_partial_for_long_tail_profit' : 'first_partial_profit_zone',
            pnlBps,
            maxFavorableBps,
            maxAdverseBps: typeof evaluation.maxAdverseBps === 'number' ? evaluation.maxAdverseBps : null,
            suggestedSellBps: tokenClass === 'long_tail' ? 5000 : 3000,
            suggestedStopBps: Math.max(-10, -(typeof evaluation.thresholds === 'object' && evaluation.thresholds !== null && 'costFloorBps' in evaluation.thresholds
              ? Number((evaluation.thresholds as { costFloorBps?: unknown }).costFloorBps ?? 0)
              : 0)),
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
            maxAdverseBps: typeof evaluation.maxAdverseBps === 'number' ? evaluation.maxAdverseBps : null,
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
          maxAdverseBps: typeof evaluation.maxAdverseBps === 'number' ? evaluation.maxAdverseBps : null,
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

const buildGridChopShadow = (params: {
  session: RawSession;
  evaluations: Array<Record<string, unknown>>;
}) => {
  const enabled = isCanaryShadowEnabled(params.session, WORKER_GRID_CHOP_SHADOW_ENABLED);
  const marketRegime = enabled && params.evaluations.some((evaluation) => evaluation.signalRegime === 'flat')
    ? 'chop' as const
    : enabled
      ? 'trend' as const
      : 'unknown' as const;

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
          const action = marketRegime !== 'chop'
            ? 'grid_disabled' as const
            : pnlBps !== null && pnlBps >= 60
              ? 'grid_sell_zone' as const
              : drawdownBps !== null && drawdownBps <= -60
                ? 'grid_buy_zone' as const
                : 'grid_hold' as const;
          return {
            mint: String(evaluation.mint),
            symbol: String(evaluation.symbol ?? 'UNKNOWN'),
            tokenClass,
            action,
            pnlBps,
            drawdownBps,
            reason: action === 'grid_disabled'
              ? 'not_chop_regime'
              : action === 'grid_sell_zone'
                ? 'range_upper_profit_zone'
                : action === 'grid_buy_zone'
                  ? 'range_lower_pullback_zone'
                  : 'inside_grid_neutral_zone',
          };
        })
      : [],
  };
};

// ---------------------------------------------------------------------------
// Shadow decision history (Step C measurement).
// Observation-only, canary-scoped. The live service_control jsonb only holds
// the LATEST shadow decision (it is overwritten every cycle), so it cannot be
// used to compare a decision against the PnL that followed it. This appends one
// durable row per position per cycle (decision + a price anchor) so a later
// read can measure "what the shadow said at T" vs "what PnL did after T".
// It does NOT change any trade behavior.
let exitShadowHistoryReadyPromise: Promise<void> | null = null;

const ensureExitShadowHistoryReady = async () => {
  if (!exitShadowHistoryReadyPromise) {
    const dbPool = getPool();
    exitShadowHistoryReadyPromise = dbPool.query(`
      CREATE TABLE IF NOT EXISTS exit_shadow_decisions (
        id UUID PRIMARY KEY,
        session_id UUID NOT NULL,
        decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        cycle_at TIMESTAMPTZ,
        mint TEXT NOT NULL,
        symbol TEXT,
        token_class TEXT,
        current_should_exit BOOLEAN,
        current_exit_reason TEXT,
        adaptive_action TEXT,
        adaptive_reason TEXT,
        adaptive_suggested_sell_bps INTEGER,
        adaptive_suggested_stop_bps INTEGER,
        grid_regime TEXT,
        grid_action TEXT,
        grid_reason TEXT,
        pnl_bps DOUBLE PRECISION,
        max_favorable_bps DOUBLE PRECISION,
        max_adverse_bps DOUBLE PRECISION,
        drawdown_bps DOUBLE PRECISION,
        mark_price_usd DOUBLE PRECISION,
        entry_price_usd DOUBLE PRECISION,
        high_water_price_usd DOUBLE PRECISION
      )
    `)
      .then(() => dbPool.query(`
        CREATE INDEX IF NOT EXISTS exit_shadow_decisions_session_mint_idx
        ON exit_shadow_decisions (session_id, mint, decided_at)
      `))
      .then(() => undefined);
  }

  return exitShadowHistoryReadyPromise;
};

const recordExitShadowDecisions = async (params: {
  session: RawSession;
  evaluations: Array<Record<string, unknown>>;
  adaptiveExitShadow: ReturnType<typeof buildAdaptiveExitShadow>;
  gridChopShadow: ReturnType<typeof buildGridChopShadow>;
}): Promise<void> => {
  // Only persist history for the canary (shadow.enabled already encodes the
  // canary scoping via isCanaryShadowEnabled).
  if (!params.adaptiveExitShadow.enabled) return;
  if (params.evaluations.length === 0) return;
  try {
    const adaptiveByMint = new Map(
      params.adaptiveExitShadow.decisions.map((decision) => [decision.mint, decision] as const),
    );
    const gridByMint = new Map(
      params.gridChopShadow.candidates.map((candidate) => [candidate.mint, candidate] as const),
    );

    await ensureExitShadowHistoryReady();
    const dbPool = getPool();
    for (const evaluation of params.evaluations) {
      const mint = String(evaluation.mint);
      const adaptive = adaptiveByMint.get(mint);
      const grid = gridByMint.get(mint);
      await dbPool.query(
        `
          INSERT INTO exit_shadow_decisions (
            id, session_id, cycle_at, mint, symbol, token_class,
            current_should_exit, current_exit_reason,
            adaptive_action, adaptive_reason,
            adaptive_suggested_sell_bps, adaptive_suggested_stop_bps,
            grid_regime, grid_action, grid_reason,
            pnl_bps, max_favorable_bps, max_adverse_bps, drawdown_bps,
            mark_price_usd, entry_price_usd, high_water_price_usd
          ) VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8,
            $9, $10,
            $11, $12,
            $13, $14, $15,
            $16, $17, $18, $19,
            $20, $21, $22
          )
        `,
        [
          randomUUID(),
          params.session.id,
          params.adaptiveExitShadow.at,
          mint,
          typeof evaluation.symbol === 'string' ? evaluation.symbol : null,
          typeof evaluation.tokenClass === 'string' ? evaluation.tokenClass : null,
          typeof evaluation.shouldExit === 'boolean' ? evaluation.shouldExit : null,
          typeof evaluation.reason === 'string' ? evaluation.reason : null,
          adaptive?.action ?? null,
          adaptive?.reason ?? null,
          adaptive?.suggestedSellBps ?? null,
          adaptive?.suggestedStopBps ?? null,
          params.gridChopShadow.marketRegime,
          grid?.action ?? null,
          grid?.reason ?? null,
          typeof evaluation.pnlBps === 'number' ? evaluation.pnlBps : null,
          typeof evaluation.maxFavorableBps === 'number' ? evaluation.maxFavorableBps : null,
          typeof evaluation.maxAdverseBps === 'number' ? evaluation.maxAdverseBps : null,
          typeof evaluation.trailingDrawdownBps === 'number' ? evaluation.trailingDrawdownBps : null,
          typeof evaluation.markPriceUsd === 'number' ? evaluation.markPriceUsd : null,
          typeof evaluation.entryPriceUsd === 'number' ? evaluation.entryPriceUsd : null,
          typeof evaluation.highWaterPriceUsd === 'number' ? evaluation.highWaterPriceUsd : null,
        ],
      );
    }
  } catch (err) {
    log('warn', params.session.id, `exit shadow decision history skipped: ${String(err)}`);
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
  const keypair = await getKeypair(session.id);
  if (!keypair) {
    await persistTradeDecision(session, 'blocked', 'missing_session_keypair');
    log('warn', session.id, 'no keypair found â€” skipping trade');
    return;
  }

  // Orphan recovery must run on every cycle, BEFORE the in-flight guard.
  // reconcileWalletInventoryPositions is read-only on-chain recovery (no submit),
  // so it is safe to run while an execution is pending. Running it after the
  // in-flight guard meant a single stuck execution starved the very safety net
  // that recovers stranded on-chain tokens — leaving real token value untracked
  // and never sold by the exit path.
  let positionsState = getPositionsState(session);
  positionsState = await reconcileWalletInventoryPositions(session, keypair.publicKey, positionsState).catch((err) => {
    log('warn', session.id, `wallet inventory reconciliation skipped: ${String(err)}`);
    return positionsState;
  });

  // Dedup guard: skip new submissions if there's an in-flight execution for this
  // wallet. Prevents double-submit if worker restarts between prepare and confirm.
  // Placed AFTER orphan recovery so reconcile always runs.
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

  positionsState = await refreshPositionsMarks(session, positionsState);
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

  // True round-robin: each enabled strategy gets ONE exclusive loop turn to open
  // an entry, then the baton passes to the next strategy — "trade or skip to the
  // next strategy" — regardless of whether it traded. Previously the scan
  // evaluated ALL strategies every loop and took the FIRST that flipped bullish,
  // which structurally handed almost every entry to whichever strategy had the
  // loosest bullish gate (supertrend), starving the others. The pointer also only
  // advanced AFTER a trade, so a quiet/blocked active strategy would dwell
  // indefinitely. The baton-pass below (after signal selection) replaces both the
  // old trade-only advance and the unused fixed 15-minute interval.
  const rotationIntervalMinutes =
    session.service_control.rotationState?.rotationIntervalMinutes ?? DEFAULT_ROTATION_INTERVAL_MINUTES;

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

  // Scan strategies in order starting from active. If the active strategy's
  // signal is blocked (not ready or bearish), try the next enabled strategy.
  // First strategy with a usable signal wins entry this loop.
  for (const strategy of strategyScanOrder) {
    const signal = strategy === activeStrategy
      ? runtimeSignal
      : buildSessionSignalForStrategy(strategy, pythTape, strategyConfig);
    strategySignalByKey.set(strategy, signal);

    if (signal.status === 'ready' && signal.regime !== 'bearish') {
      selectedEntryStrategy = strategy;
      selectedEntrySignal = signal;
      runtimeSignal = signal;
      break;
    }
  }

  await persistLastSignal(session, selectedEntrySignal ?? runtimeSignal);

  // Always advance the rotation pointer for next loop so we don't dwell on
  // a blocked strategy. Advance past whichever strategy was selected (or past
  // activeStrategy if all were blocked).
  if (strategyConfig.autoRotationEnabled && enabledStrategies.length > 1) {
    const advanceFrom = selectedEntryStrategy ?? activeStrategy;
    const nextStrategy = getNextStrategyInSequence(advanceFrom, enabledStrategies);
    if (nextStrategy !== activeStrategy) {
      await persistServiceControl(session, {
        rotationState: {
          activeStrategy: nextStrategy,
          queuedStrategy: nextStrategy,
          rotationIntervalMinutes,
          lastRotatedAt: new Date().toISOString(),
          lockedUntil: null,
        },
      } as any);
      log('info', session.id, `strategy rotation: ${activeStrategy} → ${nextStrategy} (selected=${selectedEntryStrategy ?? 'none'})`);
    }
  }

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
    await persistTradeDecision(session, 'blocked', 'insufficient_balance');
    log('warn', session.id, `insufficient balance for trade: ${balance}/${minimumRequiredLamports} lamports`);
    log('warn', session.id, 'balance depleted for trading — preserving active session; only user stop may sweep');
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
    const exitCandidates: Array<{
      mint: string;
      position: SessionPositionState;
      signal: NonNullable<Session['serviceControl']['lastSignal']>;
      trigger: ExitTriggerDecision;
    }> = [];
    const exitEvaluations: Array<Record<string, unknown>> = [];

    for (const { mint, position } of openPositions) {
      const positionStrategy = position.entryStrategy && enabledStrategies.includes(position.entryStrategy)
        ? position.entryStrategy
        : activeStrategy;
      const signalForPosition = mint === SOL_MINT
        ? (strategySignalByKey.get(positionStrategy) ?? buildSessionSignalForStrategy(positionStrategy, pythTape, strategyConfig))
        : buildRuntimeSignalForMint(mint, positionStrategy, strategyConfig);
      const exitTrigger = evaluateExitTrigger(session, position, signalForPosition);
      const tokenClass = getTokenTradeClass(mint, getPositionSymbol(position));
      const exitEvaluation = {
        at: new Date().toISOString(),
        mint,
        symbol: getPositionSymbol(position),
        tokenClass,
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
      };
      exitEvaluations.push(exitEvaluation);

      if (
        !exitTrigger.shouldExit
        && exitTrigger.pnlBps !== null
        && exitTrigger.pnlBps <= -positionExitPolicy.stopLossBps
      ) {
        log(
          'warn',
          session.id,
          `exit evaluation did not trigger despite configured stop-loss breach: ${JSON.stringify(exitEvaluation)}`,
        );
      }

      if (!exitTrigger.shouldExit) {
        if (position.pendingExitReason !== null) {
          nextPositions[mint] = {
            ...position,
            pendingExitReason: null,
          };
          positionsChanged = true;
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
      const adaptiveExitShadow = buildAdaptiveExitShadow({ session, evaluations: exitEvaluations });
      const gridChopShadow = buildGridChopShadow({ session, evaluations: exitEvaluations });
      await persistServiceControl(session, {
        lastExitEvaluations: exitEvaluations,
        lastExitEvaluation: exitEvaluations.length === 1 ? exitEvaluations[0] : exitEvaluations,
        adaptiveExitShadow,
        gridChopShadow,
      } as any);
      // Append a durable, canary-scoped decision row per position so Step C can
      // compare each shadow decision against the PnL that followed it. Detached
      // from the trade loop (does not block, does not change behavior).
      void recordExitShadowDecisions({ session, evaluations: exitEvaluations, adaptiveExitShadow, gridChopShadow });
    }

    if (positionsChanged) {
      positionsState = await persistPositionsState(session, {
        activePositionMint: positionsState.activePositionMint,
        positions: nextPositions,
      });
      positionState = summarizePositionsState(positionsState, session.service_control.positionState ?? undefined);
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
      const exitAmountLamports = computeFullExitAmountAtomic({
        walletBalanceAtomic: exitWalletBalanceAtomic,
        reserveAtomic: exitReserveAtomic,
        positionQuantityAtomic: positionState.quantityAtomic,
      });

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

    // Market-level downtrend gate ("stop fighting the tape"). Only NEW entries are
    // blocked: any exit/rebalance tradePlan set above still executes, and open
    // positions continue to be managed and exited normally. When the broad market
    // is trending down we sit in USDC rather than open long-only positions into a
    // falling tape (where give-back and sign->submit slippage losses cluster).
    if (!tradePlan && WORKER_DOWNTREND_GATE_ENABLED) {
      const marketTrend = assessMarketDowntrend();
      if (marketTrend.bearish) {
        await persistTradeDecision(session, 'blocked', 'market_downtrend_no_entry');
        await persistLastTradeGate(session, {
          at: new Date().toISOString(),
          decision: 'blocked',
          reason: 'market_downtrend_no_entry',
          expectedEdgeBps: runtimeSignal.momentumBps,
          estimatedCostBps: null,
          safetyBufferBps: null,
        });
        log(
          'info',
          session.id,
          `entry blocked: market downtrend (broad SOL momentum=${marketTrend.momentumBps}bps over ${WORKER_DOWNTREND_LOOKBACK_SAMPLES} samples, threshold=${WORKER_DOWNTREND_THRESHOLD_BPS}bps) → sitting in USDC`,
        );
        return;
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

    if (tokenEntrySignal.status !== 'ready' || tokenEntrySignal.regime === 'bearish') {
      await persistTradeDecision(session, 'blocked', 'entry_token_signal_not_bullish');
      await persistLastTradeGate(session, {
        at: new Date().toISOString(),
        decision: 'blocked',
        reason: 'entry_token_signal_not_bullish',
        expectedEdgeBps: tokenEntrySignal.momentumBps,
        estimatedCostBps: null,
        safetyBufferBps: strategyConfig.momentum.edgeSafetyBufferBps,
      });
      log('info', session.id, `entry blocked: token signal bearish for ${resolveTokenSymbol(selectedEntryMint)} (${selectedEntryMint})`);
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

    // FRESHNESS GATE: non-SOL entries require fresh GeckoTerminal candles. Without
    // them the shape/ATR scorers fall back to the blind ~60s drift tape and the bot
    // enters on no real signal -- the proven loss path on JTO/BONK. Block instead.
    // SOL is exempt (Pyth tape is always fresh). Only blocks → no new loss path.
    if (GECKO_CANDLES_REQUIRED_FOR_ENTRY
      && selectedEntryMint !== SOL_MINT
      && !geckoFeed.hasFreshCandles(selectedEntryMint)) {
      const reason = 'stale_candles_no_fresh_signal';
      await persistTradeDecision(session, 'blocked', reason);
      await persistLastTradeGate(session, {
        at: new Date().toISOString(),
        decision: 'blocked',
        reason,
        expectedEdgeBps: tokenEntrySignal.momentumBps,
        estimatedCostBps: null,
        safetyBufferBps: strategyConfig.momentum.edgeSafetyBufferBps,
      });
      log(
        'info',
        session.id,
        `entry blocked: stale candles for ${resolveTokenSymbol(selectedEntryMint)} (${selectedEntryMint}) -- no fresh GeckoTerminal signal, refusing blind-tape entry candleDepth=${geckoFeed.getTape(selectedEntryMint).length}`,
      );
      return;
    }

    // COST-FLOOR REACHABILITY GATE (majors). Their ATR-based take-profit target
    // must clear the round-trip cost floor. Prevents entries in flat markets where
    // the take-profit is unreachable.
    if (WORKER_MAJOR_COST_FLOOR_GATE_ENABLED
      && getTokenTradeClass(selectedEntryMint, resolveTokenSymbol(selectedEntryMint)) === 'major') {
      const majorCandidateAtr = computeAtrFromTape(
        selectedEntryMint === SOL_MINT
          ? sharedMarketTape.solUsdPyth
          : getCandleBackedPriceTape(selectedEntryMint),
        strategyConfig.supertrend,
      );
      const majorCandidateAtrBps = majorCandidateAtr?.atrBps ?? null;
      if (majorCandidateAtrBps !== null && majorCandidateAtrBps > 0) {
        const majorTakeProfitMult = positionExitPolicy.atrTakeProfitMultiplier;
        const majorSignalStrengthBps = Math.abs(tokenEntrySignal.momentumBps ?? 0);
        const majorSignalStrengthBoost = Math.min(0.5, majorSignalStrengthBps / 200);
        const reachableTakeProfitBps = Math.round(majorCandidateAtrBps * majorTakeProfitMult * (1 + majorSignalStrengthBoost));
        const majorCostFloorBps = computeExitCostFloorBps(session);
        if (reachableTakeProfitBps < majorCostFloorBps) {
          const reason = 'entry_target_below_cost_floor';
          await persistTradeDecision(session, 'blocked', reason);
          await persistLastTradeGate(session, {
            at: new Date().toISOString(),
            decision: 'blocked',
            reason,
            expectedEdgeBps: reachableTakeProfitBps,
            estimatedCostBps: majorCostFloorBps,
            safetyBufferBps: strategyConfig.momentum.edgeSafetyBufferBps,
          });
          log(
            'info',
            session.id,
            `entry blocked: major cost-floor gate for ${resolveTokenSymbol(selectedEntryMint)} (${selectedEntryMint}) reachableTpBps=${reachableTakeProfitBps} costFloorBps=${majorCostFloorBps} atrBps=${majorCandidateAtrBps} tpMult=${majorTakeProfitMult}`,
          );
          return;
        }
      }
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

    // EXIT-side liquidity gate. The entry route just cleared, but a cheap entry on
    // a thin token says nothing about whether we can get back OUT without paying a
    // ruinous exit toll. Probe the reverse route (token -> input) at the size we
    // would receive and read Jupiter's real priceImpactPct + recovered amount.
    const exitLiquidity = await assessExitLiquidity({
      entryInputMint: entryInventory.inputMint,
      entryOutputMint: entryInventory.outputMint,
      entryInputAmountAtomic: entryInventory.amountAtomic ?? 0,
      entryOutAmountAtomic: routeStability.minOutAmountAtomic,
      takerWallet: session.session_wallet,
      slippageBps: session.risk_limits.maxSlippageBps,
    });

    if (!exitLiquidity.ok) {
      recordEntryRejectCooldown(session, selectedEntryMint, exitLiquidity.reason);
      await persistTradeDecision(session, 'blocked', exitLiquidity.reason);
      await persistLastTradeGate(session, {
        at: new Date().toISOString(),
        decision: 'blocked',
        reason: exitLiquidity.reason,
        expectedEdgeBps: tokenEntrySignal.momentumBps,
        estimatedCostBps: exitLiquidity.exitImpactBps ?? exitLiquidity.roundTripFrictionBps,
        safetyBufferBps: strategyConfig.momentum.edgeSafetyBufferBps,
      });
      log(
        'info',
        session.id,
        `entry blocked: exit illiquid for ${entryInventory.outputSymbol} reason=${exitLiquidity.reason} exitImpact=${exitLiquidity.exitImpactBps ?? 'n/a'}bps roundTripFriction=${exitLiquidity.roundTripFrictionBps ?? 'n/a'}bps maxExitImpact=${WORKER_MAX_EXIT_PRICE_IMPACT_BPS}bps`,
      );
      return;
    }

    // ENTRY QUALITY GATE. The decisive "is this token tradeable for profit" test:
    // the take-profit this token can realistically REACH (its measured ATR x the
    // take-profit ATR multiplier) must clear the measured round-trip cost (entry +
    // exit impact + platform fee) by a safety ratio. This is what actually keeps
    // us in liquid majors -- a token only survives if its own volatility can pay
    // its own friction. Post-pump micro-caps whose exit toll dwarfs their leftover
    // volatility are rejected here instead of bought and then force-sold at a loss.
    if (WORKER_ENTRY_QUALITY_GATE_ENABLED) {
      const candidateAtr = computeAtrFromTape(
        getCandleBackedPriceTape(selectedEntryMint),
        strategyConfig.supertrend,
      );
      const roundTripCostBps =
        (exitLiquidity.roundTripFrictionBps ?? exitLiquidity.exitImpactBps ?? 0)
        + session.service_control.platformFeeBps;
      const reachableTakeProfitBps = candidateAtr
        ? candidateAtr.atrBps * positionExitPolicy.atrTakeProfitMultiplier
        : null;
      const qualityOk = reachableTakeProfitBps === null
        ? !WORKER_ENTRY_QUALITY_REQUIRE_ATR
        : reachableTakeProfitBps >= roundTripCostBps * WORKER_ENTRY_QUALITY_TP_COST_RATIO;
      if (!qualityOk) {
        recordEntryRejectCooldown(session, selectedEntryMint, 'entry_quality_below_threshold');
        await persistTradeDecision(session, 'blocked', 'entry_quality_below_threshold');
        await persistLastTradeGate(session, {
          at: new Date().toISOString(),
          decision: 'blocked',
          reason: 'entry_quality_below_threshold',
          expectedEdgeBps: reachableTakeProfitBps !== null ? Math.round(reachableTakeProfitBps) : null,
          estimatedCostBps: Math.round(roundTripCostBps),
          safetyBufferBps: strategyConfig.momentum.edgeSafetyBufferBps,
        });
        log(
          'info',
          session.id,
          `entry blocked: quality below threshold for ${entryInventory.outputSymbol} atrBps=${candidateAtr?.atrBps ?? 'n/a'} reachableTP=${reachableTakeProfitBps !== null ? Math.round(reachableTakeProfitBps) : 'n/a'}bps roundTripCost=${Math.round(roundTripCostBps)}bps ratio=${WORKER_ENTRY_QUALITY_TP_COST_RATIO}`,
        );
        return;
      }
    }

    // Cache the measured exit toll for this mint so the exit cost floor can price
    // take-profit/stop-loss against the REAL cost to get out (give-back fix),
    // instead of the assumed risk_limits.maxSlippageBps.
    if (WORKER_MEASURED_EXIT_COST_FLOOR_ENABLED) {
      const measuredExitImpact = exitLiquidity.exitImpactBps ?? exitLiquidity.roundTripFrictionBps;
      if (measuredExitImpact !== null && Number.isFinite(measuredExitImpact)) {
        measuredExitImpactBpsByMint.set(entryInventory.outputMint, Math.max(0, Math.round(measuredExitImpact)));
      }
    }

    // Cache the entry-leg cost so it can be written into position state after
    // on-chain confirmation. The exit cost floor will then include BOTH legs.
    if (exitLiquidity.roundTripFrictionBps !== null && exitLiquidity.roundTripFrictionBps !== undefined) {
      // roundTripFrictionBps includes both legs; halve it for the entry-only portion.
      const entryLegCostBps = Math.max(0, Math.round(exitLiquidity.roundTripFrictionBps / 2));
      pendingEntryCostBpsByMint.set(entryInventory.outputMint, entryLegCostBps);
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
        entryRoundTripFrictionBps: exitLiquidity.roundTripFrictionBps,
      };

      // Measurement-only: snapshot this committed entry's signal + liquidity so we
      // can later compare its forward price return (signal quality) against the
      // realized round-trip PnL (friction/exit quality). Does not affect the trade.
      void recordSignalObservation({
        session,
        mint: selectedEntryMint,
        symbol: entryInventory.outputSymbol,
        entryStrategy: entryStrategyForPlan,
        signal: tokenEntrySignal,
        entryImpactBps: routeStability.maxPriceImpactBps ?? null,
        exitImpactBps: exitLiquidity.exitImpactBps,
        roundTripFrictionBps: exitLiquidity.roundTripFrictionBps,
        entryAmountAtomic: entryInventory.amountAtomic ?? null,
      });
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
      `pre-prepare entry gate v2: momentumBps=${tradePlan.signalSnapshot.momentumBps ?? 'null'} signalThresholdBps=${tradePlan.signalSnapshot.thresholdBps ?? 'null'} configThresholdBps=${strategyConfig.momentum.thresholdBps} safetyBufferBps=${strategyConfig.momentum.edgeSafetyBufferBps} blocked=${prePrepareEntryGate ? 'true' : 'false'}`,
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
      `pre-prepare trade gate blocked v2 (${prePrepareEntryGate.reason}): expectedEdgeBps=${prePrepareEntryGate.expectedEdgeBps} estimatedCostBps=${prePrepareEntryGate.estimatedCostBps} safetyBufferBps=${prePrepareEntryGate.safetyBufferBps}`,
    );
    return;
  }

  // ── B2: RVOL entry gate ─────────────────────────────────────────────────────
  // Block entries when current candle volume is below average (RVOL < 1.0).
  // Entering on low volume = no conviction behind the move → stop-loss fodder.
  // Only gates entries; exits always proceed regardless of volume.
  // Skip RVOL when candle data isn't fresh — stale/broken data produces false blocks.
  if (tradePlan.direction === 'enter_long') {
    const entryMint = tradePlan.inventory.outputMint;
    const candlesFresh = GECKO_CANDLES_ENABLED && geckoFeed.hasFreshCandles(entryMint);
    const rvol = candlesFresh ? computeRelativeVolume(entryMint) : null;
    const rvolThreshold = 1.0;
    if (rvol !== null && rvol < rvolThreshold) {
      const rvolReason = 'rvol_below_threshold';
      recordTradePlanEntryRejectCooldown(session, tradePlan, rvolReason);
      await persistTradeDecision(session, 'blocked', rvolReason);
      log(
        'info',
        session.id,
        `RVOL gate blocked entry: mint=${entryMint} rvol=${rvol.toFixed(2)} threshold=${rvolThreshold}`,
      );
      return;
    }
    if (rvol !== null) {
      log('info', session.id, `RVOL gate passed: mint=${entryMint} rvol=${rvol.toFixed(2)}`);
    }
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
      entryCostBps:    tradePlan.direction === 'enter_long'
        ? pendingEntryCostBpsByMint.get(tradePlan.inventory.outputMint)
        : undefined,
      measuredExitImpactBps: tradePlan.direction === 'enter_long'
        ? measuredExitImpactBpsByMint.get(tradePlan.inventory.outputMint)
        : undefined,
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
      const estimatedNetworkCostLamports = prepare.data.costs?.estimatedNetworkCostLamports ?? 0;
      // tradeAmount already has reserveAtomic subtracted (via computeFullExitAmountAtomic),
      // so post-exit SOL = balance - tradeAmount = reserveAtomic.
      // Only check: can the leftover reserve cover network costs and still meet the minimum?
      const expectedPostExitLamports =
        balance - tradeAmount - estimatedNetworkCostLamports;
      const reserveShortfallLamports = Math.max(
        0,
        MIN_SOL_OPERATING_RESERVE_LAMPORTS - expectedPostExitLamports,
      );

      if (reserveShortfallLamports > 0) {
        const adjustedAmount = tradeAmount - reserveShortfallLamports;
        const retryMinimumTradeAmount = computeRetryMinimumTradeAmountAtomic({
          forceExitExecution,
          minTradeAtomic: sizingPolicy.minTradeLamports,
        });

        if (adjustedAmount < retryMinimumTradeAmount || adjustedAmount <= 0) {
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
      roundTripFrictionBps: WORKER_ROUND_TRIP_GATE_ENABLED
        ? (tradePlan.entryRoundTripFrictionBps ?? null)
        : null,
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
      await persistTradeDecision(session, 'blocked', 'insufficient_balance');
      log('warn', session.id, `balance ${freshBal} lamports after prepare failure — preserving active session; only user stop may sweep`);
    } else {
      const fails = (consecutiveSimFailures.get(session.id) ?? 0) + 1;
      consecutiveSimFailures.set(session.id, fails);
      if (fails >= 3) {
        await persistTradeDecision(session, 'blocked', 'repeated_simulation_failures');
        log('warn', session.id, `${fails} consecutive prepare failures — preserving active session; only user stop may sweep`);
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
      await persistTradeDecision(session, 'blocked', 'insufficient_balance');
      log('warn', session.id, `balance ${freshBal} lamports after simulation error — preserving active session; only user stop may sweep`);
    } else {
      const fails = (consecutiveSimFailures.get(session.id) ?? 0) + 1;
      consecutiveSimFailures.set(session.id, fails);
      if (fails >= 3) {
        await persistTradeDecision(session, 'blocked', 'repeated_simulation_failures');
        log('warn', session.id, `${fails} consecutive simulation failures — preserving active session; only user stop may sweep`);
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
    // Cancel the prepared execution so the session isn't blocked forever
    try {
      await apiPost(`/jupiter/swap/executions/${prepare.data.executionId}/cancel`, {
        stage: 'worker_cancel',
        reason: 'submit_failed',
      });
    } catch (cancelErr) {
      log('warn', session.id, `cancel prepared execution failed after submit error: ${String(cancelErr)}`);
    }
    return;
  }

  log('info', session.id, `trade submitted â€” sig: ${submit.data.signature ?? 'pending'} status: ${submit.data.status}`);
  consecutiveSimFailures.delete(session.id);

  await persistTradeDecision(session, 'submitted', submit.data.status ?? 'submitted');

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
  const rawTargetDuration = session.user_control?.targetDurationMinutes;
  const targetDurationMinutes = Number(rawTargetDuration);
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
  'market_downtrend_no_entry',
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
  const solToSend = computeSessionSolSweepLamports({
    solBalance,
    ownerAtaCreationCost,
    txFeeLamports: TX_FEE_LAMPORTS,
    mayLeaveResidualState,
  });

  if (mayLeaveResidualState) {
    log(
      'warn',
      session.id,
      `retaining ${Math.max(0, solBalance - ownerAtaCreationCost - TX_FEE_LAMPORTS)} lamports as recovery gas â€” a valued token position could not be swept home; not draining SOL to zero to avoid orphaning it`,
    );
  }

  if (solToSend > 0) {
    ixs.push(SystemProgram.transfer({
      fromPubkey: sessionPubkey,
      toPubkey: ownerPubkey,
      lamports: solToSend,
    }));
    log('info', session.id, `queuing SOL sweep: ${solToSend} lamports â†’ ${ownerWallet}`);
  }

  if (ixs.length === 0) {
    log('info', session.id, 'session wallet empty â€” nothing to sweep');
    return getWalletSweepSnapshot(sessionPubkey);
  }

  const { blockhash, lastValidBlockHeight } = await rlGetLatestBlockhash();
  const message = new TransactionMessage({
    payerKey: sessionPubkey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();

  const sweepTx = new VersionedTransaction(message);
  sweepTx.sign([keypair]);

  const sig = await rlSendRawTransaction(sweepTx.serialize());
  let confirmationSettled = false;
  try {
    const confirmation = await rlConfirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });

    if (confirmation.value.err) {
      throw new Error(`sweep transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }

    confirmationSettled = true;
    log('info', session.id, `sweep confirmed: ${sig}`);
  } catch (error) {
    if (isConfirmationExpiryError(error)) {
      log('warn', session.id, `sweep confirmation expired for ${sig}; verifying wallet state directly`);
    } else {
      throw error;
    }
  }

  const postSweepSnapshot = await waitForPostSweepSnapshot(session.id, sessionPubkey, preSweepSnapshot);
  if (!confirmationSettled && !sweepSnapshotChanged(preSweepSnapshot, postSweepSnapshot)) {
    throw new Error(`sweep transaction ${sig} expired before confirmation and wallet state did not change`);
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
  if (session.stop_reason !== 'user_requested') {
    log('error', session.id, `refusing to finalize non-user stop reason=${session.stop_reason ?? 'null'}; preserving funds/session until user stop is recorded`);
    return;
  }

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
      stop_reason: 'user_requested',
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
    stop_reason: 'user_requested',
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
              log(
                'warn',
                session.id,
                `awaiting funding timeout (${AWAITING_FUNDING_TIMEOUT_MINUTES}min) exceeded — preserving session; only user stop may close`,
              );
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
          if (WORKER_ENABLE_DURATION_AUTOSTOP && hasExceededTargetDuration(session)) {
            log('warn', session.id, `target duration ${session.user_control.targetDurationMinutes}min exceeded — auto-stop disabled; only user stop may close`);
          }

          // Stale detection is telemetry only. The worker must not stop sessions
          // autonomously; only an explicit user stop may move a session to stopping.
          const lastAttemptMs = getLastTradeAttemptMs(session);
          const staleLimitMs = STALE_SESSION_MINUTES * 60_000;
          if (WORKER_ENABLE_STALE_AUTOSTOP && STALE_SESSION_MINUTES > 0 && lastAttemptMs > 0 && (Date.now() - lastAttemptMs) > staleLimitMs) {
            log('warn', session.id, `no trade attempt for ${STALE_SESSION_MINUTES}min — preserving active session; only user stop may close`);
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
  startGeckoCandleLoop();
  startTokenAdmissionSchedule();
  await runLoop();
};

void boot();
