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

const dOld = [
  '      : {',
  '          ...positionState,',
  '          highWaterPriceUsd: isLongPositionStatus(positionState.status)',
].join(CR);
const dNew = [
  '      : {',
  '          ...positionState,',
  '          // Backfill cost basis for a re-tracked orphan the first time we have',
  '          // a price. True entry is unknown, so basis = current mark (unrealized',
  '          // starts at 0 from discovery) — this lets the position contribute to PnL.',
  '          entryPriceUsd: isLongPositionStatus(positionState.status) && positionState.entryPriceUsd === null',
  '            ? markedPriceUsd',
  '            : positionState.entryPriceUsd,',
  '          entryAt: positionState.entryAt ?? markedAt,',
  '          highWaterPriceUsd: isLongPositionStatus(positionState.status)',
].join(CR);
s = replaceOnce(s, dOld, dNew, 'D');

fs.writeFileSync(path, s, 'latin1');
console.log('APPLIED D. length=', s.length);
