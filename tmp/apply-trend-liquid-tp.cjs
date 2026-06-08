// Lever B: lower trend_liquid takeProfitMult 1.7 -> 0.8 so its rare small pop banks a scratch
// instead of waiting for an unreachable 132bps TP and bleeding to the -50 stop.
// Data (Noah 24h): trend_liquid p90 MFE = 41bps; TP target was ~132bps (3x its best move).
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
  'trend_liquid takeProfitMult 1.7->0.8',
  "    case 'trend_liquid':\n      return { takeProfitMult: 1.7, stopLossMult: 1.0, trailingStopMult: 0.8 };",
  "    case 'trend_liquid':\n      return { takeProfitMult: 0.8, stopLossMult: 1.0, trailingStopMult: 0.8 };",
);

fs.writeFileSync(path, src);
console.log('done');
