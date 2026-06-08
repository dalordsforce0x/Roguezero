// Update class-weighted entry-sizing DEFAULTS to data-backed values (shadow; flag stays OFF).
// Source data (Noah session edd46e65, 24h exit_shadow_decisions):
//   avg pnl_bps by class: major +15.5, long_tail -4.9, sol_beta -5.5, trend_liquid -26.2
//   regime: major +15.3 chop (only +EV); long_tail +4.1 trend (runner); trend_liquid -28/-22 both (no edge).
// => starve trend_liquid (0.2x), trim sol_beta (0.7x), keep major/long_tail 1.0x for now.
const fs = require('fs');
const path = 'services/worker/src/index.ts';
let src = fs.readFileSync(path, 'utf8');

function apply(label, oldStr, newStr) {
  const count = src.split(oldStr).length - 1;
  if (count !== 1) {
    throw new Error(`[${label}] expected exactly 1 match, found ${count}`);
  }
  src = src.split(oldStr).join(newStr);
  console.log(`[${label}] applied`);
}

apply(
  'sol_beta default 10000->7000',
  "const WORKER_CLASS_SIZE_SOL_BETA_BPS = Number(process.env.WORKER_CLASS_SIZE_SOL_BETA_BPS ?? 10000);",
  "const WORKER_CLASS_SIZE_SOL_BETA_BPS = Number(process.env.WORKER_CLASS_SIZE_SOL_BETA_BPS ?? 7000);",
);

apply(
  'trend_liquid default 5000->2000',
  "const WORKER_CLASS_SIZE_TREND_LIQUID_BPS = Number(process.env.WORKER_CLASS_SIZE_TREND_LIQUID_BPS ?? 5000);",
  "const WORKER_CLASS_SIZE_TREND_LIQUID_BPS = Number(process.env.WORKER_CLASS_SIZE_TREND_LIQUID_BPS ?? 2000);",
);

fs.writeFileSync(path, src);
console.log('done');
