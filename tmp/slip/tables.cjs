require('dotenv').config();
const pg = require('pg');
const url = new URL(process.env.DATABASE_PRIVATE_URL.trim());
url.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: url.toString(), ssl: { rejectUnauthorized: false } });
(async () => {
  const t = (await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND (table_name LIKE '%signal%' OR table_name LIKE '%observ%' OR table_name LIKE '%forward%' OR table_name LIKE '%shadow%' OR table_name LIKE '%feature%')
    ORDER BY table_name`)).rows;
  console.log('candidate tables:', t.map(r => r.table_name).join(', ') || '(none)');

  // what does exit_shadow_decisions.evaluation contain (feature keys)?
  const r = (await pool.query(`
    SELECT evaluation FROM exit_shadow_decisions
    WHERE evaluation IS NOT NULL AND created_at > now() - interval '72 hours' LIMIT 1`)).rows[0];
  console.log('\nexit_shadow_decisions.evaluation keys:');
  console.log(Object.keys(r?.evaluation || {}).join(', '));
  await pool.end();
})().catch((e) => { console.error(e); pool.end(); process.exit(1); });
