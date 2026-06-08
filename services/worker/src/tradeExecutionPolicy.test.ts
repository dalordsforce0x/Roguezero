import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeTrendingEntryShapeGate,
  computePrePrepareEntryGate,
  computeEntryQualityScore,
  classifyTapeRegime,
  evaluateEntryQualityGate,
  computeFullExitAmountAtomic,
  computeGasRefillPlan,
  computeRetryMinimumTradeAmountAtomic,
  computeStopLossThresholdBps,
  resolveTradeGateAssessment,
  shouldApplyPostExitSolReserveProtection,
  shouldForceExitExecution,
  type GasRefillPlanInput,
  type TradeGateAssessment,
} from './tradeExecutionPolicy.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JTO_MINT = 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL';

const baseTrendingShapeInput = {
  enabled: true,
  minSamples: 8,
  chaseLookbackSamples: 3,
  maxRecentSurgeBps: 80,
  minPullbackFromHighBps: 30,
  minReclaimFromLowBps: 20,
  maxRangePositionBps: 8500,
  maxNegativeWindowMomentumBps: 250,
};

const blockedAssessment: TradeGateAssessment = {
  allowed: false,
  reason: 'edge_below_cost_model',
  expectedEdgeBps: 0,
  estimatedCostBps: 247,
  safetyBufferBps: 5,
};

test('shouldForceExitExecution only forces confirmed exit directions', () => {
  assert.equal(shouldForceExitExecution('exit_long', 'stop_loss'), true);
  assert.equal(shouldForceExitExecution('exit_long', 'take_profit'), true);
  assert.equal(shouldForceExitExecution('exit_long', null), false);
  assert.equal(shouldForceExitExecution('enter_long', 'stop_loss'), false);
});

test('resolveTradeGateAssessment allows exit trades even when edge model blocks entries', () => {
  const resolved = resolveTradeGateAssessment({
    direction: 'exit_long',
    exitReason: 'stop_loss',
    assessment: blockedAssessment,
  });

  assert.equal(resolved.allowed, true);
  assert.equal(resolved.reason, 'exit_trigger_stop_loss');
  assert.equal(resolved.estimatedCostBps, 247);
});

test('resolveTradeGateAssessment leaves entry trades unchanged', () => {
  const resolved = resolveTradeGateAssessment({
    direction: 'enter_long',
    exitReason: null,
    assessment: blockedAssessment,
  });

  assert.deepEqual(resolved, blockedAssessment);
});

test('computePrePrepareEntryGate skips impossible entries before prepare', () => {
  const gate = computePrePrepareEntryGate({
    direction: 'enter_long',
    signalMomentumBps: 16,
    signalThresholdBps: 45,
    safetyBufferBps: 35,
  });

  assert.deepEqual(gate, {
    allowed: false,
    reason: 'entry_edge_below_cost',
    expectedEdgeBps: 0,
    estimatedCostBps: 0,
    safetyBufferBps: 35,
  });
});

test('computePrePrepareEntryGate allows prepare when edge could clear costs', () => {
  const gate = computePrePrepareEntryGate({
    direction: 'enter_long',
    signalMomentumBps: 95,
    signalThresholdBps: 45,
    safetyBufferBps: 35,
  });

  assert.equal(gate, null);
});

test('computePrePrepareEntryGate blocks when edge clears safety but not honest round-trip cost', () => {
  const gate = computePrePrepareEntryGate({
    direction: 'enter_long',
    signalMomentumBps: 95,
    signalThresholdBps: 45,
    safetyBufferBps: 35,
    estimatedCostBps: 100,
  });

  assert.deepEqual(gate, {
    allowed: false,
    reason: 'entry_edge_below_cost',
    expectedEdgeBps: 50,
    estimatedCostBps: 100,
    safetyBufferBps: 35,
  });
});

