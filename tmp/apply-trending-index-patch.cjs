const fs = require('node:fs');
const path = 'services/worker/src/index.ts';
let text = fs.readFileSync(path, 'utf8');
const replaceOnce = (oldText, newText, label) => {
  if (text.includes(newText)) {
    console.log(`${label}: already present`);
    return;
  }
  if (!text.includes(oldText)) {
    throw new Error(`${label}: old text not found`);
  }
  text = text.replace(oldText, newText);
  console.log(`${label}: applied`);
};
replaceOnce(
`  computeFullExitAmountAtomic,\n  computeGasRefillPlan,\n  resolveTradeGateAssessment,`,
`  computeFullExitAmountAtomic,\n  computeGasRefillPlan,\n  computeTrendingEntryShapeGate,\n  resolveTradeGateAssessment,`,
'import trending gate',
);
replaceOnce(
`const MARKET_SCANNER_MAX_PERSISTED_CANDIDATES = Number(process.env.WORKER_MARKET_SCANNER_MAX_PERSISTED_CANDIDATES ?? 50);\nconst RUNTIME_CONTROL_KEY = 'global_live_runtime';`,
`const MARKET_SCANNER_MAX_PERSISTED_CANDIDATES = Number(process.env.WORKER_MARKET_SCANNER_MAX_PERSISTED_CANDIDATES ?? 50);\nconst WORKER_TRENDING_ENTRY_SHAPE_GATE_ENABLED = process.env.WORKER_TRENDING_ENTRY_SHAPE_GATE_ENABLED !== 'false';\nconst WORKER_TRENDING_ENTRY_SHAPE_MIN_SAMPLES = Number(process.env.WORKER_TRENDING_ENTRY_SHAPE_MIN_SAMPLES ?? 12);\nconst WORKER_TRENDING_ENTRY_CHASE_LOOKBACK_SAMPLES = Number(process.env.WORKER_TRENDING_ENTRY_CHASE_LOOKBACK_SAMPLES ?? 4);\nconst WORKER_TRENDING_ENTRY_MAX_RECENT_SURGE_BPS = Number(process.env.WORKER_TRENDING_ENTRY_MAX_RECENT_SURGE_BPS ?? 80);\nconst WORKER_TRENDING_ENTRY_MIN_PULLBACK_BPS = Number(process.env.WORKER_TRENDING_ENTRY_MIN_PULLBACK_BPS ?? 35);\nconst WORKER_TRENDING_ENTRY_MIN_RECLAIM_BPS = Number(process.env.WORKER_TRENDING_ENTRY_MIN_RECLAIM_BPS ?? 20);\nconst WORKER_TRENDING_ENTRY_MAX_RANGE_POSITION_BPS = Number(process.env.WORKER_TRENDING_ENTRY_MAX_RANGE_POSITION_BPS ?? 8500);\nconst WORKER_TRENDING_ENTRY_MAX_NEGATIVE_WINDOW_BPS = Number(process.env.WORKER_TRENDING_ENTRY_MAX_NEGATIVE_WINDOW_BPS ?? 250);\nconst RUNTIME_CONTROL_KEY = 'global_live_runtime';`,
'env constants',
);
replaceOnce(
`    entryInventory.outputMint = selectedEntryMint;\n    entryInventory.outputSymbol = resolveTokenSymbol(selectedEntryMint);`,
`    const appliesTrendingShapeGate = WORKER_TRENDING_ENTRY_SHAPE_GATE_ENABLED\n      && selectedEntryMint !== SOL_MINT\n      && !TRUSTED_ENTRY_UNIVERSE_MINT_SET.has(selectedEntryMint);\n    if (appliesTrendingShapeGate) {\n      const shapeGate = computeTrendingEntryShapeGate({\n        enabled: true,\n        prices: getMomentumTapeForMint(selectedEntryMint).map((sample) => sample.usdPrice),\n        minSamples: WORKER_TRENDING_ENTRY_SHAPE_MIN_SAMPLES,\n        chaseLookbackSamples: WORKER_TRENDING_ENTRY_CHASE_LOOKBACK_SAMPLES,\n        maxRecentSurgeBps: WORKER_TRENDING_ENTRY_MAX_RECENT_SURGE_BPS,\n        minPullbackFromHighBps: WORKER_TRENDING_ENTRY_MIN_PULLBACK_BPS,\n        minReclaimFromLowBps: WORKER_TRENDING_ENTRY_MIN_RECLAIM_BPS,\n        maxRangePositionBps: WORKER_TRENDING_ENTRY_MAX_RANGE_POSITION_BPS,\n        maxNegativeWindowMomentumBps: WORKER_TRENDING_ENTRY_MAX_NEGATIVE_WINDOW_BPS,\n      });\n\n      if (!shapeGate.allowed) {\n        await persistTradeDecision(session, 'blocked', shapeGate.reason);\n        await persistLastTradeGate(session, {\n          at: new Date().toISOString(),\n          decision: 'blocked',\n          reason: shapeGate.reason,\n          expectedEdgeBps: tokenEntrySignal.momentumBps,\n          estimatedCostBps: shapeGate.metrics?.recentSurgeBps ?? null,\n          safetyBufferBps: strategyConfig.momentum.edgeSafetyBufferBps,\n        });\n        log(\n          'info',\n          session.id,\n          \`entry blocked: trending shape gate for \${resolveTokenSymbol(selectedEntryMint)} (\${selectedEntryMint}) reason=\${shapeGate.reason} samples=\${shapeGate.metrics?.sampleCount ?? 'n/a'} window=\${shapeGate.metrics?.windowMomentumBps ?? 'n/a'}bps surge=\${shapeGate.metrics?.recentSurgeBps ?? 'n/a'}bps pullback=\${shapeGate.metrics?.pullbackFromHighBps ?? 'n/a'}bps reclaim=\${shapeGate.metrics?.reclaimFromLowBps ?? 'n/a'}bps rangePos=\${shapeGate.metrics?.rangePositionBps ?? 'n/a'}bps\`,\n        );\n        return;\n      }\n    }\n\n    entryInventory.outputMint = selectedEntryMint;\n    entryInventory.outputSymbol = resolveTokenSymbol(selectedEntryMint);`,
'entry gate block',
);
replaceOnce(
`    universeScoutRequirePersistentBullish: WORKER_UNIVERSE_SCOUT_REQUIRE_PERSISTENT_BULLISH,\n    universeScoutMaxEntryPriceImpactBps: WORKER_UNIVERSE_SCOUT_MAX_ENTRY_PRICE_IMPACT_BPS,\n    maxConsecutiveLosses: WORKER_MAX_CONSECUTIVE_LOSSES,`,
`    universeScoutRequirePersistentBullish: WORKER_UNIVERSE_SCOUT_REQUIRE_PERSISTENT_BULLISH,\n    universeScoutMaxEntryPriceImpactBps: WORKER_UNIVERSE_SCOUT_MAX_ENTRY_PRICE_IMPACT_BPS,\n    trendingEntryShapeGateEnabled: WORKER_TRENDING_ENTRY_SHAPE_GATE_ENABLED,\n    trendingEntryShapeMinSamples: WORKER_TRENDING_ENTRY_SHAPE_MIN_SAMPLES,\n    trendingEntryChaseLookbackSamples: WORKER_TRENDING_ENTRY_CHASE_LOOKBACK_SAMPLES,\n    trendingEntryMaxRecentSurgeBps: WORKER_TRENDING_ENTRY_MAX_RECENT_SURGE_BPS,\n    trendingEntryMinPullbackBps: WORKER_TRENDING_ENTRY_MIN_PULLBACK_BPS,\n    trendingEntryMinReclaimBps: WORKER_TRENDING_ENTRY_MIN_RECLAIM_BPS,\n    trendingEntryMaxRangePositionBps: WORKER_TRENDING_ENTRY_MAX_RANGE_POSITION_BPS,\n    trendingEntryMaxNegativeWindowBps: WORKER_TRENDING_ENTRY_MAX_NEGATIVE_WINDOW_BPS,\n    maxConsecutiveLosses: WORKER_MAX_CONSECUTIVE_LOSSES,`,
'startup config',
);
fs.writeFileSync(path, text);
