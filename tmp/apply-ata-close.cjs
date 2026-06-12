const fs = require('fs');
const path = require('path');

const workerPath = path.join(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let content = fs.readFileSync(workerPath, 'utf-8');

// 1. Insert maybeCloseEmptyTokenAccounts function before maybeTopUpTradingCapitalFromSol
const insertMarker = 'const maybeTopUpTradingCapitalFromSol = async (';
const insertIdx = content.indexOf(insertMarker);
if (insertIdx === -1) {
  console.error('Could not find insertion marker');
  process.exit(1);
}

const newFunction = `// Close empty token accounts (ATAs) mid-session to reclaim locked rent (~0.00204 SOL
// per account). Runs after exit sells confirm and positions are reconciled away.
// Each close reclaims rent back to the session wallet, keeping gas reserves healthy
// and avoiding capital drain from accumulated empty ATAs.
const maybeCloseEmptyTokenAccounts = async (
  session: RawSession,
  keypair: Keypair,
  onChainAccounts: SessionTokenAccount[],
  currencyMints: Set<string>,
  openPositionMints: Set<string>,
): Promise<number> => {
  const closeable: SessionTokenAccount[] = [];
  for (const acct of onChainAccounts) {
    const mint = acct.account.mint.toBase58();
    // Never close ATAs for currency mints (SOL/USDC) or open positions.
    if (currencyMints.has(mint) || openPositionMints.has(mint)) continue;
    // Only close if balance is zero (empty after sell).
    if (Number(acct.account.amount) > 0) continue;
    // Skip if close authority is not the session wallet (foreign-controlled).
    if (acct.account.closeAuthority && !acct.account.closeAuthority.equals(keypair.publicKey)) continue;
    closeable.push(acct);
  }
  if (closeable.length === 0) return 0;

  // Batch up to 20 closes per tx (to stay within compute limits).
  const BATCH_SIZE = 20;
  let totalClosed = 0;
  for (let i = 0; i < closeable.length; i += BATCH_SIZE) {
    const batch = closeable.slice(i, i + BATCH_SIZE);
    const instructions = batch.map((acct) =>
      createCloseAccountInstruction(acct.address, keypair.publicKey, keypair.publicKey, [], acct.programId),
    );
    try {
      const { blockhash, lastValidBlockHeight } = await rlGetLatestBlockhash();
      const tx = new VersionedTransaction(new TransactionMessage({
        payerKey: keypair.publicKey,
        recentBlockhash: blockhash,
        instructions,
      }).compileToV0Message());
      tx.sign([keypair]);
      const sig = await rlSendRawTransaction(tx.serialize());
      const confirmation = await rlConfirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });
      if (confirmation.value.err) {
        log('warn', session.id, \`ATA close batch failed: \${JSON.stringify(confirmation.value.err)}\`);
        continue;
      }
      totalClosed += batch.length;
      log('info', session.id, \`closed \${batch.length} empty ATAs, reclaimed ~\${(batch.length * 0.00204).toFixed(4)} SOL · sig \${sig}\`);
    } catch (err) {
      log('warn', session.id, \`ATA close batch error: \${(err as Error).message}\`);
    }
  }
  return totalClosed;
};

`;

content = content.substring(0, insertIdx) + newFunction + content.substring(insertIdx);

// 2. Insert the call to maybeCloseEmptyTokenAccounts after reconcile drops
const callMarker = 'wallet-truth reconcile re-tracked orphaned on-chain tokens';
const callIdx = content.indexOf(callMarker);
if (callIdx === -1) {
  console.error('Could not find call site marker');
  process.exit(1);
}
// Find the closing brace of the "if (recoveredMints.length > 0)" block
const recoveredLogEnd = content.indexOf('}', callIdx);
// Then the closing brace of "if (reconcileChanged)"
const reconcileEnd = content.indexOf('\n', recoveredLogEnd + 1);

// Find the next line after the reconcileChanged block closes
// Need to find "  const openPositionMints" which comes after
const openPositionMintsMarker = 'const openPositionMints = new Set(openPositions.map';
const openPosIdx = content.indexOf(openPositionMintsMarker, callIdx);
if (openPosIdx === -1) {
  console.error('Could not find openPositionMints marker');
  process.exit(1);
}

// Insert the ATA close call after openPositionMints is defined
// Find the end of the openPositionMints line
const openPosLineEnd = content.indexOf('\n', openPosIdx);

// Find the end of the heldPositionMints loop (next empty line or comment)
const heldPosMarker = 'for (const mint of openPositionMints)';
const heldPosIdx = content.indexOf(heldPosMarker, openPosIdx);
const heldPosEnd = content.indexOf('}', content.indexOf('}', heldPosIdx) + 1);
const afterHeldPos = content.indexOf('\n', heldPosEnd);

const ataCloseCall = `
    // Reclaim rent from empty ATAs left by exited positions. Runs after
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
    }
`;

content = content.substring(0, afterHeldPos + 1) + ataCloseCall + content.substring(afterHeldPos + 1);

fs.writeFileSync(workerPath, content, 'utf-8');
console.log('Applied ATA close function and call site');