test('computePrePrepareEntryGate allows when edge clears honest cost plus safety', () => {
  const gate = computePrePrepareEntryGate({
    direction: 'enter_long',
    signalMomentumBps: 200,
    signalThresholdBps: 45,
    safetyBufferBps: 35,
    estimatedCostBps: 100,
  });

  assert.equal(gate, null);
});

test('computePrePrepareEntryGate never blocks exits', () => {
  const gate = computePrePrepareEntryGate({
    direction: 'exit_long',
    signalMomentumBps: 0,
    signalThresholdBps: 45,
    safetyBufferBps: 35,
  });

  assert.equal(gate, null);
});

test('computeTrendingEntryShapeGate blocks a vertical candle with no pullback', () => {
  const gate = computeTrendingEntryShapeGate({
    ...baseTrendingShapeInput,
    prices: [1, 1.002, 1.004, 1.007, 1.01, 1.016, 1.024, 1.035],
  });

  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, 'trending_entry_chasing_vertical');
  assert.ok((gate.metrics?.recentSurgeBps ?? 0) > baseTrendingShapeInput.maxRecentSurgeBps);
});

test('computeTrendingEntryShapeGate allows pullback then confirmed reclaim', () => {
  const gate = computeTrendingEntryShapeGate({
    ...baseTrendingShapeInput,
    prices: [1, 1.006, 1.014, 1.02, 1.015, 1.009, 1.011, 1.014],
  });

  assert.equal(gate.allowed, true);
  assert.equal(gate.reason, 'trending_entry_pullback_reclaim');
  assert.ok((gate.metrics?.pullbackFromHighBps ?? 0) >= baseTrendingShapeInput.minPullbackFromHighBps);
  assert.ok((gate.metrics?.reclaimFromLowBps ?? 0) >= baseTrendingShapeInput.minReclaimFromLowBps);
});

test('computeTrendingEntryShapeGate blocks falling-knife pullbacks without reclaim', () => {
  const gate = computeTrendingEntryShapeGate({
    ...baseTrendingShapeInput,
    prices: [1, 1.006, 1.014, 1.02, 1.015, 1.009, 1.005, 1.003],
  });

  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, 'trending_entry_reclaim_not_confirmed');
});

test('computeTrendingEntryShapeGate waits for enough live samples', () => {
  const gate = computeTrendingEntryShapeGate({
    ...baseTrendingShapeInput,
    prices: [1, 1.01, 1.005],
  });

  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, 'trending_entry_shape_warming_up');
});

const baseEntryQualityInput = {
  minSamples: 8,
  chaseLookbackSamples: 3,
  regime: 'trend' as const,
  priceImpactBps: 20,
  idealPullbackBps: 40,
  maxHealthyPullbackBps: 150,
  maxHealthyPriceImpactBps: 200,
  strongScore: 70,
  fairScore: 50,
  enterThreshold: 55,
};

test('computeEntryQualityScore scores a reclaimed pullback higher than a chased top', () => {
  // Reclaimed pullback: ran up, pulled back ~40bps, then ticked back up (confirmed).
  const pullbackReclaim = computeEntryQualityScore({
    ...baseEntryQualityInput,
    prices: [1, 1.006, 1.014, 1.02, 1.015, 1.009, 1.011, 1.014],
  });
  // Chasing the top of a vertical candle: current sits at the local high.
  const chasingTop = computeEntryQualityScore({
    ...baseEntryQualityInput,
    prices: [1, 1.002, 1.004, 1.007, 1.01, 1.016, 1.024, 1.035],
  });

  assert.ok(
    pullbackReclaim.score > chasingTop.score,
    `expected reclaimed pullback (${pullbackReclaim.score}) > chased top (${chasingTop.score})`,
  );
  assert.ok(chasingTop.score < 50, `chased top should be weak/reject, got ${chasingTop.score}`);
});

test('computeEntryQualityScore returns warming_up below min samples', () => {
  const result = computeEntryQualityScore({
    ...baseEntryQualityInput,
    prices: [1, 1.01, 1.005],
  });

  assert.equal(result.score, 0);
  assert.equal(result.band, 'reject');
  assert.equal(result.wouldEnter, false);
  assert.equal(result.reason, 'entry_quality_warming_up');
  assert.equal(result.metrics, null);
});

