import { z } from 'zod';

export const schemaVersion = '2026-06-01.1';

export const sessionNetworkValues = ['mainnet-beta', 'devnet'] as const;
export const sessionStatusValues = [
  'awaiting_funding',
  'ready',
  'starting',
  'active',
  'paused',
  'stopping',
  'stopped',
  'settling',
  'error',
] as const;
export const sessionActionValues = ['start', 'pause', 'resume', 'stop'] as const;
export const sessionStopReasonValues = [
  'user_requested',
  'risk_limit_hit',
  'license_invalid',
  'operator_stop',
  'runtime_error',
  'depleted',
  'repeated_simulation_failures',
  'funding_timeout',
  'stale_no_trade_attempts',
  'duration_exceeded',
  'stopped_residual_unrecoverable',
  'operator_cancel_unrequested_zero_funding',
  'worker_stop',
] as const;
export const strategyKeyValues = ['momentum', 'mean_reversion', 'supertrend'] as const;
export const executionStatusValues = ['prepared', 'submitted', 'confirmed', 'failed'] as const;
export const executionConfirmationStatusValues = ['processed', 'confirmed', 'finalized'] as const;

export const sessionNetworkSchema = z.enum(sessionNetworkValues);
export const sessionStatusSchema = z.enum(sessionStatusValues);
export const sessionActionSchema = z.enum(sessionActionValues);
export const sessionStopReasonSchema = z.enum(sessionStopReasonValues);
export const strategyKeySchema = z.enum(strategyKeyValues);
export const executionStatusSchema = z.enum(executionStatusValues);
export const executionConfirmationStatusSchema = z.enum(executionConfirmationStatusValues);
export const sessionPositionStatusValues = ['flat', 'long', 'long_sol'] as const;
export const sessionPositionExitReasonValues = ['take_profit', 'stop_loss', 'trailing_stop', 'signal_reversal'] as const;
export const sessionPositionStatusSchema = z.enum(sessionPositionStatusValues);
export const sessionPositionExitReasonSchema = z.enum(sessionPositionExitReasonValues);

const publicKeySchema = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'Expected a Solana public key');
const isoDatetimeSchema = z.string().datetime({ offset: true });
const atomicAmountSchema = z.string().regex(/^\d+$/, 'Expected an unsigned integer string');
const solMintSchema = z.literal('So11111111111111111111111111111111111111112');

export const sessionRiskLimitsSchema = z.object({
  maxSessionLossUsd: z.number().positive(),
  maxDailyLossUsd: z.number().positive(),
  maxPositionSizeUsd: z.number().positive(),
  maxOpenPositions: z.number().int().positive().max(10),
  maxSlippageBps: z.number().int().min(1).max(500),
  cooldownMs: z.number().int().nonnegative(),
});

export const sessionFundingSchema = z.object({
  fundingMint: publicKeySchema,
  fundingTokenSymbol: z.enum(['SOL', 'USDC', 'USDT']),
  requestedFundingLamports: atomicAmountSchema.default('0'),
  startingBalanceAtomic: atomicAmountSchema,
  currentBalanceAtomic: atomicAmountSchema,
  realizedPnlUsd: z.number(),
  unrealizedPnlUsd: z.number(),
  capturedFeesUsd: z.number().nonnegative(),
});

export const managedStrategySchema = z.object({
  key: strategyKeySchema,
  version: z.string().min(1),
  enabled: z.boolean(),
});

export const DEFAULT_ROTATION_INTERVAL_MINUTES = 15;

export const sessionRotationStateSchema = z.object({
  activeStrategy: strategyKeySchema,
  queuedStrategy: strategyKeySchema,
  rotationIntervalMinutes: z.number().int().positive().default(DEFAULT_ROTATION_INTERVAL_MINUTES),
  lastRotatedAt: isoDatetimeSchema.nullable(),
  lockedUntil: isoDatetimeSchema.nullable(),
});

