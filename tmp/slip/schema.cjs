require('dotenv').config();
const pg = require('pg');
const url = new URL(process.env.DATABASE_PRIVATE_URL.trim());
url.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: url.toString(), ssl: { rejectUnauthorized: false } });

(async () => {
  const cols = (await pool.query(`
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_name='swap_executions' ORDER BY ordinal_position
  `)).rows;
  console.log('=== swap_executions columns ===');
  for (const c of cols) console.log(`${c.column_name.padEnd(34)} ${c.data_type}`);

  const sample = (await pool.query(`
    SELECT * FROM swap_executions
    WHERE status='confirmed' AND created_at > now() - interval '72 hours'
    ORDER BY created_at DESC LIMIT 1
  `)).rows[0];
  console.log('\n=== one confirmed row keys with values (truncated) ===');
  for (const [k, v] of Object.entries(sample || {})) {
    let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (s.length > 120) s = s.slice(0, 120) + '…';
    console.log(`${k.padEnd(34)} ${s}`);
  }
  await pool.end();
})().catch((e) => { console.error(e); pool.end(); process.exit(1); });
