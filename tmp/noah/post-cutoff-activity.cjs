require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const p = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const CUTOFF = '2026-06-09T17:05:00Z';
const NAMES = {
  'edd46e65-b21d-4d99-911d-99842d62b428': 'Noah',
  'b1019831-6779-45d1-baf0-693ca610c93a': 'b1019831',
  'a51f955c-2fb2-4acb-bb9d-9500ed35b928': 'a51f955c(bleeder)',
};
(async () => {
  const now = await p.query(`select now() as t`);
  console.log('now:', now.rows[0].t.toISOString(), ' cutoff:', CUTOFF);
  const mins = (Date.now() - Date.parse(CUTOFF)) / 60000;
  console.log(`minutes since cutoff: ${mins.toFixed(1)}\n`);

  // What columns exist for outcome?
  const cols = await p.query(
    `select column_name from information_schema.columns where table_name='swap_executions' order by ordinal_position`);
  // Activity since cutoff per session
  for (const [sid, name] of Object.entries(NAMES)) {
    const r = await p.query(
      `select status, count(*) n from swap_executions
       where session_id=$1 and created_at >= $2 group by status order by n desc`,
      [sid, CUTOFF]);
    const total = r.rows.reduce((s,x)=>s+Number(x.n),0);
    console.log(`${name}: ${total} swap rows since cutoff -> ` + r.rows.map(x=>`${x.status}:${x.n}`).join(', '));
  }
  console.log('\nswap_executions columns:', cols.rows.map(c=>c.column_name).join(', '));
  await p.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
