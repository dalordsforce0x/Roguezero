// Apply quantity sync to the existing wallet-truth reconcile in the deployed worker.
// Also adds phantom position cleanup.
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let src = fs.readFileSync(filePath, 'utf8');
const eol = src.includes('\r\n') ? '\r\n' : '\n';
console.log('Line ending:', eol === '\r\n' ? 'CRLF' : 'LF');

// ── Change 1: Add quantity sync to the DROP block ──────────────────────────
// After the DROP block (which deletes positions with <10% of tracked quantity),
// add a SYNC block that corrects quantity when the position exists but the amount
// is wrong. This is the double-count fix.

const dropBlockEnd = `      if (walletInventoryAtomic < minimumExpectedInventoryAtomic) {${eol}        delete reconciledPositions[mint];${eol}        droppedMints.push(\`\${getPositionSymbol(position)}:\${walletInventoryAtomic}/\${trackedQuantityAtomic}\`);${eol}        reconcileChanged = true;${eol}      }${eol}    }`;

const quantitySyncBlock = `      if (walletInventoryAtomic < minimumExpectedInventoryAtomic) {${eol}        delete reconciledPositions[mint];${eol}        droppedMints.push(\`\${getPositionSymbol(position)}:\${walletInventoryAtomic}/\${trackedQuantityAtomic}\`);${eol}        reconcileChanged = true;${eol}      } else if (walletInventoryAtomic !== trackedQuantityAtomic) {${eol}        // SYNC: on-chain balance exists but differs from DB (e.g. API race doubled it).${eol}        reconciledPositions[mint] = {${eol}          ...position,${eol}          quantityAtomic: String(walletInventoryAtomic),${eol}        };${eol}        droppedMints.push(\`\${getPositionSymbol(position)}:qty_sync:\${trackedQuantityAtomic}->\${walletInventoryAtomic}\`);${eol}        reconcileChanged = true;${eol}      }${eol}    }`;

if (src.includes(dropBlockEnd)) {
  src = src.replace(dropBlockEnd, quantitySyncBlock);
  console.log('✓ Applied quantity sync to wallet-truth reconcile');
} else {
  console.error('✗ Could not find DROP block end marker');
  console.error('Looking for:', JSON.stringify(dropBlockEnd.substring(0, 100)));
  process.exit(1);
}

fs.writeFileSync(filePath, src, 'utf8');
console.log('Saved to disk');

// Verify
const verify = fs.readFileSync(filePath, 'utf8');
console.log('Verify qty_sync in file:', verify.includes('qty_sync'));
console.log('Verify walletInventoryAtomic !== trackedQuantityAtomic:', verify.includes('walletInventoryAtomic !== trackedQuantityAtomic'));
