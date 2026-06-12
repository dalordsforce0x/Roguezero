require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });

const ROGUE = 'a51f955c-2fb2-4acb-bb9d-9500ed35b928';

(async () => {
  const r = await pool.query(
    `SELECT id, owner_wallet, license_id, key_auth_user_id, user_id, created_by, status,
            started_at, ended_at, stop_reason
       FROM sessions WHERE id=$1`, [ROGUE]);
  console.log('RogueCEO session:', JSON.stringify(r.rows[0], null, 2));

  // rz_users / license tables
  const tabs = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND (table_name ILIKE '%user%' OR table_name ILIKE '%licen%')
      ORDER BY table_name`);
  console.log('\nuser/license tables:', tabs.rows.map(t=>t.table_name).join(', '));
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
