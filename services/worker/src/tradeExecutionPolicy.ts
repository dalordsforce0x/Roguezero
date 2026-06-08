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
  estimatedCostBps?: number | null;
}): TradeGateAssessment | null => {
  if (params.direction !== 'enter_long') {
    return null;
  }

  const signalMagnitudeBps = Math.abs(Number(params.signalMomentumBps ?? 0));
  const thresholdBps = Number(params.signalThresholdBps ?? 0);
  const safetyBufferBps = Number.isFinite(params.safetyBufferBps)
    ? Math.max(0, Math.round(params.safetyBufferBps))
    : 0;
  const estimatedCostBps = Number.isFinite(Number(params.estimatedCostBps))
    ? Math.max(0, Math.round(Number(params.estimatedCostBps)))
    : 0;
  const expectedEdgeBps = Math.max(0, Math.round(signalMagnitudeBps - thresholdBps));

  // Honest round-trip hurdle: the expected edge must clear the modeled cost of
  // entering AND exiting (both legs' slippage + platform fee) plus a safety
  // margin. When estimatedCostBps is omitted this falls back to the legacy
  // safety-buffer-only behavior. Blocking here skips /prepare so routine
  // no-edge decisions do not create failed swap_executions rows.
  const requiredEdgeBps = estimatedCostBps + safetyBufferBps;
  if (expectedEdgeBps <= requiredEdgeBps) {
    return {
      allowed: false,
      reason: 'entry_edge_below_cost',
      expectedEdgeBps,
      estimatedCostBps,
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

export type EntryQualityBand = 'strong' | 'fair' | 'weak' | 'reject';

export type EntryQualityComponents = {
  // Each component is 0..1, higher = better entry. They are diagnostic so we can
  // see WHICH factor drove a score when we correlate score vs realized MAE.
  pullback: number;
  reclaim: number;
  rangePosition: number;
  surgeRestraint: number;
  regimeAlignment: number;
  liquidity: number;
};

export type EntryQualityScoreResult = {
  // 0..100 composite. Higher = a better-timed entry (buying a reclaimed pullback
  // with room, deep liquidity, regime-aligned) instead of chasing a local top.
  score: number;
  band: EntryQualityBand;
  wouldEnter: boolean;
  components: EntryQualityComponents;
  metrics: TrendingEntryShapeMetrics | null;
  reason: string;
};

const clamp01 = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
};

/**
 * Entry-quality score (shadow-first). The 24h MFE/MAE data showed every token
 * class goes roughly -70 bps adverse right after entry, i.e. we systematically
 * buy local tops / chase. This grades the SAME shape primitives the trending
 * shape gate already computes, but (a) across every class (majors/SOL included,
 * which currently bypass the hard shape gate yet still bleed), (b) as a graded
 * 0..100 score instead of pass/fail, and (c) returning component breakdown so we
 * can measure which factor predicts a lower adverse excursion before we ever let
 * the score gate a live entry.
 *
 * Pure: no execution, no side effects. Caller decides whether to act on it.
 */
export const computeEntryQualityScore = (params: {
  prices: readonly number[];
  minSamples: number;
  chaseLookbackSamples: number;
  regime: 'chop' | 'trend' | 'unknown' | null;
  priceImpactBps: number | null;
  // Sweet-spot pullback depth from the local high (bps). Below idealPullbackBps
  // we reward more pullback; far beyond it we treat it as a falling knife.
  idealPullbackBps: number;
  maxHealthyPullbackBps: number;
  // Liquidity penalty scaling: priceImpactBps at/above this scores 0 liquidity.
  maxHealthyPriceImpactBps: number;
  // Score thresholds for banding.
  strongScore: number;
  fairScore: number;
  // wouldEnter is true when score >= enterThreshold (shadow recommendation).
  enterThreshold: number;
  weights?: Partial<EntryQualityComponents>;
}): EntryQualityScoreResult => {
  const emptyComponents: EntryQualityComponents = {
    pullback: 0,
    reclaim: 0,
    rangePosition: 0,
    surgeRestraint: 0,
    regimeAlignment: 0,
    liquidity: 0,
  };

  const prices = params.prices.filter((price) => Number.isFinite(price) && price > 0);
  const minSamples = Math.max(3, Math.floor(params.minSamples));
  if (prices.length < minSamples) {
    return {
      score: 0,
      band: 'reject',
      wouldEnter: false,
      components: emptyComponents,
      metrics: null,
      reason: 'entry_quality_warming_up',
    };
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
    // When the window has no real range (flat/stale tape) the position is
    // undefined, not "at the top". Default to the neutral midpoint (5000) so a
    // dead tape is not falsely scored as buying a local high (which the old
    // 10_000 default did, tanking rangePosition to 0 and skewing the score).
    rangePositionBps: range > 0 ? Math.round(((current - low) / range) * 10_000) : 5_000,
  };

  const idealPullbackBps = Math.max(1, Math.round(params.idealPullbackBps));
  const maxHealthyPullbackBps = Math.max(idealPullbackBps + 1, Math.round(params.maxHealthyPullbackBps));

  // Pullback: 0 at the high, ramps to 1 at the ideal pullback depth, then decays
  // back toward 0 as it becomes a falling knife beyond maxHealthyPullback.
  const pullback = metrics.pullbackFromHighBps <= idealPullbackBps
    ? clamp01(metrics.pullbackFromHighBps / idealPullbackBps)
    : clamp01(1 - (metrics.pullbackFromHighBps - idealPullbackBps) / (maxHealthyPullbackBps - idealPullbackBps));

  // Reclaim: needs to be off the low AND ticking up on the last step (confirmed).
  const reclaimMagnitude = clamp01(metrics.reclaimFromLowBps / idealPullbackBps);
  const reclaim = metrics.lastStepMomentumBps > 0 ? reclaimMagnitude : reclaimMagnitude * 0.25;

  // Range position: best entries sit in the lower-middle of the range; buying the
  // very top (10000) scores 0, the very bottom is fine but may be a knife so we
  // peak around the lower third.
  const rangePos01 = clamp01(metrics.rangePositionBps / 10_000);
  const rangePosition = clamp01(1 - Math.abs(rangePos01 - 0.33) / 0.67);

  // Surge restraint: penalize chasing a vertical recent surge with no pullback.
  const surgeRestraint = clamp01(1 - Math.max(0, metrics.recentSurgeBps) / Math.max(1, idealPullbackBps * 4));

  // Regime alignment: in a trend, a modest positive window momentum (buying a dip
  // in an uptrend) is good; in chop, near-flat/slightly-negative window with a
  // reclaim is good. Unknown regime gets a neutral 0.5.
  let regimeAlignment = 0.5;
  if (params.regime === 'trend') {
    regimeAlignment = metrics.windowMomentumBps >= 0 ? 0.85 : 0.35;
  } else if (params.regime === 'chop') {
    regimeAlignment = Math.abs(metrics.windowMomentumBps) <= idealPullbackBps * 2 ? 0.8 : 0.4;
  }

  // Liquidity: deep liquidity (low price impact) scores 1; at/above the max
  // healthy impact it scores 0. Null impact is treated as neutral 0.5 (unknown).
  const maxHealthyPriceImpactBps = Math.max(1, Math.round(params.maxHealthyPriceImpactBps));
  const liquidity = params.priceImpactBps === null
    ? 0.5
    : clamp01(1 - Math.max(0, params.priceImpactBps) / maxHealthyPriceImpactBps);

  const components: EntryQualityComponents = {
    pullback,
    reclaim,
    rangePosition,
    surgeRestraint,
    regimeAlignment,
    liquidity,
  };

  const defaultWeights: EntryQualityComponents = {
    pullback: 0.22,
    reclaim: 0.22,
    rangePosition: 0.18,
    surgeRestraint: 0.16,
    regimeAlignment: 0.12,
    liquidity: 0.10,
  };
  const weights: EntryQualityComponents = { ...defaultWeights, ...(params.weights ?? {}) };
  const weightTotal = Object.values(weights).reduce((sum, w) => sum + (Number.isFinite(w) ? w : 0), 0) || 1;

  const weighted = (components.pullback * weights.pullback)
    + (components.reclaim * weights.reclaim)
    + (components.rangePosition * weights.rangePosition)
    + (components.surgeRestraint * weights.surgeRestraint)
    + (components.regimeAlignment * weights.regimeAlignment)
    + (components.liquidity * weights.liquidity);

  const score = Math.max(0, Math.min(100, Math.round((weighted / weightTotal) * 100)));

  const strongScore = Math.max(0, Math.min(100, Math.round(params.strongScore)));
  const fairScore = Math.max(0, Math.min(strongScore, Math.round(params.fairScore)));
  const enterThreshold = Math.max(0, Math.min(100, Math.round(params.enterThreshold)));

  let band: EntryQualityBand = 'reject';
  if (score >= strongScore) band = 'strong';
  else if (score >= fairScore) band = 'fair';
  else if (score >= Math.round(fairScore / 2)) band = 'weak';

  return {
    score,
    band,
    wouldEnter: score >= enterThreshold,
    components,
    metrics,
    reason: `entry_quality_${band}`,
  };
};

/**
 * Cheap chop-vs-trend classifier for the entry-quality score's regimeAlignment
 * component. Uses the Kaufman-style efficiency ratio: net directional move over
 * the window divided by the summed absolute path length. A high ratio means the
 * tape went somewhere in a straight line (trend); a low ratio means it oscillated
 * without net progress (chop). A perfectly flat tape has no path and is treated
 * as chop (no trend to align with). Returns 'unknown' until enough samples exist.
 *
 * Pure: no side effects.
 */
export const classifyTapeRegime = (params: {
  prices: readonly number[];
  minSamples: number;
  // Efficiency ratio (0..1) at/above which the window is considered a trend.
  trendEfficiencyThreshold: number;
}): 'chop' | 'trend' | 'unknown' => {
  const prices = params.prices.filter((price) => Number.isFinite(price) && price > 0);
  const minSamples = Math.max(3, Math.floor(params.minSamples));
  if (prices.length < minSamples) {
    return 'unknown';
  }

  const window = prices.slice(-minSamples);
  let pathSum = 0;
  for (let index = 1; index < window.length; index += 1) {
    pathSum += Math.abs(window[index] - window[index - 1]);
  }
  if (pathSum <= 0) {
    return 'chop';
  }

  const netMove = Math.abs(window[window.length - 1] - window[0]);
  const efficiency = netMove / pathSum;
  const threshold = Math.min(1, Math.max(0, params.trendEfficiencyThreshold));
  return efficiency >= threshold ? 'trend' : 'chop';
};

export type EntryQualityGateDecision = {
  allowed: boolean;
  reason: string;
};

/**
 * Live entry-quality gate. Decides whether an entry should be ALLOWED based on
 * the shape primitives the 4-day round-trip backtest proved separate winners
 * from the catastrophic loss tail. These thresholds are measured, not guessed:
 *
 *   - rangePositionBps > ~9000 (buying the top of the recent range):
 *       21% win, -222 bps mean.
 *   - recentSurgeBps > ~300 (chasing a vertical spike): 0% win, -561 bps;
 *       100-300 bps: 33% win, -174 bps.
 *   - pullbackFromHighBps < ~10 (buying the exact local high): 25% win,
 *       -209 bps; a 10-50 bps pullback: 67% win, -17 bps.
 *
 * Fails OPEN while the tape is warming up (no shape data) so a worker restart /
 * deploy never freezes all trading until the per-mint tape refills. The composite
 * score is intentionally NOT used to gate here (its mapping to realized outcomes
 * is still being validated in the shadow log); only the directly-measured
 * primitives block. Pure: no side effects.
 */
export const evaluateEntryQualityGate = (params: {
  result: EntryQualityScoreResult;
  maxRangePositionBps: number;
  maxRecentSurgeBps: number;
  minPullbackFromHighBps: number;
}): EntryQualityGateDecision => {
  const metrics = params.result.metrics;
  // No shape data yet (tape warming up) => allow, do not freeze trading.
  if (metrics === null || params.result.reason === 'entry_quality_warming_up') {
    return { allowed: true, reason: 'entry_quality_warming_up' };
  }
  if (metrics.rangePositionBps > Math.max(0, Math.round(params.maxRangePositionBps))) {
    return { allowed: false, reason: 'entry_quality_range_top' };
  }
  if (metrics.recentSurgeBps > Math.max(0, Math.round(params.maxRecentSurgeBps))) {
    return { allowed: false, reason: 'entry_quality_chase_surge' };
  }
  if (metrics.pullbackFromHighBps < Math.max(0, Math.round(params.minPullbackFromHighBps))) {
    return { allowed: false, reason: 'entry_quality_no_pullback' };
  }
  return { allowed: true, reason: 'entry_quality_ok' };
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