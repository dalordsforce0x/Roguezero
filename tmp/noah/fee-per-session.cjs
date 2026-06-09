require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const p = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
(async () => {
  const r = await p.query(`select id, service_control->>'platformFeeBps' fee, user_control->'profitHandling'->>'mode' mode from sessions where status='active' order by started_at`);
  r.rows.forEach(x => console.log(`${x.id.slice(0,8)}  platformFeeBps=${x.fee}  mode=${x.mode}`));
  await p.end();
})().catch(e => { console.error(e); process.exit(1); });
