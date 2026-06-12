/**
 * Patch: Add measuredExitImpactBps: null to the second position constructor
 * (entry-at-buy, 14-space indent).
 */
const fs = require('fs');
const path = require('path');

const workerPath = path.join(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let src = fs.readFileSync(workerPath, 'utf8');

const targetCRLF = 'entryCostBps: null,\r\n              pendingExitReason: null,';
const targetLF = 'entryCostBps: null,\n              pendingExitReason: null,';
const target = src.includes(targetCRLF) ? targetCRLF : targetLF;
const nl = src.includes(targetCRLF) ? '\r\n' : '\n';

const idx = src.indexOf(target);
if (idx < 0) {
  console.error('FAIL: Could not find 14-space-indent position constructor');
  process.exit(1);
}

const replacement = `entryCostBps: null,${nl}              measuredExitImpactBps: null,${nl}              pendingExitReason: null,`;
src = src.substring(0, idx) + replacement + src.substring(idx + target.length);

fs.writeFileSync(workerPath, src);
console.log('✓ Added measuredExitImpactBps: null to entry-at-buy position constructor');
