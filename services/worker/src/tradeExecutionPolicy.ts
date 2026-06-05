export type TradeDirection = 'exit_long' | 'enter_long';
export type ExitReason = 'take_profit' | 'stop_loss' | 'trailing_stop' | 'signal_reversal' | null;

export type TradeGateAssessment = {
  allowed: boolean;
  reason: string;
  expectedEdgeBps: number;
  estimatedCostBps: number;
  safetyBufferBps: number;
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