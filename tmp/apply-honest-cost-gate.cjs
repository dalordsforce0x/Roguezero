const fs = require('fs');
const path = 'services/worker/src/index.ts';
let src = fs.readFileSync(path, 'utf8');

const L = (...lines) => lines.join('\n');

const oldBlock = L(
  '    signalThresholdBps: tradePlan.signalSnapshot.strategy === \'momentum\'',
  '      ? Math.max(',
  '        Number(tradePlan.signalSnapshot.thresholdBps ?? 0),',
  '        strategyConfig.momentum.thresholdBps,',
  '      )',
  '      : 0,',
  '    safetyBufferBps: strategyConfig.momentum.edgeSafetyBufferBps,',
  '  });',
);

const newBlock = L(
  '    signalThresholdBps: tradePlan.signalSnapshot.strategy === \'momentum\'',
  '      ? Math.max(',
  '        Number(tradePlan.signalSnapshot.thresholdBps ?? 0),',
  '        strategyConfig.momentum.thresholdBps,',
  '      )',
  '      : 0,',
  '    safetyBufferBps: strategyConfig.momentum.edgeSafetyBufferBps,',
  '    // Honest round-trip cost (entry + exit legs): slippage + platform fee, both ways.',
  '    // Only binding for momentum, whose edge metric is comparable to cost; other',
  '    // strategies remain cost-protected by the downstream route/exit-liquidity gates.',
  '    estimatedCostBps: tradePlan.signalSnapshot.strategy === \'momentum\'',
  '      ? (WORKER_EXIT_EXPECTED_SLIPPAGE_BPS + Number(session.service_control.platformFeeBps ?? 0)) * 2',
  '      : 0,',
  '  });',
);

const count = src.split(oldBlock).length - 1;
if (count !== 1) {
  console.error(`FAIL: expected exactly 1 occurrence of oldBlock, found ${count}`);
  process.exit(1);
}
src = src.split(oldBlock).join(newBlock);
fs.writeFileSync(path, src, 'utf8');
console.log('OK: honest-cost estimatedCostBps wired into pre-prepare gate call site');
