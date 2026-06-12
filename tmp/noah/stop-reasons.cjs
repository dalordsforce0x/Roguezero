require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });

const SESS = {
  'Foxy':'b1019831-6779-45d1-baf0-693ca610c93a',
  'Noah':'edd46e65-b21d-4d99-911d-99842d62b428',
  'RogueCEO':'a51f955c-2fb2-4acb-bb9d-9500ed35b928',
};
(async () => {
  for (const [name,id] of Object.entries(SESS)) {
    const r = await pool.query(
      `SELECT status, stop_reason, started_at, ended_at,
              funding->>'fundingTokenSymbol' sym,
              funding->>'currentBalanceAtomic' cur,
              funding->>'startingBalanceAtomic' start
         FROM sessions WHERE id=$1`, [id]);
    const x=r.rows[0];
    console.log(`${name.padEnd(9)} status=${String(x.status).padEnd(8)} stop_reason=${x.stop_reason||'-'} base=${x.sym} cur=${x.cur} start=${x.start} ended=${x.ended_at?x.ended_at.toISOString().slice(11,19):'-'}`);
  }
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