test('computeEntryQualityScore penalizes thin liquidity', () => {
  const prices = [1, 1.006, 1.014, 1.02, 1.015, 1.009, 1.011, 1.014];
  const deep = computeEntryQualityScore({ ...baseEntryQualityInput, prices, priceImpactBps: 10 });
  const thin = computeEntryQualityScore({ ...baseEntryQualityInput, prices, priceImpactBps: 190 });

  assert.ok(deep.score > thin.score, `deep (${deep.score}) should beat thin (${thin.score})`);
});

test('computeEntryQualityScore band + wouldEnter track the thresholds', () => {
  const result = computeEntryQualityScore({
    ...baseEntryQualityInput,
    prices: [1, 1.006, 1.014, 1.02, 1.015, 1.009, 1.011, 1.014],
  });

  assert.ok(['strong', 'fair', 'weak', 'reject'].includes(result.band));
  assert.equal(result.wouldEnter, result.score >= baseEntryQualityInput.enterThreshold);
  assert.ok(result.score >= 0 && result.score <= 100);
});

test('computeEntryQualityScore treats a flat/no-range tape as neutral, not a chased top', () => {
  // Perfectly flat tape: range is 0. The old default scored this as buying the
  // top (rangePositionBps=10000 -> rangePosition=0). It must now be neutral.
  const flat = computeEntryQualityScore({
    ...baseEntryQualityInput,
    prices: [1, 1, 1, 1, 1, 1, 1, 1],
  });

  assert.equal(flat.metrics?.rangePositionBps, 5_000);
  assert.ok(flat.components.rangePosition > 0.5, `flat tape rangePosition should be neutral, got ${flat.components.rangePosition}`);
});

test('classifyTapeRegime calls a straight directional run a trend', () => {
  const regime = classifyTapeRegime({
    prices: [1, 1.01, 1.02, 1.03, 1.04, 1.05, 1.06, 1.07],
    minSamples: 8,
    trendEfficiencyThreshold: 0.6,
  });

  assert.equal(regime, 'trend');
});

test('classifyTapeRegime calls an oscillating tape chop', () => {
  const regime = classifyTapeRegime({
    prices: [1, 1.02, 0.99, 1.03, 0.98, 1.02, 0.99, 1.01],
    minSamples: 8,
    trendEfficiencyThreshold: 0.6,
  });

  assert.equal(regime, 'chop');
});

test('classifyTapeRegime treats a flat tape as chop and is unknown below min samples', () => {
  assert.equal(
    classifyTapeRegime({ prices: [1, 1, 1, 1, 1], minSamples: 5, trendEfficiencyThreshold: 0.6 }),
    'chop',
  );
  assert.equal(
    classifyTapeRegime({ prices: [1, 1.01], minSamples: 8, trendEfficiencyThreshold: 0.6 }),
    'unknown',
  );
});

const gateThresholds = {
  maxRangePositionBps: 9_000,
  maxRecentSurgeBps: 120,
  minPullbackFromHighBps: 8,
};

test('evaluateEntryQualityGate fails open while the tape is warming up', () => {
  const warming = computeEntryQualityScore({ ...baseEntryQualityInput, prices: [1, 1.01, 1.005] });
  const decision = evaluateEntryQualityGate({ result: warming, ...gateThresholds });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'entry_quality_warming_up');
});

test('evaluateEntryQualityGate blocks buying the top of the range', () => {
  // Strictly ascending into the high: current sits at the range top.
  const chasedTop = computeEntryQualityScore({
    ...baseEntryQualityInput,
    prices: [1, 1.002, 1.004, 1.007, 1.01, 1.016, 1.024, 1.035],
  });
  const decision = evaluateEntryQualityGate({ result: chasedTop, ...gateThresholds });
  assert.equal(decision.allowed, false);
  assert.ok(
    ['entry_quality_range_top', 'entry_quality_chase_surge', 'entry_quality_no_pullback'].includes(decision.reason),
    `expected a catastrophic-shape reject, got ${decision.reason}`,
  );
});

