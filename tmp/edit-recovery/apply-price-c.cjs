const fs = require('fs');
const path = 'services/worker/src/index.ts';
let s = fs.readFileSync(path, 'latin1');
const CR = '\r\n';

function replaceOnce(hay, oldStr, newStr, label) {
  let i = 0, c = 0;
  while ((i = hay.indexOf(oldStr, i)) !== -1) { c++; i += oldStr.length; }
  if (c !== 1) { console.error(`ABORT ${label}: occurrences=${c}`); process.exit(1); }
  return hay.replace(oldStr, newStr);
}

const cOld = [
  '  const openPositionMints = new Set(openPositions.map(({ mint }) => mint));',
].join(CR);
const cNew = [
  '  const openPositionMints = new Set(openPositions.map(({ mint }) => mint));',
  '',
  '  // Register every held, non-currency mint so the global price poll keeps a',
  '  // live USD price for it. Without this, re-tracked orphans outside the trade',
  '  // universe would never be priced and their position PnL would read as zero.',
  '  for (const mint of openPositionMints) {',
  '    if (mint !== SOL_MINT && mint !== USDC_MINT && mint !== session.funding.fundingMint) {',
  '      heldPositionMints.add(mint);',
  '    }',
  '  }',
].join(CR);
s = replaceOnce(s, cOld, cNew, 'C');

fs.writeFileSync(path, s, 'latin1');
console.log('APPLIED C. length=', s.length);
