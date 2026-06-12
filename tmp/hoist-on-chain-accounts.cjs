const fs = require('fs');
const path = require('path');

const workerPath = path.join(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let content = fs.readFileSync(workerPath, 'utf-8');

// 1. Add `let onChainAccounts: SessionTokenAccount[] = [];` before the reconcile block
// The reconcile block starts with a bare `{` preceded by comments.
// We'll insert the declaration right before the opening `{`
const blockComment = '  // Base/gas currencies (the funding mint, SOL, USDC) are managed by the capital\n  // and gas keep-alive logic, not as tradeable positions, so they are excluded.\n  {';
const blockCommentIdx = content.indexOf(blockComment);
if (blockCommentIdx === -1) {
  console.error('Could not find reconcile block start');
  process.exit(1);
}

const hoistedDecl = '  let onChainAccounts: SessionTokenAccount[] = [];\n\n  // Base/gas currencies (the funding mint, SOL, USDC) are managed by the capital\n  // and gas keep-alive logic, not as tradeable positions, so they are excluded.\n  {';
content = content.replace(blockComment, hoistedDecl);

// 2. Inside the block, change `let onChainAccounts: SessionTokenAccount[] = [];` to just `onChainAccounts = [];`
// but only the SECOND occurrence (first is now the hoisted one)
const innerDecl = '    let onChainAccounts: SessionTokenAccount[] = [];';
const firstOccur = content.indexOf(innerDecl);
const secondOccur = content.indexOf(innerDecl, firstOccur + innerDecl.length);
if (secondOccur === -1) {
  // Only one, that's the inner one (hoisted already added)
  // Actually let me re-check - the hoisted one doesn't use `let onChainAccounts: SessionTokenAccount[] = [];` inside {}
  // Wait - the hoisted uses different indentation. Let me just find the inner one more carefully.
  // The hoisted is `  let onChainAccounts: SessionTokenAccount[] = [];` (2-space indent)
  // The inner is  `    let onChainAccounts: SessionTokenAccount[] = [];` (4-space indent)
  const inner4 = '    let onChainAccounts: SessionTokenAccount[] = [];';
  const innerIdx = content.indexOf(inner4);
  if (innerIdx === -1) {
    console.error('Could not find inner onChainAccounts declaration');
    process.exit(1);
  }
  content = content.substring(0, innerIdx) + '    onChainAccounts = [];' + content.substring(innerIdx + inner4.length);
} else {
  content = content.substring(0, secondOccur) + '    onChainAccounts = [];' + content.substring(secondOccur + innerDecl.length);
}

fs.writeFileSync(workerPath, content, 'utf-8');
console.log('Hoisted onChainAccounts declaration out of reconcile block');
