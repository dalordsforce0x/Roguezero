/**
 * Comprehensive fix script for 3 issues:
 * 
 * 1. WORKER: Submit failure handler doesn't cancel prepared execution
 *    → Adds cancel call matching the pattern used in sign_failed handler
 * 
 * 2. API: WebSocket watcher doesn't track enhanced vs standard subscriptions
 *    → stopWatchingSubmittedExecution calls removeSignatureListener for enhanced WS subs
 *    → Fix: add `enhanced` flag to watcher map, use correct unsubscribe method
 * 
 * 3. API: Watcher map type needs `enhanced` boolean field
 */

const fs = require('fs');

// ═══════════════════════════════════════════════════════════════
// FIX 1: Worker submit failure cancel
// ═══════════════════════════════════════════════════════════════
const workerPath = 'services/worker/src/index.ts';
let worker = fs.readFileSync(workerPath, 'utf8');

const submitReturnMarker = "preserving session funds`,\r\n      );\r\n    }\r\n    return;\r\n  }\r\n\r\n  log('info', session.id, `trade submitted";

if (worker.indexOf(submitReturnMarker) === -1) {
  console.error('WORKER FIX 1 FAILED: cannot find submit failure return block');
  process.exit(1);
}

const submitReturnReplacement = "preserving session funds`,\r\n      );\r\n    }\r\n    // Cancel the prepared execution so the session isn't blocked forever\r\n    try {\r\n      await apiPost(`/jupiter/swap/executions/${prepare.data.executionId}/cancel`, {\r\n        stage: 'worker_cancel',\r\n        reason: 'submit_failed',\r\n      });\r\n    } catch (cancelErr) {\r\n      log('warn', session.id, `cancel prepared execution failed after submit error: ${String(cancelErr)}`);\r\n    }\r\n    return;\r\n  }\r\n\r\n  log('info', session.id, `trade submitted";

worker = worker.replace(submitReturnMarker, submitReturnReplacement);
console.log('FIX 1 OK: Worker submit failure now cancels prepared execution');

fs.writeFileSync(workerPath, worker, 'utf8');
console.log('Worker file written');

// ═══════════════════════════════════════════════════════════════
// FIX 2 & 3: API WebSocket watcher type + cleanup
// ═══════════════════════════════════════════════════════════════
const apiPath = 'services/api/src/index.ts';
let api = fs.readFileSync(apiPath, 'utf8');

// Fix 2a: Change watcher map type to include `enhanced` boolean
const oldType = "const submittedExecutionWatchers = new Map<string, { signature: string; listenerId: number }>();";
const newType = "const submittedExecutionWatchers = new Map<string, { signature: string; listenerId: number; enhanced: boolean }>();";

if (api.indexOf(oldType) === -1) {
  console.error('API FIX 2a FAILED: cannot find watcher map type declaration');
  process.exit(1);
}
api = api.replace(oldType, newType);
console.log('FIX 2a OK: Watcher map type now includes enhanced flag');

// Fix 2b: stopWatchingSubmittedExecution — use correct unsubscribe based on enhanced flag
const oldStop = [
  "const stopWatchingSubmittedExecution = (executionId: string) => {\r\n",
  "  const watcher = submittedExecutionWatchers.get(executionId);\r\n",
  "\r\n",
  "  if (!watcher || !heliusConnection) {\r\n",
  "    return;\r\n",
  "  }\r\n",
  "\r\n",
  "  heliusConnection.removeSignatureListener(watcher.listenerId).catch((error) => {\r\n",
  "    app.log.warn({ error, executionId, signature: watcher.signature }, 'failed to remove submitted execution signature listener');\r\n",
  "  });\r\n",
  "  submittedExecutionWatchers.delete(executionId);\r\n",
  "};"
].join('');

const newStop = [
  "const stopWatchingSubmittedExecution = (executionId: string) => {\r\n",
  "  const watcher = submittedExecutionWatchers.get(executionId);\r\n",
  "\r\n",
  "  if (!watcher) {\r\n",
  "    return;\r\n",
  "  }\r\n",
  "\r\n",
  "  if (watcher.enhanced && enhancedWsClient) {\r\n",
  "    enhancedWsClient.unsubscribe(watcher.listenerId);\r\n",
  "  } else if (heliusConnection) {\r\n",
  "    heliusConnection.removeSignatureListener(watcher.listenerId).catch((error) => {\r\n",
  "      app.log.warn({ error, executionId, signature: watcher.signature }, 'failed to remove submitted execution signature listener');\r\n",
  "    });\r\n",
  "  }\r\n",
  "  submittedExecutionWatchers.delete(executionId);\r\n",
  "};"
].join('');

if (api.indexOf(oldStop) === -1) {
  console.error('API FIX 2b FAILED: cannot find stopWatchingSubmittedExecution function');
  process.exit(1);
}
api = api.replace(oldStop, newStop);
console.log('FIX 2b OK: stopWatchingSubmittedExecution now uses correct unsubscribe method');

// Fix 2c: Where enhanced WS watcher is stored, add enhanced: true
const oldEnhancedSet = "submittedExecutionWatchers.set(executionId, { signature, listenerId: subId });";
const newEnhancedSet = "submittedExecutionWatchers.set(executionId, { signature, listenerId: subId, enhanced: true });";

if (api.indexOf(oldEnhancedSet) === -1) {
  console.error('API FIX 2c FAILED: cannot find enhanced watcher set');
  process.exit(1);
}
api = api.replace(oldEnhancedSet, newEnhancedSet);
console.log('FIX 2c OK: Enhanced WS watcher now tagged as enhanced: true');

// Fix 2d: Where standard WS watcher is stored (fallback inside enhanced catch + standalone), add enhanced: false
// There are two places: the catch fallback and the standalone standard path
const oldStandardSet = "submittedExecutionWatchers.set(executionId, { signature, listenerId });";
const newStandardSet = "submittedExecutionWatchers.set(executionId, { signature, listenerId, enhanced: false });";

const count = (api.match(new RegExp(oldStandardSet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
if (count === 0) {
  console.error('API FIX 2d FAILED: cannot find standard watcher set');
  process.exit(1);
}
// Replace all occurrences (should be 2: catch fallback + standalone)
api = api.split(oldStandardSet).join(newStandardSet);
console.log(`FIX 2d OK: ${count} standard WS watcher(s) now tagged as enhanced: false`);

fs.writeFileSync(apiPath, api, 'utf8');
console.log('API file written');

console.log('\n=== ALL FIXES APPLIED ===');
console.log('1. Worker: submit failure now cancels prepared execution');
console.log('2. API: WebSocket cleanup uses correct unsubscribe (enhanced vs standard)');
console.log('3. API: Watcher map tracks subscription type');
