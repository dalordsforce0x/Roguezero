/*
 * Phase 3 move 2b / doc Step 4: token-class partial-TP REAL EXECUTION (Noah-only, flag-gated).
 * Reuses the proven exit_long execution path. A partial is promoted into an exitCandidate ONLY
 * when no hard exit (stop/TP/reversal) competes that cycle. Sells a class fraction of the full
 * exit amount; position stays open (fraction <= 60% keeps inventory above the 10% reconcile drop
 * threshold). One partial per position via partialExitDone (set after successful submit).
 * Disk-edit (worker file served stale by buffer tools). split/join only (never String.replace).
 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let src = fs.readFileSync(file, 'utf8');

const edits = [];
function apply(label, oldStr, newStr) {
  const count = src.split(oldStr).length - 1;
  if (count !== 1) {
    throw new Error(`[${label}] expected exactly 1 match, found ${count}`);
  }
  src = src.split(oldStr).join(newStr);
  edits.push(label);
}

// 1) Env flag (default OFF). Placed right after the expected-slippage const.
apply(
  'flag',
  `const WORKER_EXIT_EXPECTED_SLIPPAGE_BPS = Number(process.env.WORKER_EXIT_EXPECTED_SLIPPAGE_BPS ?? 15);`,
  `const WORKER_EXIT_EXPECTED_SLIPPAGE_BPS = Number(process.env.WORKER_EXIT_EXPECTED_SLIPPAGE_BPS ?? 15);
// Step 4 (real exec, Noah-only, default OFF): when enabled + canary-scoped, the worker may sell a
// token-class fraction of a position that has cleared its honest-break-even partial-TP trigger,
// but only when no hard exit (stop/TP/reversal) is competing that cycle. One partial per position.
const WORKER_PARTIAL_TP_ENABLED = process.env.WORKER_PARTIAL_TP_ENABLED === 'true';
const WORKER_PARTIAL_TP_MAX_FRACTION_BPS = Number(process.env.WORKER_PARTIAL_TP_MAX_FRACTION_BPS ?? 6000);`,
);

// 2) TradeExecutionPlan: optional partial fraction marker.
apply(
  'plantype',
  `  scannerStrategy: StrategyKey;
  entryStrategy: StrategyKey | null;
  exitStrategy: StrategyKey | null;
};

type ExitTriggerDecision = {`,
  `  scannerStrategy: StrategyKey;
  entryStrategy: StrategyKey | null;
  exitStrategy: StrategyKey | null;
  partialFractionBps?: number | null;
};

type ExitTriggerDecision = {`,
);

// 3) exitCandidates type gains partialFractionBps; add partialTpActive + partialCandidates.
apply(
  'candidates',
  `    const exitCandidates: Array<{
      mint: string;
      position: SessionPositionState;
      signal: NonNullable<Session['serviceControl']['lastSignal']>;
      trigger: ExitTriggerDecision;
    }> = [];`,
  `    const exitCandidates: Array<{
      mint: string;
      position: SessionPositionState;
      signal: NonNullable<Session['serviceControl']['lastSignal']>;
      trigger: ExitTriggerDecision;
      partialFractionBps?: number | null;
    }> = [];
    // Step 4 partial-TP (Noah-only, flag-gated). Collected during the exit scan; only promoted
    // into an exit when NO hard exit competes this cycle (hard exits always win).
    const partialTpActive = isCanaryShadowEnabled(session, WORKER_PARTIAL_TP_ENABLED);
    const partialCandidates: Array<{
      mint: string;
      position: SessionPositionState;
      signal: NonNullable<Session['serviceControl']['lastSignal']>;
      trigger: ExitTriggerDecision;
      sellBps: number;
    }> = [];`,
);

// 4) Detect partial candidates inside the no-hard-exit branch.
apply(
  'detect',
  `      if (!exitTrigger.shouldExit) {
        if (position.pendingExitReason !== null) {
          nextPositions[mint] = {
            ...position,
            pendingExitReason: null,
          };
          positionsChanged = true;
        }
        continue;
      }`,
  `      if (!exitTrigger.shouldExit) {
        if (position.pendingExitReason !== null) {
          nextPositions[mint] = {
            ...position,
            pendingExitReason: null,
          };
          positionsChanged = true;
        }
        if (partialTpActive && !position.partialExitDone) {
          const partialTokenClass = getTokenTradeClass(mint, getPositionSymbol(position));
          const partialHonestFloorBps = WORKER_EXIT_EXPECTED_SLIPPAGE_BPS + Number(session.service_control.platformFeeBps ?? 0);
          const partialEval = computePartialTpShadow(partialTokenClass, exitTrigger.pnlBps, partialHonestFloorBps);
          if (partialEval.fired) {
            partialCandidates.push({ mint, position, signal: signalForPosition, trigger: exitTrigger, sellBps: partialEval.sellBps });
          }
        }
        continue;
      }`,
);

// 5) Promote the best partial into an exitCandidate when no hard exit exists.
apply(
  'promote',
  `    if (exitCandidates.length > 0) {
      exitCandidates.sort((left, right) => {`,
  `    if (exitCandidates.length === 0 && partialTpActive && partialCandidates.length > 0) {
      partialCandidates.sort((a, b) => (b.trigger.pnlBps ?? 0) - (a.trigger.pnlBps ?? 0));
      const bestPartial = partialCandidates[0];
      exitCandidates.push({
        mint: bestPartial.mint,
        position: bestPartial.position,
        signal: bestPartial.signal,
        trigger: { ...bestPartial.trigger, reason: 'take_profit' },
        partialFractionBps: bestPartial.sellBps,
      });
      log(
        'info',
        session.id,
        \`partial-tp candidate promoted: \${getPositionSymbol(bestPartial.position)} pnl=\${bestPartial.trigger.pnlBps} sellBps=\${bestPartial.sellBps}\`,
      );
    }

    if (exitCandidates.length > 0) {
      exitCandidates.sort((left, right) => {`,
);

// 6) Apply the fraction to the exit amount.
apply(
  'amount',
  `      const exitAmountLamports = computeFullExitAmountAtomic({
        walletBalanceAtomic: exitWalletBalanceAtomic,
        reserveAtomic: exitReserveAtomic,
        positionQuantityAtomic: positionState.quantityAtomic,
      });`,
  `      const fullExitAmountLamports = computeFullExitAmountAtomic({
        walletBalanceAtomic: exitWalletBalanceAtomic,
        reserveAtomic: exitReserveAtomic,
        positionQuantityAtomic: positionState.quantityAtomic,
      });
      const exitAmountLamports = selectedExit.partialFractionBps != null
        ? Math.max(0, Math.floor((fullExitAmountLamports * Math.min(selectedExit.partialFractionBps, WORKER_PARTIAL_TP_MAX_FRACTION_BPS)) / 10000))
        : fullExitAmountLamports;`,
);

// 7) Thread partialFractionBps into the exit tradePlan.
apply(
  'planbuild',
  `      tradePlan = {
        direction: 'exit_long',
        inventory: sellInventory,
        exitReason: selectedExit.trigger.reason,
        signalSnapshot: selectedExit.signal,
        scannerStrategy: activeStrategy,
        entryStrategy: selectedExit.position.entryStrategy ?? null,
        exitStrategy: selectedExit.position.entryStrategy ?? activeStrategy,
      };`,
  `      tradePlan = {
        direction: 'exit_long',
        inventory: sellInventory,
        exitReason: selectedExit.trigger.reason,
        signalSnapshot: selectedExit.signal,
        scannerStrategy: activeStrategy,
        entryStrategy: selectedExit.position.entryStrategy ?? null,
        exitStrategy: selectedExit.position.entryStrategy ?? activeStrategy,
        partialFractionBps: selectedExit.partialFractionBps ?? null,
      };`,
);

// 8) After successful submit, mark the position partialExitDone (one partial per position).
apply(
  'markdone',
  `  if (tradePlan.direction === 'enter_long') {
    const nextScannerStrategy = getNextStrategyInSequence(`,
  `  if (tradePlan.direction === 'exit_long' && tradePlan.partialFractionBps != null) {
    try {
      const partialMint = tradePlan.inventory.inputMint;
      const existingPartialPosition = positionsState.positions[partialMint];
      if (existingPartialPosition) {
        positionsState = await persistPositionsState(session, {
          activePositionMint: positionsState.activePositionMint,
          positions: {
            ...positionsState.positions,
            [partialMint]: { ...existingPartialPosition, partialExitDone: true, pendingExitReason: null },
          },
        });
      }
      log('info', session.id, \`partial-tp marked done: \${tradePlan.inventory.inputSymbol} fraction=\${tradePlan.partialFractionBps}bps\`);
    } catch (err) {
      log('warn', session.id, \`failed to mark partial-tp done: \${String(err)}\`);
    }
  }

  if (tradePlan.direction === 'enter_long') {
    const nextScannerStrategy = getNextStrategyInSequence(`,
);

fs.writeFileSync(file, src, 'utf8');
console.log('applied edits:', edits.join(', '));