export const sessionSchedulingStateSchema = z.object({
  lastTradeAttemptedAt: isoDatetimeSchema.nullable(),
  lastTradeSubmittedAt: isoDatetimeSchema.nullable(),
  lastDecisionAt: isoDatetimeSchema.nullable().default(null),
  lastDecisionOutcome: z.enum(['attempted', 'blocked', 'submitted', 'stopped', 'error']).nullable().default(null),
  lastDecisionReason: z.string().nullable().default(null),
  lastBlockedAt: isoDatetimeSchema.nullable().default(null),
  lastBlockedReason: z.string().nullable().default(null),
  blockedReasonCounts: z.record(z.string(), z.number().int().nonnegative()).default({}),
  lastProfitTransferAt: isoDatetimeSchema.nullable().default(null),
  transferredProfitUsd: z.number().nonnegative().default(0),
  pendingProfitPayout: z.object({
    executionId: z.string().uuid(),
    submittedAt: isoDatetimeSchema,
    preRealizedPnlUsd: z.number(),
    exitReason: sessionPositionExitReasonSchema,
    attempts: z.number().int().nonnegative().default(0),
  }).nullable().default(null),
  // Post-stop-loss cooldown locks keyed by correlation-cluster id -> expiry ISO.
  // After a stop_loss exit the cluster is excluded from new entries until expiry
  // so the bot does not immediately re-buy what it just stopped out of.
  recentStopLossLocks: z.record(z.string(), isoDatetimeSchema).default({}),
});

// Stage 3 adaptive sizing — last decision snapshot for admin visibility.
// Lamport amounts are strings to match the funding.*Atomic convention.
export const sessionLastSizingTradeContextSchema = z.object({
  inputMint: publicKeySchema,
  inputSymbol: z.string().min(1).max(32),
  outputMint: publicKeySchema,
  outputSymbol: z.string().min(1).max(32),
  balanceAtomic: atomicAmountSchema,
  reserveAtomic: atomicAmountSchema,
  tradableAtomic: atomicAmountSchema,
  targetAtomic: atomicAmountSchema,
  minTradeAtomic: atomicAmountSchema,
  maxTradeAtomic: atomicAmountSchema,
  amountAtomic: atomicAmountSchema.nullable(),
  riskAdjustedAmountAtomic: atomicAmountSchema.nullable(),
});

export const sessionLastSizingSchema = z.object({
  at: isoDatetimeSchema,
  decision: z.enum(['traded', 'skipped']),
  reason: z.string().nullable().default(null),
  balanceLamports: z.string(),
  reserveLamports: z.string(),
  tradableLamports: z.string(),
  fractionBps: z.number().int().nonnegative(),
  targetLamports: z.string(),
  minTradeLamports: z.string(),
  maxTradeLamports: z.string(),
  amountLamports: z.string().nullable().default(null),
  remainingRiskBudgetUsd: z.number().nonnegative().nullable().default(null),
  quotedOutAmountAtomic: z.string().nullable().default(null),
  minimumOutputAtomic: z.string().nullable().default(null),
  priceImpactPct: z.string().nullable().default(null),
  estimatedNetworkCostLamports: z.string().nullable().default(null),
  estimatedNetworkCostOutputAtomic: z.string().nullable().default(null),
  worstCaseSlippageOutputAtomic: z.string().nullable().default(null),
  totalWorstCaseCostOutputAtomic: z.string().nullable().default(null),
  riskAdjustedAmountLamports: z.string().nullable().default(null),
  tradeContext: sessionLastSizingTradeContextSchema.optional(),
});

export const sessionLastSignalSchema = z.object({
  at: isoDatetimeSchema,
  source: z.enum(['pyth-hermes']),
  signal: z.literal('momentum'),
  // The strategy that actually produced this signal. `signal` stays the legacy
  // literal for backward compatibility; `strategy` is the real identity so UIs
  // stop showing every strategy as "momentum". Optional for older persisted rows.
  strategy: strategyKeySchema.optional(),
  status: z.enum(['warming_up', 'ready', 'guarded_off']),
  regime: z.enum(['bullish', 'bearish', 'flat']).nullable(),
  lookbackSamples: z.number().int().positive(),
  thresholdBps: z.number().int().positive(),
  momentumBps: z.number().int().nullable(),
  guardReason: z.string().nullable(),
});

