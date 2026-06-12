// Fix the entry-drift guard to work within existing types.
// Instead of returning a new reason, just skip the stop_loss block entirely
// (don't return; let it fall through to shouldExit:false at end of function).
const fs = require('fs');
const P = 'services/worker/src/index.ts';
let s = fs.readFileSync(P, 'latin1');
const orig = s;

// Replace the guard block that returns entry_drift_suppressed with one that
// just prevents the stop_loss from firing (fall through to end = shouldExit:false).
const bad =
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
  "    }\r\n";

const good =
  "    // Cost-basis sanity guard: if the entryPriceUsd is wildly divergent from the\r\n" +
  "    // current mark, it is a fabricated orphan mark, not a real fill. Suppress\r\n" +
  "    // the stop_loss entirely — these phantom losses are not real market moves.\r\n" +
  "    const entryDriftBps = positionState.entryPriceUsd && markPriceUsd && markPriceUsd > 0\r\n" +
  "      ? Math.abs((positionState.entryPriceUsd - markPriceUsd) / markPriceUsd * 10_000)\r\n" +
  "      : 0;\r\n" +
  "    if (entryDriftBps > WORKER_MAX_SANE_ENTRY_DRIFT_BPS) {\r\n" +
  "      // Fall through to shouldExit:false — do NOT fire stop_loss on a fake mark.\r\n" +
  "    } else ";

const n = s.split(bad).length - 1;
if (n !== 1) throw new Error(`anchor matched ${n} times (need 1)`);
s = s.replace(bad, good);
if (s === orig) throw new Error('no change');
fs.writeFileSync(P, s, 'latin1');
console.log('OK entry-drift guard fixed for types; delta', s.length - orig.length);
