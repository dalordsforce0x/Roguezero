require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });

(async () => {
  const r = await pool.query(
    `SELECT s.id, s.owner_wallet, s.status, s.started_at, s.ended_at,
            COALESCE(uu.username, s.user_id) uname,
            s.funding->>'fundingTokenSymbol' sym,
            s.funding->>'currentBalanceAtomic' cur
       FROM sessions s
       LEFT JOIN rz_users uu ON uu.id::text = s.user_id
      WHERE s.status IN ('active','starting','ready','stopping','paused','awaiting_funding')
      ORDER BY s.started_at DESC NULLS LAST`);
  console.log('LIVE (non-stopped) sessions:', r.rows.length);
  for (const x of r.rows) {
    console.log(`  ${x.id.slice(0,8)} ${String(x.status).padEnd(10)} owner=${(x.owner_wallet||'').slice(0,6)} user=${x.uname} bal=${x.cur} ${x.sym} started=${x.started_at?x.started_at.toISOString().slice(5,19):'-'}`);
  }

  // also ALL sessions for these 3 owners regardless of status
  const owners = ['GJmDpMoaKQzLdHxqwJL5rzA53cU2bsaVn4uwPfDQrx6g','2BKY','7cAg'];
  const all = await pool.query(
    `SELECT id, owner_wallet, status, started_at, ended_at
       FROM sessions WHERE owner_wallet LIKE 'GJmDpM%'
      ORDER BY started_at DESC NULLS LAST LIMIT 10`);
  console.log('\nRogueCEO owner (GJmDpM) ALL sessions:', all.rows.length);
  for (const x of all.rows) {
    console.log(`  ${x.id.slice(0,8)} ${String(x.status).padEnd(10)} started=${x.started_at?x.started_at.toISOString().slice(5,19):'-'} ended=${x.ended_at?x.ended_at.toISOString().slice(5,19):'-'}`);
  }
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
