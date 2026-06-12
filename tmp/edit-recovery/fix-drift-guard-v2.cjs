// Fix: replace the return { shouldExit:false, reason:'entry_drift_suppressed' }
// with a simple else-block that lets the stop_loss path be skipped.
const fs = require('fs');
const P = 'services/worker/src/index.ts';
let s = fs.readFileSync(P, 'latin1');
const orig = s;

const bad =
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
  "    // Anti-churn:";

const good =
  "    if (entryDriftBps <= WORKER_MAX_SANE_ENTRY_DRIFT_BPS) {\r\n" +
  "    // Anti-churn:";

const n = s.split(bad).length - 1;
if (n !== 1) throw new Error(`anchor matched ${n} times (need 1)`);
s = s.replace(bad, good);

// Now I need to close the brace properly. The anti-churn block ends with
// the return { shouldExit: true, reason: 'stop_loss' ... }; that's already
// properly brace-closed. I just need to add a closing brace after the
// existing stop_loss return block to close the if(entryDriftBps<=...) block.
// Let me find the "if (!withinAntiChurnHold) {" block end.
// Actually easier: wrap the ENTIRE anti-churn + stop_loss block in the if.
// The structure now is:
//   if (entryDriftBps <= MAX) {
//     // Anti-churn ...
//     if (!withinAntiChurnHold) { return stop_loss }
//   }
// I need to find the closing brace of the stop_loss return and add another }.
// Find the pattern: the stop_loss return block ends with "    }\r\n  }\r\n"
// (closing the if(!withinAntiChurnHold) and closing the if(pnlBps <= ...) blocks)

// Actually no, let me think about the structure more carefully.
// Before my edit the code was:
//   if (pnlBps !== null && pnlBps <= -thresholds.stopLossBps) {
//     ... drift guard ...
//     // Anti-churn:
//     const withinAntiChurnHold = ...
//     if (!withinAntiChurnHold) {
//       return { shouldExit: true, reason: 'stop_loss', ... };
//     }
//   }
// After my edit it becomes:
//   if (pnlBps !== null && pnlBps <= -thresholds.stopLossBps) {
//     ... drift calc ...
//     if (entryDriftBps <= MAX) {
//     // Anti-churn:
//     const withinAntiChurnHold = ...
//     if (!withinAntiChurnHold) {
//       return { shouldExit: true, reason: 'stop_loss', ... };
//     }
//   }   <-- this closes the pnlBps block but I need to close the drift block
//
// I need to add a "}" before the existing closing "}" of the pnlBps block.
// Find: "    }\r\n  }\r\n" after the stop_loss return.

// Let me find the stop_loss return and its surrounding braces
const stopReturnIdx = s.indexOf("        reason: 'stop_loss',");
console.log('stop_loss return @', stopReturnIdx);
// Find the closing of the if(!withinAntiChurnHold) block
const afterReturn = s.indexOf('    }\r\n  }\r\n', stopReturnIdx);
console.log('closing braces @', afterReturn, s.slice(afterReturn, afterReturn + 20));

// Replace the double-close with triple-close to close the new if() block
const closingBad = s.slice(afterReturn, afterReturn + 10); // "    }\r\n  }"
// Actually I need: "    }\r\n    }\r\n  }" -- close !withinAntiChurnHold, close drift guard, close pnlBps
s = s.slice(0, afterReturn) + "    }\r\n    }\r\n  }\r\n" + s.slice(afterReturn + 10);

if (s === orig) throw new Error('no change');
fs.writeFileSync(P, s, 'latin1');
console.log('OK type-safe drift guard applied; delta', s.length - orig.length);
