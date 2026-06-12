require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });

(async () => {
  const now = await pool.query(`SELECT now() at time zone 'UTC' as utc`);
  console.log('DB now (UTC):', now.rows[0].utc.toISOString());

  // last swap_execution overall (any taker)
  const lastAny = await pool.query(
    `SELECT created_at, taker, status,
            COALESCE(metadata->>'exitReason', metadata->>'entryStrategy','') tag
       FROM swap_executions ORDER BY created_at DESC LIMIT 10`
  );
  console.log('\n=== last 10 swap_executions (ANY bot) ===');
  for (const r of lastAny.rows) {
    console.log(`  ${r.created_at.toISOString().slice(11,19)} ${r.taker.slice(0,6)} ${String(r.status).padEnd(10)} ${r.tag}`);
  }

  // session statuses + heartbeats
  const sess = await pool.query(
    `SELECT id, status, session_wallet,
            updated_at,
            (SELECT MAX(last_cycle_at) FROM session_runtime_state r WHERE r.session_id = s.id) last_cycle
       FROM sessions s
      WHERE status IN ('active','starting','ready','stopping','paused')
      ORDER BY updated_at DESC`
  );
  console.log('\n=== active-ish sessions ===');
  for (const r of sess.rows) {
    const lc = r.last_cycle ? r.last_cycle.toISOString().slice(11,19) : 'null';
    console.log(`  ${r.id.slice(0,8)} ${String(r.status).padEnd(10)} wallet=${(r.session_wallet||'').slice(0,6)} updated=${r.updated_at.toISOString().slice(11,19)} last_cycle=${lc}`);
  }
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
