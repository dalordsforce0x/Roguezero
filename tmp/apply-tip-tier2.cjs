// Apply dynamic tip tier to worker submit calls (CRLF-safe)
const fs = require('fs');
const path = require('path');
const filePath = path.join(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let src = fs.readFileSync(filePath, 'utf8');
let changes = 0;

// Helper: find and replace, handling both LF and CRLF by matching substrings
function findReplace(label, find, replace) {
  if (src.includes(find)) {
    src = src.replace(find, replace);
    changes++;
    console.log(`${label}: OK`);
    return true;
  }
  console.log(`${label}: FAIL - pattern not found`);
  // Show what's nearby
  const words = find.trim().split(/\s+/).slice(0, 5).join(' ');
  const idx = src.indexOf(words.slice(0, 30));
  if (idx > -1) {
    console.log(`  (found nearby text at offset ${idx})`);
  }
  return false;
}

// 2. Main trade submit - find the unique context around it
// The main trade submit is at ~line 8821, with "signedBase64" variable
const mainIdx = src.indexOf("signedTransactionBase64: signedBase64,");
if (mainIdx > -1) {
  // Find the start of this submit block
  const blockStart = src.lastIndexOf("const submit = await apiPost", mainIdx);
  if (blockStart > -1) {
    const blockEnd = src.indexOf("});", mainIdx);
    if (blockEnd > -1) {
      const oldBlock = src.substring(blockStart, blockEnd + 3);
      if (!oldBlock.includes('tipTier')) {
        // Insert tipTier before the closing });
        const closingBrace = oldBlock.lastIndexOf("});");
        const beforeClose = oldBlock.substring(0, closingBrace);
        // Find the last property line
        const lastPropMatch = beforeClose.match(/^([ \t]+)lastValidBlockHeight:.*$/m);
        if (lastPropMatch) {
          const indent = lastPropMatch[1];
          const newBlock = oldBlock.replace(
            /lastValidBlockHeight:\s+prepare\.data\.lastValidBlockHeight,/,
            `lastValidBlockHeight:   prepare.data.lastValidBlockHeight,\n${indent}tipTier:                getFleetTipTier(isExit),`
          );
          src = src.substring(0, blockStart) + newBlock + src.substring(blockEnd + 3);
          changes++;
          console.log('2. Added tipTier to main trade submit');
        } else {
          console.log('2. FAIL: could not find lastValidBlockHeight in main submit block');
        }
      } else {
        console.log('2. SKIP: tipTier already in main trade submit');
      }
    }
  }
} else {
  console.log('2. FAIL: signedBase64 pattern not found');
}

// Generic function to add tipTier to a submit block identified by nearby error message
function addTipTierToSubmit(label, errorMsg, tipTierValue) {
  const errorIdx = src.indexOf(errorMsg);
  if (errorIdx === -1) {
    console.log(`${label}: FAIL - error message not found: ${errorMsg.slice(0, 50)}`);
    return;
  }
  // Look backwards for the submit block
  const searchRegion = src.substring(Math.max(0, errorIdx - 1500), errorIdx);
  const submitIdx = searchRegion.lastIndexOf("const submit = await apiPost");
  if (submitIdx === -1) {
    console.log(`${label}: FAIL - submit block not found near error message`);
    return;
  }
  const absSubmitIdx = Math.max(0, errorIdx - 1500) + submitIdx;
  const closingIdx = src.indexOf("});", absSubmitIdx);
  if (closingIdx === -1 || closingIdx > errorIdx) {
    console.log(`${label}: FAIL - closing brace not found`);
    return;
  }
  const block = src.substring(absSubmitIdx, closingIdx + 3);
  if (block.includes('tipTier')) {
    console.log(`${label}: SKIP - tipTier already present`);
    return;
  }
  // Insert tipTier before the closing });
  const newBlock = block.replace(
    /(lastValidBlockHeight:\s*prepare\.data\.lastValidBlockHeight),/,
    `$1,\n    tipTier: ${tipTierValue},`
  );
  if (newBlock === block) {
    console.log(`${label}: FAIL - lastValidBlockHeight pattern not found in block`);
    return;
  }
  src = src.substring(0, absSubmitIdx) + newBlock + src.substring(closingIdx + 3);
  changes++;
  console.log(`${label}: OK`);
}

// 3. SOL->USDC conversion submit
addTipTierToSubmit('3. SOL->USDC submit', 'SOL->USDC submit failed', "getFleetTipTier()");

// 4. USDC->SOL gas refill submit
addTipTierToSubmit('4. Gas refill submit', 'USDC->SOL gas refill submit failed', "getFleetTipTier()");

// 5. Liquidation submit (always urgent)
addTipTierToSubmit('5. Liquidation submit', 'liquidation submit failed for', "'urgent'");

if (changes > 0) {
  fs.writeFileSync(filePath, src);
  console.log(`\nDone: ${changes} changes applied to worker.`);
} else {
  console.log('\nNo changes applied.');
}
