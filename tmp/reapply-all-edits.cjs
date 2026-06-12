/**
 * Re-apply all B2/B3/B4/C2/A1 edits to worker/src/index.ts.
 * The Node-based insert-perf-fee.cjs script read a stale disk copy and
 * overwrote VS Code buffer edits. This script patches the current disk file.
 */
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let c = fs.readFileSync(file, 'utf8');
let edits = 0;

function mustReplace(label, old, replacement) {
  if (!c.includes(old)) {
    console.error(`FATAL: cannot find target for ${label}`);
    process.exit(1);
  }
  c = c.replace(old, replacement);
  edits++;
  console.log(`  [${edits}] ${label}`);
}

function mustInsertBefore(label, target, block) {
  if (!c.includes(target)) {
    console.error(`FATAL: cannot find insertion point for ${label}`);
    process.exit(1);
  }
  if (c.includes(block.trim().split('\n')[1])) {
    console.log(`  [skip] ${label} (already present)`);
    return;
  }
  c = c.replace(target, block + target);
  edits++;
  console.log(`  [${edits}] ${label}`);
}

// ── 1. Import getPerformanceFeeConfig ──
mustReplace(
  'import getPerformanceFeeConfig',
  "  getWorkerSizingPolicy,\r\n  normalizeRuntimeSpeedProfileName,",
  "  getWorkerSizingPolicy,\r\n  getPerformanceFeeConfig,\r\n  normalizeRuntimeSpeedProfileName,"
);

// ── 2. Import geckoTerminalCandles types ──
// Check if already imported
if (!c.includes("from './geckoTerminalCandles.js'")) {
  // Already present from earlier partial edit
}

// ── 3. Add GeckoTerminalCandleFeed import alongside gecko import ──
if (!c.includes('GeckoTerminalCandleFeed')) {
  mustReplace(
    'add GeckoTerminalCandleFeed type import',
    "} from './geckoTerminalCandles.js';",
    "  type GeckoTerminalCandleFeed,\r\n} from './geckoTerminalCandles.js';"
  );
}

// ── 4. Add createGeckoTerminalCandleFeed import ──
if (!c.includes('createGeckoTerminalCandleFeed')) {
  mustReplace(
    'add createGeckoTerminalCandleFeed import',
    "} from './geckoTerminalCandles.js';",
    "  createGeckoTerminalCandleFeed,\r\n} from './geckoTerminalCandles.js';"
  );
}

// ── 5. Add performanceFeeConfig initialization ──
mustReplace(
  'add performanceFeeConfig const',
  "const sizingPolicy = getWorkerSizingPolicy(process.env);\r\n",
  "const sizingPolicy = getWorkerSizingPolicy(process.env);\r\nconst performanceFeeConfig = getPerformanceFeeConfig(process.env);\r\n"
);

// ── 6. Add geckoFeed + computeRelativeVolume after jupiterMomentumTapeByMint ──
if (!c.includes('const geckoFeed')) {
  const geckoBlock = [
    '',
    '// \u2500\u2500 GeckoTerminal shared 1-min OHLCV candle feed (B2: volume confirmation) \u2500\u2500\u2500',
    '// Fleet-wide: one feed, all sessions consume. Free API, ~30 req/min ceiling.',
    '// The feed provides volume data for RVOL (relative volume) entry gating.',
    'const geckoFeed: GeckoTerminalCandleFeed = createGeckoTerminalCandleFeed({',
    '  fetchJson: async (url: string) => {',
    '    try {',
    '      const res = await fetch(url);',
    '      if (!res.ok) return null;',
    '      return await res.json();',
    '    } catch {',
    '      return null;',
    '    }',
    '  },',
    '  acquire: async () => {},',
    '  log: (entry) => {',
    "    if (entry.event === 'error' || entry.event === 'warn') {",
    "      console.log(JSON.stringify({ source: 'geckoFeed', ...entry }));",
    '    }',
    '  },',
    '});',
    '',
    '// RVOL (relative volume) computation for a mint: current candle volume / avg volume.',
    '// Returns null if insufficient data. RVOL > 1.0 = above-average volume.',
    'const computeRelativeVolume = (mint: string, lookback = 20): number | null => {',
    '  const volumes = geckoFeed.getVolumes(mint);',
    '  if (volumes.length < lookback + 1) return null;',
    '  const currentVolume = volumes[volumes.length - 1];',
    '  const avgVolume = volumes.slice(-lookback - 1, -1).reduce((s, v) => s + v, 0) / lookback;',
    '  if (avgVolume <= 0) return null;',
    '  return currentVolume / avgVolume;',
    '};',
    '',
  ].join('\r\n');

  mustReplace(
    'add geckoFeed + computeRelativeVolume',
    'const jupiterMomentumTapeByMint = new Map<string, MarketTapePoint[]>();\r\n\r\ntype PersistedMarketTapeRow',
    'const jupiterMomentumTapeByMint = new Map<string, MarketTapePoint[]>();\r\n' + geckoBlock + 'type PersistedMarketTapeRow'
  );
}