export const sessionLastTradeGateSchema = z.object({
  at: isoDatetimeSchema,
  decision: z.enum(['allowed', 'blocked']),
  reason: z.string(),
  expectedEdgeBps: z.number().nullable(),
  estimatedCostBps: z.number().nullable(),
  safetyBufferBps: z.number().nullable(),
  scout: z.object({
    candidateCount: z.number().int().nonnegative(),
    routeFoundCount: z.number().int().nonnegative(),
    bullishRouteCount: z.number().int().nonnegative(),
    persistentBullishRouteCount: z.number().int().nonnegative(),
    bestMint: publicKeySchema.nullable(),
    bestSymbol: z.string().min(1).max(32).nullable(),
    bestMomentumBps: z.number().int().nullable(),
    bestPriceImpactBps: z.number().nullable(),
  }).optional(),
});

export const sessionRiskStateSchema = z.object({
  dayKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dailyRealizedPnlUsd: z.number().default(0),
  consecutiveLosses: z.number().int().nonnegative().default(0),
  badFillStreak: z.number().int().nonnegative().default(0),
  lastLossAt: isoDatetimeSchema.nullable().default(null),
  lastBadFillAt: isoDatetimeSchema.nullable().default(null),
});

export const sessionLastExecutionAuditSchema = z.object({
  at: isoDatetimeSchema,
  executionId: z.string().uuid(),
  direction: z.enum(['enter_long', 'exit_long', 'other']),
  inputMint: publicKeySchema,
  outputMint: publicKeySchema,
  inputAmountAtomic: atomicAmountSchema,
  expectedOutputAtomic: atomicAmountSchema.nullable(),
  actualOutputAtomic: atomicAmountSchema.nullable(),
  outputDeltaBps: z.number().int().nullable(),
  priceImpactBps: z.number().nullable(),
  badFill: z.boolean(),
});

export const sessionHealthStateSchema = z.object({
  state: z.enum([
    'active_trading',
    'waiting_market',
    'blocked',
    'at_capacity',
    'exit_blocked',
    'gas_danger',
    'recovery_required',
    'stopping',
    'stopped',
    'error',
  ]),
  severity: z.enum(['info', 'warn', 'error']),
  reason: z.string().nullable().default(null),
  detail: z.string().nullable().default(null),
  updatedAt: isoDatetimeSchema,
  blockerCount: z.number().int().nonnegative().default(0),
});

export const sessionExitEvaluationSchema = z.object({
  at: isoDatetimeSchema,
  mint: publicKeySchema,
  symbol: z.string().min(1).max(32),
  tokenClass: z.enum(['major', 'sol_beta', 'trend_liquid', 'long_tail']),
  strategy: strategyKeySchema,
  shouldExit: z.boolean(),
  reason: sessionPositionExitReasonSchema,
  pnlBps: z.number().int().nullable(),
  trailingDrawdownBps: z.number().int().nullable(),
  maxFavorableBps: z.number().int().nullable().default(null),
  maxAdverseBps: z.number().int().nullable().default(null),
  entryPriceUsd: z.number().positive().nullable(),
  markPriceUsd: z.number().positive().nullable(),
  highWaterPriceUsd: z.number().positive().nullable(),
  thresholds: z.object({
    takeProfitBps: z.number().int().nonnegative(),
    stopLossBps: z.number().int().nonnegative(),
    trailingStopBps: z.number().int().nonnegative(),
    atrBps: z.number().int().positive().nullable(),
    costFloorBps: z.number().int().nonnegative(),
    mode: z.enum(['atr', 'fallback']),
  }),
  signalStatus: z.enum(['warming_up', 'ready', 'guarded_off']),
  signalRegime: z.enum(['bullish', 'bearish', 'flat']).nullable(),
  signalMomentumBps: z.number().int().nullable(),
  pendingExitReason: sessionPositionExitReasonSchema.nullable(),
});

export const sessionAdaptiveExitShadowSchema = z.object({
  at: isoDatetimeSchema,
  enabled: z.boolean(),
  mode: z.literal('shadow'),
  canarySessionId: z.string().uuid().nullable().default(null),
  decisions: z.array(z.object({
    mint: publicKeySchema,
    symbol: z.string().min(1).max(32),
    tokenClass: z.enum(['major', 'sol_beta', 'trend_liquid', 'long_tail']),
    action: z.enum(['hold', 'partial_take_profit', 'protect_breakeven', 'trail_runner', 'full_exit']),
    reason: z.string().min(1).max(160),
    pnlBps: z.number().int().nullable(),
    maxFavorableBps: z.number().int().nullable().default(null),
    maxAdverseBps: z.number().int().nullable().default(null),
    suggestedSellBps: z.number().int().min(0).max(10000).default(0),
    suggestedStopBps: z.number().int().nullable().default(null),
  })).default([]),
});

