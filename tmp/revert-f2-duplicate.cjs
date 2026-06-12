/**
 * Revert F2 additions — the feature already exists as profitHandling in user_control.
 */
const fs = require('fs');
const path = require('path');

// 1. Remove profitTakingMode from session schema
const schemaFile = path.join(__dirname, '..', 'packages', 'session-schema', 'src', 'index.ts');
let s = fs.readFileSync(schemaFile, 'utf8');
if (s.includes('profitTakingMode')) {
  // Remove the 4 lines + empty line
  const start = s.indexOf("  // F2: per-session profit-taking mode.");
  if (start >= 0) {
    const end = s.indexOf("\r\n  // Set when a session finalizes", start);
    if (end >= 0) {
      s = s.substring(0, start) + s.substring(end + 2); // +2 for \r\n
      fs.writeFileSync(schemaFile, s);
      console.log('[schema] Removed profitTakingMode (already exists as profitHandling)');
    }
  }
}

// 2. Remove maybeSendTakeProfitPayout from worker
const workerFile = path.join(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let w = fs.readFileSync(workerFile, 'utf8');
if (w.includes('maybeSendTakeProfitPayout')) {
  const start = w.indexOf('\r\n// ── F2: Profit-taking payout at take-profit exit');
  if (start >= 0) {
    const endMarker = 'const sweepFunds = async';
    const end = w.indexOf(endMarker, start);
    if (end >= 0) {
      w = w.substring(0, start) + '\r\n\r\n' + w.substring(end);
      fs.writeFileSync(workerFile, w);
      console.log('[worker] Removed maybeSendTakeProfitPayout (already exists as attemptPendingExitProfitPayout)');
    }
  }
}

console.log('\nF2 revert complete — feature already exists in codebase.');
