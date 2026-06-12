require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const p = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const CUTOFF = '2026-06-09T17:05:00Z';
const WALLETS = {
  'Fu23Ra8SWUUNqpjR2mKqydx37WAykGpDbKBKaxkHAsaW': 'Noah',
  'tzM97zpSQpsXUoZHgvTxj7X4sXd3bf1hrT2LmtxpKg7': 'b1019831',
  '8FvnRY4KsLGptz2HwmhUzTeEHQrrgfS8Sy343CG9anjC': 'a51f955c(bleeder)',
};
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const sym = m => m === SOL ? 'SOL' : m === USDC ? 'USDC' : m.slice(0,4);
(async () => {
  const mins = (Date.now() - Date.parse(CUTOFF)) / 60000;
  console.log(`Minutes since cutoff: ${mins.toFixed(1)}\n`);
  for (const [w, name] of Object.entries(WALLETS)) {
    const r = await p.query(
      `select status, count(*) n,
              count(*) filter (where platform_fee_bps>0) fee_nonzero,
              count(distinct input_mint||'>'||output_mint) pairs
       from swap_executions where taker=$1 and created_at >= $2 group by status`,
      [w, CUTOFF]);
    const total = r.rows.reduce((s,x)=>s+Number(x.n),0);
    const feeBad = r.rows.reduce((s,x)=>s+Number(x.fee_nonzero),0);
    console.log(`${name}: ${total} swaps  [${r.rows.map(x=>x.status+':'+x.n).join(', ')}]  feeBps>0: ${feeBad}`);
    // show last few confirmed routes
    const last = await p.query(
      `select status, input_mint, output_mint, platform_fee_bps, created_at
       from swap_executions where taker=$1 and created_at >= $2
       order by created_at desc limit 5`, [w, CUTOFF]);
    for (const x of last.rows)
      console.log(`    ${x.created_at.toISOString().slice(11,19)} ${x.status.padEnd(10)} ${sym(x.input_mint)}->${sym(x.output_mint)} feeBps=${x.platform_fee_bps}`);
  }
  await p.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
