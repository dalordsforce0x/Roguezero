import { z } from 'zod';

export const schemaVersion = '2026-05-29.2';

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

const publicKeySchema = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'Expected a Solana public key');
const isoDatetimeSchema = z.string().datetime();
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

export const sessionRotationStateSchema = z.object({
  activeStrategy: strategyKeySchema,
  queuedStrategy: strategyKeySchema,
  rotationIntervalMinutes: z.number().int().positive().default(60),
  lastRotatedAt: isoDatetimeSchema.nullable(),
  lockedUntil: isoDatetimeSchema.nullable(),
});

export const sessionSchedulingStateSchema = z.object({
  lastTradeAttemptedAt: isoDatetimeSchema.nullable(),
  lastTradeSubmittedAt: isoDatetimeSchema.nullable(),
});

// Stage 3 adaptive sizing — last decision snapshot for admin visibility.
// Lamport amounts are strings to match the funding.*Atomic convention.
export const sessionLastSizingTradeContextSchema = z.object({
  inputMint: publicKeySchema,
  inputSymbol: z.enum(['SOL', 'USDC', 'USDT']),
  outputMint: publicKeySchema,
  outputSymbol: z.enum(['SOL', 'USDC', 'USDT']),
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
});

export const sessionPositionStateSchema = z.object({
  status: z.enum(['flat', 'long_sol']),
  entryPriceUsd: z.number().positive().nullable().default(null),
  entryAt: isoDatetimeSchema.nullable().default(null),
  quantityAtomic: atomicAmountSchema.nullable().default(null),
  highWaterPriceUsd: z.number().positive().nullable().default(null),
  lastMarkedPriceUsd: z.number().positive().nullable().default(null),
  lastMarkedAt: isoDatetimeSchema.nullable().default(null),
  pendingExitReason: z.enum(['take_profit', 'stop_loss', 'trailing_stop', 'signal_reversal']).nullable().default(null),
  exitReason: z.enum(['take_profit', 'stop_loss', 'trailing_stop', 'signal_reversal']).nullable().default(null),
});

export const sessionUserControlSchema = z.object({
  targetDurationMinutes: z.number().int().positive().max(1440),
  autoRestart: z.boolean().default(false),
  stopLossBehavior: z.enum(['pause', 'stop']),
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
  lastSizing: sessionLastSizingSchema.optional(),
  lastSignal: sessionLastSignalSchema.optional(),
  lastTradeGate: sessionLastTradeGateSchema.optional(),
  positionState: sessionPositionStateSchema.optional(),
});

export type SessionServiceControl = z.infer<typeof sessionServiceControlSchema>;
export type SessionServiceControlPatch = Partial<Omit<SessionServiceControl, 'positionState' | 'schedulingState'>> & {
  positionState?: Partial<NonNullable<SessionServiceControl['positionState']>>;
  schedulingState?: Partial<NonNullable<SessionServiceControl['schedulingState']>>;
};

const defaultSessionPositionState: NonNullable<SessionServiceControl['positionState']> = {
  status: 'flat',
  entryPriceUsd: null,
  entryAt: null,
  quantityAtomic: null,
  highWaterPriceUsd: null,
  lastMarkedPriceUsd: null,
  lastMarkedAt: null,
  pendingExitReason: null,
  exitReason: null,
};

const defaultSessionSchedulingState: NonNullable<SessionServiceControl['schedulingState']> = {
  lastTradeAttemptedAt: null,
  lastTradeSubmittedAt: null,
};

const defaultSessionRotationState: NonNullable<SessionServiceControl['rotationState']> = {
  activeStrategy: 'momentum',
  queuedStrategy: 'momentum',
  rotationIntervalMinutes: 60,
  lastRotatedAt: null,
  lockedUntil: null,
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
  targetDurationMinutes: z.number().int().positive().max(1440).default(60),
  riskLimits: sessionRiskLimitsSchema.default({
    maxSessionLossUsd: 50,
    maxDailyLossUsd: 100,
    maxPositionSizeUsd: 20,
    maxOpenPositions: 1,
    maxSlippageBps: 50,
    cooldownMs: 30000,
  }),
  stopLossBehavior: z.enum(['pause', 'stop']).default('stop'),
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
