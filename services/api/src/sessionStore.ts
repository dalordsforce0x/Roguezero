import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import pg from 'pg';
import { getDatabaseConnectionUrl } from '@roguezero/runtime-config';
import {
  mergeSessionServiceControl,
  type Session,
  type SessionServiceControlPatch,
  sessionSchema,
} from '@roguezero/session-schema';

// ── Keypair encryption (AES-256-GCM) ─────────────────────────────────────────

const SESSION_KEY_ENCRYPTION_KEY = process.env.SESSION_KEY_ENCRYPTION_KEY ?? '';

const getEncryptionKey = (): Buffer | null => {
  if (!SESSION_KEY_ENCRYPTION_KEY || SESSION_KEY_ENCRYPTION_KEY.length < 32) {
    return null;
  }
  // Use first 32 bytes of the key (hex or raw)
  const keyBytes = SESSION_KEY_ENCRYPTION_KEY.length === 64
    ? Buffer.from(SESSION_KEY_ENCRYPTION_KEY, 'hex')
    : Buffer.from(SESSION_KEY_ENCRYPTION_KEY.slice(0, 32), 'utf8');
  return keyBytes.length >= 32 ? keyBytes.subarray(0, 32) : null;
};

const encryptKeypair = (plaintext: string): string => {
  const key = getEncryptionKey();
  if (!key) return plaintext; // fallback: no encryption key configured
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: enc:iv:tag:ciphertext (all hex)
  return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
};