export const sessionGridChopShadowSchema = z.object({
  at: isoDatetimeSchema,
  enabled: z.boolean(),
  mode: z.literal('shadow'),
  canarySessionId: z.string().uuid().nullable().default(null),
  marketRegime: z.enum(['chop', 'trend', 'unknown']),
  reason: z.string().min(1).max(160),
  candidates: z.array(z.object({
    mint: publicKeySchema,
    symbol: z.string().min(1).max(32),
    tokenClass: z.enum(['major', 'sol_beta', 'trend_liquid', 'long_tail']),
    action: z.enum([
      'grid_hold',
      'grid_buy_zone',
      'grid_sell_zone',
      'grid_disabled',
      'grid_warmup',
      'grid_range_too_tight',
      'grid_range_too_wide_trending',
      'grid_breakout_no_chase',
      'grid_breakdown_no_buy',
    ]),
    pnlBps: z.number().int().nullable(),
    drawdownBps: z.number().int().nullable(),
    reason: z.string().min(1).max(160),
  })).default([]),
});

export const sessionPositionStateSchema = z.object({
  status: sessionPositionStatusSchema,
  positionMint: publicKeySchema.nullable().default(null),
  positionSymbol: z.string().min(1).max(32).nullable().default(null),
  entryStrategy: strategyKeySchema.nullable().default(null),
  entryPriceUsd: z.number().positive().nullable().default(null),
  entryAt: isoDatetimeSchema.nullable().default(null),
  quantityAtomic: atomicAmountSchema.nullable().default(null),
  tokenDecimals: z.number().int().min(0).max(18).nullable().default(null),
  highWaterPriceUsd: z.number().positive().nullable().default(null),
  lastMarkedPriceUsd: z.number().positive().nullable().default(null),
  lastMarkedAt: isoDatetimeSchema.nullable().default(null),
  lastComputedAtrUsd: z.number().positive().nullable().default(null),
  lastComputedAtrBps: z.number().int().positive().nullable().default(null),
  atrComputedAt: isoDatetimeSchema.nullable().default(null),
  maxFavorableBps: z.number().int().nullable().default(null),
  maxFavorableAt: isoDatetimeSchema.nullable().default(null),
  maxAdverseBps: z.number().int().nullable().default(null),
  maxAdverseAt: isoDatetimeSchema.nullable().default(null),
  // Entry-quality score (0..100) and band captured at the moment this position
  // was opened, so the realized adverse excursion (maxAdverseBps) can later be
  // correlated against entry quality. Shadow/diagnostic only; null when unscored.
  entryQualityScore: z.number().int().min(0).max(100).nullable().default(null),
  entryQualityBand: z.enum(['strong', 'fair', 'weak', 'reject']).nullable().default(null),
  pendingExitReason: sessionPositionExitReasonSchema.nullable().default(null),
  exitReason: sessionPositionExitReasonSchema.nullable().default(null),
  partialExitDone: z.boolean().default(false),
});

export const sessionPositionsStateSchema = z.object({
  activePositionMint: publicKeySchema.nullable().default(null),
  positions: z.record(publicKeySchema, sessionPositionStateSchema).default({}),
});

export const momentumStrategyConfigSchema = z.object({
  lookbackSamples: z.number().int().min(1).max(120),
  thresholdBps: z.number().int().min(1).max(500),
  edgeSafetyBufferBps: z.number().int().min(0).max(500),
});

export const meanReversionStrategyConfigSchema = z.object({
  length: z.number().int().min(2).max(200),
  stdMultiplier: z.number().positive().max(10),
  minBandWidthFraction: z.number().positive().max(1),
  entryThreshold: z.number().min(-5).max(5),
  exitThreshold: z.number().min(-5).max(5),
});

