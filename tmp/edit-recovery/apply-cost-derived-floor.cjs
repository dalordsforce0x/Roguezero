// Replace the fixed-$5 economic floor with a LIVE cost-derived floor.
// The minimum economic entry size is computed every trade from the most recent measured
// network cost and the live cost cap, with a safety headroom. For a SOL entry the SOL price
// cancels out (cost and notional both in SOL), so it self-adjusts to priority-fee spikes with
// no price input. When fees rise so high the floor exceeds the max trade, the entry skips.
const fs = require('fs');
const path = 'services/worker/src/index.ts';
let src = fs.readFileSync(path, 'latin1');
const L = (...lines) => lines.join('\r\n');

function replaceOnce(oldStr, newStr, label) {
  const n = src.split(oldStr).length - 1;
  if (n !== 1) throw new Error(`EXPECTED 1 occurrence for ${label}, found ${n}`);
  src = src.replace(oldStr, newStr);
  console.log(`OK ${label}`);
}

// --- Edit 1: config constants block ---
const c1old = L(
  '// Per-trade economic floor: the smallest entry notional that can clear the fixed-cost gate.',
  '// A trade below this size amortizes the fixed network cost over too little notional and always',
  "// fails entry_leg_cost_too_high. USDC entries already enforce a $5 floor; SOL entries had none,",
  '// so SOL-funded sessions churned sub-economic trades forever. When enabled (canary-scoped until',
  '// graduated) the final entry size is clamped UP to this floor if affordable, else the trade skips.',
  "const WORKER_ENTRY_ECONOMIC_FLOOR_ENABLED = process.env.WORKER_ENTRY_ECONOMIC_FLOOR_ENABLED !== 'false';",
  'const WORKER_MIN_ENTRY_NOTIONAL_USD = Number(process.env.WORKER_MIN_ENTRY_NOTIONAL_USD ?? 5);',
);
const c1new = L(
  '// Per-trade economic floor: the smallest entry notional that can clear the cost gate. A trade below',
  '// this size amortizes the per-swap network cost over too little notional and always fails',
  '// entry_leg_cost_too_high. The floor is NOT a hardcoded dollar amount (both the SOL price and the',
  '// priority-fee-driven network cost move constantly); it is derived live every trade from the most',
  '// recent measured network cost and the live cost cap. When enabled (canary-scoped until graduated)',
  '// the entry is clamped UP to this floor if affordable, else the trade skips (fees too high to trade).',
  "const WORKER_ENTRY_ECONOMIC_FLOOR_ENABLED = process.env.WORKER_ENTRY_ECONOMIC_FLOOR_ENABLED !== 'false';",
  '// Headroom over the bare break-even size so normal priority-fee variance does not immediately push a',
  '// just-economic trade back over the cost cap. 15000 bps = 1.5x. This is a safety margin, not a',
  '// price/cost guess \u2014 the floor itself is derived from the measured network cost below.',
  'const WORKER_ENTRY_COST_HEADROOM_BPS = Number(process.env.WORKER_ENTRY_COST_HEADROOM_BPS ?? 15000);',
  '// Startup seed for the fleet-wide measured network cost, in lamports. Immediately overwritten by the',
  '// first real prepare response, so it only governs the first few seconds after a worker restart.',
  'const WORKER_NETWORK_COST_SEED_LAMPORTS = Number(process.env.WORKER_NETWORK_COST_SEED_LAMPORTS ?? 250_000);',
  '// Most recent network cost (base fee + priority fee + tip, plus ATA rent when a new token account is',
  '// genuinely needed) measured from a live prepare response. Shared fleet-wide in this single worker',
  '// process; busy sessions keep it fresh. Drives the live economic entry floor.',
  'let recentNetworkCostLamports = WORKER_NETWORK_COST_SEED_LAMPORTS;',
);
replaceOnce(c1old, c1new, 'edit1-config');

// --- Edit 2: helper rewrite (cost-derived) ---
const h2old = L(
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
const h2new = L(
  'const entryEconomicFloorAtomic = (inputMint: string): number => {',
  '  const capBps = MAX_QUOTE_PRICE_IMPACT_BPS;',
  '  if (capBps <= 0 || recentNetworkCostLamports <= 0) {',
  '    return 0;',
  '  }',
  '  // Smallest trade whose measured network cost amortizes under the cost cap, with headroom for fee',
  '  // variance. For a SOL-funded entry the SOL price cancels (cost and notional are both in SOL), so',
  '  // this self-adjusts to priority-fee spikes with no price input: minLamports = cost * headroom / cap.',
  '  const minSolLamports = (recentNetworkCostLamports * WORKER_ENTRY_COST_HEADROOM_BPS) / capBps;',
  '  if (inputMint === SOL_MINT) {',
  '    return Math.ceil(minSolLamports);',
  '  }',
  '  if (inputMint === USDC_MINT) {',
  '    const solUsd = lastPythSolSample?.usdPrice ?? lastJupiterSolSample?.usdPrice ?? 0;',
  '    if (solUsd <= 0) {',
  '      return 0;',
  '    }',
  '    const minNotionalUsd = (minSolLamports / 1_000_000_000) * solUsd;',
  '    return Math.ceil(minNotionalUsd * USDC_ATOMIC_PER_USD);',
  '  }',
  '  return 0;',
  '};',
);
replaceOnce(h2old, h2new, 'edit2-helper');

// --- Edit 3a: clamp apply log ---
const l3aOld = 'floor=${economicFloorAtomic} (${WORKER_MIN_ENTRY_NOTIONAL_USD}) sub-economic clamp`,';
const l3aNew = 'floor=${economicFloorAtomic} (cost=${recentNetworkCostLamports}lamports cap=${MAX_QUOTE_PRICE_IMPACT_BPS}bps) sub-economic clamp`,';
replaceOnce(l3aOld, l3aNew, 'edit3a-apply-log');

// --- Edit 3b: clamp skip log ---
const l3bOld = '`entry blocked: economic floor ${economicFloorAtomic} (${WORKER_MIN_ENTRY_NOTIONAL_USD}) exceeds tradable ${entryInventory.tradableAtomic} for ${entryInventory.inputSymbol}; cannot place an economic trade`,';
const l3bNew = '`entry blocked: economic floor ${economicFloorAtomic} (cost=${recentNetworkCostLamports}lamports, fees too high to trade economically) exceeds tradable ${entryInventory.tradableAtomic} for ${entryInventory.inputSymbol}`,';
replaceOnce(l3bOld, l3bNew, 'edit3b-skip-log');

// --- Edit 4: live network-cost tracker hook ---
const t4old = '    economics = buildTradeEconomics({';
const t4new = L(
  '    const observedNetworkCostLamports = Number(prepare.data.costs?.estimatedNetworkCostLamports ?? 0);',
  '    if (Number.isFinite(observedNetworkCostLamports) && observedNetworkCostLamports > 0) {',
  '      recentNetworkCostLamports = observedNetworkCostLamports;',
  '    }',
  '    economics = buildTradeEconomics({',
);
replaceOnce(t4old, t4new, 'edit4-tracker');

fs.writeFileSync(path, src, 'latin1');
console.log('WROTE', path, 'bytes', src.length);
