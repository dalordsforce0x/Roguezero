// Apply dynamic tip tier to worker submit calls
const fs = require('fs');
const path = require('path');
const filePath = path.join(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let src = fs.readFileSync(filePath, 'utf8');
let changes = 0;

// 1. Add getFleetTipTier() helper after the autoShift variables
const anchor1 = "let lastAutoShiftTransitionAt: string | null = null;";
const helper = `

// ── Dynamic Sender tip tier ─────────────────────────────────────────────────
// Maps fleet pressure state to a tip tier sent with each swap submit.
// - normal (SWQoS-only, 5K lamport tip): default, cheapest path
// - elevated (SWQoS-only, 50K tip): when fleet is under pressure or exits are stuck
// - urgent (full Sender + Jito, 200K tip): glide mode or exit-critical trades
type TipTier = 'normal' | 'elevated' | 'urgent';
const getFleetTipTier = (isExitTrade: boolean = false): TipTier => {
  // Urgent: glide mode means heavy pressure — use full Jito for better landing
  if (liveSpeedProfileName === 'glide') return 'urgent';
  // Exits that are stuck should escalate to ensure they land
  if (isExitTrade && liveSpeedProfileName === 'pulse') return 'elevated';
  // Pulse mode with budget pressure: elevated tips
  if (liveSpeedProfileName === 'pulse') return 'elevated';
  // Surge (healthy): cheapest path
  return 'normal';
};`;

if (src.includes(anchor1) && !src.includes('getFleetTipTier')) {
  src = src.replace(anchor1, anchor1 + helper);
  changes++;
  console.log('1. Added getFleetTipTier() helper');
} else if (src.includes('getFleetTipTier')) {
  console.log('1. SKIP: getFleetTipTier already exists');
} else {
  console.log('1. FAIL: anchor not found for helper');
}

// 2. Add tipTier to main trade submit (the entry/exit trade path ~line 8821)
const mainSubmit = `  const submit = await apiPost<SubmitResponse>('/jupiter/swap/submit', {
    executionId:            prepare.data.executionId,
    signedTransactionBase64: signedBase64,
    blockhash:              prepare.data.blockhash,
    lastValidBlockHeight:   prepare.data.lastValidBlockHeight,
  });`;

const mainSubmitNew = `  const submit = await apiPost<SubmitResponse>('/jupiter/swap/submit', {
    executionId:            prepare.data.executionId,
    signedTransactionBase64: signedBase64,
    blockhash:              prepare.data.blockhash,
    lastValidBlockHeight:   prepare.data.lastValidBlockHeight,
    tipTier:                getFleetTipTier(isExit),
  });`;

if (src.includes(mainSubmit)) {
  src = src.replace(mainSubmit, mainSubmitNew);
  changes++;
  console.log('2. Added tipTier to main trade submit');
} else {
  console.log('2. FAIL: main trade submit pattern not found');
}

// 3. Add tipTier to SOL->USDC conversion submit (~line 5589)
const solUsdcSubmit = `  const submit = await apiPost<SubmitResponse>('/jupiter/swap/submit', {
    executionId: prepare.data.executionId,
    signedTransactionBase64: Buffer.from(tx.serialize()).toString('base64'),
    blockhash: prepare.data.blockhash,
    lastValidBlockHeight: prepare.data.lastValidBlockHeight,
  });

  if (!submit.ok) {
    log('warn', session.id, \`SOL->USDC submit failed: \${submit.data.error ?? submit.status}\`);`;

const solUsdcSubmitNew = `  const submit = await apiPost<SubmitResponse>('/jupiter/swap/submit', {
    executionId: prepare.data.executionId,
    signedTransactionBase64: Buffer.from(tx.serialize()).toString('base64'),
    blockhash: prepare.data.blockhash,
    lastValidBlockHeight: prepare.data.lastValidBlockHeight,
    tipTier: getFleetTipTier(),
  });

  if (!submit.ok) {
    log('warn', session.id, \`SOL->USDC submit failed: \${submit.data.error ?? submit.status}\`);`;

if (src.includes(solUsdcSubmit)) {
  src = src.replace(solUsdcSubmit, solUsdcSubmitNew);
  changes++;
  console.log('3. Added tipTier to SOL->USDC submit');
} else {
  console.log('3. FAIL: SOL->USDC submit pattern not found');
}

// 4. Add tipTier to USDC->SOL gas refill submit (~line 5668)
const gasRefillSubmit = `  const submit = await apiPost<SubmitResponse>('/jupiter/swap/submit', {
    executionId: prepare.data.executionId,
    signedTransactionBase64: Buffer.from(tx.serialize()).toString('base64'),
    blockhash: prepare.data.blockhash,
    lastValidBlockHeight: prepare.data.lastValidBlockHeight,
  });

  if (!submit.ok) {
    log('warn', session.id, \`USDC->SOL gas refill submit failed: \${submit.data.error ?? submit.status}\`);`;

const gasRefillSubmitNew = `  const submit = await apiPost<SubmitResponse>('/jupiter/swap/submit', {
    executionId: prepare.data.executionId,
    signedTransactionBase64: Buffer.from(tx.serialize()).toString('base64'),
    blockhash: prepare.data.blockhash,
    lastValidBlockHeight: prepare.data.lastValidBlockHeight,
    tipTier: getFleetTipTier(),
  });

  if (!submit.ok) {
    log('warn', session.id, \`USDC->SOL gas refill submit failed: \${submit.data.error ?? submit.status}\`);`;

if (src.includes(gasRefillSubmit)) {
  src = src.replace(gasRefillSubmit, gasRefillSubmitNew);
  changes++;
  console.log('4. Added tipTier to gas refill submit');
} else {
  console.log('4. FAIL: gas refill submit pattern not found');
}

// 5. Add tipTier to liquidation submit (~line 9750)
const liqSubmit = `      const submit = await apiPost<SubmitResponse>('/jupiter/swap/submit', {
        executionId: prepare.data.executionId,
        signedTransactionBase64: Buffer.from(tx.serialize()).toString('base64'),
        blockhash: prepare.data.blockhash,
        lastValidBlockHeight: prepare.data.lastValidBlockHeight,
      });

      if (!submit.ok) {
        log(
          'warn',
          session.id,
          \`liquidation submit failed for \${symbol}: \${submit.data.error ?? submit.status}`;

const liqSubmitNew = `      const submit = await apiPost<SubmitResponse>('/jupiter/swap/submit', {
        executionId: prepare.data.executionId,
        signedTransactionBase64: Buffer.from(tx.serialize()).toString('base64'),
        blockhash: prepare.data.blockhash,
        lastValidBlockHeight: prepare.data.lastValidBlockHeight,
        tipTier: 'urgent',
      });

      if (!submit.ok) {
        log(
          'warn',
          session.id,
          \`liquidation submit failed for \${symbol}: \${submit.data.error ?? submit.status}`;

if (src.includes(liqSubmit)) {
  src = src.replace(liqSubmit, liqSubmitNew);
  changes++;
  console.log('5. Added tipTier to liquidation submit (always urgent)');
} else {
  console.log('5. FAIL: liquidation submit pattern not found');
}

if (changes > 0) {
  fs.writeFileSync(filePath, src);
  console.log(`\nDone: ${changes} changes applied to worker.`);
} else {
  console.log('\nNo changes applied.');
}