export const supertrendStrategyConfigSchema = z.object({
  candleSamples: z.number().int().min(2).max(120),
  atrPeriod: z.number().int().min(2).max(200),
  multiplier: z.number().positive().max(20),
});

export const sessionStrategyConfigSchema = z.object({
  autoRotationEnabled: z.boolean().default(true),
  momentum: momentumStrategyConfigSchema,
  meanReversion: meanReversionStrategyConfigSchema,
  supertrend: supertrendStrategyConfigSchema,
});

export const sessionUserControlSchema = z.object({
  targetDurationMinutes: z.number().int().nonnegative().max(1440),
  autoRestart: z.boolean().default(false),
  stopLossBehavior: z.enum(['pause', 'stop']),
  profitHandling: z.object({
    mode: z.enum(['send_to_owner', 'compound']).default('send_to_owner'),
    payoutToken: z.enum(['SOL', 'USDC']).default('USDC'),
  }).default({
    mode: 'send_to_owner',
    payoutToken: 'USDC',
  }),
  // How to handle still-open positions when the user stops the session. The session
  // wallet is destroyed after stop, so funds must come home one of two ways:
  //  - 'return_tokens': leave positions open and sweep the raw SPL tokens to the owner wallet (default)
  //  - 'liquidate': prematurely close (sell) open positions to SOL first, then sweep the proceeds home
  stopDisposition: z.enum(['return_tokens', 'liquidate']).default('return_tokens'),
});

export const sessionServiceControlSchema = z.object({
  executionVenue: z.literal('jupiter'),
  rpcProvider: z.literal('helius'),
  platformFeeBps: z.number().int().min(0).max(1000),
  strategyUniverse: z.tuple([
    managedStrategySchema,
    managedStrategySchema,
    managedStrategySchema,
  ]),
  rotationState: sessionRotationStateSchema,
  schedulingState: sessionSchedulingStateSchema.optional(),
  strategyConfig: sessionStrategyConfigSchema.optional(),
  lastSizing: sessionLastSizingSchema.optional(),
  lastSignal: sessionLastSignalSchema.optional(),
  lastTradeGate: sessionLastTradeGateSchema.optional(),
  riskState: sessionRiskStateSchema.optional(),
  lastExecutionAudit: sessionLastExecutionAuditSchema.optional(),
  healthState: sessionHealthStateSchema.optional(),
  lastExitEvaluations: z.array(sessionExitEvaluationSchema).optional(),
  lastExitEvaluation: z.union([sessionExitEvaluationSchema, z.array(sessionExitEvaluationSchema)]).optional(),
  adaptiveExitShadow: sessionAdaptiveExitShadowSchema.optional(),
  gridChopShadow: sessionGridChopShadowSchema.optional(),
  positionsState: sessionPositionsStateSchema.optional(),
  positionState: sessionPositionStateSchema.optional(),
  // Set when a session finalizes to `stopped` but the session wallet could not be
  // fully swept because it has insufficient SOL to pay even one transaction fee
  // (fee-payer bricked). Records the trapped token accounts so the owner/admin can
  // run a fee-sponsored recovery instead of the worker looping forever in `stopping`.
  residualRecovery: z.object({
    state: z.literal('unrecoverable_zero_gas'),
    sessionWallet: z.string(),
    ownerWallet: z.string(),
    solBalance: z.number().int().min(0),
    residualTokenAccounts: z.array(z.string()),
    detectedAt: z.string(),
    note: z.string(),
  }).optional(),
});

export type SessionServiceControl = z.infer<typeof sessionServiceControlSchema>;
export type SessionPositionsState = z.infer<typeof sessionPositionsStateSchema>;
export type SessionPositionState = z.infer<typeof sessionPositionStateSchema>;
export type SessionServiceControlPatch = Partial<Omit<SessionServiceControl, 'positionState' | 'positionsState' | 'schedulingState'>> & {
  positionsState?: SessionPositionsState;
  positionState?: Partial<NonNullable<SessionServiceControl['positionState']>>;
  schedulingState?: Partial<NonNullable<SessionServiceControl['schedulingState']>>;
};

