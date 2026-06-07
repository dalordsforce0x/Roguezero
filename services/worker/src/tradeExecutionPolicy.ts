export type TradeDirection = 'exit_long' | 'enter_long';
export type ExitReason = 'take_profit' | 'stop_loss' | 'trailing_stop' | 'signal_reversal' | null;

export type TradeGateAssessment = {
  allowed: boolean;
  reason: string;
  expectedEdgeBps: number;
  estimatedCostBps: number;
  safetyBufferBps: number;
};

export type TrendingEntryShapeMetrics = {
  sampleCount: number;
  windowMomentumBps: number;
  recentSurgeBps: number;
  pullbackFromHighBps: number;
  reclaimFromLowBps: number;
  lastStepMomentumBps: number;
  rangePositionBps: number;
};

export type TrendingEntryShapeGateResult = {
  allowed: boolean;
  reason: string;
  metrics: TrendingEntryShapeMetrics | null;
};

export const shouldForceExitExecution = (
  direction: TradeDirection,
  exitReason: ExitReason,
) => direction === 'exit_long' && exitReason !== null;

export const resolveTradeGateAssessment = (params: {
  direction: TradeDirection;
  exitReason: ExitReason;
  assessment: TradeGateAssessment;
}): TradeGateAssessment => {
  if (!shouldForceExitExecution(params.direction, params.exitReason)) {
    return params.assessment;
  }

  return {
    ...params.assessment,
    allowed: true,
    reason: `exit_trigger_${params.exitReason}`,
  };
};

export const computePrePrepareEntryGate = (params: {
  direction: TradeDirection;
  signalMomentumBps: number | null | undefined;
  signalThresholdBps: number | null | undefined;
  safetyBufferBps: number;
}): TradeGateAssessment | null => {
  if (params.direction !== 'enter_long') {
    return null;
  }

  const signalMagnitudeBps = Math.abs(Number(params.signalMomentumBps ?? 0));
  const thresholdBps = Number(params.signalThresholdBps ?? 0);
  const safetyBufferBps = Number.isFinite(params.safetyBufferBps)
    ? Math.max(0, Math.round(params.safetyBufferBps))
    : 0;
  const expectedEdgeBps = Math.max(0, Math.round(signalMagnitudeBps - thresholdBps));

  // If raw edge cannot clear the safety buffer even before route impact,
  // platform fees, slippage, and network cost are known, it is impossible for
  // the full prepared-trade gate to pass. Skip before /prepare so routine
  // no-edge decisions do not create failed swap_executions rows.
  if (expectedEdgeBps <= safetyBufferBps) {
    return {
      allowed: false,
      reason: 'entry_edge_below_cost',
      expectedEdgeBps,
      estimatedCostBps: 0,
      safetyBufferBps,
    };
  }

  return null;
};

const computePriceMoveBps = (fromPrice: number, toPrice: number): number => {
  if (!Number.isFinite(fromPrice) || !Number.isFinite(toPrice) || fromPrice <= 0) {
    return 0;
  }
  return Math.round(((toPrice - fromPrice) / fromPrice) * 10_000);
};

/**
 * Entry shape gate for Jupiter 1h/trending candidates. Admission answers
 * "is this token routeable/safe enough to consider?"; this answers "are we
 * buying a pullback/reclaim instead of the top of a vertical candle?" Core
 * assets can use the normal strategy gates, but long-tail hot tokens need this
 * extra shape check before the worker prepares a real entry.
 */
