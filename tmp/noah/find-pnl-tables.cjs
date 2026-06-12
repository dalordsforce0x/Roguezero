require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });

(async () => {
  const r = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='public'
        AND (table_name ILIKE '%pnl%' OR table_name ILIKE '%position%'
             OR table_name ILIKE '%performance%' OR table_name ILIKE '%snapshot%'
             OR table_name ILIKE '%session%')
      ORDER BY table_name`);
  console.log('candidate tables:\n  ' + r.rows.map(x=>x.table_name).join('\n  '));
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
