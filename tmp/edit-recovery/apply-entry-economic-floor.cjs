// Adds a per-trade economic floor for entries so sub-economic trades never churn
// at the cost gate. SOL entries previously had NO floor (USDC had $5), so SOL-funded
// sessions (e.g. RogueCEO) sized ~$1.30 entries that always failed entry_leg_cost_too_high.
// Behavior chosen by operator: CLAMP up to the economic floor when affordable; skip cleanly
// when the session genuinely cannot afford an economic trade. Canary-gated until graduated.
const fs = require('fs');
const path = 'services/worker/src/index.ts';
let src = fs.readFileSync(path, 'latin1');
const L = (...lines) => lines.join('\r\n');

function replaceOnce(oldStr, newStr, label) {
  const n = src.split(oldStr).length - 1;
  if (n !== 1) {
    throw new Error(`EXPECTED 1 occurrence for ${label}, found ${n}`);
  }
  src = src.replace(oldStr, newStr);
  console.log(`OK ${label}`);
}

// --- Edit 1: config constants after WORKER_DEMOTE_SIZE_FLOOR_BPS ---
const a1 = 'const WORKER_DEMOTE_SIZE_FLOOR_BPS = Number(process.env.WORKER_DEMOTE_SIZE_FLOOR_BPS ?? 3000);';
const a1new = L(
  a1,
  '// Per-trade economic floor: the smallest entry notional that can clear the fixed-cost gate.',
  '// A trade below this size amortizes the fixed network cost over too little notional and always',
  "// fails entry_leg_cost_too_high. USDC entries already enforce a $5 floor; SOL entries had none,",
  '// so SOL-funded sessions churned sub-economic trades forever. When enabled (canary-scoped until',
  '// graduated) the final entry size is clamped UP to this floor if affordable, else the trade skips.',
  "const WORKER_ENTRY_ECONOMIC_FLOOR_ENABLED = process.env.WORKER_ENTRY_ECONOMIC_FLOOR_ENABLED !== 'false';",
  'const WORKER_MIN_ENTRY_NOTIONAL_USD = Number(process.env.WORKER_MIN_ENTRY_NOTIONAL_USD ?? 5);',
);
replaceOnce(a1, a1new, 'edit1-config');

// --- Edit 2: helper after getUsdValueFromAtomicAmount ---
const a2 = L(
  '  return toUiAmount(mint, amountAtomic) * usdPrice;',
  '};',
);
const a2new = L(
  '  return toUiAmount(mint, amountAtomic) * usdPrice;',
  '};',
  '',
  '// Minimum economic entry size, expressed in the funding mint\u2019s atomic units. Below this notional',
  '// the fixed per-swap cost cannot be amortized under the entry cost cap, so the trade is guaranteed',
  '// to fail the cost gate. Returns 0 when the SOL price is unknown (caller then leaves size untouched).',
  'const entryEconomicFloorAtomic = (inputMint: string): number => {',
  '  const usd = WORKER_MIN_ENTRY_NOTIONAL_USD;',
  '  if (usd <= 0) {',
  '    return 0;',
  '  }',
  '  if (inputMint === USDC_MINT) {',
  '    return Math.floor(usd * USDC_ATOMIC_PER_USD);',
  '  }',
  '  if (inputMint === SOL_MINT) {',
  '    const solUsd = lastPythSolSample?.usdPrice ?? lastJupiterSolSample?.usdPrice ?? 0;',
  '    if (solUsd <= 0) {',
  '      return 0;',
  '    }',
  '    return Math.floor((usd / solUsd) * 1_000_000_000);',
  '  }',
  '  return 0;',
  '};',
);
replaceOnce(a2, a2new, 'edit2-helper');

// --- Edit 3: clamp block before assessEntryRouteStability ---
const a3 = '    const routeStability = await assessEntryRouteStability({';
const a3new = L(
  '    // Per-trade economic floor (clamp-to-floor). After all sizing reducers (volatility, class,',
  '    // demote) have run, the entry can be far below the size needed to clear the cost gate. Clamp it',
  '    // UP to the economic floor when the session can afford it; skip cleanly when it cannot, instead',
  '    // of letting a guaranteed-to-fail sub-economic trade churn the cost gate.',
  "    const economicFloorActive = isFeatureActiveForSession(session, WORKER_ENTRY_ECONOMIC_FLOOR_ENABLED, 'entry_economic_floor');",
  '    const economicFloorAtomic = entryEconomicFloorAtomic(entryInventory.inputMint);',
  '    if (economicFloorAtomic > 0) {',
  '      const preFloorAmount = entryInventory.amountAtomic ?? 0;',
  '      const affordableFloor = Math.min(economicFloorAtomic, entryInventory.maxTradeAtomic);',
  '      if (preFloorAmount > 0 && preFloorAmount < affordableFloor) {',
  '        if (affordableFloor <= entryInventory.tradableAtomic) {',
  '          log(',
  "            'info',",
  '            session.id,',
  "            `entry economic floor ${economicFloorActive ? 'apply' : 'shadow'}: ${entryInventory.inputSymbol}->${entryInventory.outputSymbol} amount ${preFloorAmount} -> ${affordableFloor} floor=${economicFloorAtomic} ($${WORKER_MIN_ENTRY_NOTIONAL_USD}) sub-economic clamp`,",
  '          );',
  '          if (economicFloorActive) {',
  '            entryInventory.amountAtomic = affordableFloor;',
  '            entryInventory.riskAdjustedAmountAtomic = affordableFloor;',
  '          }',
  '        } else if (economicFloorActive) {',
  '          log(',
  "            'info',",
  '            session.id,',
  "            `entry blocked: economic floor ${economicFloorAtomic} ($${WORKER_MIN_ENTRY_NOTIONAL_USD}) exceeds tradable ${entryInventory.tradableAtomic} for ${entryInventory.inputSymbol}; cannot place an economic trade`,",
  '          );',
  "          await persistTradeDecision(session, 'blocked', 'entry_below_economic_floor');",
  '          await persistLastTradeGate(session, {',
  '            at: new Date().toISOString(),',
  "            decision: 'blocked',",
  "            reason: 'entry_below_economic_floor',",
  '            expectedEdgeBps: tokenEntrySignal.momentumBps,',
  '            estimatedCostBps: null,',
  '            safetyBufferBps: strategyConfig.momentum.edgeSafetyBufferBps,',
  '          });',
  '          return;',
  '        }',
  '      }',
  '    }',
  '',
  '    const routeStability = await assessEntryRouteStability({',
);
replaceOnce(a3, a3new, 'edit3-clamp');

fs.writeFileSync(path, src, 'latin1');
console.log('WROTE', path, 'bytes', src.length);
