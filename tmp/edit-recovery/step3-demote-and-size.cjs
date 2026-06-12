'use strict';
const fs = require('fs');
const path = 'services/worker/src/index.ts';
let src = fs.readFileSync(path, 'latin1');
const L = (...lines) => lines.join('\r\n');

const edits = [];

// Edit 1: config constants for demote-and-size
edits.push({
  name: '1: config constants',
  old: L(
    'const WORKER_MAX_ENTRY_SELL_IMPACT_BPS = Number(process.env.WORKER_MAX_ENTRY_SELL_IMPACT_BPS ?? 12);',
    'const WORKER_SELL_IMPACT_CACHE_TTL_MS = Number(process.env.WORKER_SELL_IMPACT_CACHE_TTL_MS ?? 600000);',
  ),
  neu: L(
    'const WORKER_MAX_ENTRY_SELL_IMPACT_BPS = Number(process.env.WORKER_MAX_ENTRY_SELL_IMPACT_BPS ?? 12);',
    'const WORKER_SELL_IMPACT_CACHE_TTL_MS = Number(process.env.WORKER_SELL_IMPACT_CACHE_TTL_MS ?? 600000);',
    '// Demote-and-size (AlphaPy pattern, Noah-gated via feature key \'demote_and_size\'). Replaces the',
    '// hard sell-impact block with size-down: a token whose measured exit cost sits between the',
    '// full-size cap and the hard ceiling is entered at a reduced size (cap / exitCost, floored)',
    '// instead of being rejected. Tokens above the hard ceiling are still blocked (real exit walls).',
    "const WORKER_DEMOTE_AND_SIZE_ENABLED = process.env.WORKER_DEMOTE_AND_SIZE_ENABLED !== 'false';",
    'const WORKER_DEMOTE_MAX_EXIT_BPS = Number(process.env.WORKER_DEMOTE_MAX_EXIT_BPS ?? 45);',
    'const WORKER_DEMOTE_SIZE_FLOOR_BPS = Number(process.env.WORKER_DEMOTE_SIZE_FLOOR_BPS ?? 3000);',
  ),
});

// Edit 2: demote-and-size entry sizing, inserted after the class-sizing apply block
edits.push({
  name: '2: demote sizing block',
  old: L(
    '        `entry size adjusted by class: ${entryInventory.outputSymbol} class=${classSizing.tokenClass} amount ${preClassAmount} -> ${classSizing.adjustedAmountAtomic} mult=${(classSizing.multiplierBps / 10_000).toFixed(2)}x`,',
    '      );',
    '    }',
    '',
    '    const routeStability = await assessEntryRouteStability({',
  ),
  neu: L(
    '        `entry size adjusted by class: ${entryInventory.outputSymbol} class=${classSizing.tokenClass} amount ${preClassAmount} -> ${classSizing.adjustedAmountAtomic} mult=${(classSizing.multiplierBps / 10_000).toFixed(2)}x`,',
    '      );',
    '    }',
    '',
    '    // Demote-and-size: shrink the entry by measured exit cost instead of hard-blocking it.',
    '    // Tokens whose recent sell-side impact sits between the full-size cap and the hard ceiling',
    '    // enter at a reduced size of (cap / exitCost), floored. Canary-scoped (Noah) until graduated;',
    '    // always computed for shadow telemetry so the fleet line shows what it WOULD do.',
    "    const demoteSizingActive = isFeatureActiveForSession(session, WORKER_DEMOTE_AND_SIZE_ENABLED, 'demote_and_size');",
    '    const exitCostBpsForSizing = await getRecentSellImpactBps(entryInventory.outputMint);',
    '    if (',
    '      exitCostBpsForSizing !== null',
    '      && exitCostBpsForSizing > WORKER_MAX_ENTRY_SELL_IMPACT_BPS',
    '      && exitCostBpsForSizing < WORKER_DEMOTE_MAX_EXIT_BPS',
    '    ) {',
    '      const rawDemoteMultBps = Math.round((WORKER_MAX_ENTRY_SELL_IMPACT_BPS / exitCostBpsForSizing) * 10_000);',
    '      const demoteMultBps = Math.min(10_000, Math.max(WORKER_DEMOTE_SIZE_FLOOR_BPS, rawDemoteMultBps));',
    '      const preDemoteAmount = entryInventory.amountAtomic ?? 0;',
    '      const demotedAmount = Math.floor((preDemoteAmount * demoteMultBps) / 10_000);',
    '      const demoteBelowMin = demotedAmount < entryInventory.minTradeAtomic;',
    '      log(',
    "        'info',",
    '        session.id,',
    "        `demote-and-size ${demoteSizingActive ? 'apply' : 'shadow'}: ${entryInventory.outputSymbol} exitCost=${exitCostBpsForSizing.toFixed(1)}bps mult=${(demoteMultBps / 10_000).toFixed(2)}x base=${preDemoteAmount} would=${demotedAmount}${demoteBelowMin ? ' (below_min_trade=kept_base)' : ''}`,",
    '      );',
    '      if (demoteSizingActive && !demoteBelowMin && demotedAmount > 0 && demotedAmount < preDemoteAmount) {',
    '        entryInventory.amountAtomic = demotedAmount;',
    '        entryInventory.riskAdjustedAmountAtomic = demotedAmount;',
    '      }',
    '    }',
    '',
    '    const routeStability = await assessEntryRouteStability({',
  ),
});