// ── 7. Add geckoFeed.refreshMints in price loop after applyTokenUniverseAutoSort ──
if (!c.includes('geckoFeed.refreshMints')) {
  const refreshBlock = [
    '',
    '    // B2: Refresh GeckoTerminal 1-min OHLCV candles for active universe mints.',
    "    if (tokenUniverseActiveMints.length > 0) {",
    '      void geckoFeed.refreshMints(tokenUniverseActiveMints).catch(() => {});',
    '    }',
    '',
  ].join('\r\n');

  mustReplace(
    'add geckoFeed.refreshMints in price loop',
    '    await applyTokenUniverseAutoSort();\r\n\r\n    await persistMarketTapeState();',
    '    await applyTokenUniverseAutoSort();\r\n' + refreshBlock + '    await persistMarketTapeState();'
  );
}

// ── 8. B4+C2: Add regime + token-class exit scaling in computeDynamicExitThresholds ──
if (!c.includes('regimeTpScale')) {
  const regimeBlock = [
    '',
    '  // \u2500\u2500 B4: Regime-based exit scaling \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
    '  // Trending market \u2192 widen TP and trailing stop (let profits run)',
    '  // Ranging market \u2192 tighten TP and trailing stop (take quick profits)',
    '  const regime = recommendStrategy(sharedMarketTape.solUsdPyth);',
    '  let regimeTpScale = 1.0;',
    '  let regimeTrailingScale = 1.0;',
    "  if (regime.reason === 'expanding_bands_steep_slope') {",
    '    regimeTpScale = 1.3;',
    '    regimeTrailingScale = 1.2;',
    "  } else if (regime.reason === 'narrow_bands_flat_slope') {",
    '    regimeTpScale = 0.8;',
    '    regimeTrailingScale = 0.8;',
    '  }',
    '',
    '  // \u2500\u2500 C2: Token-class exit profile adjustment \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
    '  const mint = getPositionMint(positionState);',
    '  const tokenClass = getTokenTradeClass(mint, getPositionSymbol(positionState));',
    '  let classTpScale = 1.0;',
    '  let classTrailingScale = 1.0;',
    "  if (tokenClass === 'major') {",
    '    classTpScale = 0.85;',
    '    classTrailingScale = 0.9;',
    "  } else if (tokenClass === 'long_tail') {",
    '    classTpScale = 1.2;',
    '    classTrailingScale = 0.8;',
    '  }',
    '  const combinedTpScale = regimeTpScale * classTpScale;',
    '  const combinedTrailingScale = regimeTrailingScale * classTrailingScale;',
    '',
  ].join('\r\n');

  mustReplace(
    'add regime + token-class exit scaling',
    '  const costFloorBps = computeExitCostFloorBps(session, positionState);\r\n  const atrBps = positionState.lastComputedAtrBps ?? null;',
    '  const costFloorBps = computeExitCostFloorBps(session, positionState);\r\n  const atrBps = positionState.lastComputedAtrBps ?? null;\r\n' + regimeBlock
  );

  // Apply combinedTpScale and combinedTrailingScale to exit thresholds
  // Fallback branch TP
  mustReplace(
    'fallback TP regime scale',
    'takeProfitBps: applyTakeProfitTimeDecay(Math.max(positionExitPolicy.takeProfitBps, costFloorBps)),',
    'takeProfitBps: applyTakeProfitTimeDecay(Math.max(Math.round(positionExitPolicy.takeProfitBps * combinedTpScale), costFloorBps)),'
  );

  // Fallback branch trailing
  mustReplace(
    'fallback trailing regime scale',
    'trailingStopBps: Math.max(positionExitPolicy.trailingStopBps, costFloorBps),',
    'trailingStopBps: Math.max(Math.round(positionExitPolicy.trailingStopBps * combinedTrailingScale), costFloorBps),'
  );

  // ATR branch TP
  mustReplace(
    'ATR TP regime scale',
    'Math.round(atrBps * positionExitPolicy.atrTakeProfitMultiplier * (1 + signalStrengthBoost)),',
    'Math.round(atrBps * positionExitPolicy.atrTakeProfitMultiplier * (1 + signalStrengthBoost) * combinedTpScale),'
  );

  // ATR branch trailing
  mustReplace(
    'ATR trailing regime scale',
    'Math.round(atrBps * positionExitPolicy.atrTrailingStopMultiplier),',
    'Math.round(atrBps * positionExitPolicy.atrTrailingStopMultiplier * combinedTrailingScale),'
  );
}

