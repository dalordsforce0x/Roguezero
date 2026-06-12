require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const p = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
(async () => {
  const cols = await p.query(
    `select column_name, data_type from information_schema.columns
     where table_name='swap_executions' order by ordinal_position`);
  console.log('swap_executions columns:');
  console.log(cols.rows.map(c => `${c.column_name}:${c.data_type}`).join('\n'));
  await p.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
