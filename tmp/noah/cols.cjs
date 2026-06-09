require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });

(async () => {
  const cols = await pool.query(
    `select column_name from information_schema.columns where table_name='sessions' order by ordinal_position`
  );
  console.log('SESSIONS COLUMNS:', cols.rows.map(r => r.column_name).join(', '));
  await pool.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
