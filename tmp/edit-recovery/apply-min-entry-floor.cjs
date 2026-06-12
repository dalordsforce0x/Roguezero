// Applies the economic entry floor fix directly to disk (latin1, CRLF-safe).
// This file's VS Code buffer is stale vs disk, so edits MUST go through node.
const fs = require('fs');
const path = 'services/worker/src/index.ts';
let s = fs.readFileSync(path, 'latin1');

const oldLine = 'const MIN_USDC_ENTRY_ATOMIC = Number(process.env.WORKER_MIN_USDC_ENTRY_ATOMIC ?? 1_000_000);';
const newLine =
  '// Economic entry floor: a trade must be large enough that the fixed per-swap cost\r\n' +
  '// (base fee + Sender tip ~200k lamports + priority fee, together ~$0.03) amortizes\r\n' +
  '// under the entry cost cap (WORKER_MAX_QUOTE_PRICE_IMPACT_BPS, default 120 bps).\r\n' +
  '// At $1.00 the fixed cost alone is ~178 bps so every entry was prepared, rejected by\r\n' +
  "// the cost gate ('entry_leg_cost_too_high'), then cancelled. That prepare->cancel churn\r\n" +
  '// left a prepared/submitted row that tripped the in-flight guard and starved the whole\r\n' +
  '// trade loop (including exits). At $5.00 the fixed cost is ~64 bps with headroom for\r\n' +
  '// route price impact; sub-floor sizes are blocked before prepare instead of churning.\r\n' +
  'const MIN_USDC_ENTRY_ATOMIC = Number(process.env.WORKER_MIN_USDC_ENTRY_ATOMIC ?? 5_000_000);';

const count = s.split(oldLine).length - 1;
if (count !== 1) {
  console.error(`ABORT: expected exactly 1 match of target line, found ${count}`);
  process.exit(1);
}
s = s.replace(oldLine, newLine);
fs.writeFileSync(path, s, 'latin1');
console.log('OK: applied economic entry floor (1_000_000 -> 5_000_000)');
console.log('verify hasFloor5M:', fs.readFileSync(path, 'latin1').includes('?? 5_000_000)'));
