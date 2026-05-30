import Fastify, { type FastifyReply } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { createSharedTokenBucket, getExponentialBackoffDelayMs } from '@roguezero/provider-governor';
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  getHeliusRpcUrl,
  getJupiterSwapBuildConfig,
  getRuntimeConfigReport,
  getWorkerFundingThresholds,
  type JupiterFeeToken,
} from '@roguezero/runtime-config';
import {
  createPreparedExecution,
  executionStoreReady,
  getExecutionById,
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
  schemaVersion,
  sessionActionValues,
  sessionStatusValues,
  strategyKeyValues,
  createSessionRequestSchema,
} from '@roguezero/session-schema';
import {
  buildPriorityFeeEstimateRequest,
  composePreparedSwapInstructions,
  getHeliusTradingConfig,
  parsePriorityFeeEstimateResponse,
  parseSenderSignature,
} from './lib/heliusTrading.js';

dotenv.config({ path: '../../.env' });

const app = Fastify({ logger: true });
const port = Number(process.env.API_PORT || 4000);
const internalApiSecret = process.env.RZ_INTERNAL_SECRET?.trim() || null;
const webPublicOriginRaw = process.env.WEB_PUBLIC_ORIGIN ?? process.env.FRONTEND_ORIGIN;
if (!webPublicOriginRaw) {
  throw new Error('WEB_PUBLIC_ORIGIN (or FRONTEND_ORIGIN) must be set on the api service');
}
const webPublicOrigin = webPublicOriginRaw;
const internalSecretBypassPaths = new Set(['/health']);
const configReport = getRuntimeConfigReport(process.env);
const JUPITER_GENERAL_RPS = Number(process.env.JUPITER_GENERAL_RPS ?? 8);
const JUPITER_GENERAL_BURST = Number(process.env.JUPITER_GENERAL_BURST ?? JUPITER_GENERAL_RPS);
const HELIUS_RPC_RPS = Number(process.env.HELIUS_RPC_RPS ?? 40);
const HELIUS_RPC_BURST = Number(process.env.HELIUS_RPC_BURST ?? Math.min(10, HELIUS_RPC_RPS));
const SUBMITTED_EXECUTION_SYNC_INTERVAL_MS = Number(process.env.SUBMITTED_EXECUTION_SYNC_INTERVAL_MS ?? 15000);
const SUBMITTED_EXECUTION_STALE_MS = Number(process.env.SUBMITTED_EXECUTION_STALE_MS ?? 30000);
const jupiterSwapBuildConfig = configReport.readyForLiveIntegration
  ? getJupiterSwapBuildConfig(process.env)
  : null;
const heliusTradingConfig = getHeliusTradingConfig(process.env);
const workerFundingThresholds = getWorkerFundingThresholds(process.env);
const heliusConnection = configReport.readyForLiveIntegration
  ? new Connection(getHeliusRpcUrl(process.env), 'confirmed')
  : null;

const publicKeyPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const atomicAmountPattern = /^\d+$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const jupiterFeeTokens = new Set<JupiterFeeToken>(['SOL', 'USDC', 'USDT']);
const maxComputeUnitLimit = 1_400_000;
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

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
  maxTokens: 50,
  refillRatePerSec: 50,
});
const submittedExecutionWatchers = new Map<string, { signature: string; listenerId: number }>();
const executionReconcilesInFlight = new Set<string>();

type JupiterBuildRequestBody = {
  inputMint?: unknown;
  outputMint?: unknown;
  amount?: unknown;
  taker?: unknown;
  feeTokenSymbol?: unknown;
  slippageBps?: unknown;
};

