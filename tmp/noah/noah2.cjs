require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const TAKER = 'Fu23Ra8SWUUNqpjR2mKqydx37WAykGpDbKBKaxkHAsaW';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = 'So11111111111111111111111111111111111111112';

(async () => {
  const byStatus = await pool.query(
    `select status, count(*) c from swap_executions where taker=$1 group by status order by c desc`, [TAKER]
  );
  console.log('Noah swaps by status (all time):');
  for (const r of byStatus.rows) console.log(`  ${String(r.status).padEnd(14)} ${r.c}`);

  const recent = await pool.query(
    `select created_at, status, input_mint, output_mint, amount, signature,
            (build_response->>'priceImpactPct') as impact, last_error
       from swap_executions where taker=$1 order by created_at desc limit 15`, [TAKER]
  );
  console.log('\nLast 15 swap attempts:');
  for (const r of recent.rows) {
    const dir = r.input_mint===SOL ? 'BUY ' : (r.output_mint===SOL||r.output_mint===USDC ? 'SELL' : '????');
    const tok = r.input_mint===SOL ? r.output_mint : r.input_mint;
    const imp = r.impact ? (Number(r.impact)*10000).toFixed(0)+'bps' : '-';
    console.log(`  ${new Date(r.created_at).toISOString().slice(5,16)}  ${dir}  ${String(r.status).padEnd(11)}  tok=${tok.slice(0,6)}  imp=${imp}  ${r.last_error? 'ERR:'+String(r.last_error).slice(0,40):''}`);
  }

  const last = await pool.query(`select max(created_at) m from swap_executions where taker=$1`, [TAKER]);
  console.log('\nMost recent swap attempt:', last.rows[0].m ? new Date(last.rows[0].m).toISOString() : 'NEVER');
  await pool.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
