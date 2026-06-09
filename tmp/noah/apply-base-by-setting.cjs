const fs = require('fs');
const path = 'services/worker/src/index.ts';
let raw = fs.readFileSync(path, 'latin1');
const hadCRLF = raw.includes('\r\n');
let s = raw.replace(/\r\n/g, '\n');

const edits = [
  // A: gate the activation SOL->USDC conversion on the chosen base
  {
    name: 'activation-convert-gate',
    old: `  let solBalance = await rlGetBalance(keypair.publicKey).catch(() => 0);
  let usdcBalance = await getTokenBalanceAtomic(keypair.publicKey, USDC_MINT, TOKEN_PROGRAM_ID).catch(() => 0);

  if (usdcBalance < MIN_USDC_ENTRY_ATOMIC) {
    const lamportsToConvert = computeSolToUsdcConversionLamports(solBalance);`,
    new: `  let solBalance = await rlGetBalance(keypair.publicKey).catch(() => 0);
  let usdcBalance = await getTokenBalanceAtomic(keypair.publicKey, USDC_MINT, TOKEN_PROGRAM_ID).catch(() => 0);

  const useUsdcBase = sessionUsesUsdcBase(session);

  if (useUsdcBase && usdcBalance < MIN_USDC_ENTRY_ATOMIC) {
    const lamportsToConvert = computeSolToUsdcConversionLamports(solBalance);`,
  },
  // B: persist the base mint (SOL or USDC) chosen for this session
  {
    name: 'activation-funding-patch',
    old: `  const now = new Date().toISOString();
  await mergeFundingPatch(session, {
    fundingMint: USDC_MINT,
    fundingTokenSymbol: 'USDC',
    startingBalanceAtomic: String(usdcBalance),
    currentBalanceAtomic: String(usdcBalance),
  });`,
    new: `  const now = new Date().toISOString();
  if (useUsdcBase) {
    await mergeFundingPatch(session, {
      fundingMint: USDC_MINT,
      fundingTokenSymbol: 'USDC',
      startingBalanceAtomic: String(usdcBalance),
      currentBalanceAtomic: String(usdcBalance),
    });
  } else {
    await mergeFundingPatch(session, {
      fundingMint: SOL_MINT,
      fundingTokenSymbol: 'SOL',
      startingBalanceAtomic: String(solBalance),
      currentBalanceAtomic: String(solBalance),
    });
  }`,
  },
  // C: activation log reflects the actual base
  {
    name: 'activation-log',
    old: `USDC base trading begins (usdc=\${usdcBalance}, solReserve=\${solBalance})`,
    new: `\${useUsdcBase ? 'USDC' : 'SOL'} base trading begins (usdc=\${usdcBalance}, sol=\${solBalance})`,
  },
  // D: helper deriving the base from the profit setting
  {
    name: 'base-helper',
    old: `const getSessionProfitHandling = (session: RawSession) => (
  session.user_control?.profitHandling ?? {
    mode: 'send_to_owner' as const,
    payoutToken: 'USDC' as const,
  }
);`,
    new: `const getSessionProfitHandling = (session: RawSession) => (
  session.user_control?.profitHandling ?? {
    mode: 'send_to_owner' as const,
    payoutToken: 'USDC' as const,
  }
);

// The session's trading base currency is driven by the user's profit setting:
//   - take profits in USDC (send_to_owner + USDC) -> USDC base (idle capital parks
//     in USDC; the "usdc swap protection"). Exits settle to USDC, payouts send USDC.
//   - compound OR take profits in SOL -> SOL base. Capital stays native SOL, exits
//     settle back to SOL, and the session returns SOL with no USDC round-trip.
// Compound implies a SOL return by default, so payoutToken is ignored when compounding.
const sessionUsesUsdcBase = (session: RawSession): boolean => {
  const handling = getSessionProfitHandling(session);
  return handling.mode === 'send_to_owner' && handling.payoutToken === 'USDC';
};`,
  },
  // E: never sweep native SOL into USDC for a SOL-base session
  {
    name: 'capital-topup-guard',
    old: `const maybeTopUpTradingCapitalFromSol = async (
  session: RawSession,
  keypair: Keypair,
  solBalanceLamports: number,
): Promise<number> => {
  const excessLamports = solBalanceLamports - CAPITAL_TOPUP_KEEP_LAMPORTS;`,
    new: `const maybeTopUpTradingCapitalFromSol = async (
  session: RawSession,
  keypair: Keypair,
  solBalanceLamports: number,
): Promise<number> => {
  // SOL-base sessions (compound / take-profits-in-SOL) keep native SOL as their
  // trading capital, so it must never be swept into USDC. Only USDC-base sessions
  // treat idle SOL above the gas reserve as deployable trading capital.
  if (session.funding.fundingMint !== USDC_MINT) {
    return solBalanceLamports;
  }
  const excessLamports = solBalanceLamports - CAPITAL_TOPUP_KEEP_LAMPORTS;`,
  },
  // F: exits settle to the session's base, not always USDC
  {
    name: 'exit-base',
    old: `      const sellInventory: TradeInventoryContext = {
        inputMint: positionMint,
        inputSymbol: positionSymbol,
        outputMint: USDC_MINT,
        outputSymbol: 'USDC',
        balanceAtomic: exitWalletBalanceAtomic,`,
    new: `      const exitBaseMint = session.funding.fundingMint === USDC_MINT ? USDC_MINT : SOL_MINT;
      const exitBaseSymbol = exitBaseMint === USDC_MINT ? 'USDC' : 'SOL';
      const sellInventory: TradeInventoryContext = {
        inputMint: positionMint,
        inputSymbol: positionSymbol,
        outputMint: exitBaseMint,
        outputSymbol: exitBaseSymbol,
        balanceAtomic: exitWalletBalanceAtomic,`,
  },
];

for (const e of edits) {
  const count = s.split(e.old).length - 1;
  if (count !== 1) {
    console.error(`EDIT FAILED [${e.name}]: expected exactly 1 match, found ${count}`);
    process.exit(1);
  }
  s = s.replace(e.old, e.new);
  console.log(`OK [${e.name}]`);
}

const out = hadCRLF ? s.replace(/\n/g, '\r\n') : s;
fs.writeFileSync(path, out, 'latin1');
console.log('WROTE', path);
