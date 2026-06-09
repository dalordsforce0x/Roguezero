require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const p = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const DAY = '2026-06-09T00:00:00Z';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL  = 'So11111111111111111111111111111111111111112';
const SESSIONS = [
  { name: 'Noah',     wallet: 'Fu23Ra8SWUUNqpjR2mKqydx37WAykGpDbKBKaxkHAsaW' },
  { name: 'b1019831', wallet: 'tzM97zpSQpsXUoZHgvTxj7X4sXd3bf1hrT2LmtxpKg7' },
  { name: 'a51f955c', wallet: '8FvnRY4KsLGptz2HwmhUzTeEHQrrgfS8Sy343CG9anjC' },
];
const sym = (m) => m === USDC ? 'USDC' : m === SOL ? 'SOL' : m.slice(0,5);
(async () => {
  for (const s of SESSIONS) {
    console.log(`\n========== ${s.name} (today) ==========`);
    const r = await p.query(
      `select input_mint, output_mint,
              (build_response->>'inAmount') in_amt,
              (build_response->>'outAmount') out_amt,
              metadata->>'exitReason' exit_reason,
              metadata->>'entryStrategy' entry_strat
       from swap_executions
       where status='confirmed' and taker=$1 and created_at >= $2
       order by created_at asc`, [s.wallet, DAY]);

    // Per-token USDC-quoted PnL: net USDC from selling token minus USDC spent buying it
    const tok = {}; // mint -> {usdcIn, usdcOut, tokBought, tokSold, buys, sells}
    const exitCount = {};
    for (const x of r.rows) {
      const inM = x.input_mint, outM = x.output_mint;
      // count exit reasons (only sells = token->USDC or token->SOL)
      if (outM === USDC || outM === SOL) {
        const er = x.exit_reason || '(none)';
        exitCount[er] = (exitCount[er] || 0) + 1;
      }
      if (inM === USDC && outM !== USDC && outM !== SOL) { // buy token with USDC
        const t = tok[outM] ||= { usdcIn:0, usdcOut:0, tokBought:0, tokSold:0, buys:0, sells:0 };
        t.usdcIn += Number(x.in_amt); t.tokBought += Number(x.out_amt); t.buys++;
      } else if (outM === USDC && inM !== USDC && inM !== SOL) { // sell token for USDC
        const t = tok[inM] ||= { usdcIn:0, usdcOut:0, tokBought:0, tokSold:0, buys:0, sells:0 };
        t.usdcOut += Number(x.out_amt); t.tokSold += Number(x.in_amt); t.sells++;
      }
    }

    console.log('  Exit-reason breakdown (sell legs):');
    Object.entries(exitCount).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => console.log(`    ${k}: ${v}`));

    console.log('  Per-token USDC round-trip PnL (only ~flat positions count as realized):');
    let netRealized = 0;
    const rows = Object.entries(tok).map(([m,t]) => {
      const flatRatio = t.tokBought > 0 ? t.tokSold / t.tokBought : 0;
      const netUsdc = (t.usdcOut - t.usdcIn) / 1e6; // USDC 6 decimals
      if (flatRatio > 0.9 && flatRatio < 1.1) netRealized += netUsdc;
      return { sym: sym(m), buys: t.buys, sells: t.sells, netUsdc, flatRatio };
    }).sort((a,b)=>a.netUsdc-b.netUsdc);
    rows.forEach(x => console.log(`    ${x.sym.padEnd(6)} buys=${x.buys} sells=${x.sells} netUSDC=${x.netUsdc.toFixed(3)} flat=${(x.flatRatio*100).toFixed(0)}%`));
    console.log(`  >>> Today realized USDC (flat positions only): ${netRealized.toFixed(3)}`);
  }
  await p.end();
})().catch(e => { console.error(e.message); process.exit(1); });