const decryptKeypair = (stored: string): string => {
  if (!stored.startsWith('enc:')) return stored; // unencrypted legacy value
  const key = getEncryptionKey();
  if (!key) throw new Error('SESSION_KEY_ENCRYPTION_KEY required to decrypt session keypairs');
  const parts = stored.split(':');
  if (parts.length !== 4) throw new Error('Invalid encrypted keypair format');
  const iv = Buffer.from(parts[1], 'hex');
  const tag = Buffer.from(parts[2], 'hex');
  const ciphertext = Buffer.from(parts[3], 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
};

type RawSessionRow = {
  id: string;
  user_id: string;
  key_auth_user_id: string;
  license_id: string;
  owner_wallet: string;
  session_wallet: string;
  network: string;
  status: string;
  requested_at: Date;
  started_at: Date | null;
  ended_at: Date | null;
  stop_reason: string | null;
  user_control: Record<string, unknown>;
  service_control: Record<string, unknown>;
  risk_limits: Record<string, unknown>;
  funding: Record<string, unknown>;
  created_by: string;
  notes: string | null;
};

type SessionPerformanceFilter = {
  userId?: string;
  ownerWallet?: string;
  licenseId?: string;
};

type PerformanceSummaryRow = {
  total_sessions: string;
  active_sessions: string;
  stopped_sessions: string;
  awaiting_funding_sessions: string;
  ready_or_starting_sessions: string;
  long_sol_sessions: string;
  total_realized_pnl_usd: string;
  total_captured_fees_usd: string;
  first_session_at: Date | null;
  last_session_at: Date | null;
  total_executions: string;
  confirmed_executions: string;
  submitted_executions: string;
  prepared_executions: string;
  failed_executions: string;
  cancelled_executions: string;
  last_execution_at: Date | null;
};

type RecentActivityRow = {
  at: Date;
  kind: string;
  session_id: string;
  session_wallet: string;
  status: string | null;
  execution_id: string | null;
  signature: string | null;
  amount: string | null;
  reason: string | null;
};

type LatestSessionInsightRow = {
  session_id: string;
  status: string;
  session_wallet: string;
  signal_at: Date | null;
  signal_status: string | null;
  signal_regime: string | null;
  signal_momentum_bps: number | null;
  signal_guard_reason: string | null;
  gate_at: Date | null;
  gate_decision: string | null;
  gate_reason: string | null;
  gate_expected_edge_bps: number | null;
  gate_estimated_cost_bps: number | null;
  gate_safety_buffer_bps: number | null;
};

type TradeMetricExecutionRow = {
  session_id: string;
  session_wallet: string;
  input_mint: string;
  output_mint: string;
  amount: string;
  fee_account: string;
  fee_token_symbol: 'SOL' | 'USDC' | 'USDT';
  build_response: Record<string, unknown>;
  confirmation: Record<string, unknown> | null;
  signature: string | null;
  confirmed_at: Date;
};

type PerformanceTradeMetric = {
  tokenSymbol: string;
  pnlUsd: number;
  entryAt: string | null;
  exitAt: string;
  sessionId: string;
  sessionWallet: string;
  exitSignature: string | null;
};

type PerformanceTradeMetrics = {
  completedRoundTrips: number;
  dailyRealizedPnlUsd: number;
  historicRealizedPnlUsd: number;
  bestTrade: PerformanceTradeMetric | null;
  bestTradeToday: PerformanceTradeMetric | null;
  profitableTokens: Array<{
    tokenSymbol: string;
    realizedPnlUsd: number;
    trades: number;
  }>;
  pnlTimeline: Array<{
    date: string;
    pnlUsd: number;
    trades: number;
  }>;
};

type PerformanceSessionHistory = {
  sessionId: string;
  sessionWallet: string;
  status: string;
  requestedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  stopReason: string | null;
  fundedAmountAtomic: string;
  confirmedExecutions: number;
  completedRoundTrips: number;
  confirmedRealizedPnlUsd: number;
  confirmedCapturedFeesUsd: number;
  lastConfirmedExecutionAt: string | null;
  bestTrade: PerformanceTradeMetric | null;
  latestTrade: PerformanceTradeMetric | null;
  completedTrades: PerformanceTradeMetric[];
};

type PerformanceTradeAnalytics = {
  tradeMetrics: PerformanceTradeMetrics;
  sessionHistory: PerformanceSessionHistory[];
};

export type UserPerformanceSnapshot = {
  linkedBy: {
    userId: string | null;
    ownerWallet: string | null;
    licenseId: string | null;
  };
  summary: {
    totalSessions: number;
    activeSessions: number;
    stoppedSessions: number;
    awaitingFundingSessions: number;
    readyOrStartingSessions: number;
    longSolSessions: number;
    totalExecutions: number;
    confirmedExecutions: number;
    submittedExecutions: number;
    preparedExecutions: number;
    failedExecutions: number;
    cancelledExecutions: number;
    totalRealizedPnlUsd: number;
    confirmedRealizedPnlUsd: number;
    confirmedRealizedPnlTodayUsd: number;
    historicalPnlStatus: 'confirmed' | 'legacy_untrusted';
    totalCapturedFeesUsd: number;
    firstSessionAt: string | null;
    lastSessionAt: string | null;
    lastExecutionAt: string | null;
  };
  tradeMetrics: PerformanceTradeMetrics;
  recentActivity: Array<{
    at: string;
    kind: string;
    sessionId: string;
    sessionWallet: string;
    status: string | null;
    executionId: string | null;
    signature: string | null;
    amount: string | null;
    reason: string | null;
  }>;
  latestSessionInsights: Array<{
    sessionId: string;
    status: string;
    sessionWallet: string;
    lastSignal: {
      at: string | null;
      status: string | null;
      regime: string | null;
      momentumBps: number | null;
      guardReason: string | null;
    };
    lastTradeGate: {
      at: string | null;
      decision: string | null;
      reason: string | null;
      expectedEdgeBps: number | null;
      estimatedCostBps: number | null;
      safetyBufferBps: number | null;
    };
  }>;
  sessionHistory: PerformanceSessionHistory[];
};

const DATABASE_QUERY_TIMEOUT_MS = Number(process.env.DATABASE_QUERY_TIMEOUT_MS ?? 15000);
const DATABASE_STATEMENT_TIMEOUT_MS = Number(process.env.DATABASE_STATEMENT_TIMEOUT_MS ?? 12000);
const DATABASE_LOCK_TIMEOUT_MS = Number(process.env.DATABASE_LOCK_TIMEOUT_MS ?? 5000);
const DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS = Number(process.env.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS ?? 10000);
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

const { Pool } = pg;
let pool: pg.Pool | null = null;

export const getPool = () => {
  if (pool) return pool;

  const databaseUrl = getDatabaseConnectionUrl(process.env);

  const parsed = new URL(databaseUrl);
  parsed.searchParams.delete('sslmode');

  pool = new Pool({
    connectionString: parsed.toString(),
    ...(databaseUrl.includes('sslmode=require') ? { ssl: { rejectUnauthorized: false } } : {}),
    query_timeout: DATABASE_QUERY_TIMEOUT_MS,
    statement_timeout: DATABASE_STATEMENT_TIMEOUT_MS,
    lock_timeout: DATABASE_LOCK_TIMEOUT_MS,
    idle_in_transaction_session_timeout: DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  });

  return pool;
};

let readyPromise: Promise<void> | null = null;

const toIsoString = (value: Date | string | null) => {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
};

const getMintSymbol = (mint: string) => {
  if (mint === SOL_MINT) return 'SOL';
  if (mint === USDC_MINT) return 'USDC';
  return mint.slice(0, 4);
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

const getFeeMintForSymbol = (feeTokenSymbol: TradeMetricExecutionRow['fee_token_symbol']) => {
  if (feeTokenSymbol === 'USDC') return USDC_MINT;
  if (feeTokenSymbol === 'USDT') return USDT_MINT;
  return SOL_MINT;
};

const getQuotedSolUsdPrice = (row: TradeMetricExecutionRow): number | null => {
  const buildResponse = row.build_response as { outAmount?: unknown; inAmount?: unknown } | null;
  const inputAtomic = Number(buildResponse?.inAmount ?? row.amount);
  const outputAtomic = Number(buildResponse?.outAmount ?? NaN);

  if (!Number.isFinite(inputAtomic) || !Number.isFinite(outputAtomic) || inputAtomic <= 0 || outputAtomic <= 0) {
    return null;
  }

  if (row.input_mint === SOL_MINT && row.output_mint === USDC_MINT) {
    return (outputAtomic / 1_000_000) / (inputAtomic / 1_000_000_000);
  }

  if (row.input_mint === USDC_MINT && row.output_mint === SOL_MINT) {
    return (inputAtomic / 1_000_000) / (outputAtomic / 1_000_000_000);
  }

  return null;
};

const getConfirmationAccountKeys = (confirmation: Record<string, unknown> | null) => {
  const accountKeys = (confirmation as { accountKeys?: unknown } | null)?.accountKeys;
  return Array.isArray(accountKeys)
    ? accountKeys.filter((value): value is string => typeof value === 'string')
    : [];
};

const getConfirmationTokenBalanceDeltaAtomic = (
  confirmation: Record<string, unknown> | null,
  params: { mint: string; owner?: string; accountAddress?: string },
) => {
  if (!confirmation) {
    return null;
  }

  const accountKeys = getConfirmationAccountKeys(confirmation);
  // Token balances are stored at top level of the confirmation snapshot,
  // NOT nested under meta (meta only has err/fee/computeUnitsConsumed).
  const topLevel = confirmation as Record<string, unknown>;
  const preTokenBalances = Array.isArray(topLevel.preTokenBalances) ? topLevel.preTokenBalances : [];
  const postTokenBalances = Array.isArray(topLevel.postTokenBalances) ? topLevel.postTokenBalances : [];
  const matchingIndexes = new Set<number>();

  const matches = (entry: unknown) => {
    if (!entry || typeof entry !== 'object') {
      return false;
    }

    const candidate = entry as {
      accountIndex?: unknown;
      mint?: unknown;
      owner?: unknown;
    };

    if (candidate.mint !== params.mint) {
      return false;
    }

    if (params.owner && candidate.owner !== params.owner) {
      return false;
    }

    if (params.accountAddress) {
      const accountKey = accountKeys[candidate.accountIndex as number] ?? null;
      if (accountKey !== params.accountAddress) {
        return false;
      }
    }

    return typeof candidate.accountIndex === 'number';
  };

  for (const entry of preTokenBalances) {
    if (matches(entry)) {
      matchingIndexes.add((entry as { accountIndex: number }).accountIndex);
    }
  }

  for (const entry of postTokenBalances) {
    if (matches(entry)) {
      matchingIndexes.add((entry as { accountIndex: number }).accountIndex);
    }
  }

  if (matchingIndexes.size === 0) {
    return null;
  }

  const getAtomicAmount = (entry: unknown) => {
    if (!entry || typeof entry !== 'object') {
      return 0;
    }

    const uiTokenAmount = (entry as { uiTokenAmount?: { amount?: unknown } }).uiTokenAmount;
    const amount = Number(uiTokenAmount?.amount ?? '0');
    return Number.isFinite(amount) ? amount : 0;
  };

  let totalDeltaAtomic = 0;
  for (const accountIndex of matchingIndexes) {
    const preEntry = preTokenBalances.find((entry) => (
      typeof (entry as { accountIndex?: unknown })?.accountIndex === 'number'
      && (entry as { accountIndex: number }).accountIndex === accountIndex
    ));
    const postEntry = postTokenBalances.find((entry) => (
      typeof (entry as { accountIndex?: unknown })?.accountIndex === 'number'
      && (entry as { accountIndex: number }).accountIndex === accountIndex
    ));

    totalDeltaAtomic += getAtomicAmount(postEntry) - getAtomicAmount(preEntry);
  }

  return totalDeltaAtomic;
};

const getConfirmationWalletBalanceSnapshot = (confirmation: Record<string, unknown> | null, wallet: string) => {
  if (!confirmation) {
    return null;
  }

  const accountKeys = getConfirmationAccountKeys(confirmation);
  const accountIndex = accountKeys.findIndex((accountKey) => accountKey === wallet);

  if (accountIndex < 0) {
    return null;
  }

  const preBalances = ((confirmation as { preBalances?: unknown }).preBalances ?? []) as unknown[];
  const postBalances = ((confirmation as { postBalances?: unknown }).postBalances ?? []) as unknown[];
  const preBalance = Number(preBalances[accountIndex] ?? NaN);
  const postBalance = Number(postBalances[accountIndex] ?? NaN);

  if (!Number.isFinite(preBalance) || !Number.isFinite(postBalance)) {
    return null;
  }

  return {
    preBalance,
    postBalance,
    delta: postBalance - preBalance,
  };
};

const getBuildAtomicAmount = (
  buildResponse: Record<string, unknown> | null | undefined,
  key: 'inAmount' | 'outAmount',
) => {
  const amount = buildResponse?.[key];
  if (typeof amount !== 'string') {
    return 0;
  }

  const numeric = Number(amount);
  return Number.isFinite(numeric) ? numeric : 0;
};

const buildTradeAnalytics = (
  sessions: RawSessionRow[],
  rows: TradeMetricExecutionRow[],
): PerformanceTradeAnalytics => {
  const openPositions = new Map<string, {
    sessionId: string;
    sessionWallet: string;
    tokenSymbol: string;
    quantityAtomic: number;
    costBasisUsd: number;
    entryAt: string;
  }>();
  const completedTrades: PerformanceTradeMetric[] = [];
  const sessionHistoryMap = new Map<string, PerformanceSessionHistory>(
    sessions.map((session) => [
      session.id,
      {
        sessionId: session.id,
        sessionWallet: session.session_wallet,
        status: session.status,
        requestedAt: toIsoString(session.requested_at) ?? new Date(0).toISOString(),
        startedAt: toIsoString(session.started_at),
        endedAt: toIsoString(session.ended_at),
        stopReason: session.stop_reason,
        fundedAmountAtomic: String((session.funding as { startingBalanceAtomic?: unknown } | null)?.startingBalanceAtomic ?? '0'),
        confirmedExecutions: 0,
        completedRoundTrips: 0,
        confirmedRealizedPnlUsd: 0,
        confirmedCapturedFeesUsd: 0,
        lastConfirmedExecutionAt: null,
        bestTrade: null,
        latestTrade: null,
        completedTrades: [],
      },
    ]),
  );

  const ensureSessionHistory = (sessionId: string, sessionWallet: string) => {
    const existing = sessionHistoryMap.get(sessionId);
    if (existing) {
      return existing;
    }

    const fallback: PerformanceSessionHistory = {
      sessionId,
      sessionWallet,
      status: 'unknown',
      requestedAt: new Date(0).toISOString(),
      startedAt: null,
      endedAt: null,
      stopReason: null,
      fundedAmountAtomic: '0',
      confirmedExecutions: 0,
      completedRoundTrips: 0,
      confirmedRealizedPnlUsd: 0,
      confirmedCapturedFeesUsd: 0,
      lastConfirmedExecutionAt: null,
      bestTrade: null,
      latestTrade: null,
      completedTrades: [],
    };
    sessionHistoryMap.set(sessionId, fallback);
    return fallback;
  };

  for (const row of rows) {
    const confirmedAt = toIsoString(row.confirmed_at);
    if (!confirmedAt) {
      continue;
    }

    const sessionHistory = ensureSessionHistory(row.session_id, row.session_wallet);
    sessionHistory.confirmedExecutions += 1;
    sessionHistory.lastConfirmedExecutionAt = confirmedAt;

    const feeMint = getFeeMintForSymbol(row.fee_token_symbol);
    const feeAccountDeltaAtomic = Math.max(0, getConfirmationTokenBalanceDeltaAtomic(row.confirmation, {
      mint: feeMint,
      accountAddress: row.fee_account,
    }) ?? 0);
    sessionHistory.confirmedCapturedFeesUsd += getUsdValueFromAtomicAmount(
      feeMint,
      feeAccountDeltaAtomic,
      feeMint === SOL_MINT ? getQuotedSolUsdPrice(row) : null,
    );

    if (row.input_mint === USDC_MINT && row.output_mint === SOL_MINT) {
      const usdcDeltaAtomic = getConfirmationTokenBalanceDeltaAtomic(row.confirmation, {
        mint: USDC_MINT,
        owner: row.session_wallet,
      });
      const walletBalanceSnapshot = getConfirmationWalletBalanceSnapshot(row.confirmation, row.session_wallet);
      const usdcSpentAtomic = usdcDeltaAtomic !== null && usdcDeltaAtomic < 0
        ? Math.abs(usdcDeltaAtomic)
        : getBuildAtomicAmount(row.build_response, 'inAmount');
      const solReceivedAtomic = walletBalanceSnapshot !== null && walletBalanceSnapshot.delta > 0
        ? walletBalanceSnapshot.delta
        : getBuildAtomicAmount(row.build_response, 'outAmount');

      if (usdcSpentAtomic <= 0 || solReceivedAtomic <= 0) {
        continue;
      }

      const existing = openPositions.get(row.session_wallet);
      if (existing && existing.tokenSymbol === 'SOL') {
        openPositions.set(row.session_wallet, {
          ...existing,
          quantityAtomic: existing.quantityAtomic + solReceivedAtomic,
          costBasisUsd: existing.costBasisUsd + (usdcSpentAtomic / 1_000_000),
        });
      } else {
        openPositions.set(row.session_wallet, {
          sessionId: row.session_id,
          sessionWallet: row.session_wallet,
          tokenSymbol: 'SOL',
          quantityAtomic: solReceivedAtomic,
          costBasisUsd: usdcSpentAtomic / 1_000_000,
          entryAt: confirmedAt,
        });
      }
      continue;
    }

    if (row.input_mint === SOL_MINT && row.output_mint === USDC_MINT) {
      const usdcDeltaAtomic = getConfirmationTokenBalanceDeltaAtomic(row.confirmation, {
        mint: USDC_MINT,
        owner: row.session_wallet,
      });
      const usdcReceivedAtomic = usdcDeltaAtomic !== null && usdcDeltaAtomic > 0
        ? usdcDeltaAtomic
        : getBuildAtomicAmount(row.build_response, 'outAmount');
      const solSoldAtomic = Number(row.amount);

      if (usdcReceivedAtomic <= 0 || !Number.isFinite(solSoldAtomic) || solSoldAtomic <= 0) {
        continue;
      }

      let openPosition = openPositions.get(row.session_wallet);

      // Bootstrap handling: SOL-funded sessions start long_sol with no USDC→SOL
      // entry execution. Synthesize the entry from session funding data so the
      // exit counts as a completed trade with correct PnL.
      if (!openPosition || openPosition.quantityAtomic <= 0 || openPosition.costBasisUsd <= 0) {
        const sessionRow = sessions.find(s => s.id === row.session_id);
        const fundingData = (sessionRow?.funding ?? {}) as Record<string, unknown>;
        const isSolFunded = fundingData.fundingTokenSymbol === 'SOL';
        const startingBal = Number(fundingData.startingBalanceAtomic ?? 0);

        if (!isSolFunded || startingBal <= 0) {
          continue;
        }

        // Derive entry cost basis from session-level realizedPnlUsd.
        // For single-exit bootstrap sessions this is exact:
        //   realizedPnlUsd = usdcReceived - solSold * entryPrice
        //   costBasis = usdcReceived - realizedPnlUsd = solSold * entryPrice
        const sessionPnl = Number(fundingData.realizedPnlUsd ?? 0);
        const proceedsUsd = usdcReceivedAtomic / 1_000_000;
        const costBasisUsd = proceedsUsd - sessionPnl;

        openPosition = {
          sessionId: row.session_id,
          sessionWallet: row.session_wallet,
          tokenSymbol: 'SOL',
          quantityAtomic: solSoldAtomic,
          costBasisUsd: Math.max(0.000001, costBasisUsd),
          entryAt: toIsoString(sessionRow?.started_at ?? null) ?? confirmedAt,
        };
        openPositions.set(row.session_wallet, openPosition);
      }

      const soldFraction = Math.min(1, solSoldAtomic / openPosition.quantityAtomic);
      const costBasisSoldUsd = openPosition.costBasisUsd * soldFraction;
      const proceedsUsd = usdcReceivedAtomic / 1_000_000;
      const pnlUsd = proceedsUsd - costBasisSoldUsd;

      const completedTrade = {
        tokenSymbol: openPosition.tokenSymbol,
        pnlUsd,
        entryAt: openPosition.entryAt,
        exitAt: confirmedAt,
        sessionId: row.session_id,
        sessionWallet: row.session_wallet,
        exitSignature: row.signature,
      };

      completedTrades.push(completedTrade);
      sessionHistory.completedTrades.push(completedTrade);
      sessionHistory.completedRoundTrips += 1;
      sessionHistory.confirmedRealizedPnlUsd += pnlUsd;
      sessionHistory.latestTrade = completedTrade;
      if (!sessionHistory.bestTrade || completedTrade.pnlUsd > sessionHistory.bestTrade.pnlUsd) {
        sessionHistory.bestTrade = completedTrade;
      }

      const remainingQuantityAtomic = Math.max(0, openPosition.quantityAtomic - solSoldAtomic);
      if (remainingQuantityAtomic === 0) {
        openPositions.delete(row.session_wallet);
      } else {
        openPositions.set(row.session_wallet, {
          ...openPosition,
          quantityAtomic: remainingQuantityAtomic,
          costBasisUsd: Math.max(0, openPosition.costBasisUsd - costBasisSoldUsd),
        });
      }
    }
  }

  const todayKey = new Date().toISOString().slice(0, 10);
  const tokenRollup = new Map<string, { realizedPnlUsd: number; trades: number }>();
  const timelineRollup = new Map<string, { pnlUsd: number; trades: number }>();

  let historicRealizedPnlUsd = 0;
  let dailyRealizedPnlUsd = 0;
  let bestTrade: PerformanceTradeMetric | null = null;
  let bestTradeToday: PerformanceTradeMetric | null = null;

  for (const trade of completedTrades) {
    historicRealizedPnlUsd += trade.pnlUsd;

    const exitDate = trade.exitAt.slice(0, 10);
    if (exitDate === todayKey) {
      dailyRealizedPnlUsd += trade.pnlUsd;
      if (!bestTradeToday || trade.pnlUsd > bestTradeToday.pnlUsd) {
        bestTradeToday = trade;
      }
    }

    if (!bestTrade || trade.pnlUsd > bestTrade.pnlUsd) {
      bestTrade = trade;
    }

    const tokenAggregate = tokenRollup.get(trade.tokenSymbol) ?? { realizedPnlUsd: 0, trades: 0 };
    tokenAggregate.realizedPnlUsd += trade.pnlUsd;
    tokenAggregate.trades += 1;
    tokenRollup.set(trade.tokenSymbol, tokenAggregate);

    const timelineEntry = timelineRollup.get(exitDate) ?? { pnlUsd: 0, trades: 0 };
    timelineEntry.pnlUsd += trade.pnlUsd;
    timelineEntry.trades += 1;
    timelineRollup.set(exitDate, timelineEntry);
  }

  return {
    tradeMetrics: {
      completedRoundTrips: completedTrades.length,
      dailyRealizedPnlUsd,
      historicRealizedPnlUsd,
      bestTrade,
      bestTradeToday,
      profitableTokens: [...tokenRollup.entries()]
        .map(([tokenSymbol, aggregate]) => ({ tokenSymbol, ...aggregate }))
        .sort((left, right) => right.realizedPnlUsd - left.realizedPnlUsd),
      pnlTimeline: [...timelineRollup.entries()]
        .map(([date, aggregate]) => ({ date, ...aggregate }))
        .sort((left, right) => left.date.localeCompare(right.date)),
    },
    sessionHistory: sessions.map((session) => {
      const history = ensureSessionHistory(session.id, session.session_wallet);
      return {
        ...history,
        completedTrades: [...history.completedTrades].sort((left, right) => right.exitAt.localeCompare(left.exitAt)),
      };
    }),
  };
};

const mapRow = (row: RawSessionRow): Session =>
  sessionSchema.parse({
    id: row.id,
    userId: row.user_id,
    keyAuthUserId: row.key_auth_user_id,
    licenseId: row.license_id,
    ownerWallet: row.owner_wallet,
    sessionWallet: row.session_wallet,
    network: row.network,
    status: row.status,
    requestedAt: toIsoString(row.requested_at),
    startedAt: toIsoString(row.started_at),
    endedAt: toIsoString(row.ended_at),
    stopReason: row.stop_reason,
    userControl: row.user_control,
    serviceControl: row.service_control,
    riskLimits: row.risk_limits,
    funding: row.funding,
    createdBy: row.created_by,
    notes: row.notes,
  });

export const sessionStoreReady = async () => {
  const dbPool = getPool();
  if (!readyPromise) {
    readyPromise = dbPool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id UUID PRIMARY KEY,
        user_id TEXT NOT NULL,
        key_auth_user_id TEXT NOT NULL,
        license_id TEXT NOT NULL,
        owner_wallet TEXT NOT NULL,
        session_wallet TEXT NOT NULL,
        network TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_at TIMESTAMPTZ NOT NULL,
        started_at TIMESTAMPTZ,
        ended_at TIMESTAMPTZ,
        stop_reason TEXT,
        user_control JSONB NOT NULL,
        service_control JSONB NOT NULL,
        risk_limits JSONB NOT NULL,
        funding JSONB NOT NULL,
        created_by TEXT NOT NULL,
        notes TEXT
      )
    `)
      .then(() => dbPool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS sessions_session_wallet_key
        ON sessions (session_wallet)
      `))
      .then(() => dbPool.query(`
        CREATE TABLE IF NOT EXISTS session_keys (
          session_id UUID PRIMARY KEY,
          keypair_base58 TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `))
      .then(() => dbPool.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
              FROM pg_constraint
             WHERE conname = 'session_keys_session_id_fkey'
          ) THEN
            ALTER TABLE session_keys
            ADD CONSTRAINT session_keys_session_id_fkey
            FOREIGN KEY (session_id)
            REFERENCES sessions(id)
            ON DELETE CASCADE;
          END IF;
        END
        $$;
      `))
      .then(() => undefined);
  }
  return readyPromise;
};

export const createSessionWithKey = async (session: Session, keypairBase58: string) => {
  await sessionStoreReady();
  const dbPool = getPool();
  const client = await dbPool.connect();

  try {
    await client.query('BEGIN');

    const sessionResult = await client.query<RawSessionRow>(
      `
        INSERT INTO sessions (
          id, user_id, key_auth_user_id, license_id, owner_wallet, session_wallet,
          network, status, requested_at, started_at, ended_at, stop_reason,
          user_control, service_control, risk_limits, funding, created_by, notes
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
          $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb, $17, $18
        )
        RETURNING *
      `,
      [
        session.id, session.userId, session.keyAuthUserId, session.licenseId,
        session.ownerWallet, session.sessionWallet, session.network, session.status,
        session.requestedAt, session.startedAt, session.endedAt, session.stopReason,
        JSON.stringify(session.userControl), JSON.stringify(session.serviceControl),
        JSON.stringify(session.riskLimits), JSON.stringify(session.funding),
        session.createdBy, session.notes,
      ],
    );

    await client.query(
      `INSERT INTO session_keys (session_id, keypair_base58)
       VALUES ($1, $2)
       ON CONFLICT (session_id) DO UPDATE SET keypair_base58 = EXCLUDED.keypair_base58`,
      [session.id, encryptKeypair(keypairBase58)],
    );

    await client.query('COMMIT');
    return mapRow(sessionResult.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export const getSessionById = async (id: string) => {
  await sessionStoreReady();
  const dbPool = getPool();

  const result = await dbPool.query<RawSessionRow>('SELECT * FROM sessions WHERE id = $1', [id]);
  return result.rowCount ? mapRow(result.rows[0]) : null;
};

export const getSessionByWallet = async (sessionWallet: string) => {
  await sessionStoreReady();
  const dbPool = getPool();

  const result = await dbPool.query<RawSessionRow>(
    'SELECT * FROM sessions WHERE session_wallet = $1 LIMIT 1',
    [sessionWallet],
  );
  return result.rowCount ? mapRow(result.rows[0]) : null;
};

export const listSessions = async (filter: {
  userId?: string;
  status?: string | string[];
  limit?: number;
} = {}) => {
  await sessionStoreReady();
  const dbPool = getPool();

  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter.userId) {
    values.push(filter.userId);
    conditions.push(`user_id = $${values.length}`);
  }

  if (filter.status) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    const placeholders = statuses.map((_, i) => `$${values.length + i + 1}`).join(', ');
    conditions.push(`status IN (${placeholders})`);
    values.push(...statuses);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(filter.limit ?? 100, 500);

  const result = await dbPool.query<RawSessionRow>(
    `SELECT * FROM sessions ${where} ORDER BY requested_at DESC LIMIT ${limit}`,
    values,
  );
  return result.rows.map(mapRow);
};

export const updateSessionStatus = async (
  id: string,
  status: string,
  opts: {
    startedAt?: string | null;
    endedAt?: string | null;
    stopReason?: string | null;
    userControl?: Record<string, unknown>;
    serviceControl?: Record<string, unknown>;
    funding?: Record<string, unknown>;
  } = {},
) => {
  await sessionStoreReady();
  const dbPool = getPool();

  const setClauses: string[] = ['status = $2'];
  const values: unknown[] = [id, status];

  if (opts.startedAt !== undefined) {
    values.push(opts.startedAt);
    setClauses.push(`started_at = $${values.length}`);
  }
  if (opts.endedAt !== undefined) {
    values.push(opts.endedAt);
    setClauses.push(`ended_at = $${values.length}`);
  }
  if (opts.stopReason !== undefined) {
    values.push(opts.stopReason);
    setClauses.push(`stop_reason = $${values.length}`);
  }
  if (opts.userControl !== undefined) {
    values.push(JSON.stringify(opts.userControl));
    setClauses.push(`user_control = $${values.length}::jsonb`);
  }
  if (opts.serviceControl !== undefined) {
    values.push(JSON.stringify(opts.serviceControl));
    setClauses.push(`service_control = $${values.length}::jsonb`);
  }
  if (opts.funding !== undefined) {
    values.push(JSON.stringify(opts.funding));
    setClauses.push(`funding = $${values.length}::jsonb`);
  }

  const result = await dbPool.query<RawSessionRow>(
    `UPDATE sessions SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
    values,
  );
  return result.rowCount ? mapRow(result.rows[0]) : null;
};