const defaultSessionPositionState: NonNullable<SessionServiceControl['positionState']> = {
  status: 'flat',
  positionMint: null,
  positionSymbol: null,
  entryStrategy: null,
  entryPriceUsd: null,
  entryAt: null,
  quantityAtomic: null,
  tokenDecimals: null,
  highWaterPriceUsd: null,
  lastMarkedPriceUsd: null,
  lastMarkedAt: null,
  lastComputedAtrUsd: null,
  lastComputedAtrBps: null,
  atrComputedAt: null,
  maxFavorableBps: null,
  maxFavorableAt: null,
  maxAdverseBps: null,
  maxAdverseAt: null,
  entryQualityScore: null,
  entryQualityBand: null,
  pendingExitReason: null,
  exitReason: null,
  partialExitDone: false,
};

const defaultSessionPositionsState: SessionPositionsState = {
  activePositionMint: null,
  positions: {},
};

const defaultSessionSchedulingState: NonNullable<SessionServiceControl['schedulingState']> = {
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
};

const defaultSessionRotationState: NonNullable<SessionServiceControl['rotationState']> = {
  activeStrategy: 'momentum',
  queuedStrategy: 'momentum',
  rotationIntervalMinutes: DEFAULT_ROTATION_INTERVAL_MINUTES,
  lastRotatedAt: null,
  lockedUntil: null,
};

export const buildFlatSessionPositionState = (
  fallback: Partial<SessionPositionState> = {},
): SessionPositionState => ({
  ...defaultSessionPositionState,
  ...fallback,
  status: 'flat',
  positionMint: null,
  positionSymbol: null,
  entryPriceUsd: null,
  entryAt: null,
  quantityAtomic: null,
  highWaterPriceUsd: null,
  pendingExitReason: fallback.pendingExitReason ?? null,
  exitReason: fallback.exitReason ?? null,
});

export const getPrimaryOpenSessionPosition = (
  positionsState: SessionPositionsState | null | undefined,
): SessionPositionState | null => {
  if (!positionsState) {
    return null;
  }

  const preferredMint = positionsState.activePositionMint;
  if (preferredMint) {
    const preferred = positionsState.positions[preferredMint];
    if (preferred && preferred.status !== 'flat') {
      return preferred;
    }
  }

  for (const position of Object.values(positionsState.positions)) {
    if (position.status !== 'flat') {
      return position;
    }
  }

  return null;
};

export const summarizePositionsState = (
  positionsState: SessionPositionsState | null | undefined,
  fallback: Partial<SessionPositionState> = {},
): SessionPositionState => {
  const primary = getPrimaryOpenSessionPosition(positionsState);
  return primary
    ? { ...primary }
    : buildFlatSessionPositionState(fallback);
};

export const mergeSessionServiceControl = (
  base: SessionServiceControl,
  patch: SessionServiceControlPatch,
): SessionServiceControl => ({
  ...base,
  ...patch,
  rotationState: patch.rotationState === undefined
    ? base.rotationState
    : {
        ...(base.rotationState ?? defaultSessionRotationState),
        ...patch.rotationState,
      },
  positionsState: patch.positionsState === undefined
    ? base.positionsState
    : {
        ...defaultSessionPositionsState,
        ...patch.positionsState,
      },
  positionState: patch.positionState === undefined
    ? base.positionState
    : {
        ...(base.positionState ?? defaultSessionPositionState),
        ...patch.positionState,
      },
  schedulingState: patch.schedulingState === undefined
    ? base.schedulingState
    : {
        ...(base.schedulingState ?? defaultSessionSchedulingState),
        ...patch.schedulingState,
      },
});

export const sessionSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().min(1),
  keyAuthUserId: z.string().min(1),
  licenseId: z.string().min(1),
  ownerWallet: publicKeySchema,
  sessionWallet: publicKeySchema,
  network: sessionNetworkSchema,
  status: sessionStatusSchema,
  requestedAt: isoDatetimeSchema,
  startedAt: isoDatetimeSchema.nullable(),
  endedAt: isoDatetimeSchema.nullable(),
  stopReason: sessionStopReasonSchema.nullable(),
  userControl: sessionUserControlSchema,
  serviceControl: sessionServiceControlSchema,
  riskLimits: sessionRiskLimitsSchema,
  funding: sessionFundingSchema,
  createdBy: z.enum(['user', 'admin', 'system']),
  notes: z.string().max(500).nullable(),
});