test('evaluateEntryQualityGate blocks chasing a vertical surge', () => {
  const surge = computeEntryQualityScore({
    ...baseEntryQualityInput,
    prices: [1, 1, 1, 1, 1, 1.01, 1.03, 1.07],
  });
  const decision = evaluateEntryQualityGate({
    result: surge,
    maxRangePositionBps: 10_000, // disable the range check to isolate surge
    maxRecentSurgeBps: 120,
    minPullbackFromHighBps: 0,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'entry_quality_chase_surge');
});

test('evaluateEntryQualityGate allows a reclaimed pullback entry', () => {
  const reclaimed = computeEntryQualityScore({
    ...baseEntryQualityInput,
    prices: [1, 1.006, 1.014, 1.02, 1.015, 1.009, 1.011, 1.014],
  });
  const decision = evaluateEntryQualityGate({ result: reclaimed, ...gateThresholds });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'entry_quality_ok');
});

test('computeStopLossThresholdBps keeps stop-loss independent from cost floor', () => {
  const stopLossBps = computeStopLossThresholdBps({
    configuredStopLossBps: 8,
    atrBps: 10,
    atrStopLossMultiplier: 1,
  });

  assert.equal(stopLossBps, 10);
});

test('computeStopLossThresholdBps falls back to configured cap without ATR', () => {
  const stopLossBps = computeStopLossThresholdBps({
    configuredStopLossBps: 8,
    atrBps: null,
    atrStopLossMultiplier: 1,
  });

  assert.equal(stopLossBps, 8);
});

test('computeFullExitAmountAtomic uses tracked position quantity for exits', () => {
  const amount = computeFullExitAmountAtomic({
    walletBalanceAtomic: 111_134_998,
    reserveAtomic: 1_727_879,
    positionQuantityAtomic: '19817760',
  });

  assert.equal(amount, 19_817_760);
});

test('computeFullExitAmountAtomic caps exit size at tradable balance', () => {
  const amount = computeFullExitAmountAtomic({
    walletBalanceAtomic: 20_000_000,
    reserveAtomic: 5_000_000,
    positionQuantityAtomic: '19817760',
  });

  assert.equal(amount, 15_000_000);
});

test('shouldApplyPostExitSolReserveProtection only trims SOL exits', () => {
  assert.equal(shouldApplyPostExitSolReserveProtection({
    direction: 'exit_long',
    inputMint: SOL_MINT,
    solMint: SOL_MINT,
  }), true);

  assert.equal(shouldApplyPostExitSolReserveProtection({
    direction: 'exit_long',
    inputMint: JTO_MINT,
    solMint: SOL_MINT,
  }), false);

  assert.equal(shouldApplyPostExitSolReserveProtection({
    direction: 'enter_long',
    inputMint: SOL_MINT,
    solMint: SOL_MINT,
  }), false);
});

test('computeRetryMinimumTradeAmountAtomic lets forced exits retry below entry minimum', () => {
  assert.equal(computeRetryMinimumTradeAmountAtomic({
    forceExitExecution: true,
    minTradeAtomic: 5_000_000,
  }), 1);
});

test('computeRetryMinimumTradeAmountAtomic preserves entry minimum for non-forced trades', () => {
  assert.equal(computeRetryMinimumTradeAmountAtomic({
    forceExitExecution: false,
    minTradeAtomic: 5_000_000,
  }), 5_000_000);
});

const baseRefillInput: GasRefillPlanInput = {
  solBalanceLamports: 0,
  usdcBalanceAtomic: 0,
  solUsd: 150,
  // floor ~0.002 SOL operating reserve + one swap cost as the early trigger
  triggerLamports: 4_000_000,
  // refill up to ~0.01 SOL comfortable buffer
  targetLamports: 10_000_000,
  // one refill swap costs ~0.002 SOL
  swapCostLamports: 2_000_000,
  minUsdcKeepAtomic: 0,
  minRefillUsdcAtomic: 200_000,
  slippageHeadroom: 1.02,
  usdcAtomicPerUsd: 1_000_000,
  lamportsPerSol: 1_000_000_000,
};

