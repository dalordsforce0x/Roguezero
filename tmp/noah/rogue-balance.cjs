require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });

const ROGUE = 'a51f955c-2fb2-4acb-bb9d-9500ed35b928';

(async () => {
  const s = await pool.query(
    `SELECT funding->>'currentBalanceAtomic' cur, funding->>'startingBalanceAtomic' start,
            funding->>'fundingTokenSymbol' sym, funding->>'fundingMint' mint
       FROM sessions WHERE id=$1`, [ROGUE]);
  console.log('RogueCEO funding:', JSON.stringify(s.rows[0]));

  // event log tables?
  const tabs = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND (table_name ILIKE '%event%' OR table_name ILIKE '%activity%'
            OR table_name ILIKE '%log%' OR table_name ILIKE '%admin%' OR table_name ILIKE '%action%')
      ORDER BY table_name`);
  console.log('\nevent/log tables:', tabs.rows.map(r=>r.table_name).join(', ') || '(none)');

  // sessions full columns
  const cols = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='sessions' ORDER BY ordinal_position`);
  console.log('\nsessions cols:', cols.rows.map(r=>r.column_name).join(', '));
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
