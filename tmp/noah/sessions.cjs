require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });

(async () => {
  const r = await pool.query(
    `select id, status, owner_wallet, session_wallet, started_at, ended_at, stop_reason
       from sessions order by requested_at desc nulls last limit 10`
  );
  console.log('RECENT SESSIONS:');
  for (const x of r.rows) {
    console.log(
      `  ${x.id.slice(0,8)}  ${String(x.status).padEnd(16)}  owner=${(x.owner_wallet||'').slice(0,6)}  sw=${(x.session_wallet||'').slice(0,6)}  started=${x.started_at? new Date(x.started_at).toISOString():'-'}  ended=${x.ended_at? new Date(x.ended_at).toISOString():'-'}  stop=${x.stop_reason||'-'}`
    );
  }
  await pool.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