export const computeTrendingEntryShapeGate = (params: {
  enabled: boolean;
  prices: readonly number[];
  minSamples: number;
  chaseLookbackSamples: number;
  maxRecentSurgeBps: number;
  minPullbackFromHighBps: number;
  minReclaimFromLowBps: number;
  maxRangePositionBps: number;
  maxNegativeWindowMomentumBps: number;
}): TrendingEntryShapeGateResult => {
  if (!params.enabled) {
    return { allowed: true, reason: 'trending_entry_shape_gate_disabled', metrics: null };
  }

  const prices = params.prices.filter((price) => Number.isFinite(price) && price > 0);
  const minSamples = Math.max(3, Math.floor(params.minSamples));
  if (prices.length < minSamples) {
    return { allowed: false, reason: 'trending_entry_shape_warming_up', metrics: null };
  }

  const window = prices.slice(-minSamples);
  const current = window[window.length - 1];
  const previous = window[window.length - 2] ?? current;
  const first = window[0];
  const high = Math.max(...window);
  const low = Math.min(...window);
  const chaseLookbackSamples = Math.max(2, Math.min(window.length, Math.floor(params.chaseLookbackSamples)));
  const chaseWindow = window.slice(-chaseLookbackSamples);
  const chaseFirst = chaseWindow[0];
  const range = Math.max(0, high - low);
  const metrics: TrendingEntryShapeMetrics = {
    sampleCount: window.length,
    windowMomentumBps: computePriceMoveBps(first, current),
    recentSurgeBps: computePriceMoveBps(chaseFirst, current),
    pullbackFromHighBps: high > 0 ? Math.max(0, Math.round(((high - current) / high) * 10_000)) : 0,
    reclaimFromLowBps: low > 0 ? Math.max(0, Math.round(((current - low) / low) * 10_000)) : 0,
    lastStepMomentumBps: computePriceMoveBps(previous, current),
    rangePositionBps: range > 0 ? Math.round(((current - low) / range) * 10_000) : 10_000,
  };

  const maxNegativeWindowMomentumBps = Math.max(0, Math.round(params.maxNegativeWindowMomentumBps));
  if (metrics.windowMomentumBps < -maxNegativeWindowMomentumBps) {
    return { allowed: false, reason: 'trending_entry_window_broken', metrics };
  }

  if (
    metrics.recentSurgeBps > Math.max(0, Math.round(params.maxRecentSurgeBps))
    && metrics.pullbackFromHighBps < Math.max(0, Math.round(params.minPullbackFromHighBps))
  ) {
    return { allowed: false, reason: 'trending_entry_chasing_vertical', metrics };
  }

  if (metrics.pullbackFromHighBps < Math.max(0, Math.round(params.minPullbackFromHighBps))) {
    return { allowed: false, reason: 'trending_entry_no_pullback', metrics };
  }

  if (metrics.reclaimFromLowBps < Math.max(0, Math.round(params.minReclaimFromLowBps))) {
    return { allowed: false, reason: 'trending_entry_no_reclaim', metrics };
  }

  if (metrics.lastStepMomentumBps <= 0) {
    return { allowed: false, reason: 'trending_entry_reclaim_not_confirmed', metrics };
  }

  if (metrics.rangePositionBps > Math.max(0, Math.round(params.maxRangePositionBps))) {
    return { allowed: false, reason: 'trending_entry_overextended_after_reclaim', metrics };
  }

  return { allowed: true, reason: 'trending_entry_pullback_reclaim', metrics };
};

export const computeFullExitAmountAtomic = (params: {
  walletBalanceAtomic: number;
  reserveAtomic: number;
  positionQuantityAtomic: string | null;
}) => {
  const tradableAtomic = Math.max(0, Math.floor(params.walletBalanceAtomic - params.reserveAtomic));
  if (!params.positionQuantityAtomic || !/^\d+$/.test(params.positionQuantityAtomic)) {
    return tradableAtomic;
  }

  const positionQuantityAtomic = Number(params.positionQuantityAtomic);
  if (!Number.isFinite(positionQuantityAtomic) || positionQuantityAtomic <= 0) {
    return tradableAtomic;
  }

  return Math.max(0, Math.min(tradableAtomic, Math.floor(positionQuantityAtomic)));
};

export const shouldApplyPostExitSolReserveProtection = (params: {
  direction: TradeDirection;
  inputMint: string;
  solMint: string;
}) => params.direction === 'exit_long' && params.inputMint === params.solMint;

export const computeRetryMinimumTradeAmountAtomic = (params: {
  forceExitExecution: boolean;
  minTradeAtomic: number;
}) => {
  if (params.forceExitExecution) {
    return 1;
  }

  return Number.isFinite(params.minTradeAtomic)
    ? Math.max(1, Math.floor(params.minTradeAtomic))
    : 1;
};