type ValidatedJupiterBuildRequest = {
  inputMint: string;
  outputMint: string;
  amount: string;
  taker: string;
  feeTokenSymbol: JupiterFeeToken;
  slippageBps?: string;
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

const asOptionalNonNegativeInteger = (value: unknown) => {
  if (value === undefined) {
    return undefined;
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
};

const parseJupiterBuildRequest = (body: JupiterBuildRequestBody) => {
  const inputMint = asOptionalString(body.inputMint);
  const outputMint = asOptionalString(body.outputMint);
  const amount = asOptionalIntString(body.amount);
  const taker = asOptionalString(body.taker);
  const feeTokenSymbol = asOptionalFeeToken(body.feeTokenSymbol);
  const slippageBps = asOptionalBps(body.slippageBps);

  const errors = [
    !inputMint || !publicKeyPattern.test(inputMint) ? 'inputMint must be a Solana public key' : null,
    !outputMint || !publicKeyPattern.test(outputMint) ? 'outputMint must be a Solana public key' : null,
    !amount ? 'amount must be an unsigned integer string' : null,
    !taker || !publicKeyPattern.test(taker) ? 'taker must be a Solana public key' : null,
    !feeTokenSymbol ? 'feeTokenSymbol must be one of SOL, USDC, USDT' : null,
    body.slippageBps !== undefined && !slippageBps ? 'slippageBps must be an integer between 0 and 10000' : null,
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
  request: () => Promise<Response>;
  maxAttempts?: number;
}) => {
  const maxAttempts = options.maxAttempts ?? 5;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
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
  await heliusLimiter.acquire();
  return heliusConnection.getAddressLookupTable(lookupTableAddress);
};

const rlSimulateTransaction = async (transaction: VersionedTransaction) => {
  if (!heliusConnection) throw new Error('Solana integration is not ready');
  await heliusLimiter.acquire();
  return heliusConnection.simulateTransaction(transaction, {
    replaceRecentBlockhash: true,
    sigVerify: false,
    commitment: 'confirmed',
  });
};

const rlGetBlockHeight = async () => {
  if (!heliusConnection) throw new Error('Solana integration is not ready');
  await heliusLimiter.acquire();
  return heliusConnection.getBlockHeight('confirmed');
};

const rlSendRawTransaction = async (serializedTransaction: Uint8Array, maxRetries?: number) => {
  if (!heliusConnection) throw new Error('Solana integration is not ready');
  await heliusLimiter.acquire();
  return heliusConnection.sendRawTransaction(serializedTransaction, {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
    ...(maxRetries !== undefined ? { maxRetries } : {}),
  });
};

const rlConfirmTransaction = async (params: { signature: string; blockhash: string; lastValidBlockHeight: number }) => {
  if (!heliusConnection) throw new Error('Solana integration is not ready');
  await heliusLimiter.acquire();
  return heliusConnection.confirmTransaction(params, 'confirmed');
};

const rlGetSignatureStatus = async (signature: string) => {
  if (!heliusConnection) throw new Error('Solana integration is not ready');
  await heliusLimiter.acquire();
  return heliusConnection.getSignatureStatus(signature, {
    searchTransactionHistory: true,
  });
};

const rlGetSignatureStatuses = async (signatures: string[]) => {
  if (!heliusConnection) throw new Error('Solana integration is not ready');
  await heliusLimiter.acquire();
  return heliusConnection.getSignatureStatuses(signatures, {
    searchTransactionHistory: true,
  });
};

const rlGetTransaction = async (signature: string) => {
  if (!heliusConnection) throw new Error('Solana integration is not ready');
  await heliusLimiter.acquire();
  return heliusConnection.getTransaction(signature, {
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
    limiter: heliusLimiter,
    request: () => fetch(getHeliusRpcUrl(process.env), {
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
    limiter: senderLimiter,
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
      const lookupTableAccount = await rlGetAddressLookupTable(new PublicKey(lookupTableAddress));
      return {
        lookupTableAddress,
        value: lookupTableAccount.value,
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

  const params = new URLSearchParams({
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    amount: request.amount,
    taker: request.taker,
    platformFeeBps: String(jupiterSwapBuildConfig.platformFeeBps),
    feeAccount,
  });

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
    limiter: jupiterLimiter,
    request: () => fetch(`${jupiterSwapBuildConfig.apiBaseUrl}/build?${params.toString()}`, {
      headers: { 'x-api-key': jupiterSwapBuildConfig.apiKey },
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
  const confirmationStatus = signatureStatusValue?.confirmationStatus ?? null;
  const currentBlockHeight = execution.lastValidBlockHeight !== null
    ? await rlGetBlockHeight()
    : null;
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

  if (transitionedToConfirmed && updatedExecution?.status === 'confirmed') {
    const session = await getSessionByWallet(updatedExecution.taker);

    if (session) {
      const currentPositionState = session.serviceControl.positionState;
      let nextPositionState = currentPositionState;
      const confirmedAt = updatedExecution.confirmedAt ?? now;
      const quotedOutputAtomic = typeof updatedExecution.build?.outAmount === 'string'
        ? updatedExecution.build.outAmount
        : null;
      const markedPriceUsd = currentPositionState?.lastMarkedPriceUsd ?? null;

      const inAtomic = Number(updatedExecution.amount);
      const feeAccountDeltaAtomic = transactionDetails
        ? Math.max(0, getTokenBalanceDeltaAtomic(transactionDetails, {
            mint: updatedExecution.outputMint === SOL_MINT ? updatedExecution.inputMint : updatedExecution.outputMint,
            accountAddress: updatedExecution.feeAccount,
          }) ?? 0)
        : 0;
      const walletBalanceSnapshot = transactionDetails
        ? getWalletBalanceSnapshot(transactionDetails, updatedExecution.taker)
        : null;
      let realizedDeltaUsd = 0;
      let capturedFeesDeltaUsd = 0;
      let costBasisPerSolUsd: number | null = null;
      let fundingPatch: Partial<import('@roguezero/session-schema').Session['funding']> | undefined;

      if (
        updatedExecution.inputMint === SOL_MINT
        && updatedExecution.outputMint === USDC_MINT
      ) {
        const observedUsdcDelta = transactionDetails
          ? getTokenBalanceDeltaAtomic(transactionDetails, {
              mint: USDC_MINT,
              owner: updatedExecution.taker,
            })
          : null;
        const outAtomic = observedUsdcDelta !== null && observedUsdcDelta > 0
          ? observedUsdcDelta
          : (quotedOutputAtomic !== null ? Number(quotedOutputAtomic) : 0);
        const solSold = inAtomic / 1e9;
        const usdcReceived = outAtomic / 1e6;
        const entry = currentPositionState?.entryPriceUsd ?? null;
        if (entry !== null && solSold > 0) {
          realizedDeltaUsd = usdcReceived - solSold * entry;
        }
        capturedFeesDeltaUsd = feeAccountDeltaAtomic > 0
          ? getUsdValueFromAtomicAmount(USDC_MINT, feeAccountDeltaAtomic)
          : 0;
        fundingPatch = walletBalanceSnapshot
          ? { currentBalanceAtomic: String(walletBalanceSnapshot.postBalance) }
          : undefined;

        nextPositionState = {
          status: 'flat',
          entryPriceUsd: null,
          entryAt: null,
          quantityAtomic: null,
          highWaterPriceUsd: null,
          lastMarkedPriceUsd: currentPositionState?.lastMarkedPriceUsd ?? null,
          lastMarkedAt: currentPositionState?.lastMarkedAt ?? null,
          pendingExitReason: null,
          exitReason: currentPositionState?.pendingExitReason ?? currentPositionState?.exitReason ?? 'signal_reversal',
        };
      } else if (
        updatedExecution.inputMint === USDC_MINT
        && updatedExecution.outputMint === SOL_MINT
      ) {
        const observedUsdcDelta = transactionDetails
          ? getTokenBalanceDeltaAtomic(transactionDetails, {
              mint: USDC_MINT,
              owner: updatedExecution.taker,
            })
          : null;
        const observedSolDelta = walletBalanceSnapshot?.delta ?? null;
        const usdcSpentAtomic = observedUsdcDelta !== null && observedUsdcDelta < 0
          ? Math.abs(observedUsdcDelta)
          : inAtomic;
        const outAtomic = observedSolDelta !== null && observedSolDelta > 0
          ? observedSolDelta
          : (quotedOutputAtomic !== null ? Number(quotedOutputAtomic) : 0);
        const usdcSpent = usdcSpentAtomic / 1e6;
        const solReceived = outAtomic / 1e9;
        if (solReceived > 0) {
          costBasisPerSolUsd = usdcSpent / solReceived;
        }
        capturedFeesDeltaUsd = feeAccountDeltaAtomic > 0
          ? getUsdValueFromAtomicAmount(USDC_MINT, feeAccountDeltaAtomic)
          : 0;
        fundingPatch = walletBalanceSnapshot
          ? { currentBalanceAtomic: String(walletBalanceSnapshot.postBalance) }
          : undefined;

        const entryPriceForState = costBasisPerSolUsd ?? markedPriceUsd;
        nextPositionState = {
          status: 'long_sol',
          entryPriceUsd: entryPriceForState,
          entryAt: confirmedAt,
          quantityAtomic: outAtomic > 0 ? String(outAtomic) : quotedOutputAtomic,
          highWaterPriceUsd: entryPriceForState,
          lastMarkedPriceUsd: markedPriceUsd,
          lastMarkedAt: markedPriceUsd ? confirmedAt : currentPositionState?.lastMarkedAt ?? null,
          pendingExitReason: null,
          exitReason: null,
        };
      }

      if (
        nextPositionState !== currentPositionState
        || realizedDeltaUsd !== 0
        || capturedFeesDeltaUsd !== 0
        || fundingPatch !== undefined
      ) {
        await updateSessionExecutionOutcomeByWallet(updatedExecution.taker, {
          serviceControlPatch: nextPositionState !== currentPositionState
            ? { positionState: nextPositionState }
            : undefined,
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

  for (const execution of executions) {
    if (!execution.signature) {
      continue;
    }

    watchSubmittedExecution(execution.id, execution.signature);

    const updatedAtMs = Date.parse(execution.updatedAt);
    if (Number.isFinite(updatedAtMs) && (now - updatedAtMs) < SUBMITTED_EXECUTION_STALE_MS) {
      continue;
    }

    app.log.info({ executionId: execution.id, signature: execution.signature }, 'reconciling stale submitted execution');
    await reconcileExecutionByIdSafely(execution.id);
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

app.log.info({ configReport }, 'runtime configuration evaluated');
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

// ── API rate limiting ─────────────────────────────────────────────────────────
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

// CORS — only allow configured frontend origin.
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
  configReady: configReport.readyForLiveIntegration,
  missingLiveValues: configReport.missingLiveValues,
  timestamp: new Date().toISOString(),
}));

app.get('/config-status', async () => configReport);

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

  const result = await fetchJupiterBuild(parsed.value, feeAccount);

  if (!result.ok) {
    return reply.status(result.status).send({
      error: 'Jupiter /build request failed',
      feeTokenSymbol,
      feeAccount,
      platformFeeBps: jupiterSwapBuildConfig.platformFeeBps,
      upstream: result.payload,
    });
  }

  return {
    swapPath: '/build',
    feeTokenSymbol,
    feeAccount,
    platformFeeBps: jupiterSwapBuildConfig.platformFeeBps,
    build: result.payload,
  };
});

app.post('/jupiter/swap/prepare', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
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
      platformFeeBps: jupiterSwapBuildConfig.platformFeeBps,
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
  const recommendedComputeUnitLimit = Math.min(
    Math.ceil(unitsConsumed * 1.1),
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
      platformFeeBps: jupiterSwapBuildConfig.platformFeeBps,
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
      preparedAt: now,
      submittedAt: null,
      confirmedAt: null,
      createdAt: now,
      updatedAt: now,
      signature: null,
      confirmationStatus: null,
    });
  } catch (error) {
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
      platformFeeBps: jupiterSwapBuildConfig.platformFeeBps,
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
    platformFeeBps: jupiterSwapBuildConfig.platformFeeBps,
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

app.post('/jupiter/swap/submit', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
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
    await app.listen({ port, host: '0.0.0.0' });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

// ── User license validation ───────────────────────────────────────────────────

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

// ── Session routes ────────────────────────────────────────────────────────────

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

  // ── Validate owner wallet against rz_users ──────────────────────────────────
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

  // Use DB values as canonical — never trust the caller's userId or ownerWallet directly
  const canonicalOwnerWallet = verifiedUser.wallet_address;
  const canonicalUserId = verifiedUser.id;
  // ────────────────────────────────────────────────────────────────────────────

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

  const sessionKeypair = Keypair.generate();
  const sessionWallet = sessionKeypair.publicKey.toBase58();
  const now = new Date().toISOString();
  const id = randomUUID();
  const platformFeeBps = configReport.schemaValid
    ? (process.env.JUPITER_PLATFORM_FEE_BPS ? Number(process.env.JUPITER_PLATFORM_FEE_BPS) : 30)
    : 30;

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
        targetDurationMinutes: req.targetDurationMinutes,
        autoRestart: false,
        stopLossBehavior: req.stopLossBehavior,
      },
      serviceControl: {
        executionVenue: 'jupiter',
        rpcProvider: 'helius',
        platformFeeBps,
        strategyUniverse: [
          { key: 'momentum',       version: '1.0.0', enabled: true  },
          { key: 'mean_reversion', version: '1.0.0', enabled: false },
          { key: 'supertrend',     version: '1.0.0', enabled: false },
        ],
        rotationState: {
          activeStrategy: 'momentum',
          queuedStrategy: 'momentum',
          rotationIntervalMinutes: 60,
          lastRotatedAt: null,
          lockedUntil: null,
        },
        schedulingState: {
          lastTradeAttemptedAt: null,
          lastTradeSubmittedAt: null,
        },
        positionState: {
          status: 'flat',
          entryPriceUsd: null,
          entryAt: null,
          quantityAtomic: null,
          highWaterPriceUsd: null,
          lastMarkedPriceUsd: null,
          lastMarkedAt: null,
          pendingExitReason: null,
          exitReason: null,
        },
      },
      riskLimits: req.riskLimits,
      funding: {
        fundingMint: req.fundingMint,
        fundingTokenSymbol: req.fundingTokenSymbol,
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
    const updated = await updateSessionStatus(id, t.next, {
      startedAt: t.startedAt,
      endedAt:   t.endedAt,
      stopReason: t.stopReason,
    });

    return { session: updated, action, appliedAt: now };
  } catch (error) {
    app.log.error({ error, id, action }, 'failed to apply session action');
    return reply.status(500).send({ error: 'Failed to apply session action' });
  }
});

void start();