// Edit 3: gate threshold flip when demote-and-size is active for the session
edits.push({
  name: '3: gate threshold flip',
  old: L(
    '    const entryMint = tradePlan.inventory.outputMint;',
    '    const sellImpactBps = await getRecentSellImpactBps(entryMint);',
    '    if (sellImpactBps !== null && sellImpactBps > WORKER_MAX_ENTRY_SELL_IMPACT_BPS) {',
    '      prePrepareEntryGate = {',
    '        allowed: false,',
    "        reason: 'entry_sell_impact_too_high',",
    '        expectedEdgeBps: 0,',
    '        estimatedCostBps: Math.round(sellImpactBps),',
    '        safetyBufferBps: 0,',
    '      };',
    '      log(',
    "        'info',",
    '        session.id,',
    '        `sell-impact cap blocked entry: ${tradePlan.inventory.outputSymbol} (${entryMint}) sellImpact=${sellImpactBps.toFixed(1)}bps > cap ${WORKER_MAX_ENTRY_SELL_IMPACT_BPS}bps`,',
    '      );',
    '    }',
  ),
  neu: L(
    '    const entryMint = tradePlan.inventory.outputMint;',
    '    const sellImpactBps = await getRecentSellImpactBps(entryMint);',
    '    // When demote-and-size is active for this session the exit-cost band is handled by size-down',
    '    // (above), so the hard block only fires at the higher demote ceiling (the real exit wall).',
    '    // Normal fleet sessions keep the original full-size cap as the block threshold.',
    "    const demoteActiveForGate = isFeatureActiveForSession(session, WORKER_DEMOTE_AND_SIZE_ENABLED, 'demote_and_size');",
    '    const sellImpactBlockBps = demoteActiveForGate ? WORKER_DEMOTE_MAX_EXIT_BPS : WORKER_MAX_ENTRY_SELL_IMPACT_BPS;',
    '    if (sellImpactBps !== null && sellImpactBps > sellImpactBlockBps) {',
    '      prePrepareEntryGate = {',
    '        allowed: false,',
    "        reason: 'entry_sell_impact_too_high',",
    '        expectedEdgeBps: 0,',
    '        estimatedCostBps: Math.round(sellImpactBps),',
    '        safetyBufferBps: 0,',
    '      };',
    '      log(',
    "        'info',",
    '        session.id,',
    '        `sell-impact cap blocked entry: ${tradePlan.inventory.outputSymbol} (${entryMint}) sellImpact=${sellImpactBps.toFixed(1)}bps > cap ${sellImpactBlockBps}bps`,',
    '      );',
    '    }',
  ),
});

for (const e of edits) {
  const count = src.split(e.old).length - 1;
  if (count !== 1) {
    console.error(`FAIL [${e.name}]: expected exactly 1 occurrence, found ${count}`);
    process.exit(1);
  }
  src = src.replace(e.old, e.neu);
  console.log(`OK [${e.name}]`);
}

fs.writeFileSync(path, src, 'latin1');
console.log('WROTE', path);