export const createSessionRequestSchema = z.object({
  userId: z.string().min(1),
  keyAuthUserId: z.string().min(1),
  licenseId: z.string().min(1),
  ownerWallet: publicKeySchema,
  // Live worker funding + execution flow is currently SOL-only.
  fundingMint: solMintSchema,
  fundingTokenSymbol: z.literal('SOL'),
  startingBalanceAtomic: atomicAmountSchema.default('0'),
  targetDurationMinutes: z.number().int().nonnegative().max(1440).default(0),
  riskLimits: sessionRiskLimitsSchema.default({
    maxSessionLossUsd: 50,
    maxDailyLossUsd: 100,
    maxPositionSizeUsd: 1000,
    maxOpenPositions: 10,
    maxSlippageBps: 50,
    cooldownMs: 30000,
  }),
  stopLossBehavior: z.enum(['pause', 'stop']).default('stop'),
  profitHandling: z.object({
    mode: z.enum(['send_to_owner', 'compound']).default('send_to_owner'),
    payoutToken: z.enum(['SOL', 'USDC']).default('USDC'),
  }).default({
    mode: 'send_to_owner',
    payoutToken: 'USDC',
  }),
});

export const sessionActionRequestSchema = z.object({
  sessionId: z.string().uuid(),
  action: sessionActionSchema,
  requestedBy: z.enum(['user', 'admin', 'system']),
  requestedAt: isoDatetimeSchema,
});

export const sessionEventSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  eventType: z.enum([
    'session_created',
    'session_started',
    'session_paused',
    'session_resumed',
    'session_stopped',
    'strategy_rotated',
    'risk_limit_triggered',
    'trade_executed',
    'fee_captured',
    'runtime_error',
  ]),
  occurredAt: isoDatetimeSchema,
  payload: z.record(z.unknown()),
});

export const swapExecutionSimulationSchema = z.object({
  err: z.unknown().nullable(),
  unitsConsumed: z.number().int().nonnegative().nullable(),
  logs: z.array(z.string()),
});

export const swapExecutionSchema = z.object({
  id: z.string().uuid(),
  swapPath: z.literal('/build'),
  status: executionStatusSchema,
  inputMint: publicKeySchema,
  outputMint: publicKeySchema,
  amount: atomicAmountSchema,
  taker: publicKeySchema,
  feeTokenSymbol: z.enum(['SOL', 'USDC', 'USDT']),
  feeAccount: publicKeySchema,
  platformFeeBps: z.number().int().min(0).max(1000),
  blockhash: z.string().min(1).nullable(),
  lastValidBlockHeight: z.number().int().nonnegative().nullable(),
  recommendedComputeUnitLimit: z.number().int().positive().nullable(),
  preparedTransactionBase64: z.string().min(1).nullable(),
  signature: z.string().min(1).nullable(),
  confirmationStatus: executionConfirmationStatusSchema.nullable(),
  simulation: swapExecutionSimulationSchema,
  build: z.record(z.unknown()),
  confirmation: z.record(z.unknown()).nullable(),
  signatureStatus: z.record(z.unknown()).nullable(),
  lastError: z.record(z.unknown()).nullable(),
  metadata: z.object({
    scannerStrategy: strategyKeySchema.nullable().default(null),
    entryStrategy: strategyKeySchema.nullable().default(null),
    exitStrategy: strategyKeySchema.nullable().default(null),
    exitReason: sessionPositionExitReasonSchema.nullable().default(null),
  }).default({
    scannerStrategy: null,
    entryStrategy: null,
    exitStrategy: null,
    exitReason: null,
  }),
  preparedAt: isoDatetimeSchema,
  submittedAt: isoDatetimeSchema.nullable(),
  confirmedAt: isoDatetimeSchema.nullable(),
  createdAt: isoDatetimeSchema,
  updatedAt: isoDatetimeSchema,
});

export type Session = z.infer<typeof sessionSchema>;
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;
export type SessionActionRequest = z.infer<typeof sessionActionRequestSchema>;
export type SessionEvent = z.infer<typeof sessionEventSchema>;
export type SwapExecution = z.infer<typeof swapExecutionSchema>;
