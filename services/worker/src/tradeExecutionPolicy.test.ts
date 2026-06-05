import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeFullExitAmountAtomic,
  computeGasRefillPlan,
  resolveTradeGateAssessment,
  shouldApplyPostExitSolReserveProtection,
  shouldForceExitExecution,
  type GasRefillPlanInput,
  type TradeGateAssessment,
} from './tradeExecutionPolicy.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JTO_MINT = 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL';

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