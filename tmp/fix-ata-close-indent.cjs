const fs = require('fs');
const path = require('path');

const workerPath = path.join(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let content = fs.readFileSync(workerPath, 'utf-8');

// Fix indentation: the ATA close block has 4-space indent but context uses 2-space
const oldBlock = `    // Reclaim rent from empty ATAs left by exited positions. Runs after
    // reconcile so we know which mints are truly gone, and after
    // openPositionMints is computed so we never close an active position's ATA.
    if (onChainAccounts.length > 0) {
      const currencyMints = new Set<string>([session.funding.fundingMint, SOL_MINT, USDC_MINT]);
      try {
        const closed = await maybeCloseEmptyTokenAccounts(session, keypair, onChainAccounts, currencyMints, openPositionMints);
        if (closed > 0) {
          balance = await rlGetBalance(keypair.publicKey);
        }
      } catch (err) {
        log('warn', session.id, \`ATA cleanup error: \${(err as Error).message}\`);
      }
    }`;

const newBlock = `  // Reclaim rent from empty ATAs left by exited positions. Runs after
  // reconcile so we know which mints are truly gone, and after
  // openPositionMints is computed so we never close an active position's ATA.
  if (onChainAccounts.length > 0) {
    const currencyMints = new Set<string>([session.funding.fundingMint, SOL_MINT, USDC_MINT]);
    try {
      const closed = await maybeCloseEmptyTokenAccounts(session, keypair, onChainAccounts, currencyMints, openPositionMints);
      if (closed > 0) {
        balance = await rlGetBalance(keypair.publicKey);
      }
    } catch (err) {
      log('warn', session.id, \`ATA cleanup error: \${(err as Error).message}\`);
    }
  }`;

if (!content.includes(oldBlock)) {
  console.error('Could not find old block to fix indent');
  process.exit(1);
}

content = content.replace(oldBlock, newBlock);
fs.writeFileSync(workerPath, content, 'utf-8');
console.log('Fixed indentation');
