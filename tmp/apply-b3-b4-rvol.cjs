/**
 * Apply regime exit scaling (B4) to the REAL disk version of computeDynamicExitThresholds.
 * The disk version already has token-class exit profiles via getTokenClassExitProfile.
 * We add regime-based scaling on top of that.
 */
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let c = fs.readFileSync(file, 'utf8');
let edits = 0;

function mustReplace(label, old, replacement) {
  if (!c.includes(old)) {
    console.error(`FATAL: cannot find target for [${label}]`);
    console.error('Searching for:', JSON.stringify(old.substring(0, 80)));
    process.exit(1);
  }
  c = c.replace(old, replacement);
  edits++;
  console.log(`  [${edits}] ${label}`);
}

// ── B4: Add regime scaling right after atrBps declaration ──
if (!c.includes('regimeTpScale')) {
  const regimeBlock = [
    '  const atrBps = positionState.lastComputedAtrBps ?? null;',
    '',
    '  // \u2500\u2500 B4: Regime-based exit scaling \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
    '  // Trending: widen TP (+30%) and trailing (+20%) \u2014 let winners ride.',
    '  // Ranging: tighten TP (-20%) and trailing (-20%) \u2014 take quick profits.',
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
  ].join('\r\n');

  mustReplace(
    'B4 regime scaling',
    '  const atrBps = positionState.lastComputedAtrBps ?? null;\r\n  // Token-class exit profile',
    regimeBlock + '  // Token-class exit profile'
  );

  // Apply regime scale to ATR branch: TP
  mustReplace(
    'B4 ATR TP regime scale',
    'Math.round(atrBps * exitProfile.takeProfitMult * (1 + signalStrengthBoost)),',
    'Math.round(atrBps * exitProfile.takeProfitMult * (1 + signalStrengthBoost) * regimeTpScale),'
  );

  // Apply regime scale to ATR branch: trailing
  mustReplace(
    'B4 ATR trailing regime scale',
    'Math.round(atrBps * exitProfile.trailingStopMult),',
    'Math.round(atrBps * exitProfile.trailingStopMult * regimeTrailingScale),'
  );

  // Apply regime scale to fallback branch: TP
  mustReplace(
    'B4 fallback TP regime scale',
    'takeProfitBps: applyTakeProfitTimeDecay(Math.max(positionExitPolicy.takeProfitBps, costFloorBps)),',
    'takeProfitBps: applyTakeProfitTimeDecay(Math.max(Math.round(positionExitPolicy.takeProfitBps * regimeTpScale), costFloorBps)),'
  );

  // Apply regime scale to fallback branch: trailing
  mustReplace(
    'B4 fallback trailing regime scale',
    'trailingStopBps: Math.max(positionExitPolicy.trailingStopBps, positionExitPolicy.trailingStopFloorBps),',
    'trailingStopBps: Math.max(Math.round(positionExitPolicy.trailingStopBps * regimeTrailingScale), positionExitPolicy.trailingStopFloorBps),'
  );
}

// ── B3: Wire recommendStrategy into baton pass ──
// The baton pass currently uses getNextStrategyInSequence. 
// Need to find where it's called in the strategy rotation context.
if (!c.includes('regime.recommended')) {
  // Find the baton pass usage (not the definition)
  const defPattern = 'export const getNextStrategyInSequence';
  const usagePattern = 'getNextStrategyInSequence(';
  let pos = 0;
  let batonUsageIdx = -1;
  while (true) {
    const idx = c.indexOf(usagePattern, pos);
    if (idx < 0) break;
    // Skip if it's the definition in strategies.ts (imported, not in this file)
    const lineStart = c.lastIndexOf('\n', idx) + 1;
    const line = c.substring(lineStart, c.indexOf('\n', idx));
    if (!line.includes('export') && !line.includes('import')) {
      batonUsageIdx = idx;
      break;
    }
    pos = idx + 1;
  }
  
  if (batonUsageIdx >= 0) {
    // Get the full statement
    const lineStart = c.lastIndexOf('\n', batonUsageIdx) + 1;
    const lineEnd = c.indexOf('\n', batonUsageIdx);
    const fullLine = c.substring(lineStart, lineEnd);
    console.log('  Found baton pass line:', fullLine.trim());
    
    // Find the preceding and following context to do a safe replacement
    const contextStart = c.lastIndexOf('\n', lineStart - 2) + 1;
    const contextEnd = c.indexOf('\n', lineEnd + 1);
    const prevLine = c.substring(contextStart, lineStart - 1);
    const nextLine = c.substring(lineEnd + 1, contextEnd);
    console.log('  Prev:', prevLine.trim());
    console.log('  Next:', nextLine.trim());
    
    // Replace the getNextStrategyInSequence call with recommendStrategy-based selection
    const oldBaton = fullLine;
    // Extract variable name and args
    const match = fullLine.match(/(\s+)(\w+)\s*=\s*getNextStrategyInSequence\(([^)]+)\)/);
    if (match) {
      const indent = match[1];
      const varName = match[2];
      const args = match[3]; // e.g. "currentStrategy, enabledStrategies"
      const argsArr = args.split(',').map(s => s.trim());
      const enabledArg = argsArr[1] || 'enabledStrategies';
      
      const newBaton = [
        `${indent}// B3: Regime-based strategy selection instead of blind round-robin`,
        `${indent}const regime = recommendStrategy(sharedMarketTape.solUsdPyth);`,
        `${indent}const recommendedKey = regime.recommended;`,
        `${indent}const enabledSet = new Set(${enabledArg});`,
        `${indent}${varName} = enabledSet.has(recommendedKey) ? recommendedKey : getNextStrategyInSequence(${args});`,
      ].join('\r\n');
      
      mustReplace('B3 baton pass', oldBaton, newBaton);
    } else {
      console.log('  [WARN] Could not parse baton pass line pattern');
    }
  } else {
    console.log('  [SKIP] B3: getNextStrategyInSequence usage not found');
  }
}

// ── B2: RVOL entry gate ──
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

  // Find the for loop that starts the sizing attempts
  const sizeLoopTarget = "  for (let attempt = 1; attempt <= 2; attempt++) {";
  if (c.includes(sizeLoopTarget)) {
    // Find the SECOND occurrence (the one inside executeTrade, not elsewhere)
    const firstIdx = c.indexOf(sizeLoopTarget);
    const secondIdx = c.indexOf(sizeLoopTarget, firstIdx + 1);
    // Use the one that's near executeTrade (after line ~8000)
    const targetIdx = secondIdx > 0 ? secondIdx : firstIdx;
    
    // Insert the RVOL block before this loop
    c = c.substring(0, targetIdx) + rvolBlock + c.substring(targetIdx);
    edits++;
    console.log(`  [${edits}] RVOL entry gate`);
  } else {
    console.log('  [WARN] sizing loop target not found for RVOL gate');
  }
}

fs.writeFileSync(file, c);
console.log(`\nDone: ${edits} edits applied.`);
