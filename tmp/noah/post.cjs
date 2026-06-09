require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const TAKER = 'Fu23Ra8SWUUNqpjR2mKqydx37WAykGpDbKBKaxkHAsaW';
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const CUTOFF = '2026-06-09T14:49:44Z'; // new worker instance go-live

(async () => {
  console.log('=== Noah activity AFTER go-live', CUTOFF, '===\n');

  const byStatus = await pool.query(
    `select status, count(*) c from swap_executions
       where taker=$1 and created_at > $2 group by status order by c desc`, [TAKER, CUTOFF]
  );
  console.log('Swaps by status (post-cutoff):');
  if (byStatus.rows.length === 0) console.log('  (none yet)');
  for (const r of byStatus.rows) console.log(`  ${String(r.status).padEnd(12)} ${r.c}`);

  const recent = await pool.query(
    `select created_at, status, input_mint, output_mint,
            (build_response->>'priceImpactPct') impact, last_error
       from swap_executions where taker=$1 and created_at > $2
       order by created_at desc limit 25`, [TAKER, CUTOFF]
  );
  console.log('\nMost recent post-cutoff attempts:');
  for (const r of recent.rows) {
    const dir = r.input_mint===SOL ? 'BUY ' : (r.output_mint===SOL||r.output_mint===USDC ? 'SELL' : '????');
    const tok = (r.input_mint===SOL ? r.output_mint : r.input_mint).slice(0,6);
    const imp = r.impact ? (Number(r.impact)*10000).toFixed(0)+'bps' : '-';
    let err='';
    const e=r.last_error;
    if(e){ err = typeof e==='string'? e : (e.message||e.error||e.reason||JSON.stringify(e)); err=' ERR:'+String(err).slice(0,38);}
    console.log(`  ${new Date(r.created_at).toISOString().slice(11,19)}  ${dir} ${String(r.status).padEnd(10)} tok=${tok} imp=${imp}${err}`);
  }
  await pool.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
