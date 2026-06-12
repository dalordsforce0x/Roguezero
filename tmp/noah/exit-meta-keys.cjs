require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });

(async () => {
  // sample metadata keys from a recent confirmed exit
  const s = await pool.query(
    `SELECT metadata FROM swap_executions
      WHERE status='confirmed' AND metadata->>'exitReason' IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`);
  if (s.rows.length) {
    console.log('exit metadata keys:', Object.keys(s.rows[0].metadata).join(', '));
    console.log('\nsample:', JSON.stringify(s.rows[0].metadata, null, 2).slice(0, 1500));
  } else {
    console.log('no confirmed exit found');
  }
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
