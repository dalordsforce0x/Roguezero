const fs = require('fs');
const path = 'services/worker/src/index.ts';
let s = fs.readFileSync(path, 'latin1');

function replaceOnce(hay, oldStr, newStr, label) {
  let i = 0, c = 0;
  while ((i = hay.indexOf(oldStr, i)) !== -1) { c++; i += oldStr.length; }
  if (c !== 1) { console.error(`ABORT ${label}: occurrences=${c}`); process.exit(1); }
  return hay.replace(oldStr, newStr);
}

const CR = '\r\n';

// Edit A: declare the held-position mint registry next to the price maps.
const aOld = [
  'const latestJupiterUsdByMint = new Map<string, number>();',
  'const previousJupiterUsdByMint = new Map<string, number>();',
].join(CR);
const aNew = [
  'const latestJupiterUsdByMint = new Map<string, number>();',
  '// Mints currently held as positions across active sessions. The price poll',
  '// adds these to its fetch list so EVERY held token (including re-tracked',
  '// orphans outside the trade universe) gets a live USD price, keeping PnL',
  '// valuation honest. Populated by the wallet-truth reconcile each cycle.',
  'const heldPositionMints = new Set<string>();',
  'const previousJupiterUsdByMint = new Map<string, number>();',
].join(CR);
s = replaceOnce(s, aOld, aNew, 'A');

// Edit B: include held-position mints in the price poll fetch list.
const bOld = [
  '    await refreshTokenUniverseMints();',
  '    const mints = dedupeMints([',
  '      ...jupiterPriceConfig.defaultMints,',
  '      ...tokenUniverseMints,',
  '    ]);',
].join(CR);
const bNew = [
  '    await refreshTokenUniverseMints();',
  '    const mints = dedupeMints([',
  '      ...jupiterPriceConfig.defaultMints,',
  '      ...tokenUniverseMints,',
  '      ...heldPositionMints,',
  '    ]);',
].join(CR);
s = replaceOnce(s, bOld, bNew, 'B');

fs.writeFileSync(path, s, 'latin1');
console.log('APPLIED A+B. length=', s.length);
