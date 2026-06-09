const fs = require('fs');
const path = 'services/worker/src/index.ts';
let src = fs.readFileSync(path, 'utf8');

const oldBlock =
`      const entryStrategyForPlan = selectedEntryStrategy;
      const entrySignalForPlan = selectedEntrySignal;
      if (!entryStrategyForPlan || !entrySignalForPlan) {`;

const newBlock =
`      // Decouple token entries from SOL/USD direction. Previously selectedEntryStrategy
      // was set ONLY when a strategy was bullish on the SOL/USD tape, so a ripping token
      // was never entered unless SOL was also pumping. Now, when SOL/USD has no bullish
      // trigger, we fall back to the active strategy as the per-token signal basis and let
      // the universe scout find a token that is persistently bullish on its OWN tape. The
      // scout enforces per-token persistent bullishness + flat-regime fallback suppression,
      // so this never buys chop. We only hard-block when the scout is disabled AND SOL/USD
      // produced no trigger (no other way to choose a target).
      const solStrategyTriggered = selectedEntryStrategy !== null && selectedEntrySignal !== null;
      const entryStrategyForPlan = selectedEntryStrategy ?? activeStrategy;
      const entrySignalForPlan = selectedEntrySignal ?? runtimeSignal;
      if (!WORKER_UNIVERSE_SCOUT_ENABLED && !solStrategyTriggered) {`;

const count = src.split(oldBlock).length - 1;
if (count !== 1) {
  console.error('ABORT: expected exactly 1 match, found ' + count);
  process.exit(1);
}
src = src.replace(oldBlock, newBlock);
fs.writeFileSync(path, src, 'utf8');
console.log('OK: decoupled SOL-gated entry (1 replacement)');
