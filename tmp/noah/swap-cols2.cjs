require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });

(async () => {
  const cols = await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name='swap_executions' ORDER BY ordinal_position`);
  console.log('swap_executions cols:');
  for (const c of cols.rows) console.log(`  ${c.column_name} (${c.data_type})`);
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
