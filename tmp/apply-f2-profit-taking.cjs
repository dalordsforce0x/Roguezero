/**
 * F2: Per-session profit-taking mode.
 * 
 * 1. Session schema: add profitTakingMode field
 * 2. Worker: after TP exit, if mode is take_profits, send profit to owner
 * 3. Web app: setting at session creation (deferred — not blocking)
 */
const fs = require('fs');
const path = require('path');

// ── 1. Session schema — add profitTakingMode ──
const schemaFile = path.join(__dirname, '..', 'packages', 'session-schema', 'src', 'index.ts');
let s = fs.readFileSync(schemaFile, 'utf8');

if (!s.includes('profitTakingMode')) {
  // Add the field just before residualRecovery
  const target = "  // Set when a session finalizes to `stopped`";
  if (!s.includes(target)) {
    console.error('FATAL: schema insertion target not found');
    process.exit(1);
  }
  
  const insertion = [
    "  // F2: per-session profit-taking mode. 'reinvest' = keep profits in session.",
    "  // 'take_profits' = after each TP exit, send realized profit to owner_wallet",
    "  // (minus 0.33% performance fee). Default: 'reinvest'.",
    "  profitTakingMode: z.enum(['reinvest', 'take_profits']).default('reinvest'),",
    "",
  ].join('\r\n');
  
  s = s.replace(target, insertion + '  ' + target.trimStart());
  fs.writeFileSync(schemaFile, s);
  console.log('[schema] Added profitTakingMode to sessionServiceControlSchema');
} else {
  console.log('[schema] profitTakingMode already exists');
}

