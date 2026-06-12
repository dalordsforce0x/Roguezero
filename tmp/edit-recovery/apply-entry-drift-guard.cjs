// Add a cost-basis sanity guard to the stop_loss path:
// If entryPriceUsd is more than MAX_SANE_ENTRY_DRIFT_BPS away from the current
// mark, it's clearly a fabricated orphan mark, not a real fill price. Block the
// stop_loss and let the position sit until it either gets a real mark update or
// the entry-at-buy fix creates positions with correct prices going forward.
const fs = require('fs');
const P = 'services/worker/src/index.ts';
let s = fs.readFileSync(P, 'latin1');
const orig = s;

function replaceOnce(find, repl, label) {
  const n = s.split(find).length - 1;
  if (n !== 1) throw new Error(`anchor "${label}" matched ${n} times (need 1)`);
  s = s.replace(find, repl);
}

// Add the constant after WORKER_ANTI_CHURN_HARD_STOP_BPS
replaceOnce(
  "const WORKER_ANTI_CHURN_HARD_STOP_BPS = Math.max(0, Number(process.env.WORKER_ANTI_CHURN_HARD_STOP_BPS ?? 250));\r\n",
  "const WORKER_ANTI_CHURN_HARD_STOP_BPS = Math.max(0, Number(process.env.WORKER_ANTI_CHURN_HARD_STOP_BPS ?? 250));\r\n" +
  "// If the recorded entryPriceUsd diverges from the current mark by more than this,\r\n" +
  "// the cost basis is a fabricated orphan mark, not a real fill. Block stop_loss.\r\n" +
  "const WORKER_MAX_SANE_ENTRY_DRIFT_BPS = Math.max(0, Number(process.env.WORKER_MAX_SANE_ENTRY_DRIFT_BPS ?? 500));\r\n",
  'constant-decl',
);

// In the stop_loss branch, add a sanity check BEFORE the anti-churn check.
// The anchor is the stop_loss block inside evaluateExit.
replaceOnce(
  "  if (pnlBps !== null && pnlBps <= -thresholds.stopLossBps) {\r\n" +
  "    // Anti-churn: suppress the stop inside the min-hold window unless the loss is a\r\n" +
  "    // genuine blowout past the hard floor. Recovering positions then exit via\r\n" +
  "    // take_profit/trailing; true disasters still cut immediately.\r\n" +
  "    const withinAntiChurnHold = WORKER_ANTI_CHURN_MIN_HOLD_MS > 0\r\n" +
  "      && positionAgeMs < WORKER_ANTI_CHURN_MIN_HOLD_MS\r\n" +
  "      && pnlBps > -WORKER_ANTI_CHURN_HARD_STOP_BPS;\r\n" +
  "    if (!withinAntiChurnHold) {\r\n" +
  "      return {\r\n" +
  "        shouldExit: true,\r\n" +
  "        reason: 'stop_loss',\r\n",

  "  if (pnlBps !== null && pnlBps <= -thresholds.stopLossBps) {\r\n" +
  "    // Cost-basis sanity guard: if the entryPriceUsd is wildly divergent from the\r\n" +
  "    // current mark, it is a fabricated orphan mark, not a real fill. Suppress\r\n" +
  "    // the stop_loss entirely — these phantom losses are not real market moves.\r\n" +
  "    const entryDriftBps = positionState.entryPriceUsd && markPriceUsd && markPriceUsd > 0\r\n" +
  "      ? Math.abs((positionState.entryPriceUsd - markPriceUsd) / markPriceUsd * 10_000)\r\n" +
  "      : 0;\r\n" +
  "    if (entryDriftBps > WORKER_MAX_SANE_ENTRY_DRIFT_BPS) {\r\n" +
  "      return {\r\n" +
  "        shouldExit: false,\r\n" +
  "        reason: 'entry_drift_suppressed',\r\n" +
  "        markPriceUsd,\r\n" +
  "        pnlBps,\r\n" +
  "        trailingDrawdownBps,\r\n" +
  "        thresholds,\r\n" +
  "      };\r\n" +
  "    }\r\n" +
  "    // Anti-churn: suppress the stop inside the min-hold window unless the loss is a\r\n" +
  "    // genuine blowout past the hard floor. Recovering positions then exit via\r\n" +
  "    // take_profit/trailing; true disasters still cut immediately.\r\n" +
  "    const withinAntiChurnHold = WORKER_ANTI_CHURN_MIN_HOLD_MS > 0\r\n" +
  "      && positionAgeMs < WORKER_ANTI_CHURN_MIN_HOLD_MS\r\n" +
  "      && pnlBps > -WORKER_ANTI_CHURN_HARD_STOP_BPS;\r\n" +
  "    if (!withinAntiChurnHold) {\r\n" +
  "      return {\r\n" +
  "        shouldExit: true,\r\n" +
  "        reason: 'stop_loss',\r\n",
  'stop-loss-guard',
);

if (s === orig) throw new Error('no change applied');
fs.writeFileSync(P, s, 'latin1');
console.log('OK entry-drift guard applied; delta', s.length - orig.length);