export const updateSessionFundingByWallet = async (
  sessionWallet: string,
  fundingDelta: { realizedPnlUsd?: number; capturedFeesUsd?: number },
) => {
  await sessionStoreReady();
  const dbPool = getPool();
  const client = await dbPool.connect();

  try {
    await client.query('BEGIN');

    const existingResult = await client.query<RawSessionRow>(
      `SELECT *
         FROM sessions
        WHERE session_wallet = $1
        LIMIT 1
        FOR UPDATE`,
      [sessionWallet],
    );

    if (!existingResult.rowCount) {
      await client.query('ROLLBACK');
      return null;
    }

    const existingFunding = (existingResult.rows[0].funding ?? {}) as Record<string, unknown>;
    const currentRealized = Number(existingFunding.realizedPnlUsd ?? 0);
    const currentFees = Number(existingFunding.capturedFeesUsd ?? 0);
    const mergedFunding = {
      ...existingFunding,
      realizedPnlUsd: currentRealized + (fundingDelta.realizedPnlUsd ?? 0),
      capturedFeesUsd: currentFees + (fundingDelta.capturedFeesUsd ?? 0),
    };

    const result = await client.query<RawSessionRow>(
      `UPDATE sessions
          SET funding = $2::jsonb
        WHERE session_wallet = $1
        RETURNING *`,
      [sessionWallet, JSON.stringify(mergedFunding)],
    );

    await client.query('COMMIT');
    return result.rowCount ? mapRow(result.rows[0]) : null;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export const updateSessionExecutionOutcomeByWallet = async (
  sessionWallet: string,
  params: {
    serviceControlPatch?: SessionServiceControlPatch;
    fundingDelta?: { realizedPnlUsd?: number; capturedFeesUsd?: number };
    fundingPatch?: Partial<Session['funding']>;
  },
) => {
  await sessionStoreReady();
  const dbPool = getPool();
  const client = await dbPool.connect();

  try {
    await client.query('BEGIN');

    const existingResult = await client.query<RawSessionRow>(
      `SELECT *
         FROM sessions
        WHERE session_wallet = $1
        LIMIT 1
        FOR UPDATE`,
      [sessionWallet],
    );

    if (!existingResult.rowCount) {
      await client.query('ROLLBACK');
      return null;
    }

    const existingRow = existingResult.rows[0];
    const setClauses: string[] = [];
    const values: unknown[] = [sessionWallet];
    let mergedFunding: Record<string, unknown> | null = null;

    if (params.serviceControlPatch !== undefined) {
      const mergedServiceControl = mergeSessionServiceControl(
        existingRow.service_control as Session['serviceControl'],
        params.serviceControlPatch,
      );
      values.push(JSON.stringify(mergedServiceControl));
      setClauses.push(`service_control = $${values.length}::jsonb`);
    }

    if (params.fundingDelta !== undefined || params.fundingPatch !== undefined) {
      const existingFunding = (existingRow.funding ?? {}) as Record<string, unknown>;
      const currentRealized = Number(existingFunding.realizedPnlUsd ?? 0);
      const currentFees = Number(existingFunding.capturedFeesUsd ?? 0);

      mergedFunding = {
        ...existingFunding,
        ...(params.fundingPatch ?? {}),
      };

      if (params.fundingDelta !== undefined) {
        mergedFunding.realizedPnlUsd = currentRealized + (params.fundingDelta.realizedPnlUsd ?? 0);
        mergedFunding.capturedFeesUsd = currentFees + (params.fundingDelta.capturedFeesUsd ?? 0);
      }

      values.push(JSON.stringify(mergedFunding));
      setClauses.push(`funding = $${values.length}::jsonb`);
    }

    if (setClauses.length === 0) {
      await client.query('ROLLBACK');
      return mapRow(existingRow);
    }

    const result = await client.query<RawSessionRow>(
      `UPDATE sessions
          SET ${setClauses.join(', ')}
        WHERE session_wallet = $1
        RETURNING *`,
      values,
    );

    await client.query('COMMIT');
    return result.rowCount ? mapRow(result.rows[0]) : null;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export const updateSessionServiceControlByWallet = async (
  sessionWallet: string,
  serviceControlPatch: SessionServiceControlPatch,
) => {
  await sessionStoreReady();
  const dbPool = getPool();
  const client = await dbPool.connect();

  try {
    await client.query('BEGIN');

    const existingResult = await client.query<RawSessionRow>(
      `SELECT *
         FROM sessions
        WHERE session_wallet = $1
        LIMIT 1
        FOR UPDATE`,
      [sessionWallet],
    );

    if (!existingResult.rowCount) {
      await client.query('ROLLBACK');
      return null;
    }

    const mergedServiceControl = mergeSessionServiceControl(
      existingResult.rows[0].service_control as Session['serviceControl'],
      serviceControlPatch,
    );

    const result = await client.query<RawSessionRow>(
      `UPDATE sessions
          SET service_control = $2::jsonb
        WHERE session_wallet = $1
        RETURNING *`,
      [sessionWallet, JSON.stringify(mergedServiceControl)],
    );

    await client.query('COMMIT');
    return result.rowCount ? mapRow(result.rows[0]) : null;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

// ── Session key store (private keypairs for autonomous trading) ───────────────

export const sessionKeysReady = async () => {
  await sessionStoreReady();
};

export const getSessionKey = async (sessionId: string): Promise<string | null> => {
  const dbPool = getPool();
  const result = await dbPool.query<{ keypair_base58: string }>(
    'SELECT keypair_base58 FROM session_keys WHERE session_id = $1',
    [sessionId],
  );
  return result.rowCount ? decryptKeypair(result.rows[0].keypair_base58) : null;
};

// ── rz_users lookup (used by /users/by-wallet route) ─────────────────────────

export type RzUserRow = {
  id: string;
  username: string;
  wallet_address: string;
  license_key: string | null;
  expiry_date: string | null;
  access_enabled: boolean;
  max_wallet_usd: number;
  duration: string | null;
};

let rzUsersColumnsReadyPromise: Promise<void> | null = null;

const ensureRzUsersColumnsReady = async () => {
  const dbPool = getPool();
  if (!rzUsersColumnsReadyPromise) {
    rzUsersColumnsReadyPromise = dbPool.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
            FROM information_schema.tables
           WHERE table_schema = 'public'
             AND table_name = 'rz_users'
        ) THEN
          ALTER TABLE rz_users
            ADD COLUMN IF NOT EXISTS max_wallet_usd INTEGER NOT NULL DEFAULT 10000;
        END IF;
      END
      $$;
    `).then(() => undefined);
  }

  return rzUsersColumnsReadyPromise;
};

export const getUserByWallet = async (walletAddress: string): Promise<RzUserRow | null> => {
  await ensureRzUsersColumnsReady();
  const dbPool = getPool();
  const result = await dbPool.query<RzUserRow>(
    `SELECT id, username, wallet_address, license_key, expiry_date, access_enabled,
            COALESCE(max_wallet_usd, 10000)::integer AS max_wallet_usd,
            duration
       FROM rz_users
      WHERE wallet_address = $1
      LIMIT 1`,
    [walletAddress],
  );

  return result.rows[0] ?? null;
};

export const getUserById = async (userId: string): Promise<RzUserRow | null> => {
  await ensureRzUsersColumnsReady();
  const dbPool = getPool();
  const result = await dbPool.query<RzUserRow>(
    `SELECT id, username, wallet_address, license_key, expiry_date, access_enabled,
            COALESCE(max_wallet_usd, 10000)::integer AS max_wallet_usd,
            duration
       FROM rz_users
      WHERE id = $1
      LIMIT 1`,
    [userId],
  );

  return result.rows[0] ?? null;
};

export const getUserByLicenseKey = async (licenseKey: string): Promise<RzUserRow | null> => {
  await ensureRzUsersColumnsReady();
  const dbPool = getPool();
  const result = await dbPool.query<RzUserRow>(
    `SELECT id, username, wallet_address, license_key, expiry_date, access_enabled,
            COALESCE(max_wallet_usd, 10000)::integer AS max_wallet_usd,
            duration
       FROM rz_users
      WHERE license_key = $1
      LIMIT 1`,
    [licenseKey],
  );

  return result.rows[0] ?? null;
};

const buildPerformanceFilterClauses = (filter: SessionPerformanceFilter) => {
  const values: unknown[] = [];
  const clauses: string[] = [];

  if (filter.userId) {
    values.push(filter.userId);
    clauses.push(`user_id = $${values.length}`);
  }

  if (filter.ownerWallet) {
    values.push(filter.ownerWallet);
    clauses.push(`owner_wallet = $${values.length}`);
  }

  if (filter.licenseId) {
    values.push(filter.licenseId);
    clauses.push(`license_id = $${values.length}`);
  }

  if (clauses.length === 0) {
    throw new Error('At least one performance filter must be provided');
  }

  return {
    where: clauses.join(' AND '),
    values,
  };
};

const parseCount = (value: string | number | null | undefined) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const parseUsd = (value: string | number | null | undefined) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const getUserPerformanceSnapshot = async (
  filter: SessionPerformanceFilter,
): Promise<UserPerformanceSnapshot> => {
  await sessionStoreReady();
  const dbPool = getPool();
  const { where, values } = buildPerformanceFilterClauses(filter);

  const identityResult = await dbPool.query<{
    user_id: string;
    owner_wallet: string;
    license_id: string;
  }>(
    `SELECT user_id, owner_wallet, license_id
       FROM sessions
      WHERE ${where}
      ORDER BY requested_at DESC
      LIMIT 1`,
    values,
  );

  const matchedSessionsResult = await dbPool.query<RawSessionRow>(
    `SELECT *
       FROM sessions
      WHERE ${where}
      ORDER BY requested_at DESC`,
    values,
  );

  const summaryResult = await dbPool.query<PerformanceSummaryRow>(
    `WITH matched_sessions AS (
       SELECT *
         FROM sessions
        WHERE ${where}
     ),
     session_rollup AS (
       SELECT
         COUNT(*)::bigint AS total_sessions,
         COUNT(*) FILTER (WHERE status = 'active')::bigint AS active_sessions,
         COUNT(*) FILTER (WHERE status = 'stopped')::bigint AS stopped_sessions,
         COUNT(*) FILTER (WHERE status = 'awaiting_funding')::bigint AS awaiting_funding_sessions,
         COUNT(*) FILTER (WHERE status IN ('ready', 'starting'))::bigint AS ready_or_starting_sessions,
         COUNT(*) FILTER (
           WHERE status = 'active'
             AND (
               COALESCE(service_control->'positionsState'->'positions', '{}'::jsonb) <> '{}'::jsonb
               OR COALESCE(service_control->'positionState'->>'status', 'flat') IN ('long', 'long_sol')
             )
         )::bigint AS long_sol_sessions,
         COALESCE(SUM((funding->>'realizedPnlUsd')::numeric), 0)::text AS total_realized_pnl_usd,
         COALESCE(SUM((funding->>'capturedFeesUsd')::numeric), 0)::text AS total_captured_fees_usd,
         MIN(requested_at) AS first_session_at,
         MAX(COALESCE(ended_at, started_at, requested_at)) AS last_session_at
       FROM matched_sessions
     ),
     execution_rollup AS (
       SELECT
         COUNT(*)::bigint AS total_executions,
         COUNT(*) FILTER (WHERE e.status = 'confirmed')::bigint AS confirmed_executions,
         COUNT(*) FILTER (WHERE e.status = 'submitted')::bigint AS submitted_executions,
         COUNT(*) FILTER (WHERE e.status = 'prepared')::bigint AS prepared_executions,
         COUNT(*) FILTER (WHERE e.status = 'failed' AND COALESCE(e.last_error->>'stage', '') <> 'worker_cancel')::bigint AS failed_executions,
         COUNT(*) FILTER (WHERE e.status = 'failed' AND e.last_error->>'stage' = 'worker_cancel')::bigint AS cancelled_executions,
         MAX(COALESCE(e.confirmed_at, e.submitted_at, e.prepared_at)) AS last_execution_at
       FROM swap_executions e
       INNER JOIN matched_sessions s
               ON s.session_wallet = e.taker
     )
     SELECT
       session_rollup.total_sessions,
       session_rollup.active_sessions,
       session_rollup.stopped_sessions,
       session_rollup.awaiting_funding_sessions,
       session_rollup.ready_or_starting_sessions,
       session_rollup.long_sol_sessions,
       session_rollup.total_realized_pnl_usd,
       session_rollup.total_captured_fees_usd,
       session_rollup.first_session_at,
       session_rollup.last_session_at,
       COALESCE(execution_rollup.total_executions, 0)::text AS total_executions,
       COALESCE(execution_rollup.confirmed_executions, 0)::text AS confirmed_executions,
       COALESCE(execution_rollup.submitted_executions, 0)::text AS submitted_executions,
       COALESCE(execution_rollup.prepared_executions, 0)::text AS prepared_executions,
       COALESCE(execution_rollup.failed_executions, 0)::text AS failed_executions,
       COALESCE(execution_rollup.cancelled_executions, 0)::text AS cancelled_executions,
       execution_rollup.last_execution_at
     FROM session_rollup
     CROSS JOIN execution_rollup`,
    values,
  );

  const activityResult = await dbPool.query<RecentActivityRow>(
    `WITH matched_sessions AS (
       SELECT *
         FROM sessions
        WHERE ${where}
     )
     SELECT *
       FROM (
         SELECT
           requested_at AS at,
           'session_requested' AS kind,
           id AS session_id,
           session_wallet,
           status,
           NULL::uuid AS execution_id,
           NULL::text AS signature,
           NULL::text AS amount,
           NULL::text AS reason
         FROM matched_sessions

         UNION ALL

         SELECT
           started_at AS at,
           'session_started' AS kind,
           id AS session_id,
           session_wallet,
           status,
           NULL::uuid AS execution_id,
           NULL::text AS signature,
           NULL::text AS amount,
           NULL::text AS reason
         FROM matched_sessions
         WHERE started_at IS NOT NULL

         UNION ALL

         SELECT
           ended_at AS at,
           'session_ended' AS kind,
           id AS session_id,
           session_wallet,
           status,
           NULL::uuid AS execution_id,
           NULL::text AS signature,
           NULL::text AS amount,
           NULL::text AS reason
         FROM matched_sessions
         WHERE ended_at IS NOT NULL

         UNION ALL

         SELECT
           COALESCE(e.confirmed_at, e.submitted_at, e.prepared_at) AS at,
           CASE
             WHEN e.status = 'confirmed' THEN 'swap_confirmed'
             WHEN e.status = 'submitted' THEN 'swap_submitted'
             WHEN e.status = 'prepared' THEN 'swap_prepared'
             WHEN e.status = 'failed' AND e.last_error->>'stage' = 'worker_cancel' THEN 'swap_skipped'
             ELSE 'swap_failed'
           END AS kind,
           s.id AS session_id,
           s.session_wallet,
           e.status,
           e.id AS execution_id,
           e.signature,
           e.amount,
           e.last_error->>'reason' AS reason
         FROM swap_executions e
         INNER JOIN matched_sessions s
                 ON s.session_wallet = e.taker
       ) activity
      WHERE at IS NOT NULL
      ORDER BY at DESC
      LIMIT 20`,
    values,
  );

  const latestInsightResult = await dbPool.query<LatestSessionInsightRow>(
    `WITH matched_sessions AS (
       SELECT *
         FROM sessions
        WHERE ${where}
     )
     SELECT
       id AS session_id,
       status,
       session_wallet,
       NULLIF(service_control->'lastSignal'->>'at', '')::timestamptz AS signal_at,
       service_control->'lastSignal'->>'status' AS signal_status,
       service_control->'lastSignal'->>'regime' AS signal_regime,
       CASE
         WHEN service_control->'lastSignal'->>'momentumBps' IS NULL THEN NULL
         ELSE (service_control->'lastSignal'->>'momentumBps')::integer
       END AS signal_momentum_bps,
       service_control->'lastSignal'->>'guardReason' AS signal_guard_reason,
       NULLIF(service_control->'lastTradeGate'->>'at', '')::timestamptz AS gate_at,
       service_control->'lastTradeGate'->>'decision' AS gate_decision,
       service_control->'lastTradeGate'->>'reason' AS gate_reason,
       CASE
         WHEN service_control->'lastTradeGate'->>'expectedEdgeBps' IS NULL THEN NULL
         ELSE (service_control->'lastTradeGate'->>'expectedEdgeBps')::integer
       END AS gate_expected_edge_bps,
       CASE
         WHEN service_control->'lastTradeGate'->>'estimatedCostBps' IS NULL THEN NULL
         ELSE (service_control->'lastTradeGate'->>'estimatedCostBps')::integer
       END AS gate_estimated_cost_bps,
       CASE
         WHEN service_control->'lastTradeGate'->>'safetyBufferBps' IS NULL THEN NULL
         ELSE (service_control->'lastTradeGate'->>'safetyBufferBps')::integer
       END AS gate_safety_buffer_bps
     FROM matched_sessions
     ORDER BY requested_at DESC
     LIMIT 5`,
    values,
  );

  const tradeMetricResult = await dbPool.query<TradeMetricExecutionRow>(
    `WITH matched_sessions AS (
       SELECT *
         FROM sessions
        WHERE ${where}
     )
     SELECT
       s.id AS session_id,
       s.session_wallet,
       e.input_mint,
       e.output_mint,
       e.amount,
       e.fee_account,
       e.fee_token_symbol,
       e.build_response,
       e.confirmation,
       e.signature,
       e.confirmed_at
     FROM swap_executions e
     INNER JOIN matched_sessions s
             ON s.session_wallet = e.taker
     WHERE e.status = 'confirmed'
       AND e.confirmation IS NOT NULL
       AND e.confirmed_at IS NOT NULL
     ORDER BY e.confirmed_at ASC, e.created_at ASC`,
    values,
  );

  const identity = identityResult.rows[0];
  const summary = summaryResult.rows[0] ?? {
    total_sessions: '0',
    active_sessions: '0',
    stopped_sessions: '0',
    awaiting_funding_sessions: '0',
    ready_or_starting_sessions: '0',
    long_sol_sessions: '0',
    total_realized_pnl_usd: '0',
    total_captured_fees_usd: '0',
    first_session_at: null,
    last_session_at: null,
    total_executions: '0',
    confirmed_executions: '0',
    submitted_executions: '0',
    prepared_executions: '0',
    failed_executions: '0',
    cancelled_executions: '0',
    last_execution_at: null,
  };
  const tradeAnalytics = buildTradeAnalytics(matchedSessionsResult.rows, tradeMetricResult.rows);
  const tradeMetrics = tradeAnalytics.tradeMetrics;
  const totalRealizedPnlUsd = parseUsd(summary.total_realized_pnl_usd);
  const confirmedRealizedPnlUsd = tradeMetrics.historicRealizedPnlUsd;
  const historicalPnlStatus = Math.abs(totalRealizedPnlUsd - confirmedRealizedPnlUsd) > 0.01
    ? 'legacy_untrusted'
    : 'confirmed';

  return {
    linkedBy: {
      userId: identity?.user_id ?? filter.userId ?? null,
      ownerWallet: identity?.owner_wallet ?? filter.ownerWallet ?? null,
      licenseId: identity?.license_id ?? filter.licenseId ?? null,
    },
    summary: {
      totalSessions: parseCount(summary.total_sessions),
      activeSessions: parseCount(summary.active_sessions),
      stoppedSessions: parseCount(summary.stopped_sessions),
      awaitingFundingSessions: parseCount(summary.awaiting_funding_sessions),
      readyOrStartingSessions: parseCount(summary.ready_or_starting_sessions),
      longSolSessions: parseCount(summary.long_sol_sessions),
      totalExecutions: parseCount(summary.total_executions),
      confirmedExecutions: parseCount(summary.confirmed_executions),
      submittedExecutions: parseCount(summary.submitted_executions),
      preparedExecutions: parseCount(summary.prepared_executions),
      cancelledExecutions: parseCount(summary.cancelled_executions),
      failedExecutions: parseCount(summary.failed_executions),
      totalRealizedPnlUsd,
      confirmedRealizedPnlUsd,
      confirmedRealizedPnlTodayUsd: tradeMetrics.dailyRealizedPnlUsd,
      historicalPnlStatus,
      totalCapturedFeesUsd: parseUsd(summary.total_captured_fees_usd),
      firstSessionAt: toIsoString(summary.first_session_at),
      lastSessionAt: toIsoString(summary.last_session_at),
      lastExecutionAt: toIsoString(summary.last_execution_at),
    },
    tradeMetrics,
    recentActivity: activityResult.rows.map((row) => ({
      at: toIsoString(row.at) ?? new Date(0).toISOString(),
      kind: row.kind,
      sessionId: row.session_id,
      sessionWallet: row.session_wallet,
      status: row.status,
      executionId: row.execution_id,
      signature: row.signature,
      amount: row.amount,
      reason: row.reason,
    })),
    latestSessionInsights: latestInsightResult.rows.map((row) => ({
      sessionId: row.session_id,
      status: row.status,
      sessionWallet: row.session_wallet,
      lastSignal: {
        at: toIsoString(row.signal_at),
        status: row.signal_status,
        regime: row.signal_regime,
        momentumBps: row.signal_momentum_bps,
        guardReason: row.signal_guard_reason,
      },
      lastTradeGate: {
        at: toIsoString(row.gate_at),
        decision: row.gate_decision,
        reason: row.gate_reason,
        expectedEdgeBps: row.gate_expected_edge_bps,
        estimatedCostBps: row.gate_estimated_cost_bps,
        safetyBufferBps: row.gate_safety_buffer_bps,
      },
    })),
    sessionHistory: tradeAnalytics.sessionHistory,
  };
};
