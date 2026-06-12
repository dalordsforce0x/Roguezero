const fs = require('fs');
let code = fs.readFileSync('services/worker/src/index.ts', 'utf8');

// Fix 1: Change bullish-only gate to not-bearish (allow flat through)
const old1 = "    if (signal.status === 'ready' && signal.regime === 'bullish') {";
const new1 = "    if (signal.status === 'ready' && signal.regime !== 'bearish') {";
if (!code.includes(old1)) { console.log('ERROR: old1 not found'); process.exit(1); }
code = code.replace(old1, new1);

// Fix 2: Add rotation block after persistLastSignal
const anchor = '  await persistLastSignal(session, selectedEntrySignal ?? runtimeSignal);\r\n\r\n  const lastTradeSubmittedMs';
if (!code.includes(anchor)) { console.log('ERROR: anchor not found'); process.exit(1); }

const rotationBlock = `  await persistLastSignal(session, selectedEntrySignal ?? runtimeSignal);

  // Always advance the rotation pointer for next loop so we don't dwell on
  // a blocked strategy. Advance past whichever strategy was selected (or past
  // activeStrategy if all were blocked).
  if (strategyConfig.autoRotationEnabled && enabledStrategies.length > 1) {
    const advanceFrom = selectedEntryStrategy ?? activeStrategy;
    const nextStrategy = getNextStrategyInSequence(advanceFrom, enabledStrategies);
    if (nextStrategy !== activeStrategy) {
      await persistServiceControl(session, {
        rotationState: {
          activeStrategy: nextStrategy,
          queuedStrategy: nextStrategy,
          rotationIntervalMinutes,
          lastRotatedAt: new Date().toISOString(),
          lockedUntil: null,
        },
      } as any);
      log('info', session.id, \`strategy rotation: \${activeStrategy} → \${nextStrategy} (selected=\${selectedEntryStrategy ?? 'none'})\`);
    }
  }

  const lastTradeSubmittedMs`;

code = code.replace(anchor, rotationBlock);

fs.writeFileSync('services/worker/src/index.ts', code);
console.log('OK: rotation fix applied to disk');
