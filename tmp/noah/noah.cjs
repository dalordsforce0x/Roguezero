require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const SID_PREFIX = 'edd46e65';

(async () => {
  const sid = (await pool.query(`select id from sessions where id::text like $1`, [SID_PREFIX + '%'])).rows[0].id;
  console.log('Noah session', sid);

  const cols = await pool.query(`select column_name from information_schema.columns where table_name='swap_executions' order by ordinal_position`);
  console.log('swap_executions cols:', cols.rows.map(r=>r.column_name).join(', '));

  const tot = await pool.query(
    `select status, count(*) from swap_executions where session_id=$1 group by status order by count(*) desc`, [sid]
  );
  console.log('\nNoah swaps by status:');
  for (const r of tot.rows) console.log(`  ${String(r.status).padEnd(14)} ${r.count}`);

  await pool.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
