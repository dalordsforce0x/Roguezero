// Apply phantom position cleanup to reconcileWalletInventoryPositions
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let src = fs.readFileSync(filePath, 'utf8');

// 1. Add phantom position cleanup after the inventory loop
const oldBlock = `    recovered.push(\`\${holding.symbol}:\${holding.balanceAtomic}\`);
  }

  if (recovered.length === 0 && quantitySynced.length === 0) {
    return positionsState;
  }`;

const newBlock = `    recovered.push(\`\${holding.symbol}:\${holding.balanceAtomic}\`);
  }

  // Remove phantom positions: tracked in DB but no longer on-chain.
  // This can happen when the API exit-confirm path fails to remove the position
  // or when the race between worker recovery and API reconcile leaves stale data.
  const inventoryMints = new Set(inventory.map((h) => h.mint));
  const phantomRemoved = [];
  for (const [mint, pos] of Object.entries(nextPositions)) {
    if (isLongPositionStatus(pos.status) && !inventoryMints.has(mint)) {
      delete nextPositions[mint];
      phantomRemoved.push(\`\${pos.positionSymbol ?? mint}\`);
    }
  }

  if (recovered.length === 0 && quantitySynced.length === 0 && phantomRemoved.length === 0) {
    return positionsState;
  }`;

if (!src.includes(oldBlock)) {
  // Try with \r\n
  const oldBlockCRLF = oldBlock.replace(/\n/g, '\r\n');
  if (src.includes(oldBlockCRLF)) {
    src = src.replace(oldBlockCRLF, newBlock.replace(/\n/g, '\r\n'));
    console.log('✓ Applied phantom position cleanup (CRLF)');
  } else {
    console.error('✗ Could not find the target block for phantom cleanup');
    process.exit(1);
  }
} else {
  src = src.replace(oldBlock, newBlock);
  console.log('✓ Applied phantom position cleanup (LF)');
}

// 2. Update the log message to include phantomRemoved
const oldLog = 'wallet inventory reconciled into positionsState recovered=[${recovered.join(\',\')}] quantitySynced=[${quantitySynced.join(\',\')}]';
const newLog = 'wallet inventory reconciled into positionsState recovered=[${recovered.join(\',\')}] quantitySynced=[${quantitySynced.join(\',\')}] phantomRemoved=[${phantomRemoved.join(\',\')}]';

if (src.includes(oldLog)) {
  src = src.replace(oldLog, newLog);
  console.log('✓ Updated log message (LF)');
} else {
  console.error('✗ Could not find log message to update (may already be updated)');
}

fs.writeFileSync(filePath, src, 'utf8');
console.log('Done');
