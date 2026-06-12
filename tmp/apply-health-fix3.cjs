// Fix: Remove || hasOpenPositions from exit_blocked check
// Also remove stale_candles_no_fresh_signal from entryGateReasons (it's a data issue, not entry gate)
const fs = require('fs');
const file = 'services/worker/src/index.ts';
let src = fs.readFileSync(file, 'utf8');
let changes = 0;

// Detect line ending
const nl = src.includes('\r\n') ? '\r\n' : '\n';

// --- Fix 1: Remove || hasOpenPositions from exit_blocked ---
const exitBroken = `  if (reason && (exitBlockedReasons.has(reason) || hasOpenPositions)) {${nl}    return {${nl}      state: 'exit_blocked',`;
const exitFixed  = `  if (reason && exitBlockedReasons.has(reason)) {${nl}    return {${nl}      state: 'exit_blocked',`;

if (src.includes(exitBroken)) {
  src = src.replace(exitBroken, exitFixed);
  changes++;
  console.log('1. Removed || hasOpenPositions from exit_blocked check');
} else {
  console.log('1. FAIL: exit_blocked anchor not found');
  const idx = src.indexOf('exitBlockedReasons.has(reason)');
  if (idx > -1) {
    console.log('   Context:', JSON.stringify(src.substring(idx - 20, idx + 80)));
  }
}

// --- Fix 2: Remove stale_candles_no_fresh_signal from entryGateReasons ---
// It was incorrectly added; it's a data staleness issue, not an entry gate
const staleCandlesEntry = `  'stale_candles_no_fresh_signal',${nl}`;
if (src.includes(`  'entry_cooldown_active',${nl}  'stale_candles_no_fresh_signal',${nl}`)) {
  src = src.replace(`  'entry_cooldown_active',${nl}  'stale_candles_no_fresh_signal',${nl}`, `  'entry_cooldown_active',${nl}`);
  changes++;
  console.log('2. Removed stale_candles_no_fresh_signal from entryGateReasons');
} else {
  console.log('2. SKIP: stale_candles_no_fresh_signal not in entryGateReasons');
}

if (changes > 0) {
  fs.writeFileSync(file, src);
}
console.log(`\nDone: ${changes} changes applied.`);
