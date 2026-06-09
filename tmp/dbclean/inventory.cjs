require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const p = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
(async () => {
  console.log('=== ACTIVE sessions (KEEP) ===');
  const s = await p.query(
    "select id, session_wallet, owner_wallet, status, started_at from sessions where status = 'active' order by started_at"
  );
  s.rows.forEach(r => console.log(`  ${r.id}  wallet=${r.session_wallet}  status=${r.status}  started=${r.started_at && r.started_at.toISOString ? r.started_at.toISOString() : r.started_at}`));
  console.log(`  TOTAL active = ${s.rows.length}`);

  console.log('\n=== ALL session statuses ===');
  const st = await p.query('select status, count(*) n from sessions group by status order by n desc');
  st.rows.forEach(r => console.log(`  ${r.status}: ${r.n}`));

  console.log('\n=== ALL public tables + row counts ===');
  const t = await p.query("select table_name from information_schema.tables where table_schema='public' order by table_name");
  for (const row of t.rows) {
    const c = await p.query(`select count(*) n from "${row.table_name}"`);
    console.log(`  ${row.table_name}: ${c.rows[0].n}`);
  }
  await p.end();
})().catch(e => { console.error(e.message); process.exit(1); });
