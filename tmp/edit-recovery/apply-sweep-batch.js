const fs = require('fs');

const targetPath = 'services/worker/src/index.ts';
const newBlockPath = 'tmp/edit-recovery/sweep-new-block.txt';

let content = fs.readFileSync(targetPath, 'utf8');
let newBlock = fs.readFileSync(newBlockPath, 'utf8');

const usesCRLF = content.includes('\r\n');

// Normalize new block to LF first, then match the target file's line endings.
newBlock = newBlock.replace(/\r\n/g, '\n');
if (usesCRLF) {
  newBlock = newBlock.replace(/\n/g, '\r\n');
}

const startAnchor = '  const solToSend = computeSessionSolSweepLamports({';
const endAnchor = '  if (!mayLeaveResidualState && hasResidualWalletState(postSweepSnapshot)) {';

const startIdx = content.indexOf(startAnchor);
const endIdx = content.indexOf(endAnchor);

if (startIdx === -1) { console.error('FAIL: start anchor not found'); process.exit(1); }
if (endIdx === -1) { console.error('FAIL: end anchor not found'); process.exit(1); }
if (endIdx <= startIdx) { console.error('FAIL: end anchor before start anchor'); process.exit(1); }
if (content.indexOf(startAnchor, startIdx + 1) !== -1) { console.error('FAIL: start anchor not unique'); process.exit(1); }
if (content.indexOf(endAnchor, endIdx + 1) !== -1) { console.error('FAIL: end anchor not unique'); process.exit(1); }

const before = content.slice(0, startIdx);
const after = content.slice(endIdx);

// Guard: the region we are replacing must contain the old single-tx send.
const replaced = content.slice(startIdx, endIdx);
if (!replaced.includes('instructions: ixs,')) {
  console.error('FAIL: replaced region did not contain the old single-tx send (instructions: ixs)');
  process.exit(1);
}

const updated = before + newBlock + after;
fs.writeFileSync(targetPath, updated, 'utf8');

console.log('OK: applied batched-sweep fix');
console.log('old length:', content.length, 'new length:', updated.length);
console.log('CRLF:', usesCRLF);
