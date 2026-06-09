require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const p = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
(async () => {
  const r = await p.query(
    `select column_name, data_type from information_schema.columns
     where table_name='exit_shadow_decisions' order by ordinal_position`);
  console.log(r.rows.map(x => `${x.column_name}  ${x.data_type}`).join('\n'));
  await p.end();
})().catch(e => { console.error(e.message); process.exit(1); });
