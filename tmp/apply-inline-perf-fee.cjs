/**
 * Patch: Deduct 0.33% performance fee inline during mid-session send_to_owner profit transfers.
 *
 * Changes:
 * 1. After `let transferredUsd = 0;` add fee computation (shouldDeductFee, feeBps)
 * 2. USDC path: split transfer into owner + fee collector portions
 * 3. SOL path: split transfer into owner + fee collector portions
 * 4. State persistence: track collectedPerformanceFeeUsd
 * 5. Sweep: subtract already-collected mid-session fees
 */
const fs = require('fs');
const path = require('path');

const workerPath = path.resolve(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let content = fs.readFileSync(workerPath, 'utf-8');
// Normalize to LF for matching, then restore CRLF at the end
const hadCRLF = content.includes('\r\n');
if (hadCRLF) content = content.replace(/\r\n/g, '\n');

// ── 1. Add fee computation after `let transferredUsd = 0;` ──────────────────
const feeCompAnchor =
  '  let transferredUsd = 0;\n' +
  '\n' +
  '  if (handling.payoutToken === \'USDC\') {';

const feeCompReplacement =
  '  let transferredUsd = 0;\n' +
  '  let feeUsd = 0;\n' +
  '\n' +
  '  // Inline performance fee: deduct WORKER_PERFORMANCE_FEE_BPS from each mid-session\n' +
  '  // profit transfer so the platform collects its cut in real-time instead of only at\n' +
  '  // session-end sweep. The sweep subtracts already-collected fees to avoid double-charge.\n' +
  '  const shouldDeductInlineFee = WORKER_PERFORMANCE_FEE_BPS > 0\n' +
  '    && livePerformanceFeeEnabled\n' +
  '    && isFeatureActiveForSession(session, WORKER_PERFORMANCE_FEE_ENABLED, \'performance_fee\');\n' +
  '  const inlineFeeFraction = shouldDeductInlineFee ? WORKER_PERFORMANCE_FEE_BPS / 10_000 : 0;\n' +
  '\n' +
  '  if (handling.payoutToken === \'USDC\') {';

if (!content.includes(feeCompAnchor)) {
  console.error('FAIL: fee computation anchor not found');
  process.exit(1);
}
content = content.replace(feeCompAnchor, feeCompReplacement);
console.log('OK: 1. fee computation added');

// ── 2. USDC path: split transfer ────────────────────────────────────────────
// Find the USDC transfer instruction block and replace with split
const usdcTransferOld =
  '    instructions.push(createTransferInstruction(\n' +
  '      sessionUsdcAta,\n' +
  '      ownerUsdcAta,\n' +
  '      payerPubkey,\n' +
  '      BigInt(transferUsdcAtomic),\n' +
  '      [],\n' +
  '      TOKEN_PROGRAM_ID,\n' +
  '    ));\n' +
  '\n' +
  '    const { blockhash, lastValidBlockHeight } = await rlGetLatestBlockhash();';

const usdcTransferNew =
  '    // Split transfer: owner gets profit minus fee, fee collector gets the fee portion.\n' +
  '    const feeUsdcAtomic = Math.floor(transferUsdcAtomic * inlineFeeFraction);\n' +
  '    const ownerUsdcAtomic = transferUsdcAtomic - feeUsdcAtomic;\n' +
  '\n' +
  '    if (ownerUsdcAtomic > 0) {\n' +
  '      instructions.push(createTransferInstruction(\n' +
  '        sessionUsdcAta,\n' +
  '        ownerUsdcAta,\n' +
  '        payerPubkey,\n' +
  '        BigInt(ownerUsdcAtomic),\n' +
  '        [],\n' +
  '        TOKEN_PROGRAM_ID,\n' +
  '      ));\n' +
  '    }\n' +
  '\n' +
  '    if (feeUsdcAtomic > 0) {\n' +
  '      const feeCollectorUsdcAta = await getAssociatedTokenAddress(new PublicKey(USDC_MINT), PERFORMANCE_FEE_PUBKEY, true, TOKEN_PROGRAM_ID);\n' +
  '      const feeAtaExists = await hasTokenAccount(PERFORMANCE_FEE_PUBKEY, USDC_MINT, TOKEN_PROGRAM_ID);\n' +
  '      if (!feeAtaExists) {\n' +
  '        instructions.push(createAssociatedTokenAccountIdempotentInstruction(\n' +
  '          payerPubkey,\n' +
  '          feeCollectorUsdcAta,\n' +
  '          PERFORMANCE_FEE_PUBKEY,\n' +
  '          new PublicKey(USDC_MINT),\n' +
  '          TOKEN_PROGRAM_ID,\n' +
  '        ));\n' +
  '      }\n' +
  '      instructions.push(createTransferInstruction(\n' +
  '        sessionUsdcAta,\n' +
  '        feeCollectorUsdcAta,\n' +
  '        payerPubkey,\n' +
  '        BigInt(feeUsdcAtomic),\n' +
  '        [],\n' +
  '        TOKEN_PROGRAM_ID,\n' +
  '      ));\n' +
  '    }\n' +
  '\n' +
  '    const { blockhash, lastValidBlockHeight } = await rlGetLatestBlockhash();';

if (!content.includes(usdcTransferOld)) {
  console.error('FAIL: USDC transfer anchor not found');
  process.exit(1);
}
content = content.replace(usdcTransferOld, usdcTransferNew);
console.log('OK: 2. USDC path fee split added');

// ── 2b. USDC: update transferredUsd and feeUsd accounting ───────────────────
const usdcAccountingOld =
  '    transferredUsd = transferUsdcAtomic / USDC_ATOMIC_PER_USD;\n' +
  '    log(\'info\', session.id, `profit skimmed to owner (USDC): ${transferredUsd.toFixed(4)} usd';

const usdcAccountingNew =
  '    transferredUsd = ownerUsdcAtomic / USDC_ATOMIC_PER_USD;\n' +
  '    feeUsd = feeUsdcAtomic / USDC_ATOMIC_PER_USD;\n' +
  '    log(\'info\', session.id, `profit skimmed to owner (USDC): ${transferredUsd.toFixed(4)} usd (fee: ${feeUsd.toFixed(4)} usd)';

if (!content.includes(usdcAccountingOld)) {
  console.error('FAIL: USDC accounting anchor not found');
  process.exit(1);
}
content = content.replace(usdcAccountingOld, usdcAccountingNew);
console.log('OK: 2b. USDC accounting updated');

// ── 3. SOL path: split transfer ─────────────────────────────────────────────
const solTransferOld =
  '    const { blockhash, lastValidBlockHeight } = await rlGetLatestBlockhash();\n' +
  '    const tx = new VersionedTransaction(new TransactionMessage({\n' +
  '      payerKey: payerPubkey,\n' +
  '      recentBlockhash: blockhash,\n' +
  '      instructions: [\n' +
  '        SystemProgram.transfer({\n' +
  '          fromPubkey: payerPubkey,\n' +
  '          toPubkey: ownerPubkey,\n' +
  '          lamports: transferableLamports,\n' +
  '        }),\n' +
  '      ],\n' +
  '    }).compileToV0Message());\n' +
  '    tx.sign([keypair]);\n' +
  '    const sig = await rlSendRawTransaction(tx.serialize());\n' +
  '    const confirmation = await rlConfirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });\n' +
  '    if (confirmation.value.err) {\n' +
  '      throw new Error(`profit transfer failed: ${JSON.stringify(confirmation.value.err)}`);\n' +
  '    }\n' +
  '\n' +
  '    transferredUsd = (transferableLamports / 1_000_000_000) * solUsd;\n' +
  '    log(\'info\', session.id, `profit skimmed to owner (SOL): ${transferredUsd.toFixed(4)} usd-equivalent';

const solTransferNew =
  '    // Split transfer: owner gets profit minus fee, fee collector gets the fee portion.\n' +
  '    const feeLamports = Math.floor(transferableLamports * inlineFeeFraction);\n' +
  '    const ownerLamports = transferableLamports - feeLamports;\n' +
  '\n' +
  '    const solPayoutInstructions: TransactionInstruction[] = [];\n' +
  '    if (ownerLamports > 0) {\n' +
  '      solPayoutInstructions.push(SystemProgram.transfer({\n' +
  '        fromPubkey: payerPubkey,\n' +
  '        toPubkey: ownerPubkey,\n' +
  '        lamports: ownerLamports,\n' +
  '      }));\n' +
  '    }\n' +
  '    if (feeLamports > 0) {\n' +
  '      solPayoutInstructions.push(SystemProgram.transfer({\n' +
  '        fromPubkey: payerPubkey,\n' +
  '        toPubkey: PERFORMANCE_FEE_PUBKEY,\n' +
  '        lamports: feeLamports,\n' +
  '      }));\n' +
  '    }\n' +
  '\n' +
  '    const { blockhash, lastValidBlockHeight } = await rlGetLatestBlockhash();\n' +
  '    const tx = new VersionedTransaction(new TransactionMessage({\n' +
  '      payerKey: payerPubkey,\n' +
  '      recentBlockhash: blockhash,\n' +
  '      instructions: solPayoutInstructions,\n' +
  '    }).compileToV0Message());\n' +
  '    tx.sign([keypair]);\n' +
  '    const sig = await rlSendRawTransaction(tx.serialize());\n' +
  '    const confirmation = await rlConfirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });\n' +
  '    if (confirmation.value.err) {\n' +
  '      throw new Error(`profit transfer failed: ${JSON.stringify(confirmation.value.err)}`);\n' +
  '    }\n' +
  '\n' +
  '    transferredUsd = (ownerLamports / 1_000_000_000) * solUsd;\n' +
  '    feeUsd = (feeLamports / 1_000_000_000) * solUsd;\n' +
  '    log(\'info\', session.id, `profit skimmed to owner (SOL): ${transferredUsd.toFixed(4)} usd-equivalent (fee: ${feeUsd.toFixed(4)} usd)';

if (!content.includes(solTransferOld)) {
  console.error('FAIL: SOL transfer anchor not found');
  process.exit(1);
}
content = content.replace(solTransferOld, solTransferNew);
console.log('OK: 3. SOL path fee split added');

// ── 4. State persistence: track collectedPerformanceFeeUsd ──────────────────
const stateOld =
  '  if (transferredUsd > 0) {\n' +
  '    await persistSchedulingState(session, {\n' +
  '      transferredProfitUsd: Math.max(0, Number((transferredProfitUsd + transferredUsd).toFixed(6))),\n' +
  '      lastProfitTransferAt: nowIso,\n' +
  '    });\n' +
  '  }\n' +
  '\n' +
  '  return transferredUsd;';

const stateNew =
  '  if (transferredUsd > 0 || feeUsd > 0) {\n' +
  '    const prevCollectedFee = session.service_control.schedulingState?.collectedPerformanceFeeUsd ?? 0;\n' +
  '    await persistSchedulingState(session, {\n' +
  '      transferredProfitUsd: Math.max(0, Number((transferredProfitUsd + transferredUsd + feeUsd).toFixed(6))),\n' +
  '      collectedPerformanceFeeUsd: Math.max(0, Number((prevCollectedFee + feeUsd).toFixed(6))),\n' +
  '      lastProfitTransferAt: nowIso,\n' +
  '    });\n' +
  '  }\n' +
  '\n' +
  '  return transferredUsd;';

if (!content.includes(stateOld)) {
  console.error('FAIL: state persistence anchor not found');
  process.exit(1);
}
content = content.replace(stateOld, stateNew);
console.log('OK: 4. state persistence updated');

// ── 5. Sweep: subtract already-collected mid-session fees ───────────────────
// The sweep currently computes: rawFee = realizedProfitLamports * feeBps / 10000
// We need to subtract what was already collected mid-session.
const sweepOld =
  '    if (Number.isFinite(fundedBaselineLamports) && fundedBaselineLamports > 0 && realizedProfitLamports > 0) {\n' +
  '      const rawFee = Math.floor((realizedProfitLamports * WORKER_PERFORMANCE_FEE_BPS) / 10_000);\n' +
  '      // Clamp so the fee can never exceed realized profit (owner always keeps principal).\n' +
  '      performanceFeeLamports = Math.max(0, Math.min(rawFee, realizedProfitLamports));\n' +
  '    }';

const sweepNew =
  '    if (Number.isFinite(fundedBaselineLamports) && fundedBaselineLamports > 0 && realizedProfitLamports > 0) {\n' +
  '      const rawFee = Math.floor((realizedProfitLamports * WORKER_PERFORMANCE_FEE_BPS) / 10_000);\n' +
  '      // Subtract performance fees already collected mid-session via send_to_owner transfers.\n' +
  '      const alreadyCollectedUsd = session.service_control.schedulingState?.collectedPerformanceFeeUsd ?? 0;\n' +
  '      const solUsdAtSweep = lastPythSolSample?.usdPrice ?? lastJupiterSolSample?.usdPrice ?? 0;\n' +
  '      const alreadyCollectedLamports = solUsdAtSweep > 0\n' +
  '        ? Math.floor((alreadyCollectedUsd / solUsdAtSweep) * 1_000_000_000)\n' +
  '        : 0;\n' +
  '      const adjustedFee = Math.max(0, rawFee - alreadyCollectedLamports);\n' +
  '      // Clamp so the fee can never exceed realized profit (owner always keeps principal).\n' +
  '      performanceFeeLamports = Math.max(0, Math.min(adjustedFee, realizedProfitLamports));\n' +
  '    }';

if (!content.includes(sweepOld)) {
  console.error('FAIL: sweep fee anchor not found');
  process.exit(1);
}
content = content.replace(sweepOld, sweepNew);
console.log('OK: 5. sweep double-charge prevention added');

fs.writeFileSync(workerPath, hadCRLF ? content.replace(/\n/g, '\r\n') : content, 'utf-8');
console.log('All patches applied successfully.');
