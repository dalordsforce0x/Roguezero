/**
 * Remove the DUPLICATE performance fee block in finalizeStop (lines ~10542-10610).
 * The REAL implementation lives in sweepFunds (lines ~10337-10382) and is already
 * complete, feature-gated, and bundles the fee into the sweep tx.
 */
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let c = fs.readFileSync(file, 'utf8');

const startMarker = '  // ── A1: Performance fee deduction';
const endMarker = '  const sweepResult = await sweepFunds(session);';

const startIdx = c.indexOf(startMarker);
if (startIdx < 0) {
  console.log('Duplicate fee block already removed or not found, skipping');
  process.exit(0);
}

const endIdx = c.indexOf(endMarker, startIdx);
if (endIdx < 0) {
  console.error('FATAL: cannot find end marker (sweepFunds call)');
  process.exit(1);
}

// Remove everything from startMarker to just before sweepFunds call
c = c.substring(0, startIdx) + c.substring(endIdx);
fs.writeFileSync(file, c);
console.log('Removed duplicate A1 performance fee block from finalizeStop.');
console.log('Real implementation lives in sweepFunds (~line 10337).');
