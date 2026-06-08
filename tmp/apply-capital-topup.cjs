// Add dynamic trading-capital top-up (SOL -> USDC), the mirror of the existing
// USDC -> SOL gas keep-alive. When an active session carries more native SOL
// than it needs for gas, sweep the excess into USDC so freshly-funded SOL
// actually becomes deployable trading capital. Hysteresis deadband (keep floor
// held above the gas-refill target) prevents ping-pong with the gas refill.
// Flag-gated (WORKER_CAPITAL_TOPUP_ENABLED) + canary-scoped (isCanaryShadowEnabled);
// shadow-logs what it WOULD convert when the flag is off.
const fs = require('fs');
const path = 'services/worker/src/index.ts';
let src = fs.readFileSync(path, 'utf8');

function apply(label, oldStr, newStr) {
  const count = src.split(oldStr).length - 1;
  if (count !== 1) {
    throw new Error(`[${label}] expected exactly 1 match, found ${count}`);
  }
  src = src.split(oldStr).join(newStr);
  console.log(`[${label}] applied`);
}

// ── Edit 1: insert constants + maybeTopUpTradingCapitalFromSol after the gas refill fn ──
const anchor1 = `  setCachedSessionBalance(keypair.publicKey.toBase58(), newSolBalance);
  log('info', session.id, \`gas refill complete: SOL \${solBalanceLamports} -> \${newSolBalance}\`);
  return newSolBalance;
};

const maybeTransferRealizedProfit = async (`;

const insert1 = `  setCachedSessionBalance(keypair.publicKey.toBase58(), newSolBalance);
  log('info', session.id, \`gas refill complete: SOL \${solBalanceLamports} -> \${newSolBalance}\`);
  return newSolBalance;
};

// ── Trading-capital top-up (SOL -> USDC) ─────────────────────────────────────
// Mirror image of the gas keep-alive above. The gas refill converts USDC->SOL
// when the fee tank runs low; this converts the REVERSE when a session carries
// more native SOL than it needs for gas. In the USDC-base model trading capital
// lives in USDC, so idle SOL above a comfortable gas reserve is dead weight that
// can never be entered. This sweeps the excess into USDC so freshly-funded SOL
// becomes deployable trading capital. The keep floor is pinned above the gas
// refill's target so the two directions never ping-pong (a wide hysteresis
// deadband sits between them). Flag-gated + canary-scoped + shadow-first.
const WORKER_CAPITAL_TOPUP_ENABLED = process.env.WORKER_CAPITAL_TOPUP_ENABLED === 'true';
// SOL retained for gas after a top-up. Held above the gas-refill target (+ one
// swap cost) so converting excess never drops us into gas-refill territory.
const CAPITAL_TOPUP_KEEP_LAMPORTS = Math.max(
  Number(process.env.WORKER_CAPITAL_TOPUP_KEEP_LAMPORTS ?? 50_000_000), // 0.05 SOL default
  GAS_REFILL_TARGET_LAMPORTS + GAS_REFILL_SWAP_COST_LAMPORTS,
);
// Only act once the idle excess is worth a swap (avoid dust conversions every loop).
const CAPITAL_TOPUP_MIN_EXCESS_LAMPORTS = Number(
  process.env.WORKER_CAPITAL_TOPUP_MIN_EXCESS_LAMPORTS ?? 20_000_000, // 0.02 SOL default
);

const maybeTopUpTradingCapitalFromSol = async (
  session: RawSession,
  keypair: Keypair,
  solBalanceLamports: number,
): Promise<number> => {
  const excessLamports = solBalanceLamports - CAPITAL_TOPUP_KEEP_LAMPORTS;
  if (excessLamports < CAPITAL_TOPUP_MIN_EXCESS_LAMPORTS) {
    // Common "no idle SOL" case stays quiet to avoid per-loop log spam.
    return solBalanceLamports;
  }

  const active = isCanaryShadowEnabled(session, WORKER_CAPITAL_TOPUP_ENABLED);
  const excessSol = (excessLamports / 1_000_000_000).toFixed(4);
  log(
    'info',
    session.id,
    \`capital top-up \${active ? 'apply' : 'shadow'}: SOL \${solBalanceLamports} keep \${CAPITAL_TOPUP_KEEP_LAMPORTS}; would convert \${excessLamports} lamports (~\${excessSol} SOL) -> USDC\`,
  );
  if (!active) {
    return solBalanceLamports;
  }

  const converted = await convertSolToUsdc(session, keypair, excessLamports);
  if (!converted) {
    log('warn', session.id, 'capital top-up: SOL->USDC conversion did not complete this cycle');
    return solBalanceLamports;
  }

  // Wait for the reduced SOL balance to land before continuing the trade loop.
  let newSolBalance = solBalanceLamports;
  for (let attempt = 1; attempt <= 8; attempt++) {
    const sol = await rlGetBalance(keypair.publicKey).catch(() => newSolBalance);
    if (sol < solBalanceLamports) {
      newSolBalance = sol;
      break;
    }
    if (attempt === 8) {
      log('warn', session.id, 'capital top-up submitted but SOL balance not yet reduced');
    } else {
      await new Promise<void>((resolve) => setTimeout(resolve, 1500));
    }
  }

  setCachedSessionBalance(keypair.publicKey.toBase58(), newSolBalance);
  log('info', session.id, \`capital top-up complete: SOL \${solBalanceLamports} -> \${newSolBalance} (excess moved to USDC trading capital)\`);
  return newSolBalance;
};

const maybeTransferRealizedProfit = async (`;

apply('insert capital top-up fn', anchor1, insert1);

// ── Edit 2: call the top-up just before the gas refill in the active loop ──
const anchor2 = `  balance = await maybeRefillGasFromUsdc(session, keypair, balance);`;
const insert2 = `  // Capital keep-alive (mirror of the gas refill below): sweep idle SOL above the
  // gas reserve into USDC so freshly-funded SOL becomes deployable trading capital.
  balance = await maybeTopUpTradingCapitalFromSol(session, keypair, balance);

  balance = await maybeRefillGasFromUsdc(session, keypair, balance);`;

apply('insert capital top-up call', anchor2, insert2);

fs.writeFileSync(path, src);
console.log('done');
