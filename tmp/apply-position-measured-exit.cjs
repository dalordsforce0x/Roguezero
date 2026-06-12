/**
 * Patch: Add measuredExitImpactBps: null to position constructors that are
 * missing it (required by session-schema but not present in worker).
 */
const fs = require('fs');
const path = require('path');

const workerPath = path.join(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let src = fs.readFileSync(workerPath, 'utf8');

// Both constructors have `entryCostBps: null,` followed by `pendingExitReason: null,`
// We need to insert `measuredExitImpactBps: null,` after `entryCostBps: null,`
// but ONLY in the position object literals (not random code).

// Pattern: "entryCostBps: null,\r\n        pendingExitReason: null,"
// Both instances have 8-space indent on entryCostBps.
const targetLF = 'entryCostBps: null,\n        pendingExitReason: null,';
const targetCRLF = 'entryCostBps: null,\r\n        pendingExitReason: null,';

let count = 0;
const target = src.includes(targetCRLF) ? targetCRLF : targetLF;
const nl = src.includes(targetCRLF) ? '\r\n' : '\n';
const replacement = `entryCostBps: null,${nl}        measuredExitImpactBps: null,${nl}        pendingExitReason: null,`;

let idx = 0;
while (true) {
  idx = src.indexOf(target, idx);
  if (idx < 0) break;
  src = src.substring(0, idx) + replacement + src.substring(idx + target.length);
  idx += replacement.length;
  count++;
}

if (count === 0) {
  console.error('FAIL: Could not find entryCostBps: null + pendingExitReason: null pattern');
  process.exit(1);
}

fs.writeFileSync(workerPath, src);
console.log(`✓ Added measuredExitImpactBps: null to ${count} position constructor(s)`);
