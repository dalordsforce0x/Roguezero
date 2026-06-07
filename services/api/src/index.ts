import Fastify, { type FastifyReply } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import {
  createMonthlyBudgetGovernor,
  createSharedTokenBucket,
  getExponentialBackoffDelayMs,
} from '@roguezero/provider-governor';
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  type SignatureStatus,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  createRoundRobinKeySelector,
  getHeliusRpcUrls,
  getJupiterSwapBuildConfig,
  getPythPriceConfig,
  getRuntimeSpeedProfile,
  getRuntimeConfigReport,
  getWorkerSignalPolicy,
  getWorkerFundingThresholds,
  type JupiterFeeToken,
} from '@roguezero/runtime-config';
import {
  createPreparedExecution,
  executionStoreReady,
  getActiveExecutionByTaker,
  getExecutionById,
  isSwapExecutionUniqueViolation,
  listExecutionsByStatus,
  markExecutionFailed,
  updateSubmittedExecution,
} from './swapExecutionStore.js';
import {
  createSessionWithKey,
  getSessionById,
  getUserById,
  getUserByLicenseKey,
  getSessionByWallet,
  getPool,
  getUserPerformanceSnapshot,
  getUserByWallet,
  listSessions,
  sessionKeysReady,
  sessionStoreReady,
  updateSessionExecutionOutcomeByWallet,
  updateSessionFundingByWallet,
  updateSessionServiceControlByWallet,
  updateSessionStatus,
} from './sessionStore.js';
import {
  accessTablesReady,
  acknowledgeLicenseKeyReveal,
  createWebAccessSession,
  enrollTrustedDeviceForWallet,
  getAccessUserByWallet,
  getLiveSessionCountForUser,
  getTrustedDeviceEnrollment,
  verifyTrustedDeviceLicense,
  verifyWebAccessSession,
} from './accessStore.js';
import {
  getLiveRuntimeControl,
  runtimeControlStoreReady,
} from './runtimeControlStore.js';
import {
  DEFAULT_ROTATION_INTERVAL_MINUTES,
  buildFlatSessionPositionState,
  schemaVersion,
  sessionActionValues,
  sessionStatusValues,
  strategyKeyValues,
  createSessionRequestSchema,
  summarizePositionsState,
  type SessionPositionState,
  type SessionPositionsState,
  type SessionServiceControlPatch,
  type SwapExecution,
} from '@roguezero/session-schema';
import {
  buildPriorityFeeEstimateRequest,
  composePreparedSwapInstructions,
  getHeliusTradingConfig,
  parsePriorityFeeEstimateResponse,
  parseSenderSignature,
} from './lib/heliusTrading.js';
import {
  computeSolInputEntryPriceUsd,
  computeTokenToSolRealizedPnlUsd,
  computeTokenToUsdcRealizedPnlUsd,
} from './lib/pnlAccounting.js';

dotenv.config({ path: '../../.env' });

const app = Fastify({ logger: true });
const port = Number(process.env.PORT || process.env.API_PORT || 4000);
const DEPLOY_CANARY = process.env.DEPLOY_CANARY ?? 'rz-canary-2026-06-01-03';
const internalApiSecret = process.env.RZ_INTERNAL_SECRET?.trim() || null;
const webPublicOriginRaw = process.env.WEB_PUBLIC_ORIGIN ?? process.env.FRONTEND_ORIGIN;
if (!webPublicOriginRaw) {
  throw new Error('WEB_PUBLIC_ORIGIN (or FRONTEND_ORIGIN) must be set on the api service');
}
const webPublicOrigin = webPublicOriginRaw;
const internalSecretBypassPaths = new Set(['/health']);
const configReport = getRuntimeConfigReport(process.env);
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
const EXECUTION_BAD_FILL_THRESHOLD_BPS = Number(process.env.RZ_BAD_FILL_THRESHOLD_BPS ?? process.env.WORKER_BAD_FILL_THRESHOLD_BPS ?? 50);
// Jupiter Pro yearly includes 6B credits/year (~500M/month equivalent).
const JUPITER_MONTHLY_REQUEST_LIMIT = Number(process.env.JUPITER_MONTHLY_REQUEST_LIMIT ?? 500_000_000);
const JUPITER_MONTHLY_BUDGET_ENFORCE = process.env.JUPITER_MONTHLY_BUDGET_ENFORCE === 'true';
const INTERNAL_SWAP_PREPARE_RATE_LIMIT_PER_MINUTE = Number(process.env.INTERNAL_SWAP_PREPARE_RATE_LIMIT_PER_MINUTE ?? 600);
const INTERNAL_SWAP_SUBMIT_RATE_LIMIT_PER_MINUTE = Number(process.env.INTERNAL_SWAP_SUBMIT_RATE_LIMIT_PER_MINUTE ?? 600);
const SUBMITTED_EXECUTION_SYNC_INTERVAL_MS = Number(process.env.SUBMITTED_EXECUTION_SYNC_INTERVAL_MS ?? 15000);
const SUBMITTED_EXECUTION_STALE_MS = Number(process.env.SUBMITTED_EXECUTION_STALE_MS ?? 30000);
const jupiterSwapBuildConfig = configReport.readyForLiveIntegration
  ? getJupiterSwapBuildConfig(process.env)
  : null;
const jupiterApiKeySelector = jupiterSwapBuildConfig
  ? createRoundRobinKeySelector(jupiterSwapBuildConfig.apiKeys)
  : null;
const heliusTradingConfig = getHeliusTradingConfig(process.env);
const workerFundingThresholds = getWorkerFundingThresholds(process.env);
const workerSignalPolicy = getWorkerSignalPolicy(process.env);
const heliusRpcConnections = configReport.readyForLiveIntegration
  ? getHeliusRpcUrls(process.env).map((rpcUrl) => new Connection(rpcUrl, 'confirmed'))
  : [];
const heliusConnection = heliusRpcConnections[0] ?? null;
let heliusRpcConnectionCursor = 0;
const getHeliusRpcConnection = () => {
  if (!heliusConnection || heliusRpcConnections.length === 0) {
    throw new Error('Solana integration is not ready');
  }

  const connection = heliusRpcConnections[heliusRpcConnectionCursor % heliusRpcConnections.length];
  heliusRpcConnectionCursor = (heliusRpcConnectionCursor + 1) % heliusRpcConnections.length;
  return connection;
};
const pythPriceConfig = getPythPriceConfig(process.env);

const publicKeyPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const atomicAmountPattern = /^\d+$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const jupiterFeeTokens = new Set<JupiterFeeToken>(['SOL', 'USDC', 'USDT']);
const maxComputeUnitLimit = 1_400_000;
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const LAMPORTS_PER_SOL = 1_000_000_000;
const FUNDING_FEE_CUSHION_LAMPORTS = 50_000;

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
const senderLimiter = createSharedTokenBucket({
  pool: sharedRatePool,
  key: 'helius-sender',
  maxTokens: 45,
  refillRatePerSec: 45,
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
const submittedExecutionWatchers = new Map<string, { signature: string; listenerId: number }>();
const executionReconcilesInFlight = new Set<string>();

type ProviderLaneName = 'helius-rpc' | 'helius-sender' | 'jupiter-general' | 'helius-rpc-cache-hit';

type ProviderLaneStats = {
  requests: number;
  creditUnits: number;
  lastUsedAt: string | null;
};

const providerLaneStats = new Map<ProviderLaneName, ProviderLaneStats>();

const recordProviderLaneUse = (lane: ProviderLaneName, creditUnits: number) => {
  const previous = providerLaneStats.get(lane) ?? {
    requests: 0,
    creditUnits: 0,
    lastUsedAt: null,
  };

  providerLaneStats.set(lane, {
    requests: previous.requests + 1,
    creditUnits: previous.creditUnits + creditUnits,
    lastUsedAt: new Date().toISOString(),
  });
};

const getProviderLaneStatsSnapshot = () => Object.fromEntries(
  Array.from(providerLaneStats.entries()).map(([lane, stats]) => [lane, { ...stats }]),
) as Record<ProviderLaneName, ProviderLaneStats>;

class ProviderBudgetExceededError extends Error {
  constructor(
    message: string,
    readonly provider: 'helius' | 'jupiter',
    readonly budget: { remainingUnits: number; usageRatio: number; pressure: string },
  ) {
    super(message);
    this.name = 'ProviderBudgetExceededError';
  }
}

const reserveProviderBudget = async (params: {
  provider: 'helius' | 'jupiter';
  units?: number;
  governor: { reserve: (units?: number) => Promise<{ granted: boolean; pressure: string; remainingUnits: number; usageRatio: number }> };
}) => {
  const budget = await params.governor.reserve(params.units ?? 1);

  if (budget.pressure === 'watch' || budget.pressure === 'throttle') {
    app.log.warn({
      provider: params.provider,
      pressure: budget.pressure,
      remainingUnits: budget.remainingUnits,
      usageRatio: budget.usageRatio,
    }, 'provider monthly budget pressure');
  }

  if (!budget.granted) {
    throw new ProviderBudgetExceededError(
      `${params.provider} monthly budget exhausted`,
      params.provider,
      {
        remainingUnits: budget.remainingUnits,
        usageRatio: budget.usageRatio,
        pressure: budget.pressure,
      },
    );
  }
};

const reserveHeliusRpc = async (units = 1) => {
  await reserveProviderBudget({ provider: 'helius', governor: heliusMonthlyBudget, units });
  await heliusLimiter.acquire();
  recordProviderLaneUse('helius-rpc', units);
};

const reserveHeliusSender = async () => {
  await senderLimiter.acquire();
  recordProviderLaneUse('helius-sender', 0);
};

const reserveJupiterRequest = async () => {
  await reserveProviderBudget({ provider: 'jupiter', governor: jupiterMonthlyBudget, units: 1 });
  await jupiterLimiter.acquire();
  recordProviderLaneUse('jupiter-general', 1);
};

const getProviderBudgetSnapshot = async () => {
  const [helius, jupiter] = await Promise.all([
    heliusMonthlyBudget.reserve(0),
    jupiterMonthlyBudget.reserve(0),
  ]);

  return {
    timestamp: new Date().toISOString(),
    budgets: {
      helius: {
        key: 'helius-credits',
        enforceLimit: HELIUS_MONTHLY_BUDGET_ENFORCE,
        monthlyLimitUnits: HELIUS_MONTHLY_CREDIT_LIMIT,
        pressure: helius.pressure,
        usedUnits: helius.usedUnits,
        remainingUnits: helius.remainingUnits,
        usageRatio: helius.usageRatio,
        elapsedRatio: helius.elapsedRatio,
        projectedUsageRatio: helius.projectedUsageRatio,
      },
      jupiter: {
        key: 'jupiter-requests',
        enforceLimit: JUPITER_MONTHLY_BUDGET_ENFORCE,
        monthlyLimitUnits: JUPITER_MONTHLY_REQUEST_LIMIT,
        pressure: jupiter.pressure,
        usedUnits: jupiter.usedUnits,
        remainingUnits: jupiter.remainingUnits,
        usageRatio: jupiter.usageRatio,
        elapsedRatio: jupiter.elapsedRatio,
        projectedUsageRatio: jupiter.projectedUsageRatio,
      },
    },
    lanes: getProviderLaneStatsSnapshot(),
  };
};

const isLongPositionStatus = (status: SessionPositionState['status']) =>
  status === 'long' || status === 'long_sol';
  
const getUtcDayKey = (date: Date = new Date()): string => date.toISOString().slice(0, 10);

const parseQuotePriceImpactBps = (priceImpactPct: string | null | undefined): number | null => {
  if (!priceImpactPct) return null;
  const parsed = Number(priceImpactPct);
  return Number.isFinite(parsed) ? Math.round(parsed * 10_000) : null;
};

const computeOutputDeltaBps = (actualOutputAtomic: number | null, expectedOutputAtomic: number | null): number | null => {
  if (actualOutputAtomic === null || expectedOutputAtomic === null || expectedOutputAtomic <= 0) {
    return null;
  }

  return Math.round(((actualOutputAtomic - expectedOutputAtomic) / expectedOutputAtomic) * 10_000);
};

const normalizePositionsState = (
  positionsState: SessionPositionsState | null | undefined,
  legacyPositionState: SessionPositionState | null | undefined,
): SessionPositionsState => {
  if (positionsState) {
    const positions = Object.fromEntries(
      Object.entries(positionsState.positions ?? {}).filter(([, position]) => (
        !!position
        && isLongPositionStatus(position.status)
        && typeof position.positionMint === 'string'
      )),
    ) as SessionPositionsState['positions'];

    return {
      activePositionMint: positionsState.activePositionMint && positions[positionsState.activePositionMint]
        ? positionsState.activePositionMint
        : (Object.keys(positions)[0] ?? null),
      positions,
    };
  }

  if (legacyPositionState && isLongPositionStatus(legacyPositionState.status)) {
    const mint = legacyPositionState.positionMint ?? SOL_MINT;
    return {
      activePositionMint: mint,
      positions: {
        [mint]: {
          ...legacyPositionState,
          positionMint: mint,
          positionSymbol: legacyPositionState.positionSymbol ?? (mint === SOL_MINT ? 'SOL' : null),
        },
      },
    };
  }

  return {
    activePositionMint: null,
    positions: {},
  };
};

const getPositionUiAmount = (mint: string, quantityAtomic: number, decimals?: number | null) =>
  quantityAtomic / (10 ** (decimals ?? (mint === SOL_MINT ? 9 : 6)));

const upsertPositionEntry = (params: {
  existingPosition: SessionPositionState | null;
  mint: string;
  symbol: string | null;
  quantityAtomic: number;
  entryPriceUsd: number | null;
  tokenDecimals: number | null;
  entryStrategy: SessionPositionState['entryStrategy'];
  confirmedAt: string;
  markedPriceUsd: number | null;
  status: SessionPositionState['status'];
}): SessionPositionState => {
  const nextQuantityAtomic = Math.max(0, params.quantityAtomic);
  const existingQuantityAtomic = params.existingPosition?.quantityAtomic
    ? Number(params.existingPosition.quantityAtomic)
    : 0;
  const totalQuantityAtomic = existingQuantityAtomic + nextQuantityAtomic;
  const existingUiQuantity = params.existingPosition?.positionMint
    ? getPositionUiAmount(params.existingPosition.positionMint, existingQuantityAtomic, params.existingPosition.tokenDecimals ?? null)
    : 0;
  const nextUiQuantity = getPositionUiAmount(params.mint, nextQuantityAtomic, params.tokenDecimals);
  const weightedEntryPriceUsd = params.entryPriceUsd !== null && (existingUiQuantity + nextUiQuantity) > 0
    ? (((params.existingPosition?.entryPriceUsd ?? 0) * existingUiQuantity) + (params.entryPriceUsd * nextUiQuantity)) / (existingUiQuantity + nextUiQuantity)
    : (params.existingPosition?.entryPriceUsd ?? params.entryPriceUsd ?? null);

  return {
    status: params.status,
    positionMint: params.mint,
    positionSymbol: params.symbol,
    entryStrategy: params.existingPosition?.entryStrategy ?? params.entryStrategy ?? null,
    entryPriceUsd: weightedEntryPriceUsd,
    entryAt: params.existingPosition?.entryAt ?? params.confirmedAt,
    quantityAtomic: String(totalQuantityAtomic),
    tokenDecimals: params.existingPosition?.tokenDecimals ?? params.tokenDecimals ?? null,
    highWaterPriceUsd: params.existingPosition?.highWaterPriceUsd ?? params.entryPriceUsd ?? params.markedPriceUsd,
    lastMarkedPriceUsd: params.markedPriceUsd ?? params.existingPosition?.lastMarkedPriceUsd ?? null,
    lastMarkedAt: params.markedPriceUsd ? params.confirmedAt : params.existingPosition?.lastMarkedAt ?? null,
    lastComputedAtrUsd: params.existingPosition?.lastComputedAtrUsd ?? null,
    lastComputedAtrBps: params.existingPosition?.lastComputedAtrBps ?? null,
    atrComputedAt: params.existingPosition?.atrComputedAt ?? null,
    maxFavorableBps: params.existingPosition?.maxFavorableBps ?? null,
    maxAdverseBps: params.existingPosition?.maxAdverseBps ?? null,
    maxFavorableAt: params.existingPosition?.maxFavorableAt ?? null,
    maxAdverseAt: params.existingPosition?.maxAdverseAt ?? null,
    pendingExitReason: null,
    exitReason: null,
  };
};

const applyPositionExit = (params: {
  existingPosition: SessionPositionState | null;
  soldAtomic: number;
  exitReason: SessionPositionState['exitReason'];
  fallbackMarkedPriceUsd: number | null;
  fallbackMarkedAt: string | null;
}) => {
  if (!params.existingPosition?.quantityAtomic) {
    return {
      remainingPosition: null,
      summaryFallback: buildFlatSessionPositionState({
        lastMarkedPriceUsd: params.fallbackMarkedPriceUsd,
        lastMarkedAt: params.fallbackMarkedAt,
        exitReason: params.exitReason,
      }),
    };
  }

  const existingAtomic = Number(params.existingPosition.quantityAtomic);
  const remainingAtomic = Math.max(0, existingAtomic - Math.max(0, params.soldAtomic));

  if (remainingAtomic === 0) {
    return {
      remainingPosition: null,
      summaryFallback: buildFlatSessionPositionState({
        lastMarkedPriceUsd: params.existingPosition.lastMarkedPriceUsd ?? params.fallbackMarkedPriceUsd,
        lastMarkedAt: params.existingPosition.lastMarkedAt ?? params.fallbackMarkedAt,
        exitReason: params.exitReason,
      }),
    };
  }

  return {
    remainingPosition: {
      ...params.existingPosition,
      quantityAtomic: String(remainingAtomic),
      pendingExitReason: null,
      exitReason: null,
    },
    summaryFallback: buildFlatSessionPositionState({
      lastMarkedPriceUsd: params.existingPosition.lastMarkedPriceUsd ?? params.fallbackMarkedPriceUsd,
      lastMarkedAt: params.existingPosition.lastMarkedAt ?? params.fallbackMarkedAt,
      exitReason: params.exitReason,
    }),
  };
};

type JupiterBuildRequestBody = {
  inputMint?: unknown;
  outputMint?: unknown;
  amount?: unknown;
  taker?: unknown;
  feeTokenSymbol?: unknown;
  slippageBps?: unknown;
  scannerStrategy?: unknown;
  entryStrategy?: unknown;
  exitStrategy?: unknown;
  exitReason?: unknown;
};

type ValidatedJupiterBuildRequest = {
  inputMint: string;
  outputMint: string;
  amount: string;
  taker: string;
  feeTokenSymbol: JupiterFeeToken;
  slippageBps?: string;
  scannerStrategy?: typeof strategyKeyValues[number];
  entryStrategy?: typeof strategyKeyValues[number];
  exitStrategy?: typeof strategyKeyValues[number];
  exitReason?: NonNullable<SessionPositionState['exitReason']>;
};

type JupiterSubmitRequestBody = {
  executionId?: unknown;
  signedTransactionBase64?: unknown;
  blockhash?: unknown;
  lastValidBlockHeight?: unknown;
  maxRetries?: unknown;
};

type ValidatedJupiterSubmitRequest = {
  executionId: string;
  signedTransactionBase64: string;
  blockhash?: string;
  lastValidBlockHeight?: number;
  maxRetries?: number;
};

type JupiterInstructionAccount = {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
};

type JupiterInstructionPayload = {
  programId: string;
  accounts: JupiterInstructionAccount[];
  data: string;
};

type JupiterBuildResponse = {
  computeBudgetInstructions: JupiterInstructionPayload[];
  setupInstructions: JupiterInstructionPayload[];
  swapInstruction: JupiterInstructionPayload;
  cleanupInstruction?: JupiterInstructionPayload | null;
  otherInstructions: JupiterInstructionPayload[];
  tipInstruction?: JupiterInstructionPayload | null;
  addressesByLookupTableAddress: Record<string, string[]>;
  blockhashWithMetadata: {
    blockhash: string | number[];
    lastValidBlockHeight?: number;
  };
};

type LamportShortfall = {
  availableLamports: number;
  requiredLamports: number;
  gapLamports: number;
};

type JupiterRouteControlOverrides = {
  maxAccounts?: number;
  dexes?: string;
  excludeDexes?: string;
};

type FundingQuoteRequestBody = {
  requestedUsd?: unknown;
  requestedLamports?: unknown;
  requestedFundingPct?: unknown;
};

type PythQuoteSample = {
  usdPrice: number;
  confidenceUsd: number;
  confidenceBps: number;
  publishTime: number;
  sampledAt: string;
};

const asOptionalString = (value: unknown) =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

type AccessDeniedReason = 'not_registered' | 'access_disabled' | 'license_expired';

const isLicenseExpired = (expiryDate: string | null | undefined) => (
  Boolean(expiryDate) && new Date(expiryDate as string) < new Date()
);

const buildAccessDeniedPayload = (
  reason: AccessDeniedReason,
  user?: {
    id: string;
    username: string;
    walletAddress?: string;
    expiryDate?: string | null;
    licenseKey?: string | null;
    duration?: string | null;
  },
) => {
  const error = reason === 'not_registered'
    ? 'Wallet not registered'
    : reason === 'access_disabled'
      ? 'Access disabled'
      : 'License expired';

  return {
    authorized: false,
    error,
    reason,
    user,
  };
};

const resolveUserForAccessCheck = async (params: {
  userId?: string;
  ownerWallet?: string;
  licenseId?: string;
}) => {
  if (params.ownerWallet) {
    return getUserByWallet(params.ownerWallet);
  }

  if (params.userId) {
    return getUserById(params.userId);
  }

  if (params.licenseId) {
    return getUserByLicenseKey(params.licenseId);
  }

  return null;
};

const enforceUserAccess = async (
  reply: FastifyReply,
  params: {
    userId?: string;
    ownerWallet?: string;
    licenseId?: string;
  },
) => {
  const user = await resolveUserForAccessCheck(params);

  if (!user) {
    return {
      ok: false as const,
      response: reply.status(403).send(buildAccessDeniedPayload('not_registered')),
    };
  }

  if (!user.access_enabled) {
    return {
      ok: false as const,
      response: reply.status(403).send(buildAccessDeniedPayload('access_disabled', {
        id: user.id,
        username: user.username,
        walletAddress: user.wallet_address,
        expiryDate: user.expiry_date,
        licenseKey: user.license_key,
        duration: user.duration,
      })),
    };
  }

  if (isLicenseExpired(user.expiry_date)) {
    return {
      ok: false as const,
      response: reply.status(403).send(buildAccessDeniedPayload('license_expired', {
        id: user.id,
        username: user.username,
        walletAddress: user.wallet_address,
        expiryDate: user.expiry_date,
        licenseKey: user.license_key,
        duration: user.duration,
      })),
    };
  }

  return { ok: true as const, user };
};

const asOptionalIntString = (value: unknown) => {
  const candidate = asOptionalString(value);
  return candidate && atomicAmountPattern.test(candidate) ? candidate : undefined;
};

const asOptionalFeeToken = (value: unknown) => {
  const candidate = asOptionalString(value) as JupiterFeeToken | undefined;
  return candidate && jupiterFeeTokens.has(candidate) ? candidate : undefined;
};

const asOptionalBps = (value: unknown) => {
  if (value === undefined) {
    return undefined;
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 10000
    ? String(parsed)
    : undefined;
};

const isStrategyKey = (value: unknown): value is typeof strategyKeyValues[number] => (
  value === 'momentum' || value === 'mean_reversion' || value === 'supertrend'
);

const asOptionalStrategyKey = (value: unknown) => (
  value === undefined ? undefined : (isStrategyKey(value) ? value : undefined)
);

const isExitReason = (value: unknown): value is NonNullable<SessionPositionState['exitReason']> => (
  value === 'take_profit' || value === 'stop_loss' || value === 'trailing_stop' || value === 'signal_reversal'
);

const asOptionalExitReason = (value: unknown) => (
  value === undefined ? undefined : (isExitReason(value) ? value : undefined)
);

const asOptionalNonNegativeInteger = (value: unknown) => {
  if (value === undefined) {
    return undefined;
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
};

const asOptionalPositiveInt = (value: unknown) => {
  if (value === undefined) {
    return undefined;
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const asOptionalNonNegativeNumber = (value: unknown) => {
  if (value === undefined) {
    return undefined;
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

const asOptionalPositiveNumber = (value: unknown) => {
  const parsed = asOptionalNonNegativeNumber(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
};

const asOptionalNumber = (value: unknown) => {
  if (value === undefined) {
    return undefined;
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const asOptionalBoolean = (value: unknown) => {
  if (value === undefined) {
    return undefined;
  }

  return typeof value === 'boolean' ? value : undefined;
};

const asOptionalProfitMode = (value: unknown) => {
  if (value === undefined) {
    return undefined;
  }

  return value === 'send_to_owner' || value === 'compound'
    ? value
    : undefined;
};

const asOptionalProfitPayoutToken = (value: unknown) => {
  if (value === undefined) {
    return undefined;
  }

  return value === 'SOL' || value === 'USDC'
    ? value
    : undefined;
};

const asOptionalStopDisposition = (value: unknown) => {
  if (value === undefined) {
    return undefined;
  }

  return value === 'return_tokens' || value === 'liquidate'
    ? value
    : undefined;
};

const buildDefaultStrategyConfig = () => ({
  autoRotationEnabled: true,
  momentum: {
    lookbackSamples: workerSignalPolicy.momentumLookbackSamples,
    thresholdBps: workerSignalPolicy.momentumThresholdBps,
    edgeSafetyBufferBps: workerSignalPolicy.edgeSafetyBufferBps,
  },
  meanReversion: {
    length: 20,
    stdMultiplier: 2,
    minBandWidthFraction: 0.006,
    entryThreshold: 0,
    exitThreshold: 0.5,
  },
  supertrend: {
    candleSamples: 10,
    atrPeriod: 10,
    multiplier: 3,
  },
});

const parseJupiterBuildRequest = (body: JupiterBuildRequestBody) => {
  const inputMint = asOptionalString(body.inputMint);
  const outputMint = asOptionalString(body.outputMint);
  const amount = asOptionalIntString(body.amount);
  const taker = asOptionalString(body.taker);
  const feeTokenSymbol = asOptionalFeeToken(body.feeTokenSymbol);
  const slippageBps = asOptionalBps(body.slippageBps);
  const scannerStrategy = asOptionalStrategyKey(body.scannerStrategy);
  const entryStrategy = asOptionalStrategyKey(body.entryStrategy);
  const exitStrategy = asOptionalStrategyKey(body.exitStrategy);
  const exitReason = asOptionalExitReason(body.exitReason);

  const errors = [
    !inputMint || !publicKeyPattern.test(inputMint) ? 'inputMint must be a Solana public key' : null,
    !outputMint || !publicKeyPattern.test(outputMint) ? 'outputMint must be a Solana public key' : null,
    !amount ? 'amount must be an unsigned integer string' : null,
    !taker || !publicKeyPattern.test(taker) ? 'taker must be a Solana public key' : null,
    !feeTokenSymbol ? 'feeTokenSymbol must be one of SOL, USDC, USDT' : null,
    body.slippageBps !== undefined && !slippageBps ? 'slippageBps must be an integer between 0 and 10000' : null,
    body.scannerStrategy !== undefined && !scannerStrategy ? 'scannerStrategy must be a known strategy key' : null,
    body.entryStrategy !== undefined && !entryStrategy ? 'entryStrategy must be a known strategy key' : null,
    body.exitStrategy !== undefined && !exitStrategy ? 'exitStrategy must be a known strategy key' : null,
    body.exitReason !== undefined && !exitReason ? 'exitReason must be one of take_profit, stop_loss, trailing_stop, signal_reversal' : null,
  ].filter((value): value is string => value !== null);

  if (errors.length > 0) {
    return { ok: false as const, errors };
  }

  const value: ValidatedJupiterBuildRequest = {
    inputMint: inputMint!,
    outputMint: outputMint!,
    amount: amount!,
    taker: taker!,
    feeTokenSymbol: feeTokenSymbol!,
    slippageBps,
    scannerStrategy,
    entryStrategy,
    exitStrategy,
    exitReason,
  };

  return {
    ok: true as const,
    value,
  };
};

const parseJupiterSubmitRequest = (body: JupiterSubmitRequestBody) => {
  const executionId = asOptionalString(body.executionId);
  const signedTransactionBase64 = asOptionalString(body.signedTransactionBase64);
  const blockhash = asOptionalString(body.blockhash);
  const lastValidBlockHeight = asOptionalNonNegativeInteger(body.lastValidBlockHeight);
  const maxRetries = asOptionalNonNegativeInteger(body.maxRetries);

  const errors = [
    !executionId || !uuidPattern.test(executionId) ? 'executionId must be a UUID' : null,
    !signedTransactionBase64 ? 'signedTransactionBase64 must be a base64-encoded signed transaction' : null,
    body.blockhash !== undefined && !blockhash ? 'blockhash must be a non-empty string' : null,
    body.lastValidBlockHeight !== undefined && lastValidBlockHeight === undefined
      ? 'lastValidBlockHeight must be a non-negative integer'
      : null,
    body.maxRetries !== undefined && maxRetries === undefined
      ? 'maxRetries must be a non-negative integer'
      : null,
    (blockhash && lastValidBlockHeight === undefined) || (!blockhash && lastValidBlockHeight !== undefined)
      ? 'blockhash and lastValidBlockHeight must be provided together for confirmation'
      : null,
  ].filter((value): value is string => value !== null);

  if (errors.length > 0) {
    return { ok: false as const, errors };
  }

  const value: ValidatedJupiterSubmitRequest = {
    executionId: executionId!,
    signedTransactionBase64: signedTransactionBase64!,
    blockhash,
    lastValidBlockHeight,
    maxRetries,
  };

  return {
    ok: true as const,
    value,
  };
};

const parseJsonResponse = (responseText: string) => {
  if (responseText.length === 0) {
    return null;
  }

  return JSON.parse(responseText) as unknown;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const retriableStatusCodes = new Set([408, 429, 500, 502, 503, 504]);

const fetchJsonWithRetry = async (options: {
  label: string;
  limiter?: { acquire: () => Promise<void> };
  budget?: { reserve: () => Promise<void> };
  request: () => Promise<Response>;
  maxAttempts?: number;
}) => {
  const maxAttempts = options.maxAttempts ?? 5;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (options.budget) {
        await options.budget.reserve();
      }

      if (options.limiter) {
        await options.limiter.acquire();
      }

      const response = await options.request();
      const responseText = await response.text();
      const payload = parseJsonResponse(responseText);

      if (retriableStatusCodes.has(response.status) && attempt < maxAttempts) {
        const delayMs = getExponentialBackoffDelayMs(attempt);
        app.log.warn({ attempt, delayMs, label: options.label, status: response.status }, 'retriable upstream response');
        await sleep(delayMs);
        continue;
      }

      return {
        ok: response.ok,
        status: response.status,
        payload,
        responseText,
      };
    } catch (error) {
      if (error instanceof ProviderBudgetExceededError) {
        throw error;
      }

      lastError = error;

      if (attempt === maxAttempts) {
        break;
      }

      const delayMs = getExponentialBackoffDelayMs(attempt);
      app.log.warn({ attempt, delayMs, label: options.label, error }, 'retriable upstream network error');
      await sleep(delayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Failed request for ${options.label}`);
};

const rlGetAddressLookupTable = async (lookupTableAddress: PublicKey) => {
  if (!heliusConnection) throw new Error('Solana integration is not ready');
  await reserveHeliusRpc();
  return getHeliusRpcConnection().getAddressLookupTable(lookupTableAddress);
};

// Address lookup tables are effectively stable for routing within a short window.
// Caching them removes the largest per-trade Helius RPC cost (~2-4 calls/trade at 350-bot scale).
const ALT_CACHE_TTL_MS = Number(process.env.API_ALT_CACHE_TTL_MS ?? 300_000);
const lookupTableAccountCache = new Map<string, { value: AddressLookupTableAccount; expiresAt: number }>();

const getCachedLookupTableAccount = async (
  lookupTableAddress: string,
): Promise<AddressLookupTableAccount | null> => {
  const now = Date.now();
  const cached = lookupTableAccountCache.get(lookupTableAddress);
  if (cached && cached.expiresAt > now) {
    recordProviderLaneUse('helius-rpc-cache-hit', 0);
    return cached.value;
  }

  const result = await rlGetAddressLookupTable(new PublicKey(lookupTableAddress));
  if (result.value) {
    lookupTableAccountCache.set(lookupTableAddress, {
      value: result.value,
      expiresAt: now + ALT_CACHE_TTL_MS,
    });
  }
  return result.value;
};

const rlGetBalance = async (publicKey: PublicKey) => {
  if (!heliusConnection) throw new Error('Solana integration is not ready');
  await reserveHeliusRpc();
  return getHeliusRpcConnection().getBalance(publicKey, 'confirmed');
};

const rlGetLatestBlockhash = async () => {
  if (!heliusConnection) throw new Error('Solana integration is not ready');
  await reserveHeliusRpc();
  return getHeliusRpcConnection().getLatestBlockhash('confirmed');
};

const rlGetFeeForMessage = async (message: Parameters<Connection['getFeeForMessage']>[0]) => {
  if (!heliusConnection) throw new Error('Solana integration is not ready');
  await reserveHeliusRpc();
  return getHeliusRpcConnection().getFeeForMessage(message, 'confirmed');
};

const rlSimulateTransaction = async (transaction: VersionedTransaction) => {
  if (!heliusConnection) throw new Error('Solana integration is not ready');
  await reserveHeliusRpc();
  return getHeliusRpcConnection().simulateTransaction(transaction, {
    replaceRecentBlockhash: true,
    sigVerify: false,
    commitment: 'confirmed',
  });
};

const rlGetBlockHeight = async () => {
  if (!heliusConnection) throw new Error('Solana integration is not ready');
  await reserveHeliusRpc();
  return getHeliusRpcConnection().getBlockHeight('confirmed');
};

const rlSendRawTransaction = async (serializedTransaction: Uint8Array, maxRetries?: number) => {
  if (!heliusConnection) throw new Error('Solana integration is not ready');
  await reserveHeliusRpc();
  return getHeliusRpcConnection().sendRawTransaction(serializedTransaction, {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
    ...(maxRetries !== undefined ? { maxRetries } : {}),
  });
};

const rlConfirmTransaction = async (params: { signature: string; blockhash: string; lastValidBlockHeight: number }) => {
  if (!heliusConnection) throw new Error('Solana integration is not ready');
  await reserveHeliusRpc();
  return getHeliusRpcConnection().confirmTransaction(params, 'confirmed');
};

const rlGetSignatureStatus = async (signature: string) => {
  if (!heliusConnection) throw new Error('Solana integration is not ready');
  await reserveHeliusRpc();
  return getHeliusRpcConnection().getSignatureStatus(signature, {
    searchTransactionHistory: true,
  });
};

const rlGetSignatureStatuses = async (signatures: string[]) => {
  if (!heliusConnection) throw new Error('Solana integration is not ready');
  await reserveHeliusRpc();
  return getHeliusRpcConnection().getSignatureStatuses(signatures, {
    searchTransactionHistory: true,
  });
};

const rlGetTransaction = async (signature: string) => {
  if (!heliusConnection) throw new Error('Solana integration is not ready');
  await reserveHeliusRpc();
  return getHeliusRpcConnection().getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
};

const getUsdValueFromAtomicAmount = (mint: string, amountAtomic: number, solUsdPrice: number | null = null): number => {
  if (!Number.isFinite(amountAtomic) || amountAtomic <= 0) {
    return 0;
  }

  if (mint === USDC_MINT || mint === USDT_MINT) {
    return amountAtomic / 1_000_000;
  }

  if (mint === SOL_MINT && solUsdPrice && solUsdPrice > 0) {
    return (amountAtomic / 1_000_000_000) * solUsdPrice;
  }

  return 0;
};

const fetchPythSolUsd = async (): Promise<PythQuoteSample> => {
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
    }>;
  };

  const parsed = body.parsed?.find((entry) => entry.id === pythPriceConfig.solUsdFeedId);
  if (!parsed) {
    throw new Error(`pyth hermes response missing feed ${pythPriceConfig.solUsdFeedId}`);
  }

  const scale = Math.pow(10, parsed.price.expo);
  const usdPrice = Number(parsed.price.price) * scale;
  const confidenceUsd = Number(parsed.price.conf) * scale;
  const confidenceBps = usdPrice > 0
    ? Math.round((confidenceUsd / usdPrice) * 10_000)
    : 0;

  return {
    usdPrice,
    confidenceUsd,
    confidenceBps,
    publishTime: parsed.price.publish_time,
    sampledAt: new Date().toISOString(),
  };
};

const getPythFundingQuoteSample = async () => {
  const sample = await fetchPythSolUsd();
  const sampleAgeSeconds = Math.max(0, Math.floor(Date.now() / 1000) - sample.publishTime);

  if (sampleAgeSeconds > workerSignalPolicy.maxPythAgeSeconds) {
    throw new Error(`stale_price_${sampleAgeSeconds}s`);
  }

  if (sample.confidenceBps > workerSignalPolicy.maxPythConfidenceBps) {
    throw new Error(`confidence_too_wide_${sample.confidenceBps}bps`);
  }

  return sample;
};

const getTransactionAccountKeys = (transactionDetails: any): string[] => {
  const staticAccountKeys = transactionDetails?.transaction?.message?.staticAccountKeys?.map((key: { toBase58: () => string }) => key.toBase58()) ?? [];
  const loadedWritable = transactionDetails?.meta?.loadedAddresses?.writable ?? [];
  const loadedReadonly = transactionDetails?.meta?.loadedAddresses?.readonly ?? [];
  return [...staticAccountKeys, ...loadedWritable, ...loadedReadonly];
};

const getTokenBalanceDeltaAtomic = (
  transactionDetails: any,
  params: { mint: string; owner?: string; accountAddress?: string },
): number | null => {
  const accountKeys = getTransactionAccountKeys(transactionDetails);
  const preTokenBalances = transactionDetails?.meta?.preTokenBalances ?? [];
  const postTokenBalances = transactionDetails?.meta?.postTokenBalances ?? [];
  const matchingIndexes = new Set<number>();

  const matches = (entry: any) => {
    if (!entry || entry.mint !== params.mint) {
      return false;
    }

    const accountAddress = accountKeys[entry.accountIndex] ?? null;
    if (params.owner && entry.owner !== params.owner) {
      return false;
    }
    if (params.accountAddress && accountAddress !== params.accountAddress) {
      return false;
    }

    return true;
  };

  for (const entry of preTokenBalances) {
    if (matches(entry)) {
      matchingIndexes.add(entry.accountIndex);
    }
  }

  for (const entry of postTokenBalances) {
    if (matches(entry)) {
      matchingIndexes.add(entry.accountIndex);
    }
  }

  if (matchingIndexes.size === 0) {
    return null;
  }

  let totalDeltaAtomic = 0;
  for (const accountIndex of matchingIndexes) {
    const preAmount = Number(
      preTokenBalances.find((entry: any) => entry.accountIndex === accountIndex)?.uiTokenAmount?.amount
      ?? '0',
    );
    const postAmount = Number(
      postTokenBalances.find((entry: any) => entry.accountIndex === accountIndex)?.uiTokenAmount?.amount
      ?? '0',
    );
    totalDeltaAtomic += postAmount - preAmount;
  }

  return totalDeltaAtomic;
};

const getTokenPostBalanceAtomic = (
  transactionDetails: any,
  params: { mint: string; owner?: string; accountAddress?: string },
): number | null => {
  const accountKeys = getTransactionAccountKeys(transactionDetails);
  const postTokenBalances = transactionDetails?.meta?.postTokenBalances ?? [];
  let totalPostAtomic = 0;
  let matched = false;

  for (const entry of postTokenBalances) {
    if (!entry || entry.mint !== params.mint) {
      continue;
    }

    const accountAddress = accountKeys[entry.accountIndex] ?? null;
    if (params.owner && entry.owner !== params.owner) {
      continue;
    }
    if (params.accountAddress && accountAddress !== params.accountAddress) {
      continue;
    }

    matched = true;
    totalPostAtomic += Number(entry.uiTokenAmount?.amount ?? '0');
  }

  return matched ? totalPostAtomic : null;
};

const getTokenDecimalsFromTransaction = (transactionDetails: any, mint: string): number | null => {
  const tokenBalances = [
    ...(transactionDetails?.meta?.preTokenBalances ?? []),
    ...(transactionDetails?.meta?.postTokenBalances ?? []),
  ];
  const match = tokenBalances.find((entry: any) => entry?.mint === mint && Number.isFinite(entry?.uiTokenAmount?.decimals));
  return Number.isFinite(match?.uiTokenAmount?.decimals) ? Number(match.uiTokenAmount.decimals) : null;
};

const getWalletBalanceSnapshot = (transactionDetails: any, wallet: string) => {
  const accountKeys = getTransactionAccountKeys(transactionDetails);
  const accountIndex = accountKeys.findIndex((accountKey) => accountKey === wallet);

  if (accountIndex < 0) {
    return null;
  }

  const preBalance = Number(transactionDetails?.meta?.preBalances?.[accountIndex] ?? NaN);
  const postBalance = Number(transactionDetails?.meta?.postBalances?.[accountIndex] ?? NaN);

  if (!Number.isFinite(preBalance) || !Number.isFinite(postBalance)) {
    return null;
  }

  return {
    preBalance,
    postBalance,
    delta: postBalance - preBalance,
  };
};

const buildExecutionConfirmationSnapshot = (transactionDetails: any) => ({
  slot: transactionDetails?.slot ?? null,
  blockTime: transactionDetails?.blockTime ?? null,
  meta: {
    err: transactionDetails?.meta?.err ?? null,
    fee: transactionDetails?.meta?.fee ?? null,
    computeUnitsConsumed: transactionDetails?.meta?.computeUnitsConsumed ?? null,
    costUnits: transactionDetails?.meta?.costUnits ?? null,
  },
  accountKeys: getTransactionAccountKeys(transactionDetails),
  preBalances: transactionDetails?.meta?.preBalances ?? [],
  postBalances: transactionDetails?.meta?.postBalances ?? [],
  preTokenBalances: transactionDetails?.meta?.preTokenBalances ?? [],
  postTokenBalances: transactionDetails?.meta?.postTokenBalances ?? [],
});

const getDynamicSenderTipLamports = async () => {
  const minimumLamports = heliusTradingConfig.senderMinTipLamports;

  try {
    const result = await fetchJsonWithRetry({
      label: 'jito-tip-floor',
      request: () => fetch('https://bundles.jito.wtf/api/v1/bundles/tip_floor'),
      maxAttempts: 3,
    });
    const tipFloor = Array.isArray(result.payload) ? result.payload[0] : null;
    const landedTip = typeof tipFloor?.landed_tips_75th_percentile === 'number'
      ? tipFloor.landed_tips_75th_percentile
      : null;

    if (landedTip === null) {
      return minimumLamports;
    }

    return Math.max(minimumLamports, Math.ceil(landedTip * 1_000_000_000));
  } catch (error) {
    app.log.warn({ error }, 'failed to fetch dynamic Jito tip floor; using minimum sender tip');
    return minimumLamports;
  }
};

const estimatePriorityFeeMicroLamports = async (params: {
  payer: PublicKey;
  blockhash: string;
  instructions: TransactionInstruction[];
}) => {
  const result = await fetchJsonWithRetry({
    label: 'helius-priority-fee-estimate',
    budget: { reserve: reserveHeliusRpc },
    request: () => fetch(getHeliusRpcConnection().rpcEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPriorityFeeEstimateRequest({
        payer: params.payer,
        blockhash: params.blockhash,
        instructions: params.instructions,
        priorityLevel: heliusTradingConfig.priorityFeeLevel,
      })),
    }),
  });

  return parsePriorityFeeEstimateResponse(
    result.payload,
    heliusTradingConfig.priorityFeeFallbackMicroLamports,
    heliusTradingConfig.priorityFeeMultiplier,
  );
};

const sendViaHeliusSender = async (signedTransactionBase64: string) => {
  const result = await fetchJsonWithRetry({
    label: 'helius-sender',
    budget: { reserve: reserveHeliusSender },
    request: () => fetch(heliusTradingConfig.senderEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now().toString(),
        method: 'sendTransaction',
        params: [
          signedTransactionBase64,
          {
            encoding: 'base64',
            skipPreflight: true,
            maxRetries: 0,
          },
        ],
      }),
    }),
  });

  return parseSenderSignature(result.payload);
};

const toTransactionInstruction = (instruction: JupiterInstructionPayload) =>
  new TransactionInstruction({
    programId: new PublicKey(instruction.programId),
    keys: instruction.accounts.map((account) => ({
      pubkey: new PublicKey(account.pubkey),
      isSigner: account.isSigner,
      isWritable: account.isWritable,
    })),
    data: Buffer.from(instruction.data, 'base64'),
  });

const loadLookupTableAccounts = async (
  _connection: Connection,
  addressesByLookupTableAddress: Record<string, string[]>,
) => {
  const lookupTableAddresses = Object.keys(addressesByLookupTableAddress ?? {});

  if (lookupTableAddresses.length === 0) {
    return [] as AddressLookupTableAccount[];
  }

  const lookupTableResults = await Promise.all(
    lookupTableAddresses.map(async (lookupTableAddress) => {
      const value = await getCachedLookupTableAccount(lookupTableAddress);
      return {
        lookupTableAddress,
        value,
      };
    }),
  );

  const missingLookupTables = lookupTableResults
    .filter((result) => result.value === null)
    .map((result) => result.lookupTableAddress);

  if (missingLookupTables.length > 0) {
    throw new Error(`Missing lookup table accounts: ${missingLookupTables.join(', ')}`);
  }

  return lookupTableResults.map((result) => result.value!);
};

const getCoreSwapInstructions = (build: JupiterBuildResponse) => [
  ...build.setupInstructions.map(toTransactionInstruction),
  toTransactionInstruction(build.swapInstruction),
  ...(build.cleanupInstruction ? [toTransactionInstruction(build.cleanupInstruction)] : []),
  ...build.otherInstructions.map(toTransactionInstruction),
  ...(build.tipInstruction ? [toTransactionInstruction(build.tipInstruction)] : []),
];

const getBuildBlockhash = (build: JupiterBuildResponse) => {
  const { blockhash } = build.blockhashWithMetadata;

  if (typeof blockhash === 'string') {
    return blockhash;
  }

  if (Array.isArray(blockhash) && blockhash.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
    return bs58.encode(Buffer.from(blockhash));
  }

  throw new Error('Jupiter build response returned an invalid blockhash format');
};

// Platform fee is charged ONLY on profit-taking exits (take_profit / trailing_stop),
// which by design fire above the cost floor. Entries, stop-losses, and signal
// reversals are fee-free so users never pay the platform fee on an entry or a loss.
const PROFIT_EXIT_FEE_REASONS = new Set(['take_profit', 'trailing_stop']);

const resolveEffectivePlatformFeeBps = (
  request: ValidatedJupiterBuildRequest,
  basePlatformFeeBps: number,
): number => {
  if (request.exitReason && PROFIT_EXIT_FEE_REASONS.has(request.exitReason)) {
    return basePlatformFeeBps;
  }
  return 0;
};

const fetchJupiterBuild = async (
  request: ValidatedJupiterBuildRequest,
  feeAccount: string,
  routeControlsOverride?: JupiterRouteControlOverrides,
) => {
  if (!jupiterSwapBuildConfig) {
    throw new Error('Jupiter integration is not ready');
  }

  const routeControls = {
    ...jupiterSwapBuildConfig.routeControls,
    ...routeControlsOverride,
  };

  const effectivePlatformFeeBps = resolveEffectivePlatformFeeBps(
    request,
    jupiterSwapBuildConfig.platformFeeBps,
  );

  const params = new URLSearchParams({
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    amount: request.amount,
    taker: request.taker,
  });

  if (effectivePlatformFeeBps > 0) {
    params.set('platformFeeBps', String(effectivePlatformFeeBps));
    params.set('feeAccount', feeAccount);
  }

  if (request.slippageBps) {
    params.set('slippageBps', request.slippageBps);
  }

  if (routeControls.maxAccounts !== undefined) {
    params.set('maxAccounts', String(routeControls.maxAccounts));
  }

  if (routeControls.dexes) {
    params.set('dexes', routeControls.dexes);
  }

  if (routeControls.excludeDexes) {
    params.set('excludeDexes', routeControls.excludeDexes);
  }

  const result = await fetchJsonWithRetry({
    label: 'jupiter-build',
    budget: { reserve: reserveJupiterRequest },
    request: () => fetch(`${jupiterSwapBuildConfig.apiBaseUrl}/build?${params.toString()}`, {
      headers: { 'x-api-key': (jupiterApiKeySelector?.next() ?? jupiterSwapBuildConfig.apiKey) },
    }),
  });

  return {
    ok: result.ok,
    status: result.status,
    payload: result.payload,
  };
};

const createSimulationSwapTransaction = (
  taker: string,
  blockhash: string,
  lookupTableAccounts: AddressLookupTableAccount[],
  instructions: TransactionInstruction[],
) => {
  const message = new TransactionMessage({
    payerKey: new PublicKey(taker),
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(lookupTableAccounts);

  return new VersionedTransaction(message);
};

const createPreparedSwapTransaction = (
  taker: string,
  blockhash: string,
  lookupTableAccounts: AddressLookupTableAccount[],
  instructions: TransactionInstruction[],
) => {
  const message = new TransactionMessage({
    payerKey: new PublicKey(taker),
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(lookupTableAccounts);

  return new VersionedTransaction(message);
};

const getTransactionMessageBase64 = (transaction: VersionedTransaction) =>
  Buffer.from(transaction.message.serialize()).toString('base64');

const estimatePriorityFeeLamports = (computeUnitLimit: number, priorityFeeMicroLamports?: number) => {
  if (!priorityFeeMicroLamports || priorityFeeMicroLamports <= 0) {
    return 0;
  }

  return Math.ceil((computeUnitLimit * priorityFeeMicroLamports) / 1_000_000);
};

const lamportShortfallPattern = /insufficient lamports\s+(\d+), need\s+(\d+)/i;
const insufficientFundsForFeePattern = /insufficient funds for fee/i;

const extractLamportShortfallFromText = (text: string | null | undefined): LamportShortfall | null => {
  if (!text) {
    return null;
  }

  const match = text.match(lamportShortfallPattern);

  if (!match) {
    return null;
  }

  const availableLamports = Number(match[1]);
  const requiredLamports = Number(match[2]);

  if (!Number.isFinite(availableLamports) || !Number.isFinite(requiredLamports)) {
    return null;
  }

  return {
    availableLamports,
    requiredLamports,
    gapLamports: Math.max(0, requiredLamports - availableLamports),
  };
};

const isInsufficientFundsForFeeText = (text: string | null | undefined): boolean => {
  if (!text) {
    return false;
  }

  return insufficientFundsForFeePattern.test(text);
};

const extractLamportShortfallFromLogs = (logs: string[] | null | undefined): LamportShortfall | null => {
  if (!logs || logs.length === 0) {
    return null;
  }

  for (const line of logs) {
    const shortfall = extractLamportShortfallFromText(line);
    if (shortfall) {
      return shortfall;
    }
  }

  return null;
};

const computeExhaustionPattern = /(exceeded CUs meter|comput(e|e units?)|ProgramFailedToComplete|panicked in src\/internal\.rs)/i;

const isComputeHeavySimulationFailure = (simulation: { err?: unknown; logs?: string[] | null } | null | undefined) => {
  if (!simulation?.err) {
    return false;
  }

  const errText = JSON.stringify(simulation.err);
  if (computeExhaustionPattern.test(errText)) {
    return true;
  }

  return (simulation.logs ?? []).some((line) => computeExhaustionPattern.test(line));
};

const getFallbackMaxAccountsCandidates = (configuredMaxAccounts?: number) => {
  const startingPoint = configuredMaxAccounts ?? 32;
  const candidates = [24, 20, 16, 12]
    .filter((value) => value > 0 && value < startingPoint);

  return [...new Set(candidates)];
};

const buildPreparedSimulationCandidate = async (params: {
  request: ValidatedJupiterBuildRequest;
  feeAccount: string;
  routeControlsOverride?: JupiterRouteControlOverrides;
}) => {
  if (!heliusConnection) {
    throw new Error('Solana integration is not ready');
  }

  const buildResult = await fetchJupiterBuild(
    params.request,
    params.feeAccount,
    params.routeControlsOverride,
  );

  if (!buildResult.ok) {
    return {
      ok: false as const,
      buildResult,
    };
  }

  const build = buildResult.payload as JupiterBuildResponse;
  const lookupTableAccounts = await loadLookupTableAccounts(
    heliusConnection,
    build.addressesByLookupTableAddress ?? {},
  );
  const blockhash = getBuildBlockhash(build);
  const coreSwapInstructions = getCoreSwapInstructions(build);
  const payer = new PublicKey(params.request.taker);
  const senderTipLamports = heliusTradingConfig.senderEnabled
    ? await getDynamicSenderTipLamports()
    : null;
  const simulationInstructions = composePreparedSwapInstructions({
    senderEnabled: heliusTradingConfig.senderEnabled,
    payer,
    computeUnitLimit: maxComputeUnitLimit,
    priorityFeeMicroLamports: heliusTradingConfig.priorityFeeFallbackMicroLamports,
    senderTipLamports: senderTipLamports ?? undefined,
    baseComputeBudgetInstructions: build.computeBudgetInstructions.map(toTransactionInstruction),
    coreSwapInstructions,
  });
  const simulationTransaction = createSimulationSwapTransaction(
    params.request.taker,
    blockhash,
    lookupTableAccounts,
    simulationInstructions,
  );
  const simulation = await rlSimulateTransaction(simulationTransaction);
  const simulationShortfall = extractLamportShortfallFromLogs(simulation.value.logs ?? []);

  return {
    ok: true as const,
    build,
    blockhash,
    coreSwapInstructions,
    payer,
    senderTipLamports,
    simulation,
    simulationShortfall,
    routeControlsOverride: params.routeControlsOverride,
  };
};

const reconcileExecutionById = async (executionId: string) => {
  if (!heliusConnection) {
    throw new Error('Solana integration is not ready');
  }

  const execution = await getExecutionById(executionId);

  if (!execution) {
    return { kind: 'not_found' as const };
  }

  if (!execution.signature) {
    return {
      kind: 'not_reconcilable' as const,
      execution,
      reason: 'Execution does not have a signature yet',
    };
  }

  const signatureStatuses = await rlGetSignatureStatuses([execution.signature]);
  const signatureStatusValue = signatureStatuses.value[0] ?? null;
  const currentBlockHeight = execution.lastValidBlockHeight !== null
    ? await rlGetBlockHeight()
    : null;

  return reconcileSubmittedExecutionRecord(execution, signatureStatusValue, currentBlockHeight);
};

const reconcileSubmittedExecutionRecord = async (
  execution: SwapExecution,
  signatureStatusValue: SignatureStatus | null,
  currentBlockHeight: number | null,
) => {
  if (!execution.signature) {
    return {
      kind: 'not_reconcilable' as const,
      execution,
      reason: 'Execution does not have a signature yet',
    };
  }

  const confirmationStatus = signatureStatusValue?.confirmationStatus ?? null;
  const blockhashExpired =
    execution.lastValidBlockHeight !== null &&
    currentBlockHeight !== null &&
    currentBlockHeight > execution.lastValidBlockHeight;
  const nextStatus = signatureStatusValue?.err
    ? 'failed'
    : confirmationStatus === 'confirmed' || confirmationStatus === 'finalized'
      ? 'confirmed'
      : blockhashExpired
        ? 'failed'
        : 'submitted';
  const now = new Date().toISOString();
  const transitionedToConfirmed = execution.status !== 'confirmed' && nextStatus === 'confirmed';
  const transactionDetails = transitionedToConfirmed && execution.signature
    ? await rlGetTransaction(execution.signature)
    : null;
  const updatedExecution = await updateSubmittedExecution({
    id: execution.id,
    status: nextStatus,
    signature: execution.signature,
    confirmationStatus,
    confirmation: transactionDetails ? buildExecutionConfirmationSnapshot(transactionDetails) : execution.confirmation,
    signatureStatus: signatureStatusValue
      ? {
          slot: signatureStatusValue.slot,
          confirmations: signatureStatusValue.confirmations,
          err: signatureStatusValue.err,
          confirmationStatus,
        }
      : null,
    lastError: signatureStatusValue?.err
      ? {
          stage: 'reconcile',
          reason: 'signature_error',
          signatureStatusError: signatureStatusValue.err,
        }
      : blockhashExpired
        ? {
            stage: 'reconcile',
            reason: 'confirmation_expired',
            blockhash: execution.blockhash,
            lastValidBlockHeight: execution.lastValidBlockHeight,
            currentBlockHeight,
          }
        : null,
    submittedAt: execution.submittedAt ?? now,
    confirmedAt: nextStatus === 'confirmed' ? execution.confirmedAt ?? now : null,
    updatedAt: now,
  });

  if (updatedExecution?.status === 'confirmed') {
    const session = await getSessionByWallet(updatedExecution.taker);

    if (session) {
      const alreadyAccounted = session.serviceControl.lastExecutionAudit?.executionId === updatedExecution.id;
      if (alreadyAccounted) {
        return {
          kind: 'updated' as const,
          execution: updatedExecution,
        };
      }

      const currentPositionState = session.serviceControl.positionState;
      const currentPositionsState = normalizePositionsState(
        session.serviceControl.positionsState,
        currentPositionState ?? null,
      );
      let nextPositionsState = currentPositionsState;
      let summaryFallback = currentPositionState ?? buildFlatSessionPositionState();
      const confirmedAt = updatedExecution.confirmedAt ?? now;
      const quotedOutputAtomic = typeof updatedExecution.build?.outAmount === 'string'
        ? updatedExecution.build.outAmount
        : null;
      const expectedOutputAtomic = quotedOutputAtomic !== null ? Number(quotedOutputAtomic) : null;
      const markedPriceUsd = currentPositionState?.lastMarkedPriceUsd ?? null;

      const inAtomic = Number(updatedExecution.amount);
      const feeMint = updatedExecution.feeTokenSymbol === 'USDC'
        ? USDC_MINT
        : updatedExecution.feeTokenSymbol === 'USDT'
          ? USDT_MINT
          : SOL_MINT;
      const feeAccountDeltaAtomic = transactionDetails
        ? Math.max(0, getTokenBalanceDeltaAtomic(transactionDetails, {
            mint: feeMint,
            accountAddress: updatedExecution.feeAccount,
          }) ?? 0)
        : 0;
      let feeSolUsdPrice = markedPriceUsd;
      if (feeMint === SOL_MINT && feeAccountDeltaAtomic > 0 && (!feeSolUsdPrice || feeSolUsdPrice <= 0)) {
        try {
          feeSolUsdPrice = (await fetchPythSolUsd()).usdPrice;
        } catch (error) {
          console.warn('Unable to fetch SOL/USD price for fee accounting', error);
        }
      }
      const capturedFeeUsdFromDelta = feeAccountDeltaAtomic > 0
        ? getUsdValueFromAtomicAmount(feeMint, feeAccountDeltaAtomic, feeSolUsdPrice)
        : 0;
      const walletBalanceSnapshot = transactionDetails
        ? getWalletBalanceSnapshot(transactionDetails, updatedExecution.taker)
        : null;
      const usdcPostBalanceAtomic = transactionDetails
        ? getTokenPostBalanceAtomic(transactionDetails, {
            mint: USDC_MINT,
            owner: updatedExecution.taker,
          })
        : null;
      let realizedDeltaUsd = 0;
      let capturedFeesDeltaUsd = 0;
      let costBasisPerSolUsd: number | null = null;
      let fundingPatch: Partial<import('@roguezero/session-schema').Session['funding']> | undefined;
      let executionAuditDirection: 'enter_long' | 'exit_long' | 'other' = 'other';
      let actualOutputAtomic: number | null = null;

      if (
        updatedExecution.outputMint === USDC_MINT
        && isLongPositionStatus((currentPositionsState.positions[updatedExecution.inputMint]?.status ?? 'flat') as SessionPositionState['status'])
      ) {
        executionAuditDirection = 'exit_long';
        const soldMint = updatedExecution.inputMint;
        const existingPosition = currentPositionsState.positions[soldMint] ?? null;
        const observedUsdcDelta = transactionDetails
          ? getTokenBalanceDeltaAtomic(transactionDetails, {
              mint: USDC_MINT,
              owner: updatedExecution.taker,
            })
          : null;
        const outAtomic = observedUsdcDelta !== null && observedUsdcDelta > 0
          ? observedUsdcDelta
          : (quotedOutputAtomic !== null ? Number(quotedOutputAtomic) : 0);
        actualOutputAtomic = outAtomic > 0 ? outAtomic : null;
        const soldDecimals = (transactionDetails ? getTokenDecimalsFromTransaction(transactionDetails, soldMint) : null)
          ?? existingPosition?.tokenDecimals
          ?? (soldMint === SOL_MINT ? 9 : 6);
        const entry = existingPosition?.entryPriceUsd ?? null;
        if (entry !== null) {
          const realized = computeTokenToUsdcRealizedPnlUsd({
            receivedUsdcAtomic: outAtomic,
            soldAtomic: inAtomic,
            soldDecimals,
            entryPriceUsd: entry,
          });
          if (realized !== null) {
            realizedDeltaUsd = realized;
          }
        }
        capturedFeesDeltaUsd = capturedFeeUsdFromDelta;
        fundingPatch = usdcPostBalanceAtomic !== null
          ? { currentBalanceAtomic: String(usdcPostBalanceAtomic) }
          : undefined;

        const exitUpdate = applyPositionExit({
          existingPosition,
          soldAtomic: inAtomic,
          exitReason: existingPosition?.pendingExitReason ?? existingPosition?.exitReason ?? 'signal_reversal',
          fallbackMarkedPriceUsd: currentPositionState?.lastMarkedPriceUsd ?? null,
          fallbackMarkedAt: currentPositionState?.lastMarkedAt ?? null,
        });
        const nextPositions = { ...currentPositionsState.positions };
        if (exitUpdate.remainingPosition) {
          nextPositions[soldMint] = exitUpdate.remainingPosition;
        } else {
          delete nextPositions[soldMint];
        }
        nextPositionsState = normalizePositionsState({
          activePositionMint: currentPositionsState.activePositionMint === soldMint
            ? null
            : currentPositionsState.activePositionMint,
          positions: nextPositions,
        }, null);
        summaryFallback = exitUpdate.summaryFallback;
      } else if (
        updatedExecution.inputMint === USDC_MINT
        && updatedExecution.outputMint !== USDC_MINT
      ) {
        executionAuditDirection = 'enter_long';
        const boughtMint = updatedExecution.outputMint;
        const existingPosition = currentPositionsState.positions[boughtMint] ?? null;
        const observedUsdcDelta = transactionDetails
          ? getTokenBalanceDeltaAtomic(transactionDetails, {
              mint: USDC_MINT,
              owner: updatedExecution.taker,
            })
          : null;
        const usdcSpentAtomic = observedUsdcDelta !== null && observedUsdcDelta < 0
          ? Math.abs(observedUsdcDelta)
          : inAtomic;
        const observedOutputDelta = transactionDetails
          ? getTokenBalanceDeltaAtomic(transactionDetails, {
              mint: boughtMint,
              owner: updatedExecution.taker,
            })
          : null;
        const outAtomic = observedOutputDelta !== null && observedOutputDelta > 0
          ? observedOutputDelta
          : (quotedOutputAtomic !== null ? Number(quotedOutputAtomic) : 0);
        actualOutputAtomic = outAtomic > 0 ? outAtomic : null;
        const usdcSpent = usdcSpentAtomic / 1e6;
        const outputDecimals = transactionDetails ? getTokenDecimalsFromTransaction(transactionDetails, boughtMint) : null;
        const outputUiAmount = getPositionUiAmount(boughtMint, outAtomic, outputDecimals);
        if (outputUiAmount > 0) {
          costBasisPerSolUsd = usdcSpent / outputUiAmount;
        }
        capturedFeesDeltaUsd = capturedFeeUsdFromDelta;
        fundingPatch = usdcPostBalanceAtomic !== null
          ? { currentBalanceAtomic: String(usdcPostBalanceAtomic) }
          : undefined;

        const entryPriceForState = costBasisPerSolUsd ?? markedPriceUsd;
        nextPositionsState = normalizePositionsState({
          activePositionMint: boughtMint,
          positions: {
            ...currentPositionsState.positions,
            [boughtMint]: upsertPositionEntry({
              existingPosition,
              mint: boughtMint,
              symbol: boughtMint === SOL_MINT ? 'SOL' : null,
              quantityAtomic: outAtomic > 0 ? outAtomic : Number(quotedOutputAtomic ?? 0),
              entryPriceUsd: entryPriceForState,
              tokenDecimals: outputDecimals,
              entryStrategy: updatedExecution.metadata.entryStrategy ?? updatedExecution.metadata.scannerStrategy ?? null,
              confirmedAt,
              markedPriceUsd,
              status: 'long',
            }),
          },
        }, null);
      } else if (
        updatedExecution.outputMint === SOL_MINT
        && isLongPositionStatus((currentPositionsState.positions[updatedExecution.inputMint]?.status ?? 'flat') as SessionPositionState['status'])
      ) {
        // Exit: token → SOL
        executionAuditDirection = 'exit_long';
        const soldMint = updatedExecution.inputMint;
        const existingPosition = currentPositionsState.positions[soldMint] ?? null;
        const observedSolDelta = walletBalanceSnapshot?.delta ?? null;
        const outLamports = observedSolDelta !== null && observedSolDelta > 0
          ? observedSolDelta
          : (quotedOutputAtomic !== null ? Number(quotedOutputAtomic) : 0);
        actualOutputAtomic = outLamports > 0 ? outLamports : null;
        const solReceived = outLamports / 1e9;
        const entry = existingPosition?.entryPriceUsd ?? null;
        const quantityAtomic = existingPosition?.quantityAtomic
          ? Number(existingPosition.quantityAtomic)
          : inAtomic;
        const quantityUi = getPositionUiAmount(soldMint, quantityAtomic, existingPosition?.tokenDecimals ?? null);
        if (entry !== null && solReceived > 0 && quantityUi > 0) {
          // Resolve SOL/USD explicitly for token→SOL exits. `markedPriceUsd`
          // belongs to the sold token/position and must not be reused as the
          // SOL proceeds price, or realized PnL is scaled down by hundreds.
          let solPriceUsd = 0;
          try {
            solPriceUsd = (await fetchPythSolUsd()).usdPrice;
          } catch (error) {
            console.warn('Unable to fetch SOL/USD price for token→SOL PnL accounting; leaving realized PnL unchanged', error);
          }

          const realized = computeTokenToSolRealizedPnlUsd({
            receivedLamports: outLamports,
            soldAtomic: quantityAtomic,
            soldDecimals: existingPosition?.tokenDecimals ?? (soldMint === SOL_MINT ? 9 : 6),
            entryPriceUsd: entry,
            solUsdPrice: solPriceUsd,
          });
          if (realized !== null) {
            realizedDeltaUsd = realized;
          }
        }
        capturedFeesDeltaUsd = 0; // SOL fee capture tracked separately
        fundingPatch = walletBalanceSnapshot
          ? { currentBalanceAtomic: String(walletBalanceSnapshot.postBalance) }
          : undefined;
        const exitUpdate = applyPositionExit({
          existingPosition,
          soldAtomic: inAtomic,
          exitReason: existingPosition?.pendingExitReason ?? existingPosition?.exitReason ?? 'signal_reversal',
          fallbackMarkedPriceUsd: currentPositionState?.lastMarkedPriceUsd ?? null,
          fallbackMarkedAt: currentPositionState?.lastMarkedAt ?? null,
        });
        const nextPositions = { ...currentPositionsState.positions };
        if (exitUpdate.remainingPosition) {
          nextPositions[soldMint] = exitUpdate.remainingPosition;
        } else {
          delete nextPositions[soldMint];
        }
        nextPositionsState = normalizePositionsState({
          activePositionMint: currentPositionsState.activePositionMint === soldMint
            ? null
            : currentPositionsState.activePositionMint,
          positions: nextPositions,
        }, null);
        summaryFallback = exitUpdate.summaryFallback;
      } else if (
        updatedExecution.inputMint === SOL_MINT
        && updatedExecution.outputMint === USDC_MINT
      ) {
        // Funding conversion: SOL → USDC establishes the neutral base inventory.
        // It is not a long position unless an existing SOL position was being exited,
        // which is handled by the outputMint === USDC_MINT exit branch above.
        executionAuditDirection = 'other';
        const observedUsdcDelta = transactionDetails
          ? getTokenBalanceDeltaAtomic(transactionDetails, {
              mint: USDC_MINT,
              owner: updatedExecution.taker,
            })
          : null;
        const outAtomic = observedUsdcDelta !== null && observedUsdcDelta > 0
          ? observedUsdcDelta
          : (quotedOutputAtomic !== null ? Number(quotedOutputAtomic) : 0);
        actualOutputAtomic = outAtomic > 0 ? outAtomic : null;
        capturedFeesDeltaUsd = capturedFeeUsdFromDelta;
        fundingPatch = usdcPostBalanceAtomic !== null
          ? {
              fundingMint: USDC_MINT,
              fundingTokenSymbol: 'USDC',
              currentBalanceAtomic: String(usdcPostBalanceAtomic),
            }
          : {
              fundingMint: USDC_MINT,
              fundingTokenSymbol: 'USDC',
            };
        nextPositionsState = normalizePositionsState({
          activePositionMint: currentPositionsState.activePositionMint,
          positions: currentPositionsState.positions,
        }, null);
        summaryFallback = summarizePositionsState(nextPositionsState, buildFlatSessionPositionState());
      } else if (
        updatedExecution.inputMint === SOL_MINT
        && updatedExecution.outputMint !== SOL_MINT
      ) {
        // Entry: SOL → token
        executionAuditDirection = 'enter_long';
        const boughtMint = updatedExecution.outputMint;
        const existingPosition = currentPositionsState.positions[boughtMint] ?? null;
        const observedSolDelta = walletBalanceSnapshot?.delta ?? null;
        const spentLamports = observedSolDelta !== null && observedSolDelta < 0
          ? Math.max(Math.abs(observedSolDelta), inAtomic)
          : inAtomic;
        // Use the actual on-chain token delta when available; fall back to the
        // quoted output only if the confirmation didn't expose a balance change.
        const observedOutputDelta = transactionDetails
          ? getTokenBalanceDeltaAtomic(transactionDetails, {
              mint: boughtMint,
              owner: updatedExecution.taker,
            })
          : null;
        const outAtomic = observedOutputDelta !== null && observedOutputDelta > 0
          ? observedOutputDelta
          : (quotedOutputAtomic !== null ? Number(quotedOutputAtomic) : 0);
        actualOutputAtomic = outAtomic > 0 ? outAtomic : null;
        const solSpent = spentLamports / 1e9;
        // Resolve the bought token's real decimals from the transaction instead
        // of assuming 6. A wrong decimal count scales the recorded quantity and
        // cost basis by orders of magnitude and fabricates phantom PnL on exit.
        const outputDecimals = transactionDetails ? getTokenDecimalsFromTransaction(transactionDetails, boughtMint) : null;
        const outputUiAmount = getPositionUiAmount(boughtMint, outAtomic, outputDecimals);
        if (outputUiAmount > 0 && solSpent > 0) {
          // Cost basis: USD per token = (SOL spent × SOL/USD) / tokens received.
          // This must never silently fall back to zero/null. If entry cost basis is
          // wrong, a later token→USDC exit treats returned principal as profit and
          // profit-payout can drain the whole exit proceeds to the owner wallet.
          // `markedPriceUsd` is the bought token's mark in this branch, not
          // SOL/USD. Always fetch SOL/USD for SOL-denominated cost basis.
          let solPriceUsd = 0;
          try {
            solPriceUsd = (await fetchPythSolUsd()).usdPrice;
          } catch (error) {
            console.warn('Unable to fetch SOL/USD price for SOL→token cost basis; recording entry without fabricated cost basis', error);
          }

          costBasisPerSolUsd = computeSolInputEntryPriceUsd({
            spentLamports,
            outputAtomic: outAtomic,
            outputDecimals: outputDecimals ?? (boughtMint === SOL_MINT ? 9 : 6),
            solUsdPrice: solPriceUsd,
          });
        }
        capturedFeesDeltaUsd = 0;
        fundingPatch = walletBalanceSnapshot
          ? { currentBalanceAtomic: String(walletBalanceSnapshot.postBalance) }
          : undefined;
        const entryPriceForState = costBasisPerSolUsd ?? existingPosition?.entryPriceUsd ?? null;
        nextPositionsState = normalizePositionsState({
          activePositionMint: boughtMint,
          positions: {
            ...currentPositionsState.positions,
            [boughtMint]: upsertPositionEntry({
              existingPosition,
              mint: boughtMint,
              symbol: boughtMint === SOL_MINT ? 'SOL' : null,
              quantityAtomic: outAtomic > 0 ? outAtomic : Number(quotedOutputAtomic ?? 0),
              entryPriceUsd: entryPriceForState,
              tokenDecimals: outputDecimals,
              entryStrategy: updatedExecution.metadata.entryStrategy ?? updatedExecution.metadata.scannerStrategy ?? null,
              confirmedAt,
              markedPriceUsd,
              status: 'long_sol',
            }),
          },
        }, null);
      }

      const nextPositionState = summarizePositionsState(nextPositionsState, summaryFallback);
      const positionsChanged = JSON.stringify(nextPositionsState) !== JSON.stringify(currentPositionsState);
      const outputDeltaBps = computeOutputDeltaBps(actualOutputAtomic, expectedOutputAtomic);
      const badFill = outputDeltaBps !== null && outputDeltaBps <= -Math.abs(EXECUTION_BAD_FILL_THRESHOLD_BPS);
      const currentRiskState = session.serviceControl.riskState;
      const confirmedAtIso = confirmedAt;
      const dayKey = getUtcDayKey(new Date(confirmedAtIso));
      const priceImpactPct = typeof updatedExecution.build?.priceImpactPct === 'string'
        ? updatedExecution.build.priceImpactPct
        : null;
      const previousDailyRealizedPnlUsd = currentRiskState?.dayKey === dayKey
        ? currentRiskState.dailyRealizedPnlUsd
        : 0;
      const dailyRealizedPnlUsd = Number((previousDailyRealizedPnlUsd + realizedDeltaUsd).toFixed(6));
      const consecutiveLosses = realizedDeltaUsd < 0
        ? (currentRiskState?.consecutiveLosses ?? 0) + 1
        : realizedDeltaUsd > 0
          ? 0
          : currentRiskState?.consecutiveLosses ?? 0;
      const badFillStreak = badFill
        ? (currentRiskState?.badFillStreak ?? 0) + 1
        : outputDeltaBps !== null
          ? 0
          : currentRiskState?.badFillStreak ?? 0;
      const serviceControlPatch: SessionServiceControlPatch = {
        riskState: {
          dayKey,
          dailyRealizedPnlUsd,
          consecutiveLosses,
          badFillStreak,
          lastLossAt: realizedDeltaUsd < 0 ? confirmedAtIso : currentRiskState?.lastLossAt ?? null,
          lastBadFillAt: badFill ? confirmedAtIso : currentRiskState?.lastBadFillAt ?? null,
        },
        lastExecutionAudit: {
          at: confirmedAtIso,
          executionId: updatedExecution.id,
          direction: executionAuditDirection,
          inputMint: updatedExecution.inputMint,
          outputMint: updatedExecution.outputMint,
          inputAmountAtomic: String(updatedExecution.amount),
          expectedOutputAtomic: expectedOutputAtomic !== null && expectedOutputAtomic > 0 ? String(expectedOutputAtomic) : null,
          actualOutputAtomic: actualOutputAtomic !== null && actualOutputAtomic > 0 ? String(actualOutputAtomic) : null,
          outputDeltaBps,
          priceImpactBps: parseQuotePriceImpactBps(priceImpactPct),
          badFill,
        },
      };

      if (positionsChanged) {
        serviceControlPatch.positionsState = nextPositionsState;
        serviceControlPatch.positionState = nextPositionState;
      }

      if (
        positionsChanged
        || realizedDeltaUsd !== 0
        || capturedFeesDeltaUsd !== 0
        || fundingPatch !== undefined
        || serviceControlPatch.lastExecutionAudit !== undefined
      ) {
        await updateSessionExecutionOutcomeByWallet(updatedExecution.taker, {
          serviceControlPatch,
          fundingDelta: (realizedDeltaUsd !== 0 || capturedFeesDeltaUsd !== 0)
            ? {
                realizedPnlUsd: realizedDeltaUsd,
                capturedFeesUsd: capturedFeesDeltaUsd,
              }
            : undefined,
          fundingPatch,
        });
      }
    }
  }

  return {
    kind: 'updated' as const,
    execution: updatedExecution,
  };
};

const stopWatchingSubmittedExecution = (executionId: string) => {
  const watcher = submittedExecutionWatchers.get(executionId);

  if (!watcher || !heliusConnection) {
    return;
  }

  heliusConnection.removeSignatureListener(watcher.listenerId).catch((error) => {
    app.log.warn({ error, executionId, signature: watcher.signature }, 'failed to remove submitted execution signature listener');
  });
  submittedExecutionWatchers.delete(executionId);
};

const reconcileExecutionByIdSafely = async (executionId: string) => {
  if (executionReconcilesInFlight.has(executionId)) {
    return null;
  }

  executionReconcilesInFlight.add(executionId);

  try {
    const result = await reconcileExecutionById(executionId);

    if (result.kind === 'updated' && result.execution && result.execution.status !== 'submitted') {
      stopWatchingSubmittedExecution(executionId);
    }

    if (result.kind === 'not_found') {
      stopWatchingSubmittedExecution(executionId);
    }

    return result;
  } finally {
    executionReconcilesInFlight.delete(executionId);
  }
};

const watchSubmittedExecution = (executionId: string, signature: string) => {
  if (!heliusConnection) {
    return;
  }

  const existingWatcher = submittedExecutionWatchers.get(executionId);

  if (existingWatcher?.signature === signature) {
    return;
  }

  if (existingWatcher) {
    stopWatchingSubmittedExecution(executionId);
  }

  const listenerId = heliusConnection.onSignature(
    signature,
    (result, context) => {
      app.log.info({ executionId, signature, slot: context.slot, err: result.err }, 'submitted execution signature notification received');
      void reconcileExecutionByIdSafely(executionId);
    },
    'confirmed',
  );

  submittedExecutionWatchers.set(executionId, { signature, listenerId });
};

const syncSubmittedExecutionWatchers = async () => {
  if (!heliusConnection) {
    return;
  }

  const executions = await listExecutionsByStatus(['submitted'], 200);
  const activeExecutionIds = new Set<string>();

  for (const execution of executions) {
    if (!execution.signature) {
      continue;
    }

    activeExecutionIds.add(execution.id);
    watchSubmittedExecution(execution.id, execution.signature);
  }

  for (const executionId of submittedExecutionWatchers.keys()) {
    if (!activeExecutionIds.has(executionId)) {
      stopWatchingSubmittedExecution(executionId);
    }
  }
};

const reconcileStaleSubmittedExecutions = async () => {
  if (!heliusConnection) {
    return;
  }

  const executions = await listExecutionsByStatus(['submitted'], 200);
  const now = Date.now();
  const staleExecutions: SwapExecution[] = [];

  for (const execution of executions) {
    if (!execution.signature) {
      continue;
    }

    watchSubmittedExecution(execution.id, execution.signature);

    const updatedAtMs = Date.parse(execution.updatedAt);
    if (Number.isFinite(updatedAtMs) && (now - updatedAtMs) < SUBMITTED_EXECUTION_STALE_MS) {
      continue;
    }

    if (executionReconcilesInFlight.has(execution.id)) {
      continue;
    }

    staleExecutions.push(execution);
  }

  if (staleExecutions.length === 0) {
    return;
  }

  app.log.info({ count: staleExecutions.length }, 'batch reconciling stale submitted executions');
  const signatures = staleExecutions.map((execution) => execution.signature!);
  const signatureStatuses = await rlGetSignatureStatuses(signatures);
  const currentBlockHeight = staleExecutions.some((execution) => execution.lastValidBlockHeight !== null)
    ? await rlGetBlockHeight()
    : null;

  for (let index = 0; index < staleExecutions.length; index += 1) {
    const execution = staleExecutions[index];
    if (executionReconcilesInFlight.has(execution.id)) {
      continue;
    }

    executionReconcilesInFlight.add(execution.id);

    try {
      const result = await reconcileSubmittedExecutionRecord(
        execution,
        signatureStatuses.value[index] ?? null,
        currentBlockHeight,
      );

      if (result.kind === 'updated' && result.execution && result.execution.status !== 'submitted') {
        stopWatchingSubmittedExecution(execution.id);
      }
    } finally {
      executionReconcilesInFlight.delete(execution.id);
    }
  }
};

const startSubmittedExecutionWatcherLoop = () => {
  if (!heliusConnection) {
    return;
  }

  void syncSubmittedExecutionWatchers()
    .catch((error) => {
      app.log.error({ error }, 'initial submitted execution watcher sync failed');
    });

  setInterval(() => {
    void reconcileStaleSubmittedExecutions().catch((error) => {
      app.log.error({ error }, 'submitted execution watcher loop failed');
    });
  }, SUBMITTED_EXECUTION_SYNC_INTERVAL_MS);
};

app.log.info({ configReport, deployCanary: DEPLOY_CANARY }, 'runtime configuration evaluated');
void executionStoreReady()
  .then(() => {
    app.log.info('swap execution store ready');
    startSubmittedExecutionWatcherLoop();
  })
  .catch((error) => {
    app.log.error({ error }, 'swap execution store initialization failed');
  });
void sessionStoreReady()
  .then(() => sessionKeysReady())
  .then(() => {
    app.log.info('session store + key store ready');
  })
  .catch((error) => {
    app.log.error({ error }, 'session store initialization failed');
  });
void accessTablesReady()
  .then(() => {
    app.log.info('access store ready');
  })
  .catch((error) => {
    app.log.error({ error }, 'access store initialization failed');
  });
void runtimeControlStoreReady()
  .then(() => {
    app.log.info('runtime control store ready');
  })
  .catch((error) => {
    app.log.error({ error }, 'runtime control store initialization failed');
  });

// â”€â”€ API rate limiting â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
void app.register(rateLimit, {
  max: 60,              // 60 requests per window per IP (default for all routes)
  timeWindow: '1 minute',
  allowList: ['127.0.0.1', '::1'],  // localhost exempt for dev/worker
  addHeadersOnExceeding: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true, 'x-ratelimit-reset': true },
  addHeaders: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true, 'x-ratelimit-reset': true, 'retry-after': true },
});

// Require an internal trust header for backend routes.
app.addHook('onRequest', async (request, reply) => {
  if (request.method === 'OPTIONS') {
    return;
  }

  const requestPath = request.url.split('?')[0] ?? '/';
  if (internalSecretBypassPaths.has(requestPath)) {
    return;
  }

  if (!internalApiSecret) {
    if (process.env.NODE_ENV === 'production') {
      app.log.error('RZ_INTERNAL_SECRET is not set in production');
      return reply.status(503).send({ error: 'Service not configured for secure internal access' });
    }
    return;
  }

  const providedSecret = request.headers['x-rz-internal-secret'];
  if (typeof providedSecret !== 'string' || providedSecret !== internalApiSecret) {
    return reply.status(401).send({ error: 'Unauthorized internal request' });
  }
});

// CORS â€” only allow configured frontend origin.
app.addHook('onSend', async (_req, reply) => {
  void reply.header('Access-Control-Allow-Origin', webPublicOrigin);
  void reply.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  void reply.header('Access-Control-Allow-Headers', 'Content-Type, x-rz-internal-secret');
  void reply.header('Vary', 'Origin');
});
app.options('*', async (_req, reply) => {
  reply.header('Access-Control-Allow-Origin', webPublicOrigin);
  reply.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Content-Type, x-rz-internal-secret');
  reply.header('Vary', 'Origin');
  return reply.status(204).send();
});

app.get('/health', async () => ({
  service: 'roguezero-api',
  status: 'ok',
  deployCanary: DEPLOY_CANARY,
  configReady: configReport.readyForLiveIntegration,
  missingLiveValues: configReport.missingLiveValues,
  timestamp: new Date().toISOString(),
}));

app.get('/ops/deploy-drain', async () => {
  const pool = getPool();
  const runtimeControl = await getLiveRuntimeControl();

  const executionResult = await pool.query<{
    prepared: string;
    submitted: string;
    recent_submitted: string;
  }>(`
    SELECT count(*) FILTER (WHERE status = 'prepared')::text AS prepared,
           count(*) FILTER (WHERE status = 'submitted')::text AS submitted,
           count(*) FILTER (
             WHERE status = 'submitted'
               AND submitted_at > NOW() - INTERVAL '5 minutes'
           )::text AS recent_submitted
      FROM swap_executions
  `);

  const queueExists = await pool.query<{ exists: boolean }>(
    `SELECT to_regclass('public.execution_queue') IS NOT NULL AS exists`,
  );
  const queueResult = queueExists.rows[0]?.exists
    ? await pool.query<{
        queued: string;
        running: string;
        locked: string;
      }>(`
        SELECT count(*) FILTER (WHERE status = 'queued')::text AS queued,
               count(*) FILTER (WHERE status = 'running')::text AS running,
               count(*) FILTER (
                 WHERE status = 'running'
                   AND locked_until IS NOT NULL
                   AND locked_until > NOW()
               )::text AS locked
          FROM execution_queue
      `)
    : null;

  const sessionResult = await pool.query<{
    active_sessions: string;
    active_flat_sessions: string;
    active_with_positions: string;
    stopping_sessions: string;
  }>(`
    SELECT count(*) FILTER (WHERE status = 'active')::text AS active_sessions,
           count(*) FILTER (
             WHERE status = 'active'
               AND COALESCE(service_control->'positionsState'->>'activePositionMint', '') = ''
           )::text AS active_flat_sessions,
           count(*) FILTER (
             WHERE status = 'active'
               AND COALESCE(service_control->'positionsState'->>'activePositionMint', '') <> ''
           )::text AS active_with_positions,
           count(*) FILTER (WHERE status = 'stopping')::text AS stopping_sessions
      FROM sessions
     WHERE status IN ('awaiting_funding', 'ready', 'starting', 'active', 'paused', 'stopping')
  `);

  const executions = executionResult.rows[0] ?? { prepared: '0', submitted: '0', recent_submitted: '0' };
  const queue = queueResult?.rows[0] ?? { queued: '0', running: '0', locked: '0' };
  const sessions = sessionResult.rows[0] ?? {
    active_sessions: '0',
    active_flat_sessions: '0',
    active_with_positions: '0',
    stopping_sessions: '0',
  };

  const inFlightExecutions = Number(executions.prepared) + Number(executions.submitted);
  const inFlightQueue = Number(queue.running) + Number(queue.locked);
  const safeToRestartWorker = runtimeControl.entriesEnabled === false
    && inFlightExecutions === 0
    && inFlightQueue === 0;

  return {
    service: 'roguezero-api',
    status: safeToRestartWorker ? 'drained' : 'not_drained',
    safeToRestartWorker,
    entriesEnabled: runtimeControl.entriesEnabled,
    maintenanceReason: runtimeControl.maintenanceReason,
    speedProfile: runtimeControl.speedProfile,
    executions: {
      prepared: Number(executions.prepared),
      submitted: Number(executions.submitted),
      recentSubmitted: Number(executions.recent_submitted),
    },
    queue: {
      queued: Number(queue.queued),
      running: Number(queue.running),
      locked: Number(queue.locked),
    },
    sessions: {
      active: Number(sessions.active_sessions),
      activeFlat: Number(sessions.active_flat_sessions),
      activeWithPositions: Number(sessions.active_with_positions),
      stopping: Number(sessions.stopping_sessions),
    },
    timestamp: new Date().toISOString(),
  };
});

app.get('/config-status', async () => configReport);

app.get('/provider/budgets', async () => getProviderBudgetSnapshot());

app.get('/session-schema', async () => ({
  schemaVersion,
  ownership: {
    userControls: ['start', 'pause', 'resume', 'stop'],
    serviceControls: ['strategy_rotation', 'risk_enforcement', 'execution_routing'],
  },
  sessionStatuses: sessionStatusValues,
  sessionActions: sessionActionValues,
  managedStrategies: strategyKeyValues,
}));

app.get('/jupiter/swap-build-config', async () => {
  if (!jupiterSwapBuildConfig) {
    return {
      ready: false,
      reason: 'Runtime configuration is not ready for live Jupiter integration',
      missingLiveValues: configReport.missingLiveValues,
    };
  }

  return {
    ready: true,
    swapPath: '/build',
    apiBaseUrl: jupiterSwapBuildConfig.apiBaseUrl,
    platformFeeBps: jupiterSwapBuildConfig.platformFeeBps,
    feeAccounts: jupiterSwapBuildConfig.feeAccounts,
    routeControls: jupiterSwapBuildConfig.routeControls,
  };
});

app.get('/jupiter/swap/executions/:executionId', async (request, reply) => {
  const executionId = asOptionalString((request.params as { executionId?: unknown }).executionId);

  if (!executionId || !uuidPattern.test(executionId)) {
    return reply.status(400).send({ error: 'executionId must be a UUID' });
  }

  try {
    const execution = await getExecutionById(executionId);

    if (!execution) {
      return reply.status(404).send({ error: 'Execution not found', executionId });
    }

    return execution;
  } catch (error) {
    app.log.error({ error, executionId }, 'failed to load swap execution');
    return reply.status(500).send({
      error: 'Failed to load swap execution',
      executionId,
    });
  }
});

app.post('/jupiter/swap/executions/:executionId/reconcile', async (request, reply) => {
  if (!heliusConnection) {
    return reply.status(503).send({
      error: 'Solana integration is not ready',
      missingLiveValues: configReport.missingLiveValues,
    });
  }

  const executionId = asOptionalString((request.params as { executionId?: unknown }).executionId);

  if (!executionId || !uuidPattern.test(executionId)) {
    return reply.status(400).send({ error: 'executionId must be a UUID' });
  }

  try {
    const result = await reconcileExecutionByIdSafely(executionId);

    if (!result) {
      return reply.status(409).send({
        error: 'Execution reconcile is already in progress',
        executionId,
      });
    }

    if (result.kind === 'not_found') {
      return reply.status(404).send({ error: 'Execution not found', executionId });
    }

    if (result.kind === 'not_reconcilable') {
      return reply.status(409).send({
        error: result.reason,
        executionId,
        status: result.execution.status,
      });
    }

    if (!result.execution) {
      return reply.status(500).send({
        error: 'Execution reconcile state could not be persisted',
        executionId,
      });
    }

    return {
      reconciled: true,
      execution: result.execution,
    };
  } catch (error) {
    app.log.error({ error, executionId }, 'failed to reconcile swap execution');
    return reply.status(502).send({
      error: 'Failed to reconcile swap execution',
      executionId,
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post('/jupiter/swap/executions/reconcile-submitted', async (_request, reply) => {
  if (!heliusConnection) {
    return reply.status(503).send({
      error: 'Solana integration is not ready',
      missingLiveValues: configReport.missingLiveValues,
    });
  }

  try {
    const executions = await listExecutionsByStatus(['submitted'], 100);
    const results = [] as Array<{
      executionId: string;
      status: string;
      signature: string | null;
    }>;

    for (const execution of executions) {
      const result = await reconcileExecutionByIdSafely(execution.id);

      if (!result) {
        results.push({
          executionId: execution.id,
          status: execution.status,
          signature: execution.signature,
        });
        continue;
      }

      if (result.kind === 'updated' && result.execution) {
        results.push({
          executionId: result.execution.id,
          status: result.execution.status,
          signature: result.execution.signature,
        });
        continue;
      }

      if (result.kind === 'not_reconcilable') {
        results.push({
          executionId: result.execution.id,
          status: result.execution.status,
          signature: result.execution.signature,
        });
      }
    }

    return {
      reconciled: true,
      checkedCount: executions.length,
      results,
    };
  } catch (error) {
    app.log.error({ error }, 'failed to reconcile submitted swap executions');
    return reply.status(502).send({
      error: 'Failed to reconcile submitted swap executions',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post('/jupiter/swap/executions/:executionId/cancel', async (request, reply) => {
  const { executionId } = request.params as { executionId?: string };
  if (typeof executionId !== 'string' || executionId.length === 0) {
    return reply.status(400).send({ error: 'executionId is required' });
  }

  const body = (request.body ?? {}) as { reason?: unknown; stage?: unknown };
  const reason = typeof body.reason === 'string' ? body.reason : 'worker_cancelled';
  const stage = typeof body.stage === 'string' ? body.stage : 'worker_cancel';

  const existing = await getExecutionById(executionId);
  if (!existing) {
    return reply.status(404).send({ error: 'Execution not found' });
  }
  if (existing.status !== 'prepared') {
    return reply.status(409).send({
      error: 'Execution is not in prepared state',
      status: existing.status,
    });
  }

  const updated = await markExecutionFailed({
    id: executionId,
    lastError: { stage, reason },
    updatedAt: new Date().toISOString(),
  });

  return {
    cancelled: true,
    executionId,
    status: updated?.status ?? 'failed',
  };
});

app.post('/jupiter/swap/build', async (request, reply) => {
  if (!jupiterSwapBuildConfig) {
    return reply.status(503).send({
      error: 'Jupiter integration is not ready',
      missingLiveValues: configReport.missingLiveValues,
    });
  }

  const parsed = parseJupiterBuildRequest((request.body ?? {}) as JupiterBuildRequestBody);

  if (!parsed.ok) {
    return reply.status(400).send({ error: 'Invalid build request', issues: parsed.errors });
  }

  const { feeTokenSymbol } = parsed.value;
  const feeAccount = jupiterSwapBuildConfig.getFeeAccountForToken(feeTokenSymbol);
  const effectivePlatformFeeBps = resolveEffectivePlatformFeeBps(parsed.value, jupiterSwapBuildConfig.platformFeeBps);

  const result = await fetchJupiterBuild(parsed.value, feeAccount);

  if (!result.ok) {
    return reply.status(result.status).send({
      error: 'Jupiter /build request failed',
      feeTokenSymbol,
      feeAccount,
      platformFeeBps: effectivePlatformFeeBps,
      upstream: result.payload,
    });
  }

  return {
    swapPath: '/build',
    feeTokenSymbol,
    feeAccount,
    platformFeeBps: effectivePlatformFeeBps,
    build: result.payload,
  };
});

app.post('/jupiter/swap/prepare', { config: { rateLimit: { max: INTERNAL_SWAP_PREPARE_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } } }, async (request, reply) => {
  if (!jupiterSwapBuildConfig || !heliusConnection) {
    return reply.status(503).send({
      error: 'Jupiter or Solana integration is not ready',
      missingLiveValues: configReport.missingLiveValues,
    });
  }

  const parsed = parseJupiterBuildRequest((request.body ?? {}) as JupiterBuildRequestBody);

  if (!parsed.ok) {
    return reply.status(400).send({ error: 'Invalid prepare request', issues: parsed.errors });
  }

  const { taker, feeTokenSymbol } = parsed.value;
  const feeAccount = jupiterSwapBuildConfig.getFeeAccountForToken(feeTokenSymbol);
  const effectivePlatformFeeBps = resolveEffectivePlatformFeeBps(parsed.value, jupiterSwapBuildConfig.platformFeeBps);
  const activeExecution = await getActiveExecutionByTaker(taker);

  if (activeExecution) {
    return reply.status(409).send({
      error: 'Execution already in flight for taker',
      executionId: activeExecution.id,
      status: activeExecution.status,
      taker,
    });
  }

  let candidate = await buildPreparedSimulationCandidate({
    request: parsed.value,
    feeAccount,
  });

  if (!candidate.ok) {
    const buildResult = candidate.buildResult;
    return reply.status(buildResult.status).send({
      error: 'Jupiter /build request failed',
      feeTokenSymbol,
      feeAccount,
      platformFeeBps: effectivePlatformFeeBps,
      upstream: buildResult.payload,
    });
  }

  if (isComputeHeavySimulationFailure(candidate.simulation.value)) {
    const fallbackCandidates = getFallbackMaxAccountsCandidates(jupiterSwapBuildConfig.routeControls.maxAccounts);

    for (const maxAccounts of fallbackCandidates) {
      app.log.warn({ taker, maxAccounts }, 'retrying Jupiter build with lower maxAccounts after compute-heavy simulation failure');
      const fallbackCandidate = await buildPreparedSimulationCandidate({
        request: parsed.value,
        feeAccount,
        routeControlsOverride: { maxAccounts },
      });

      if (!fallbackCandidate.ok) {
        app.log.warn({ taker, maxAccounts, status: fallbackCandidate.buildResult.status }, 'fallback Jupiter build request failed');
        continue;
      }

      candidate = fallbackCandidate;

      if (!isComputeHeavySimulationFailure(candidate.simulation.value)) {
        break;
      }
    }
  }

  const {
    build,
    blockhash,
    coreSwapInstructions,
    payer,
    senderTipLamports,
    simulation,
    simulationShortfall,
  } = candidate;

  const lookupTableAccounts = await loadLookupTableAccounts(
    heliusConnection,
    build.addressesByLookupTableAddress ?? {},
  );

  const unitsConsumed = (simulation.value.unitsConsumed && simulation.value.unitsConsumed > 0)
    ? simulation.value.unitsConsumed
    : maxComputeUnitLimit;
  // On-chain landing routinely consumes more compute than simulation predicts
  // (account states shift between sim and land), so a thin 10% margin caused
  // real `ComputationalBudgetExceeded` failures — including stop-loss exits that
  // then failed to close the position. Use a 30% margin plus a fixed 20k-CU
  // floor so small routes also get absolute headroom, capped at the network max.
  const recommendedComputeUnitLimit = Math.min(
    Math.ceil(unitsConsumed * 1.3) + 20_000,
    maxComputeUnitLimit,
  );
  const priorityFeeMicroLamports = heliusTradingConfig.senderEnabled
    ? await estimatePriorityFeeMicroLamports({
        payer,
        blockhash,
        instructions: [...coreSwapInstructions],
      })
    : undefined;
  const estimatedBaseTxFeeLamports = 5_000;
  const estimatedPriorityFeeLamports = estimatePriorityFeeLamports(
    recommendedComputeUnitLimit,
    priorityFeeMicroLamports,
  );
  const estimatedSenderTipLamports = heliusTradingConfig.senderEnabled
    ? (senderTipLamports ?? heliusTradingConfig.senderMinTipLamports)
    : 0;
  const estimatedNetworkCostLamports =
    estimatedBaseTxFeeLamports +
    estimatedPriorityFeeLamports +
    estimatedSenderTipLamports;
  const preparedInstructions = composePreparedSwapInstructions({
    senderEnabled: heliusTradingConfig.senderEnabled,
    payer,
    computeUnitLimit: recommendedComputeUnitLimit,
    priorityFeeMicroLamports,
    senderTipLamports: senderTipLamports ?? undefined,
    baseComputeBudgetInstructions: build.computeBudgetInstructions.map(toTransactionInstruction),
    coreSwapInstructions,
  });

  const preparedTransaction = createPreparedSwapTransaction(
    taker,
    blockhash,
    lookupTableAccounts,
    preparedInstructions,
  );
  const preparedTransactionBase64 = Buffer.from(preparedTransaction.serialize()).toString('base64');
  const now = new Date().toISOString();
  const executionId = randomUUID();
  const persistedStatus = simulation.value.err ? 'failed' : 'prepared';

  try {
    await createPreparedExecution({
      id: executionId,
      swapPath: '/build',
      status: persistedStatus,
      inputMint: parsed.value.inputMint,
      outputMint: parsed.value.outputMint,
      amount: parsed.value.amount,
      taker: parsed.value.taker,
      feeTokenSymbol,
      feeAccount,
      platformFeeBps: effectivePlatformFeeBps,
      blockhash,
      lastValidBlockHeight: build.blockhashWithMetadata.lastValidBlockHeight ?? null,
      recommendedComputeUnitLimit,
      preparedTransactionBase64,
      simulation: {
        err: simulation.value.err,
        unitsConsumed: simulation.value.unitsConsumed ?? null,
        logs: simulation.value.logs ?? [],
      },
      build: build as unknown as Record<string, unknown>,
      confirmation: null,
      signatureStatus: null,
      lastError: simulation.value.err
        ? {
            stage: 'prepare',
            reason: simulationShortfall ? 'funding_shortfall' : 'simulation_failed',
            simulationErr: simulation.value.err,
            shortfall: simulationShortfall,
          }
        : null,
      metadata: {
        scannerStrategy: parsed.value.scannerStrategy ?? null,
        entryStrategy: parsed.value.entryStrategy ?? null,
        exitStrategy: parsed.value.exitStrategy ?? null,
        exitReason: parsed.value.exitReason ?? null,
      },
      preparedAt: now,
      submittedAt: null,
      confirmedAt: null,
      createdAt: now,
      updatedAt: now,
      signature: null,
      confirmationStatus: null,
    });
  } catch (error) {
    if (isSwapExecutionUniqueViolation(error)) {
      const conflictingExecution = await getActiveExecutionByTaker(taker);
      return reply.status(409).send({
        error: 'Execution already in flight for taker',
        executionId: conflictingExecution?.id ?? null,
        status: conflictingExecution?.status ?? null,
        taker,
      });
    }

    app.log.error({ error }, 'failed to persist prepared swap execution');
    return reply.status(500).send({
      error: 'Failed to persist prepared swap execution',
    });
  }

  if (simulation.value.err) {
    return reply.status(409).send({
      executionId,
      error: 'Simulation failed; execution cannot proceed to signing or submission',
      swapPath: '/build',
      feeTokenSymbol,
      feeAccount,
      platformFeeBps: effectivePlatformFeeBps,
      quote: {
        inAmount: String((build as Record<string, unknown>).inAmount ?? parsed.value.amount),
        outAmount: String((build as Record<string, unknown>).outAmount ?? '0'),
        otherAmountThreshold: String((build as Record<string, unknown>).otherAmountThreshold ?? '0'),
        priceImpactPct: typeof (build as Record<string, unknown>).priceImpactPct === 'string'
          ? ((build as Record<string, unknown>).priceImpactPct as string)
          : null,
      },
      costs: {
        baseTxFeeLamports: estimatedBaseTxFeeLamports,
        priorityFeeMicroLamports: priorityFeeMicroLamports ?? null,
        estimatedPriorityFeeLamports,
        senderTipLamports: estimatedSenderTipLamports,
        estimatedNetworkCostLamports,
      },
      blockhash,
      lastValidBlockHeight: build.blockhashWithMetadata.lastValidBlockHeight ?? null,
      recommendedComputeUnitLimit,
      simulation: {
        err: simulation.value.err,
        unitsConsumed: simulation.value.unitsConsumed ?? null,
        logs: simulation.value.logs ?? [],
      },
      shortfall: simulationShortfall,
    });
  }

  return {
    executionId,
    swapPath: '/build',
    feeTokenSymbol,
    feeAccount,
    platformFeeBps: effectivePlatformFeeBps,
    quote: {
      inAmount: String((build as Record<string, unknown>).inAmount ?? parsed.value.amount),
      outAmount: String((build as Record<string, unknown>).outAmount ?? '0'),
      otherAmountThreshold: String((build as Record<string, unknown>).otherAmountThreshold ?? '0'),
      priceImpactPct: typeof (build as Record<string, unknown>).priceImpactPct === 'string'
        ? ((build as Record<string, unknown>).priceImpactPct as string)
        : null,
    },
    costs: {
      baseTxFeeLamports: estimatedBaseTxFeeLamports,
      priorityFeeMicroLamports: priorityFeeMicroLamports ?? null,
      estimatedPriorityFeeLamports,
      senderTipLamports: estimatedSenderTipLamports,
      estimatedNetworkCostLamports,
    },
    blockhash,
    lastValidBlockHeight: build.blockhashWithMetadata.lastValidBlockHeight ?? null,
    recommendedComputeUnitLimit,
    simulation: {
      err: simulation.value.err,
      unitsConsumed: simulation.value.unitsConsumed ?? null,
      logs: simulation.value.logs ?? [],
    },
    preparedTransactionBase64,
    build,
  };
});

app.post('/jupiter/swap/submit', { config: { rateLimit: { max: INTERNAL_SWAP_SUBMIT_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } } }, async (request, reply) => {
  if (!heliusConnection) {
    return reply.status(503).send({
      error: 'Solana integration is not ready',
      missingLiveValues: configReport.missingLiveValues,
    });
  }

  const parsed = parseJupiterSubmitRequest((request.body ?? {}) as JupiterSubmitRequestBody);

  if (!parsed.ok) {
    return reply.status(400).send({ error: 'Invalid submit request', issues: parsed.errors });
  }

  const { executionId, signedTransactionBase64, blockhash, lastValidBlockHeight, maxRetries } = parsed.value;
  const existingExecution = await getExecutionById(executionId);

  if (!existingExecution) {
    return reply.status(404).send({
      error: 'Execution not found',
      executionId,
    });
  }

  if (existingExecution.status !== 'prepared') {
    return reply.status(409).send({
      error: 'Only prepared executions can be signed and submitted',
      executionId,
      status: existingExecution.status,
      signature: existingExecution.signature,
      confirmationStatus: existingExecution.confirmationStatus,
    });
  }

  const effectiveBlockhash = blockhash ?? existingExecution.blockhash ?? undefined;
  const effectiveLastValidBlockHeight = lastValidBlockHeight ?? existingExecution.lastValidBlockHeight ?? undefined;

  if (effectiveBlockhash && effectiveLastValidBlockHeight !== undefined) {
    const currentBlockHeight = await rlGetBlockHeight();

    if (currentBlockHeight > effectiveLastValidBlockHeight) {
      const updatedExecution = await markExecutionFailed({
        id: executionId,
        lastError: {
          stage: 'submit',
          reason: 'blockhash_expired',
          blockhash: effectiveBlockhash,
          lastValidBlockHeight: effectiveLastValidBlockHeight,
          currentBlockHeight,
        },
        updatedAt: new Date().toISOString(),
      });

      return reply.status(409).send({
        error: 'Execution blockhash has expired and must be rebuilt',
        executionId,
        status: updatedExecution?.status ?? 'failed',
        blockhash: effectiveBlockhash,
        lastValidBlockHeight: effectiveLastValidBlockHeight,
        currentBlockHeight,
      });
    }
  }

  let transaction: VersionedTransaction;
  let preparedTransaction: VersionedTransaction | null = null;

  if (!existingExecution.preparedTransactionBase64) {
    await markExecutionFailed({
      id: executionId,
      lastError: {
        stage: 'submit',
        reason: 'missing_prepared_transaction',
      },
      updatedAt: new Date().toISOString(),
    });

    return reply.status(409).send({
      error: 'Execution does not have a prepared transaction to sign and submit',
      executionId,
    });
  }

  try {
    preparedTransaction = VersionedTransaction.deserialize(
      Buffer.from(existingExecution.preparedTransactionBase64, 'base64'),
    );
  } catch (error) {
    await markExecutionFailed({
      id: executionId,
      lastError: {
        stage: 'submit',
        reason: 'prepared_transaction_deserialize_failed',
        details: error instanceof Error ? error.message : String(error),
      },
      updatedAt: new Date().toISOString(),
    });

    return reply.status(500).send({
      error: 'Prepared transaction could not be deserialized from execution state',
      executionId,
    });
  }

  try {
    transaction = VersionedTransaction.deserialize(Buffer.from(signedTransactionBase64, 'base64'));
  } catch (error) {
    await markExecutionFailed({
      id: executionId,
      lastError: {
        stage: 'submit',
        reason: 'deserialize_failed',
        details: error instanceof Error ? error.message : String(error),
      },
      updatedAt: new Date().toISOString(),
    });

    return reply.status(400).send({
      error: 'signedTransactionBase64 could not be deserialized as a signed Solana transaction',
      details: error instanceof Error ? error.message : String(error),
    });
  }

  if (!transaction.signatures.some((signature) => signature.some((byte) => byte !== 0))) {
    await markExecutionFailed({
      id: executionId,
      lastError: {
        stage: 'submit',
        reason: 'missing_signature',
      },
      updatedAt: new Date().toISOString(),
    });

    return reply.status(400).send({
      error: 'signedTransactionBase64 does not include any signatures',
    });
  }

  if (blockhash && transaction.message.recentBlockhash !== blockhash) {
    await markExecutionFailed({
      id: executionId,
      lastError: {
        stage: 'submit',
        reason: 'blockhash_mismatch',
        providedBlockhash: blockhash,
        transactionBlockhash: transaction.message.recentBlockhash,
      },
      updatedAt: new Date().toISOString(),
    });

    return reply.status(400).send({
      error: 'Provided blockhash does not match the signed transaction',
      providedBlockhash: blockhash,
      transactionBlockhash: transaction.message.recentBlockhash,
    });
  }

  if (effectiveBlockhash && transaction.message.recentBlockhash !== effectiveBlockhash) {
    await markExecutionFailed({
      id: executionId,
      lastError: {
        stage: 'submit',
        reason: 'execution_blockhash_mismatch',
        executionBlockhash: effectiveBlockhash,
        transactionBlockhash: transaction.message.recentBlockhash,
      },
      updatedAt: new Date().toISOString(),
    });

    return reply.status(400).send({
      error: 'Signed transaction blockhash does not match the prepared execution',
      executionId,
      executionBlockhash: effectiveBlockhash,
      transactionBlockhash: transaction.message.recentBlockhash,
    });
  }

  if (preparedTransaction && getTransactionMessageBase64(transaction) !== getTransactionMessageBase64(preparedTransaction)) {
    await markExecutionFailed({
      id: executionId,
      lastError: {
        stage: 'submit',
        reason: 'prepared_transaction_mismatch',
      },
      updatedAt: new Date().toISOString(),
    });

    return reply.status(400).send({
      error: 'Signed transaction does not match the prepared transaction for this execution',
      executionId,
    });
  }

  try {
    const signature = heliusTradingConfig.senderEnabled
      ? await sendViaHeliusSender(signedTransactionBase64)
      : await rlSendRawTransaction(transaction.serialize(), maxRetries);
    const now = new Date().toISOString();
    const persistedExecution = await updateSubmittedExecution({
      id: executionId,
      status: 'submitted',
      signature,
      confirmationStatus: null,
      confirmation: null,
      signatureStatus: null,
      lastError: null,
      submittedAt: now,
      confirmedAt: null,
      updatedAt: now,
    });

    if (!persistedExecution) {
      return reply.status(500).send({
        error: 'Execution submit state could not be persisted',
        executionId,
      });
    }

    watchSubmittedExecution(executionId, signature);

    return {
      executionId,
      submitted: true,
      signature,
      blockhash: transaction.message.recentBlockhash,
      confirmationAttempted: false,
      confirmation: persistedExecution.confirmation,
      signatureStatus: persistedExecution.signatureStatus,
      status: persistedExecution.status,
    };
  } catch (error) {
    app.log.error({ error, executionId }, 'failed to submit signed swap transaction');
    const details = error instanceof Error ? error.message : String(error);
    const submitShortfall = extractLamportShortfallFromText(details);
    const insufficientFundsForFee = isInsufficientFundsForFeeText(details);
    await markExecutionFailed({
      id: executionId,
      lastError: {
        stage: 'submit',
        reason: submitShortfall
          ? 'funding_shortfall'
          : insufficientFundsForFee
            ? 'fee_insufficient'
            : 'send_failed',
        details,
        shortfall: submitShortfall,
      },
      updatedAt: new Date().toISOString(),
    });

    return reply.status(502).send({
      error: 'Failed to submit signed swap transaction',
      executionId,
      details,
      shortfall: submitShortfall,
      feeInsufficient: insufficientFundsForFee,
    });
  }
});

const start = async () => {
  try {
    await app.listen({ port, host: '::' });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

// â”€â”€ User license validation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.get('/users/by-wallet/:wallet', async (request, reply) => {
  const wallet = (request.params as { wallet?: unknown }).wallet;
  if (typeof wallet !== 'string' || !publicKeyPattern.test(wallet)) {
    return reply.status(400).send({ error: 'Invalid wallet address' });
  }

  try {
    const user = await getAccessUserByWallet(wallet);

    if (!user) {
      return reply.status(404).send({ authorized: false, reason: 'not_registered' });
    }

    if (!user.accessEnabled) {
      return reply.status(403).send({
        authorized: false,
        reason: 'access_disabled',
        user: { id: user.id, username: user.username },
      });
    }

    if (isLicenseExpired(user.expiryDate)) {
      return reply.status(403).send({
        authorized: false,
        reason: 'license_expired',
        user: { id: user.id, username: user.username, expiryDate: user.expiryDate },
      });
    }

    return {
      authorized: true,
      user: {
        id: user.id,
        username: user.username,
        walletAddress: user.walletAddress,
        expiryDate: user.expiryDate,
        maxWalletUsd: user.maxWalletUsd,
        duration: user.duration,
        gatedAccessEnrolledAt: user.gatedAccessEnrolledAt,
        licenseKeyRevealedAt: user.licenseKeyRevealedAt,
      },
    };
  } catch (err) {
    app.log.error({ err, wallet }, 'getUserByWallet failed');
    return reply.status(500).send({ error: 'Failed to validate wallet' });
  }
});

app.post('/access/boot', async (request, reply) => {
  const body = (request.body ?? {}) as Record<string, unknown>;
  const tokenHash = asOptionalString(body.tokenHash);
  const deviceIdHash = asOptionalString(body.deviceIdHash);

  if (deviceIdHash && !/^[a-f0-9]{64}$/i.test(deviceIdHash)) {
    return reply.status(400).send({ error: 'deviceIdHash must be a sha256 hex string' });
  }

  if (tokenHash && !/^[a-f0-9]{64}$/i.test(tokenHash)) {
    return reply.status(400).send({ error: 'tokenHash must be a sha256 hex string' });
  }

  try {
    if (tokenHash && deviceIdHash) {
      const session = await verifyWebAccessSession(tokenHash, deviceIdHash);
      if (session) {
        return {
          state: 'access_granted',
          source: session.accessMode,
          userId: session.userId,
          trustedUntil: session.trustedUntil,
        };
      }
    }

    if (!deviceIdHash) {
      return { state: 'temporary_required' };
    }

    const device = await getTrustedDeviceEnrollment(deviceIdHash);
    if (!device) {
      return { state: 'temporary_required' };
    }

    const liveSessionCount = await getLiveSessionCountForUser(device.userId);
    if (liveSessionCount > 0) {
      return {
        state: 'access_granted',
        source: 'live_session_bypass',
        userId: device.userId,
        liveSessionCount,
      };
    }

    return {
      state: 'license_required',
      userId: device.userId,
    };
  } catch (error) {
    app.log.error({ error }, 'failed to resolve access boot state');
    return reply.status(500).send({ error: 'Failed to resolve access state' });
  }
});

app.post('/access/enroll', async (request, reply) => {
  const body = (request.body ?? {}) as Record<string, unknown>;
  const wallet = asOptionalString(body.wallet);
  const deviceIdHash = asOptionalString(body.deviceIdHash);

  if (!wallet || !publicKeyPattern.test(wallet)) {
    return reply.status(400).send({ error: 'wallet must be a Solana public key' });
  }

  if (!deviceIdHash || !/^[a-f0-9]{64}$/i.test(deviceIdHash)) {
    return reply.status(400).send({ error: 'deviceIdHash must be a sha256 hex string' });
  }

  try {
    const enrollment = await enrollTrustedDeviceForWallet(wallet, deviceIdHash);
    const liveSessionCount = await getLiveSessionCountForUser(enrollment.user.id);

    return {
      ok: true,
      user: enrollment.user,
      firstReveal: enrollment.firstReveal,
      licenseKey: enrollment.licenseKey,
      liveSessionCount,
    };
  } catch (error) {
    app.log.error({ error, wallet }, 'failed to enroll trusted device');
    const details = error instanceof Error ? error.message : String(error);
    const status = details === 'User not found'
      ? 404
      : details === 'Access disabled' || details === 'License expired' || details === 'License key not assigned'
        ? 403
        : 500;

    return reply.status(status).send({ error: 'Failed to enroll trusted device', details });
  }
});

app.post('/access/license-auth', async (request, reply) => {
  const body = (request.body ?? {}) as Record<string, unknown>;
  const licenseKey = asOptionalString(body.licenseKey);
  const deviceIdHash = asOptionalString(body.deviceIdHash);

  if (!licenseKey) {
    return reply.status(400).send({ error: 'licenseKey is required' });
  }

  if (!deviceIdHash || !/^[a-f0-9]{64}$/i.test(deviceIdHash)) {
    return reply.status(400).send({ error: 'deviceIdHash must be a sha256 hex string' });
  }

  try {
    const user = await verifyTrustedDeviceLicense(licenseKey, deviceIdHash);
    const liveSessionCount = await getLiveSessionCountForUser(user.id);

    return {
      ok: true,
      user,
      liveSessionCount,
    };
  } catch (error) {
    app.log.error({ error }, 'failed to validate trusted-device license key');
    const details = error instanceof Error ? error.message : String(error);
    const status = details === 'Trusted device enrollment not found'
      ? 404
      : details === 'License key does not match the enrolled device' || details === 'Access disabled' || details === 'License expired' || details === 'License key not assigned'
        ? 403
        : details === 'User not found'
          ? 404
          : 500;

    return reply.status(status).send({ error: 'Failed to validate license key', details });
  }
});

app.post('/access/license-revealed', async (request, reply) => {
  const body = (request.body ?? {}) as Record<string, unknown>;
  const userId = asOptionalString(body.userId);

  if (!userId) {
    return reply.status(400).send({ error: 'userId is required' });
  }

  try {
    const user = await acknowledgeLicenseKeyReveal(userId);
    if (!user) {
      return reply.status(404).send({ error: 'User not found' });
    }

    return { ok: true, user };
  } catch (error) {
    app.log.error({ error, userId }, 'failed to mark license key reveal');
    return reply.status(500).send({ error: 'Failed to mark license reveal' });
  }
});

app.post('/access/session', async (request, reply) => {
  const body = (request.body ?? {}) as Record<string, unknown>;
  const tokenHash = asOptionalString(body.tokenHash);
  const userId = asOptionalString(body.userId);
  const deviceIdHash = asOptionalString(body.deviceIdHash);
  const accessMode = asOptionalString(body.accessMode);
  const trustedUntil = asOptionalString(body.trustedUntil);

  if (!tokenHash || !/^[a-f0-9]{64}$/i.test(tokenHash)) {
    return reply.status(400).send({ error: 'tokenHash must be a sha256 hex string' });
  }

  if (!userId) {
    return reply.status(400).send({ error: 'userId is required' });
  }

  if (!deviceIdHash || !/^[a-f0-9]{64}$/i.test(deviceIdHash)) {
    return reply.status(400).send({ error: 'deviceIdHash must be a sha256 hex string' });
  }

  if (!accessMode || !['trusted_device', 'license_key', 'live_session_bypass'].includes(accessMode)) {
    return reply.status(400).send({ error: 'accessMode must be trusted_device, license_key, or live_session_bypass' });
  }

  if (!trustedUntil || Number.isNaN(Date.parse(trustedUntil))) {
    return reply.status(400).send({ error: 'trustedUntil must be a valid ISO timestamp' });
  }

  try {
    const device = await getTrustedDeviceEnrollment(deviceIdHash);
    if (!device || device.userId !== userId) {
      return reply.status(403).send({ error: 'Trusted device does not belong to this user' });
    }

    const session = await createWebAccessSession({
      tokenHash,
      userId,
      deviceIdHash,
      accessMode: accessMode as 'trusted_device' | 'license_key' | 'live_session_bypass',
      trustedUntil,
    });

    return { ok: true, session };
  } catch (error) {
    app.log.error({ error, userId }, 'failed to create web access session');
    return reply.status(500).send({ error: 'Failed to create web access session' });
  }
});

// â”€â”€ Session routes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.post('/sessions', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
  const body = (request.body ?? {}) as Record<string, unknown>;
  const parsed = createSessionRequestSchema.safeParse(body);

  if (!parsed.success) {
    return reply.status(400).send({
      error: 'Invalid session request',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }

  const req = parsed.data;

  // â”€â”€ Validate owner wallet against rz_users â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // The canonical ownerWallet and userId come from the DB, not the request body.
  // This ensures sweep-back always has the correct destination.
  let verifiedUser: Awaited<ReturnType<typeof getUserByWallet>>;
  try {
    verifiedUser = await getUserByWallet(req.ownerWallet);
  } catch (err) {
    app.log.error({ err }, 'getUserByWallet failed during session creation');
    return reply.status(500).send({ error: 'Failed to verify wallet' });
  }

  if (!verifiedUser) {
    return reply.status(403).send({ error: 'Wallet not registered', wallet: req.ownerWallet });
  }
  if (!verifiedUser.access_enabled) {
    return reply.status(403).send({ error: 'Access disabled for this wallet' });
  }
  if (verifiedUser.expiry_date && new Date(verifiedUser.expiry_date) < new Date()) {
    return reply.status(403).send({ error: 'License expired' });
  }

  // Use DB values as canonical â€” never trust the caller's userId or ownerWallet directly
  const canonicalOwnerWallet = verifiedUser.wallet_address;
  const canonicalUserId = verifiedUser.id;
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  const existingLiveOrPendingSession = (
    await listSessions({
      userId: canonicalUserId,
      status: ['awaiting_funding', 'ready', 'starting', 'active', 'stopping'],
      limit: 10,
    })
  )[0];

  if (existingLiveOrPendingSession) {
    return reply.status(409).send({
      error: 'User already has a live or pending session',
      existingSession: existingLiveOrPendingSession,
      fundingInstructions: existingLiveOrPendingSession.status === 'awaiting_funding'
        ? {
            sendTo: existingLiveOrPendingSession.sessionWallet,
            minimumFundingLamports: workerFundingThresholds.minimumTradeableLamports,
            minimumFundingSol: Number((workerFundingThresholds.minimumTradeableLamports / 1_000_000_000).toFixed(6)),
            message: `Send at least ${(workerFundingThresholds.minimumTradeableLamports / 1_000_000_000).toFixed(6)} SOL to ${existingLiveOrPendingSession.sessionWallet} to start your trading session`,
          }
        : null,
    });
  }

  const runtimeControl = await getLiveRuntimeControl();
  const occupiedCapacitySessions = await listSessions({
    status: ['awaiting_funding', 'ready', 'starting', 'active', 'paused', 'stopping'],
    limit: runtimeControl.profile.concurrentCapacity + 1,
  });

  if (occupiedCapacitySessions.length >= runtimeControl.profile.concurrentCapacity) {
    return reply.status(409).send({
      error: 'Bot capacity is full',
      speedProfile: runtimeControl.speedProfile,
      concurrentCapacity: runtimeControl.profile.concurrentCapacity,
      occupiedCapacity: occupiedCapacitySessions.length,
    });
  }

  const sessionKeypair = Keypair.generate();
  const sessionWallet = sessionKeypair.publicKey.toBase58();
  const now = new Date().toISOString();
  const id = randomUUID();
  const platformFeeBps = configReport.schemaValid
    ? (process.env.JUPITER_PLATFORM_FEE_BPS ? Number(process.env.JUPITER_PLATFORM_FEE_BPS) : 30)
    : 30;
  const normalizedTargetDurationMinutes = Number.isFinite(req.targetDurationMinutes) && req.targetDurationMinutes >= 1
    ? req.targetDurationMinutes
    : 0;

  try {
    const session = await createSessionWithKey({
      id,
      userId: canonicalUserId,
      keyAuthUserId: req.keyAuthUserId,
      licenseId: req.licenseId,
      ownerWallet: canonicalOwnerWallet,
      sessionWallet,
      network: 'mainnet-beta',
      status: 'awaiting_funding',
      requestedAt: now,
      startedAt: null,
      endedAt: null,
      stopReason: null,
      userControl: {
        targetDurationMinutes: normalizedTargetDurationMinutes,
        autoRestart: false,
        stopLossBehavior: req.stopLossBehavior,
        profitHandling: req.profitHandling,
        stopDisposition: 'return_tokens',
      },
      serviceControl: {
        executionVenue: 'jupiter',
        rpcProvider: 'helius',
        platformFeeBps,
        strategyUniverse: [
          { key: 'momentum',       version: '1.0.0', enabled: true  },
          { key: 'mean_reversion', version: '1.0.0', enabled: true  },
          { key: 'supertrend',     version: '1.0.0', enabled: true  },
        ],
        rotationState: {
          activeStrategy: 'momentum',
          queuedStrategy: 'momentum',
          rotationIntervalMinutes: DEFAULT_ROTATION_INTERVAL_MINUTES,
          lastRotatedAt: null,
          lockedUntil: null,
        },
        schedulingState: {
          lastTradeAttemptedAt: null,
          lastTradeSubmittedAt: null,
          lastDecisionAt: null,
          lastDecisionOutcome: null,
          lastDecisionReason: null,
          lastBlockedAt: null,
          lastBlockedReason: null,
          blockedReasonCounts: {},
          lastProfitTransferAt: null,
          transferredProfitUsd: 0,
          pendingProfitPayout: null,
          recentStopLossLocks: {},
        },
        strategyConfig: buildDefaultStrategyConfig(),
        positionsState: {
          activePositionMint: null,
          positions: {},
        },
        positionState: buildFlatSessionPositionState(),
      },
      riskLimits: req.riskLimits,
      funding: {
        fundingMint: req.fundingMint,
        fundingTokenSymbol: req.fundingTokenSymbol,
        requestedFundingLamports: '0',
        startingBalanceAtomic: req.startingBalanceAtomic,
        currentBalanceAtomic: req.startingBalanceAtomic,
        realizedPnlUsd: 0,
        unrealizedPnlUsd: 0,
        capturedFeesUsd: 0,
      },
      createdBy: 'user',
      notes: null,
    }, bs58.encode(Buffer.from(sessionKeypair.secretKey)));

    return reply.status(201).send({
      session,
      sessionWallet,
      fundingInstructions: {
        sendTo: sessionWallet,
        minimumFundingLamports: workerFundingThresholds.minimumTradeableLamports,
        minimumFundingSol: Number((workerFundingThresholds.minimumTradeableLamports / 1_000_000_000).toFixed(6)),
        message: `Send at least ${(workerFundingThresholds.minimumTradeableLamports / 1_000_000_000).toFixed(6)} SOL to ${sessionWallet} to start your trading session`,
      },
    });
  } catch (error) {
    app.log.error({ error }, 'failed to create session');
    return reply.status(500).send({
      error: 'Failed to create session',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post('/sessions/:id/funding-quote', async (request, reply) => {
  const id = asOptionalString((request.params as { id?: unknown }).id);
  if (!id || !uuidPattern.test(id)) {
    return reply.status(400).send({ error: 'id must be a UUID' });
  }

  const body = (request.body ?? {}) as FundingQuoteRequestBody;
  const requestedUsd = asOptionalPositiveNumber(body.requestedUsd);
  const requestedLamportsRaw = asOptionalIntString(body.requestedLamports);
  const requestedFundingPct = asOptionalPositiveNumber(body.requestedFundingPct);

  const requestedModeCount = [
    requestedUsd !== undefined,
    Boolean(requestedLamportsRaw),
    requestedFundingPct !== undefined,
  ].filter(Boolean).length;

  if (requestedModeCount !== 1) {
    return reply.status(400).send({ error: 'Provide exactly one of requestedUsd, requestedLamports, or requestedFundingPct' });
  }

  if (requestedFundingPct !== undefined && requestedFundingPct > 100) {
    return reply.status(400).send({ error: 'requestedFundingPct must be greater than 0 and no more than 100' });
  }

  try {
    const session = await getSessionById(id);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found', id });
    }

    const access = await enforceUserAccess(reply, {
      userId: session.userId,
      ownerWallet: session.ownerWallet,
      licenseId: session.licenseId,
    });
    if (!access.ok) {
      return access.response;
    }

    if (session.status !== 'awaiting_funding') {
      return reply.status(409).send({
        error: 'Funding quote is only available while the session is awaiting funding',
        sessionStatus: session.status,
      });
    }

    const ownerPubkey = new PublicKey(session.ownerWallet);
    const sessionPubkey = new PublicKey(session.sessionWallet);
    const priceSample = await getPythFundingQuoteSample();
    const { blockhash, lastValidBlockHeight } = await rlGetLatestBlockhash();
    const feeProbeTransaction = new Transaction({
      feePayer: ownerPubkey,
      blockhash,
      lastValidBlockHeight,
    }).add(
      SystemProgram.transfer({
        fromPubkey: ownerPubkey,
        toPubkey: sessionPubkey,
        lamports: 1,
      }),
    );
    const estimatedFeeLamports = (await rlGetFeeForMessage(feeProbeTransaction.compileMessage())).value ?? workerFundingThresholds.txFeeLamports;
    const feeReserveLamports = Math.max(
      estimatedFeeLamports + FUNDING_FEE_CUSHION_LAMPORTS,
      FUNDING_FEE_CUSHION_LAMPORTS,
    );
    const rentReserveLamports = 0;
    const ownerBalanceLamports = await rlGetBalance(ownerPubkey);
    const maxSpendableLamports = Math.max(0, ownerBalanceLamports - feeReserveLamports - rentReserveLamports);
    const maxWalletLamports = Math.floor((access.user.max_wallet_usd / priceSample.usdPrice) * LAMPORTS_PER_SOL);
    const maxAllowedFundingLamports = Math.max(0, Math.min(maxSpendableLamports, maxWalletLamports));
    const requestedLamports = requestedLamportsRaw
      ? Number(requestedLamportsRaw)
      : requestedFundingPct !== undefined
        ? Math.floor(maxAllowedFundingLamports * (requestedFundingPct / 100))
        : Math.floor(((requestedUsd ?? 0) / priceSample.usdPrice) * LAMPORTS_PER_SOL);

    if (!Number.isFinite(requestedLamports) || requestedLamports <= 0) {
      return reply.status(400).send({ error: 'Requested amount must resolve to at least 1 lamport' });
    }

    const requestedUsdValue = requestedLamportsRaw
      ? Number((((requestedLamports / LAMPORTS_PER_SOL) * priceSample.usdPrice)).toFixed(6))
      : Number((requestedUsd ?? 0).toFixed(6));

    if (requestedUsdValue > access.user.max_wallet_usd) {
      return reply.status(400).send({
        error: 'Requested funding exceeds wallet cap',
        requestedUsd: requestedUsdValue,
        maxWalletUsd: access.user.max_wallet_usd,
      });
    }

    if (requestedLamports < workerFundingThresholds.minimumTradeableLamports) {
      return reply.status(400).send({
        error: 'Requested funding is below the minimum funding threshold',
        requestedLamports,
        minimumFundingLamports: workerFundingThresholds.minimumTradeableLamports,
        minimumFundingSol: Number((workerFundingThresholds.minimumTradeableLamports / LAMPORTS_PER_SOL).toFixed(6)),
      });
    }

    const transaction = new Transaction({
      feePayer: ownerPubkey,
      blockhash,
      lastValidBlockHeight,
    }).add(
      SystemProgram.transfer({
        fromPubkey: ownerPubkey,
        toPubkey: sessionPubkey,
        lamports: requestedLamports,
      }),
    );

    if (requestedLamports > maxSpendableLamports) {
      return reply.status(400).send({
        error: 'Requested funding exceeds available wallet balance after reserves',
        ownerBalanceLamports,
        feeReserveLamports,
        rentReserveLamports,
        maxSpendableLamports,
        requestedLamports,
      });
    }

    const updatedSession = await updateSessionExecutionOutcomeByWallet(session.sessionWallet, {
      fundingPatch: {
        requestedFundingLamports: String(requestedLamports),
      },
    });

    return {
      sessionId: session.id,
      sessionWallet: session.sessionWallet,
      ownerWallet: session.ownerWallet,
      requestedLamports,
      requestedSol: Number((requestedLamports / LAMPORTS_PER_SOL).toFixed(9)),
      requestedUsd: requestedUsdValue,
      requestedFundingPct: requestedFundingPct ?? null,
      maxWalletUsd: access.user.max_wallet_usd,
      minimumFundingLamports: workerFundingThresholds.minimumTradeableLamports,
      minimumFundingSol: Number((workerFundingThresholds.minimumTradeableLamports / LAMPORTS_PER_SOL).toFixed(6)),
      ownerBalanceLamports,
      maxSpendableLamports,
      maxAllowedFundingLamports,
      feeReserveLamports,
      rentReserveLamports,
      solUsdPrice: priceSample.usdPrice,
      priceSample: {
        sampledAt: priceSample.sampledAt,
        publishTime: priceSample.publishTime,
        confidenceBps: priceSample.confidenceBps,
      },
      blockhash,
      lastValidBlockHeight,
      unsignedTransactionBase64: transaction.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      }).toString('base64'),
      persistedRequestedFundingLamports: updatedSession?.funding.requestedFundingLamports ?? String(requestedLamports),
    };
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    if (details.startsWith('stale_price_') || details.startsWith('confidence_too_wide_')) {
      return reply.status(503).send({
        error: 'Funding quote unavailable because the SOL/USD price feed is not healthy enough',
        details,
      });
    }

    app.log.error({ error, id }, 'failed to build funding quote');
    return reply.status(500).send({
      error: 'Failed to build funding quote',
      details,
    });
  }
});

app.get('/sessions', async (request, reply) => {
  const query = request.query as Record<string, string | undefined>;
  const userId  = query.userId  ?? undefined;
  const status  = query.status  ? query.status.split(',')  : undefined;
  const limit   = query.limit   ? Math.min(Number(query.limit), 200) : 100;

  if (!userId) {
    return reply.status(400).send({ error: 'userId is required' });
  }

  try {
    const access = await enforceUserAccess(reply, { userId });
    if (!access.ok) {
      return access.response;
    }

    const sessions = await listSessions({ userId, status, limit });
    return {
      sessions,
      count: sessions.length,
      minimumFundingLamports: workerFundingThresholds.minimumTradeableLamports,
      minimumFundingSol: Number((workerFundingThresholds.minimumTradeableLamports / 1_000_000_000).toFixed(6)),
    };
  } catch (error) {
    app.log.error({ error }, 'failed to list sessions');
    return reply.status(500).send({ error: 'Failed to list sessions' });
  }
});

app.get('/sessions/:id', async (request, reply) => {
  const id = asOptionalString((request.params as { id?: unknown }).id);
  if (!id || !uuidPattern.test(id)) {
    return reply.status(400).send({ error: 'id must be a UUID' });
  }
  try {
    const session = await getSessionById(id);
    if (!session) return reply.status(404).send({ error: 'Session not found', id });

    const access = await enforceUserAccess(reply, {
      userId: session.userId,
      ownerWallet: session.ownerWallet,
      licenseId: session.licenseId,
    });
    if (!access.ok) {
      return access.response;
    }

    return session;
  } catch (error) {
    app.log.error({ error, id }, 'failed to load session');
    return reply.status(500).send({ error: 'Failed to load session' });
  }
});

app.patch('/sessions/:id/strategy-controls', async (request, reply) => {
  const id = asOptionalString((request.params as { id?: unknown }).id);
  if (!id || !uuidPattern.test(id)) {
    return reply.status(400).send({ error: 'id must be a UUID' });
  }

  try {
    const session = await getSessionById(id);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found', id });
    }

    const access = await enforceUserAccess(reply, {
      userId: session.userId,
      ownerWallet: session.ownerWallet,
      licenseId: session.licenseId,
    });
    if (!access.ok) {
      return access.response;
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const enabledStrategiesRaw = Array.isArray(body.enabledStrategies)
      ? body.enabledStrategies.filter((value): value is string => typeof value === 'string')
      : undefined;
    const activeStrategy = asOptionalString(body.activeStrategy);
    const queuedStrategy = asOptionalString(body.queuedStrategy);
    const rotationIntervalMinutes = asOptionalPositiveInt(body.rotationIntervalMinutes);
    const autoRotationEnabled = asOptionalBoolean(body.autoRotationEnabled);

    if (body.rotationIntervalMinutes !== undefined && rotationIntervalMinutes === undefined) {
      return reply.status(400).send({ error: 'rotationIntervalMinutes must be a positive integer' });
    }

    if (activeStrategy && !strategyKeyValues.includes(activeStrategy as any)) {
      return reply.status(400).send({ error: `activeStrategy must be one of ${strategyKeyValues.join(', ')}` });
    }
    if (queuedStrategy && !strategyKeyValues.includes(queuedStrategy as any)) {
      return reply.status(400).send({ error: `queuedStrategy must be one of ${strategyKeyValues.join(', ')}` });
    }

    if (enabledStrategiesRaw) {
      const invalid = enabledStrategiesRaw.filter((value) => !strategyKeyValues.includes(value as any));
      if (invalid.length > 0) {
        return reply.status(400).send({ error: `enabledStrategies contains invalid keys: ${invalid.join(', ')}` });
      }
    }

    const currentUniverse = session.serviceControl.strategyUniverse;
    const nextEnabledSet = enabledStrategiesRaw
      ? new Set(enabledStrategiesRaw)
      : new Set(currentUniverse.filter((strategy) => strategy.enabled).map((strategy) => strategy.key));

    const nextStrategyUniverse = currentUniverse.map((strategy) => ({
      ...strategy,
      enabled: nextEnabledSet.has(strategy.key),
    })) as typeof currentUniverse;

    if (!nextStrategyUniverse.some((strategy) => strategy.enabled)) {
      return reply.status(400).send({ error: 'At least one strategy must remain enabled' });
    }

    const nextActiveStrategy = activeStrategy ?? session.serviceControl.rotationState.activeStrategy;
    const nextQueuedStrategy = queuedStrategy ?? session.serviceControl.rotationState.queuedStrategy;

    if (!nextStrategyUniverse.some((strategy) => strategy.key === nextActiveStrategy && strategy.enabled)) {
      return reply.status(400).send({ error: 'activeStrategy must be enabled' });
    }
    if (!nextStrategyUniverse.some((strategy) => strategy.key === nextQueuedStrategy && strategy.enabled)) {
      return reply.status(400).send({ error: 'queuedStrategy must be enabled' });
    }

    const momentumPatch = (body.momentum ?? {}) as Record<string, unknown>;
    const meanReversionPatch = (body.meanReversion ?? {}) as Record<string, unknown>;
    const supertrendPatch = (body.supertrend ?? {}) as Record<string, unknown>;

    const defaultStrategyConfig = buildDefaultStrategyConfig();
    const currentStrategyConfig = session.serviceControl.strategyConfig ?? defaultStrategyConfig;
    const nextStrategyConfig = {
      autoRotationEnabled: autoRotationEnabled ?? currentStrategyConfig.autoRotationEnabled,
      momentum: {
        lookbackSamples: asOptionalPositiveInt(momentumPatch.lookbackSamples)
          ?? currentStrategyConfig.momentum.lookbackSamples,
        thresholdBps: Math.max(
          workerSignalPolicy.momentumThresholdBps,
          asOptionalPositiveInt(momentumPatch.thresholdBps)
            ?? currentStrategyConfig.momentum.thresholdBps,
        ),
        edgeSafetyBufferBps: Math.max(
          workerSignalPolicy.edgeSafetyBufferBps,
          asOptionalNonNegativeNumber(momentumPatch.edgeSafetyBufferBps)
            ?? currentStrategyConfig.momentum.edgeSafetyBufferBps,
        ),
      },
      meanReversion: {
        length: asOptionalPositiveInt(meanReversionPatch.length)
          ?? currentStrategyConfig.meanReversion.length,
        stdMultiplier: asOptionalNonNegativeNumber(meanReversionPatch.stdMultiplier)
          ?? currentStrategyConfig.meanReversion.stdMultiplier,
        minBandWidthFraction: asOptionalNonNegativeNumber(meanReversionPatch.minBandWidthFraction)
          ?? currentStrategyConfig.meanReversion.minBandWidthFraction,
        entryThreshold: asOptionalNumber(meanReversionPatch.entryThreshold)
          ?? currentStrategyConfig.meanReversion.entryThreshold,
        exitThreshold: asOptionalNumber(meanReversionPatch.exitThreshold)
          ?? currentStrategyConfig.meanReversion.exitThreshold,
      },
      supertrend: {
        candleSamples: asOptionalPositiveInt(supertrendPatch.candleSamples)
          ?? currentStrategyConfig.supertrend.candleSamples,
        atrPeriod: asOptionalPositiveInt(supertrendPatch.atrPeriod)
          ?? currentStrategyConfig.supertrend.atrPeriod,
        multiplier: asOptionalNonNegativeNumber(supertrendPatch.multiplier)
          ?? currentStrategyConfig.supertrend.multiplier,
      },
    };

    const updatedSession = await updateSessionServiceControlByWallet(session.sessionWallet, {
      strategyUniverse: nextStrategyUniverse,
      strategyConfig: nextStrategyConfig,
      rotationState: {
        activeStrategy: nextActiveStrategy as any,
        queuedStrategy: nextQueuedStrategy as any,
        rotationIntervalMinutes: rotationIntervalMinutes ?? session.serviceControl.rotationState.rotationIntervalMinutes,
        lastRotatedAt: session.serviceControl.rotationState.lastRotatedAt,
        lockedUntil: session.serviceControl.rotationState.lockedUntil,
      },
    });

    if (!updatedSession) {
      return reply.status(404).send({ error: 'Session not found after update', id });
    }

    return {
      session: updatedSession,
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    app.log.error({ error, id }, 'failed to patch strategy controls');
    return reply.status(500).send({
      error: 'Failed to patch strategy controls',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get('/sessions/performance', async (request, reply) => {
  const query = request.query as Record<string, string | undefined>;
  const userId = asOptionalString(query.userId);
  const ownerWallet = asOptionalString(query.ownerWallet);
  const licenseId = asOptionalString(query.licenseId);

  if (!userId && !ownerWallet && !licenseId) {
    return reply.status(400).send({
      error: 'At least one of userId, ownerWallet, or licenseId must be provided',
    });
  }

  if (ownerWallet && !publicKeyPattern.test(ownerWallet)) {
    return reply.status(400).send({ error: 'ownerWallet must be a Solana public key' });
  }

  try {
    const access = await enforceUserAccess(reply, { userId, ownerWallet, licenseId });
    if (!access.ok) {
      return access.response;
    }

    const snapshot = await getUserPerformanceSnapshot({
      userId,
      ownerWallet,
      licenseId,
    });

    return {
      ...snapshot,
      generatedAt: new Date().toISOString(),
    };
  } catch (error) {
    app.log.error({ error, userId, ownerWallet, licenseId }, 'failed to load performance snapshot');
    return reply.status(500).send({
      error: 'Failed to load performance snapshot',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

app.patch('/sessions/:id/action', async (request, reply) => {
  const id = asOptionalString((request.params as { id?: unknown }).id);
  if (!id || !uuidPattern.test(id)) {
    return reply.status(400).send({ error: 'id must be a UUID' });
  }

  const body = (request.body ?? {}) as Record<string, unknown>;
  const action = asOptionalString(body.action);
  if (!action || !(sessionActionValues as readonly string[]).includes(action)) {
    return reply.status(400).send({
      error: 'action must be one of: ' + sessionActionValues.join(', '),
    });
  }

  const profitMode = asOptionalProfitMode(body.profitMode);
  const profitPayoutToken = asOptionalProfitPayoutToken(body.profitPayoutToken);

  if (body.profitMode !== undefined && profitMode === undefined) {
    return reply.status(400).send({ error: 'profitMode must be one of: send_to_owner, compound' });
  }

  if (body.profitPayoutToken !== undefined && profitPayoutToken === undefined) {
    return reply.status(400).send({ error: 'profitPayoutToken must be one of: SOL, USDC' });
  }

  if (action === 'start' && (!profitMode || !profitPayoutToken)) {
    return reply.status(400).send({
      error: 'start requires explicit profitMode and profitPayoutToken selection',
    });
  }

  const stopDisposition = asOptionalStopDisposition(body.stopDisposition);

  if (body.stopDisposition !== undefined && stopDisposition === undefined) {
    return reply.status(400).send({ error: 'stopDisposition must be one of: return_tokens, liquidate' });
  }

  if (action === 'stop') {
    app.log.warn({
      sessionId: id,
      event: 'SESSION_STOP_REQUEST_SOURCE',
      method: request.method,
      userAgent: request.headers['user-agent'] ?? null,
      referer: request.headers['referer'] ?? request.headers['referrer'] ?? null,
      origin: request.headers['origin'] ?? null,
      xForwardedFor: request.headers['x-forwarded-for'] ?? null,
      remoteAddress: request.ip,
      bodyKeys: Object.keys(body),
      stopDisposition: stopDisposition ?? null,
    }, 'session stop request received — capturing source');
  }

  try {
    const session = await getSessionById(id);
    if (!session) return reply.status(404).send({ error: 'Session not found', id });

    const access = await enforceUserAccess(reply, {
      userId: session.userId,
      ownerWallet: session.ownerWallet,
      licenseId: session.licenseId,
    });
    if (!access.ok) {
      return access.response;
    }

    const now = new Date().toISOString();
    const transitions: Record<string, { next: string; startedAt?: string | null; endedAt?: string | null; stopReason?: string | null }> = {
      start:  { next: 'starting',  startedAt: now },
      pause:  { next: 'paused' },
      resume: { next: 'active' },
      stop:   { next: 'stopping',  endedAt: now, stopReason: 'user_requested' },
    };

    const t = transitions[action];
    const stopRequestSource = action === 'stop'
      ? {
          at: now,
          event: 'SESSION_STOP_REQUEST_SOURCE',
          source: 'api-session-action',
          method: request.method,
          userAgent: request.headers['user-agent'] ?? null,
          referer: request.headers['referer'] ?? request.headers['referrer'] ?? null,
          origin: request.headers['origin'] ?? null,
          xForwardedFor: request.headers['x-forwarded-for'] ?? null,
          remoteAddress: request.ip,
          bodyKeys: Object.keys(body),
          clientActionSource: asOptionalString(body.clientActionSource) ?? null,
          stopDisposition: stopDisposition ?? null,
        }
      : undefined;
    const nextUserControl = action === 'start'
      ? {
          ...session.userControl,
          profitHandling: {
            mode: profitMode ?? session.userControl.profitHandling.mode,
            payoutToken: profitPayoutToken ?? session.userControl.profitHandling.payoutToken,
          },
        }
      : action === 'stop'
        ? {
            ...session.userControl,
            stopDisposition: stopDisposition ?? session.userControl.stopDisposition ?? 'return_tokens',
          }
        : undefined;
    const currentServiceControl = session.serviceControl as Record<string, unknown>;
    const stopRequestSourceHistory = Array.isArray(currentServiceControl.stopRequestSourceHistory)
      ? currentServiceControl.stopRequestSourceHistory
      : [];
    const nextServiceControl = stopRequestSource
      ? {
          ...currentServiceControl,
          lastStopRequestSource: stopRequestSource,
          stopRequestSourceHistory: [
            ...stopRequestSourceHistory.slice(-9),
            stopRequestSource,
          ],
        }
      : undefined;

    const updated = await updateSessionStatus(id, t.next, {
      startedAt: t.startedAt,
      endedAt:   t.endedAt,
      stopReason: t.stopReason,
      userControl: nextUserControl,
      serviceControl: nextServiceControl,
      userInitiatedStop: action === 'stop',
    });

    return { session: updated, action, appliedAt: now };
  } catch (error) {
    app.log.error({ error, id, action }, 'failed to apply session action');
    return reply.status(500).send({ error: 'Failed to apply session action' });
  }
});

void start();