test('computeGasRefillPlan refills from USDC when SOL drains below the trigger', () => {
  const plan = computeGasRefillPlan({
    ...baseRefillInput,
    solBalanceLamports: 3_000_000,
    usdcBalanceAtomic: 50_000_000,
  });

  assert.equal(plan.shouldRefill, true);
  assert.equal(plan.reason, 'ok');
  // needs 7_000_000 lamports = 0.007 SOL * $150 = $1.05 -> 1_050_000 atomic * 1.02 headroom
  assert.equal(plan.usdcToConvertAtomic, 1_071_000);
});

test('computeGasRefillPlan does nothing while SOL is comfortably above the trigger', () => {
  const plan = computeGasRefillPlan({
    ...baseRefillInput,
    solBalanceLamports: 8_000_000,
    usdcBalanceAtomic: 50_000_000,
  });

  assert.equal(plan.shouldRefill, false);
  assert.equal(plan.reason, 'sol_above_trigger');
  assert.equal(plan.usdcToConvertAtomic, 0);
});

test('computeGasRefillPlan refuses to refill once SOL cannot afford the swap', () => {
  const plan = computeGasRefillPlan({
    ...baseRefillInput,
    solBalanceLamports: 1_000_000,
    usdcBalanceAtomic: 50_000_000,
  });

  assert.equal(plan.shouldRefill, false);
  assert.equal(plan.reason, 'sol_below_swap_cost');
});

test('computeGasRefillPlan skips when there is no spendable USDC', () => {
  const plan = computeGasRefillPlan({
    ...baseRefillInput,
    solBalanceLamports: 3_000_000,
    usdcBalanceAtomic: 100_000,
    minUsdcKeepAtomic: 100_000,
  });

  assert.equal(plan.shouldRefill, false);
  assert.equal(plan.reason, 'no_spendable_usdc');
});

test('computeGasRefillPlan caps the slice at the spendable USDC after the keep reserve', () => {
  const plan = computeGasRefillPlan({
    ...baseRefillInput,
    solBalanceLamports: 3_000_000,
    usdcBalanceAtomic: 1_500_000,
    minUsdcKeepAtomic: 1_000_000,
  });

  // spendable = 500_000, which is below the sized need (1_071_000) -> capped
  assert.equal(plan.shouldRefill, true);
  assert.equal(plan.usdcToConvertAtomic, 500_000);
});

test('computeGasRefillPlan skips when the available slice is below the minimum', () => {
  const plan = computeGasRefillPlan({
    ...baseRefillInput,
    solBalanceLamports: 3_000_000,
    usdcBalanceAtomic: 350_000,
    minUsdcKeepAtomic: 200_000,
  });

  // spendable = 150_000 < minRefillUsdcAtomic (200_000)
  assert.equal(plan.shouldRefill, false);
  assert.equal(plan.reason, 'slice_below_min');
});

test('computeGasRefillPlan skips when SOL is already at or above the target', () => {
  const plan = computeGasRefillPlan({
    ...baseRefillInput,
    triggerLamports: 12_000_000,
    solBalanceLamports: 11_000_000,
    usdcBalanceAtomic: 50_000_000,
  });

  assert.equal(plan.shouldRefill, false);
  assert.equal(plan.reason, 'already_at_target');
});

test('computeGasRefillPlan defers when there is no SOL price to size the conversion', () => {
  const plan = computeGasRefillPlan({
    ...baseRefillInput,
    solBalanceLamports: 3_000_000,
    usdcBalanceAtomic: 50_000_000,
    solUsd: 0,
  });

  assert.equal(plan.shouldRefill, false);
  assert.equal(plan.reason, 'no_sol_price');
});