// ── 9. B3: Wire recommendStrategy into baton pass ──
// Find the baton pass location where getNextStrategyInSequence is used
if (!c.includes('regime.recommended')) {
  // Find the baton pass: 'getNextStrategyInSequence(currentStrategy, enabledStrategies)'
  // This is in the strategy rotation section. We need to replace it with recommendStrategy.
  // Let me search for it first
  const batonIdx = c.indexOf('getNextStrategyInSequence(');
  if (batonIdx >= 0) {
    // Find the context around it to make a precise replacement
    const beforeBaton = c.substring(Math.max(0, batonIdx - 200), batonIdx);
    // Check if this is the baton pass (not the function definition)
    const defIdx = c.indexOf('export const getNextStrategyInSequence');
    if (batonIdx !== defIdx) {
      // Find the full line
      const lineStart = c.lastIndexOf('\n', batonIdx) + 1;
      const lineEnd = c.indexOf('\n', batonIdx);
      const fullLine = c.substring(lineStart, lineEnd).trim();
      console.log('  Baton pass line:', fullLine);
      // This needs the full context to do properly - skip for now and do via VS Code
      console.log('  [DEFERRED] B3 baton pass needs VS Code edit (context-dependent)');
    }
  }
}

// ── 10. B2: RVOL entry gate ──
if (!c.includes('rvol_below_threshold')) {
  const rvolBlock = [
    '',
    "  // \u2500\u2500 B2: RVOL entry gate \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
    "  // Block entries when current candle volume is below average (RVOL < 1.0).",
    "  if (tradePlan.direction === 'enter_long') {",
    '    const entryMint = tradePlan.inventory.outputMint;',
    '    const rvol = computeRelativeVolume(entryMint);',
    '    const rvolThreshold = 1.0;',
    '    if (rvol !== null && rvol < rvolThreshold) {',
    "      const rvolReason = 'rvol_below_threshold';",
    '      recordTradePlanEntryRejectCooldown(session, tradePlan, rvolReason);',
    "      await persistTradeDecision(session, 'blocked', rvolReason);",
    '      log(',
    "        'info',",
    '        session.id,',
    '        `RVOL gate blocked entry: mint=${entryMint} rvol=${rvol.toFixed(2)} threshold=${rvolThreshold}`,',
    '      );',
    '      return;',
    '    }',
    '    if (rvol !== null) {',
    "      log('info', session.id, `RVOL gate passed: mint=${entryMint} rvol=${rvol.toFixed(2)}`);",
    '    }',
    '  }',
    '',
  ].join('\r\n');

  // Insert before the sizing loop
  mustReplace(
    'add RVOL entry gate before sizing loop',
    '  for (let attempt = 1; attempt <= 2; attempt++) {\r\n    log(\r\n      \'info\',\r\n      session.id,\r\n      `preparing swap:',
    rvolBlock + '  for (let attempt = 1; attempt <= 2; attempt++) {\r\n    log(\r\n      \'info\',\r\n      session.id,\r\n      `preparing swap:'
  );
}

fs.writeFileSync(file, c);
console.log(`\nDone: ${edits} edits applied.`);
