require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const TAKER = 'Fu23Ra8SWUUNqpjR2mKqydx37WAykGpDbKBKaxkHAsaW';

(async () => {
  const r = await pool.query(
    `select last_error from swap_executions
       where taker=$1 and status='failed' and created_at > now() - interval '24 hours'`, [TAKER]
  );
  const tally = {};
  for (const row of r.rows) {
    let msg = '(empty)';
    const e = row.last_error;
    if (e) {
      if (typeof e === 'string') msg = e;
      else if (typeof e === 'object') msg = e.message || e.error || e.reason || e.code || JSON.stringify(e);
    }
    msg = String(msg).slice(0, 70);
    tally[msg] = (tally[msg] || 0) + 1;
  }
  console.log('Noah FAILED swap reasons (last 24h):');
  for (const [k, v] of Object.entries(tally).sort((a,b)=>b[1]-a[1])) {
    console.log(`  ${String(v).padStart(4)}  ${k}`);
  }
  await pool.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
