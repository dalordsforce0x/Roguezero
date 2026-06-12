const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let src = fs.readFileSync(filePath, 'utf8');

// Detect line ending
const eol = src.includes('\r\n') ? '\r\n' : '\n';
console.log('Line ending:', eol === '\r\n' ? 'CRLF' : 'LF');

// Change 1: Add phantom position cleanup
const marker1 = 'recovered.push(`${holding.symbol}:${holding.balanceAtomic}`);';
const marker2 = 'if (recovered.length === 0 && quantitySynced.length === 0) {';
const marker2end = 'return positionsState;';

const idx1 = src.indexOf(marker1);
const idx2 = src.indexOf(marker2, idx1);
if (idx1 < 0 || idx2 < 0) {
  console.error('Could not find markers:', idx1, idx2);
  process.exit(1);
}

// Find the end of the if block (return + closing brace)
const idxReturn = src.indexOf(marker2end, idx2);
const idxCloseBrace = src.indexOf('}', idxReturn + marker2end.length);

const before = src.substring(0, idx2);
const after = src.substring(idxCloseBrace + 1);

const phantomBlock = [
  '// Remove phantom positions: tracked in DB but no longer on-chain.',
  '  // This can happen when the API exit-confirm path fails to remove the position',
  '  // or when the race between worker recovery and API reconcile leaves stale data.',
  '  const inventoryMints = new Set(inventory.map((h) => h.mint));',
  '  const phantomRemoved: string[] = [];',
  '  for (const [mint, pos] of Object.entries(nextPositions)) {',
  '    if (isLongPositionStatus(pos.status) && !inventoryMints.has(mint)) {',
  '      delete nextPositions[mint];',
  '      phantomRemoved.push(`${pos.positionSymbol ?? mint}`);',
  '    }',
  '  }',
  '',
  '  if (recovered.length === 0 && quantitySynced.length === 0 && phantomRemoved.length === 0) {',
  '    return positionsState;',
  '  }',
].join(eol);

src = before + phantomBlock + after;
console.log('✓ Applied phantom position cleanup');

// Change 2: Update log message
const oldLog = 'quantitySynced=[${quantitySynced.join(\',\')}]`';
const newLog = 'quantitySynced=[${quantitySynced.join(\',\')}] phantomRemoved=[${phantomRemoved.join(\',\')}]`';

if (src.includes(oldLog)) {
  src = src.replace(oldLog, newLog);
  console.log('✓ Updated log message');
} else {
  console.log('⚠ Log message already updated or not found');
}

fs.writeFileSync(filePath, src, 'utf8');
console.log('Saved to disk');

// Verify
const verify = fs.readFileSync(filePath, 'utf8');
console.log('Verify phantomRemoved in file:', verify.includes('phantomRemoved'));
