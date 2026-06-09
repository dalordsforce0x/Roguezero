require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const TAKER = 'Fu23Ra8SWUUNqpjR2mKqydx37WAykGpDbKBKaxkHAsaW';
const CUTOFF = '2026-06-09T14:49:44Z';

(async () => {
  // distinct mints traded post-cutoff
  const mints = await pool.query(
    `select input_mint, output_mint, count(*) c from swap_executions
       where taker=$1 and created_at > $2 group by input_mint, output_mint order by c desc`,
    [TAKER, CUTOFF]
  );
  console.log('Post-cutoff mint pairs (input -> output):');
  for (const r of mints.rows) console.log(`  ${r.input_mint.slice(0,8)} -> ${r.output_mint.slice(0,8)}  x${r.c}`);

  // failure reason tally post-cutoff (decoded)
  const fails = await pool.query(
    `select last_error from swap_executions
       where taker=$1 and created_at > $2 and status='failed'`, [TAKER, CUTOFF]
  );
  const tally = {};
  for (const row of fails.rows) {
    let m='(empty)'; const e=row.last_error;
    if(e){ m = typeof e==='string'? e : (e.message||e.error||e.reason||e.code||JSON.stringify(e)); }
    m=String(m).slice(0,60); tally[m]=(tally[m]||0)+1;
  }
  console.log('\nPost-cutoff failure reasons:');
  for (const [k,v] of Object.entries(tally).sort((a,b)=>b[1]-a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);

  // is the sell-impact cap firing anywhere (all sessions, post-cutoff)?
  const cap = await pool.query(
    `select count(*) c from swap_executions
       where created_at > $1 and (last_error::text ilike '%entry_sell_impact_too_high%')`, [CUTOFF]
  );
  console.log('\nentry_sell_impact_too_high blocks (fleet, post-cutoff):', cap.rows[0].c);
  await pool.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
