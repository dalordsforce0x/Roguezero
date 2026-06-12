require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });

const ROGUE = 'a51f955c-2fb2-4acb-bb9d-9500ed35b928';

(async () => {
  const r = await pool.query(`SELECT service_control FROM sessions WHERE id=$1`, [ROGUE]);
  const sc = r.rows[0].service_control || {};
  console.log('lastStopRequestSource:');
  console.log(JSON.stringify(sc.lastStopRequestSource ?? null, null, 2));
  console.log('\nstopRequestSourceHistory (count=' + (sc.stopRequestSourceHistory?.length||0) + '):');
  console.log(JSON.stringify(sc.stopRequestSourceHistory ?? [], null, 2));
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
