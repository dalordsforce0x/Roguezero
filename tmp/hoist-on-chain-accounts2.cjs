const fs = require('fs');
const path = require('path');

const workerPath = path.join(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let content = fs.readFileSync(workerPath, 'utf-8');

// Find the exact pattern accounting for any line endings
// Look for the inner declaration: 4-space indented `let onChainAccounts`
const innerPattern = '    let onChainAccounts: SessionTokenAccount[] = [];';
const innerIdx = content.indexOf(innerPattern);
if (innerIdx === -1) {
  console.error('Could not find inner onChainAccounts declaration');
  process.exit(1);
}
console.log('Inner declaration found at index:', innerIdx);

// Replace the inner `let` with just assignment
content = content.substring(0, innerIdx) + '    onChainAccounts = [];' + content.substring(innerIdx + innerPattern.length);

// Now find the bare block `{` that starts the reconcile section
// It should be a few lines before the innerIdx location
// Search backwards from innerIdx for a line that is just `  {`
const beforeInner = content.substring(0, innerIdx);
const lastBareBlock = beforeInner.lastIndexOf('\n  {\n');
const lastBareBlockCRLF = beforeInner.lastIndexOf('\r\n  {\r\n');
const blockIdx = Math.max(lastBareBlock, lastBareBlockCRLF);

if (blockIdx === -1) {
  console.error('Could not find bare block start');
  process.exit(1);
}
console.log('Bare block found at index:', blockIdx);

// Insert the hoisted declaration before the bare block line
// Find the start of the `  {` line
const lineEnd = content.indexOf('{', blockIdx);
const lineStart = content.lastIndexOf('\n', lineEnd - 1) + 1;

const eol = content.includes('\r\n') ? '\r\n' : '\n';
const hoisted = `  let onChainAccounts: SessionTokenAccount[] = [];${eol}${eol}`;

content = content.substring(0, lineStart) + hoisted + content.substring(lineStart);

fs.writeFileSync(workerPath, content, 'utf-8');
console.log('Hoisted onChainAccounts declaration');