export const computeStopLossThresholdBps = (params: {
  configuredStopLossBps: number;
  atrBps: number | null;
  atrStopLossMultiplier: number;
}) => {
  const configuredStopLossBps = Number.isFinite(params.configuredStopLossBps)
    ? Math.max(0, Math.round(params.configuredStopLossBps))
    : 0;
  if (!params.atrBps || params.atrBps <= 0 || !Number.isFinite(params.atrStopLossMultiplier)) {
    return configuredStopLossBps;
  }

  return Math.max(configuredStopLossBps, Math.round(params.atrBps * params.atrStopLossMultiplier));
};

export type GasRefillReason =
  | 'ok'
  | 'sol_above_trigger'
  | 'sol_below_swap_cost'
  | 'no_sol_price'
  | 'no_spendable_usdc'
  | 'slice_below_min'
  | 'already_at_target';

export type GasRefillPlanInput = {
  /** Current native SOL balance, in lamports. */
  solBalanceLamports: number;
  /** Current USDC balance, in atomic units. */
  usdcBalanceAtomic: number;
  /** SOL price in USD used to size the conversion. */
  solUsd: number;
  /** Refill is attempted only when SOL is at or below this lamports floor. */
  triggerLamports: number;
  /** Refill aims to restore SOL up to this comfortable buffer (lamports). */
  targetLamports: number;
  /** Minimum SOL required to afford the refill swap itself (lamports). */
  swapCostLamports: number;
  /** USDC kept untouched so refills never strand trading capital (atomic). */
  minUsdcKeepAtomic: number;
  /** Smallest USDC slice worth converting (atomic). */
  minRefillUsdcAtomic: number;
  /** Slippage/impact headroom multiplier applied to the sized slice (e.g. 1.02). */
  slippageHeadroom: number;
  /** Atomic USDC units per 1 USD (1_000_000). */
  usdcAtomicPerUsd: number;
  /** Lamports per 1 SOL (1_000_000_000). */
  lamportsPerSol: number;
};

export type GasRefillPlan = {
  shouldRefill: boolean;
  usdcToConvertAtomic: number;
  reason: GasRefillReason;
};

/**
 * Pure decision for the SOL gas keep-alive. When a session's SOL fee reserve
 * drains toward the floor while it still holds USDC working capital, this sizes
 * a small USDC->SOL conversion to refill the gas tank instead of letting the
 * session stall/stop with money in the wallet.
 *
 * The refill is intentionally triggered EARLY — only while SOL is still above
 * the cost of the refill swap itself — so the session never reaches the point
 * where it cannot afford the very swap that would save it.
 */
export const computeGasRefillPlan = (input: GasRefillPlanInput): GasRefillPlan => {
  const sol = Math.max(0, Math.floor(input.solBalanceLamports));

  if (sol > input.triggerLamports) {
    return { shouldRefill: false, usdcToConvertAtomic: 0, reason: 'sol_above_trigger' };
  }
  if (sol < input.swapCostLamports) {
    // Too late to refill: cannot afford the conversion swap. True depletion path.
    return { shouldRefill: false, usdcToConvertAtomic: 0, reason: 'sol_below_swap_cost' };
  }
  if (!Number.isFinite(input.solUsd) || input.solUsd <= 0) {
    return { shouldRefill: false, usdcToConvertAtomic: 0, reason: 'no_sol_price' };
  }

  const lamportsNeeded = Math.max(0, input.targetLamports - sol);
  if (lamportsNeeded <= 0) {
    return { shouldRefill: false, usdcToConvertAtomic: 0, reason: 'already_at_target' };
  }

  const spendableUsdcAtomic = Math.max(0, Math.floor(input.usdcBalanceAtomic - input.minUsdcKeepAtomic));
  if (spendableUsdcAtomic <= 0) {
    return { shouldRefill: false, usdcToConvertAtomic: 0, reason: 'no_spendable_usdc' };
  }

  const neededUsd = (lamportsNeeded / input.lamportsPerSol) * input.solUsd;
  const desiredUsdcAtomic = Math.ceil(neededUsd * input.usdcAtomicPerUsd * input.slippageHeadroom);
  const usdcToConvertAtomic = Math.min(desiredUsdcAtomic, spendableUsdcAtomic);

  if (usdcToConvertAtomic < input.minRefillUsdcAtomic) {
    return { shouldRefill: false, usdcToConvertAtomic: 0, reason: 'slice_below_min' };
  }

  return { shouldRefill: true, usdcToConvertAtomic, reason: 'ok' };
};