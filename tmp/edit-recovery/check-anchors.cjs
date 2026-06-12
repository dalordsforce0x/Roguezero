const fs = require('fs');
const s = fs.readFileSync('services/worker/src/index.ts', 'latin1');

const A1 = "  if (tradePlan.direction === 'enter_long') {\n    const nextScannerStrategy = getNextStrategyInSequence(";
const A2 = "const pendingEntryQualityByMint = new Map<string, { score: number; band: string }>();";
const A3 = "        entryStrategy: null,\n        entryPriceUsd: markPriceUsd,\n        entryAt: nowIso,";

console.log('enter_long open count:', s.split(A1).length - 1);
console.log('map decl count:', s.split(A2).length - 1);
console.log('orphan block count:', s.split(A3).length - 1);
