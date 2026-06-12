require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });

(async () => {
  const now = await pool.query(`SELECT now() at time zone 'UTC' as utc`);
  console.log('DB now (UTC):', now.rows[0].utc.toISOString());

  // discover session_runtime_state columns
  const cols = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name='session_runtime_state' ORDER BY ordinal_position`
  );
  console.log('\nsession_runtime_state cols:', cols.rows.map(r=>r.column_name).join(', '));

  // active sessions + their runtime heartbeat
  const sess = await pool.query(
    `SELECT s.id, s.status, s.session_wallet,
            r.last_cycle_at, r.runtime_health, r.current_positions_count
       FROM sessions s
       LEFT JOIN session_runtime_state r ON r.session_id = s.id
      WHERE s.status IN ('active','starting','ready','stopping','paused')
      ORDER BY r.last_cycle_at DESC NULLS LAST`
  );
  console.log('\n=== active sessions + heartbeat ===');
  for (const r of sess.rows) {
    const lc = r.last_cycle_at ? r.last_cycle_at.toISOString().slice(11,19) : 'NULL';
    console.log(`  ${r.id.slice(0,8)} ${String(r.status).padEnd(9)} wallet=${(r.session_wallet||'').slice(0,6)} last_cycle=${lc} health=${r.runtime_health||''} pos=${r.current_positions_count}`);
  }
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