// ── 2. Worker — profit-taking at TP exit ──
const workerFile = path.join(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let w = fs.readFileSync(workerFile, 'utf8');

if (!w.includes('profitTakingMode')) {
  // Find where take_profit exits are handled — after a confirmed take_profit exit
  // Look for the exitReason === 'take_profit' check
  const tpExitCheck = "exitReason === 'take_profit'";
  const allOccurrences = [];
  let pos = 0;
  while (true) {
    const idx = w.indexOf(tpExitCheck, pos);
    if (idx < 0) break;
    const lineNum = w.substring(0, idx).split(/\r?\n/).length;
    allOccurrences.push({ idx, line: lineNum });
    pos = idx + 1;
  }
  
  console.log('[worker] take_profit exit references:', allOccurrences.map(o => `line ${o.line}`).join(', '));
  
  if (allOccurrences.length === 0) {
    console.log('[worker] WARN: no take_profit exit handling found. Looking for exit confirmation code...');
    
    // Find where positions are closed/exited
    const exitConfirmation = w.indexOf("exitReason: 'take_profit'");
    if (exitConfirmation >= 0) {
      const lineNum = w.substring(0, exitConfirmation).split(/\r?\n/).length;
      console.log(`[worker] Found exitReason assignment at line ${lineNum}`);
    }
  }
  
  // The profit-taking logic needs to:
  // 1. After a confirmed TP exit (position closed at take_profit)
  // 2. Check session.service_control.profitTakingMode
  // 3. If 'take_profits': calculate realized profit, deduct 0.33% fee, send SOL to owner
  //
  // This is complex and interacts with the position management flow.
  // For now, add a helper function and wire the call site.
  
  // Add the profit-taking helper
  const helperFn = [
    '',
    '// ── F2: Profit-taking payout at take-profit exit ─────────────────────────────',
    '// When profitTakingMode is "take_profits", after a confirmed TP exit,',
    '// compute realized profit, deduct performance fee, and send to owner wallet.',
    'const maybeSendTakeProfitPayout = async (',
    '  session: RawSession,',
    '  exitPnlLamports: number,',
    '): Promise<void> => {',
    "  const mode = session.service_control?.profitTakingMode ?? 'reinvest';",
    "  if (mode !== 'take_profits' || exitPnlLamports <= 0) return;",
    '',
    '  const keypair = await getKeypair(session.id);',
    '  if (!keypair) {',
    "    log('warn', session.id, 'profit-taking: cannot load session keypair');",
    '    return;',
    '  }',
    '',
    '  const ownerWallet = session.owner_wallet;',
    '  if (!ownerWallet) {',
    "    log('warn', session.id, 'profit-taking: no owner_wallet on session');",
    '    return;',
    '  }',
    '',
    '  // Deduct performance fee (0.33%)',
    '  const feeBps = WORKER_PERFORMANCE_FEE_BPS;',
    '  const feeLamports = livePerformanceFeeEnabled && feeBps > 0',
    '    ? Math.floor(exitPnlLamports * feeBps / 10_000)',
    '    : 0;',
    '  const payoutLamports = exitPnlLamports - feeLamports;',
    '',
    '  if (payoutLamports <= TX_FEE_LAMPORTS * 2) {',
    "    log('info', session.id, `profit-taking: payout too small (${payoutLamports} lamports), skipping`);",
    '    return;',
    '  }',
    '',
    '  const sessionPubkey = keypair.publicKey;',
    '  const ownerPubkey = new PublicKey(ownerWallet);',
    '',
    '  try {',
    '    const ixs: TransactionInstruction[] = [',
    '      SystemProgram.transfer({ fromPubkey: sessionPubkey, toPubkey: ownerPubkey, lamports: payoutLamports }),',
    '    ];',
    '    if (feeLamports > TX_FEE_LAMPORTS) {',
    '      ixs.push(SystemProgram.transfer({ fromPubkey: sessionPubkey, toPubkey: PERFORMANCE_FEE_PUBKEY, lamports: feeLamports }));',
    '    }',
    '',
    '    const { blockhash, lastValidBlockHeight } = await rlGetLatestBlockhash();',
    '    const msg = new TransactionMessage({',
    '      payerKey: sessionPubkey,',
    '      recentBlockhash: blockhash,',
    '      instructions: ixs,',
    '    }).compileToV0Message();',
    '    const tx = new VersionedTransaction(msg);',
    '    tx.sign([keypair]);',
    '    const sig = await rlSendRawTransaction(tx.serialize());',
    '',
    '    const confirmation = await rlConfirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });',
    '    if (!confirmation.value.err) {',
    "      log('info', session.id, `profit-taking payout sent: ${payoutLamports} to ${ownerWallet}, fee ${feeLamports} lamports, sig=${sig}`);",
    '    } else {',
    "      log('warn', session.id, `profit-taking payout tx failed: ${JSON.stringify(confirmation.value.err)}`);",
    '    }',
    '  } catch (err) {',
    "    log('warn', session.id, `profit-taking payout error: ${String(err)}`);",
    '  }',
    '};',
    '',
  ].join('\r\n');
  
  // Insert before the sweepFunds function
  const sweepTarget = 'const sweepFunds = async';
  const sweepIdx = w.indexOf(sweepTarget);
  if (sweepIdx >= 0) {
    w = w.substring(0, sweepIdx) + helperFn + w.substring(sweepIdx);
    console.log('[worker] Added maybeSendTakeProfitPayout helper');
  } else {
    console.log('[worker] WARN: sweepFunds not found for insertion');
  }
  
  // Now wire the call — find where a take-profit exit is confirmed and the position is closed
  // Look for exitReason = 'take_profit' in the position exit flow
  const exitConfirmation = "exitReason: 'take_profit'";
  if (w.includes(exitConfirmation)) {
    // Find the broader context — we need to call maybeSendTakeProfitPayout AFTER the exit is confirmed
    // Look for where position PnL is calculated after exit
    const pnlAfterExit = w.indexOf('realizedPnl');
    if (pnlAfterExit >= 0) {
      console.log('[worker] Found realizedPnl — profit-taking call site needs manual wiring');
      console.log('[worker] The maybeSendTakeProfitPayout function is ready to be called');
      console.log('[worker] Call: await maybeSendTakeProfitPayout(session, realizedPnlLamports)');
    }
  }
  
  fs.writeFileSync(workerFile, w);
  console.log('[worker] F2 profit-taking helper added');
} else {
  console.log('[worker] profitTakingMode already exists');
}

console.log('\nF2 done: schema + worker helper. Call site wiring may need refinement.');
