require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });

const OLD = 'a51f955c-2fb2-4acb-bb9d-9500ed35b928';
const NEW = '299c83d6-fff0-4a2b-a46e-265b5fd8855e';

(async () => {
  for (const [label, id] of [['OLD (stopped)', OLD], ['NEW (active)', NEW]]) {
    const r = await pool.query(
      `SELECT id, session_wallet, owner_wallet, status, started_at, ended_at, stop_reason,
              funding->>'fundingTokenSymbol' sym,
              funding->>'currentBalanceAtomic' cur,
              funding->>'startingBalanceAtomic' start,
              funding->>'requestedFundingLamports' req
         FROM sessions WHERE id=$1`, [id]);
    const x = r.rows[0];
    console.log(`\n=== ${label} ${id.slice(0,8)} ===`);
    console.log(`  status      : ${x.status}  stop_reason: ${x.stop_reason||'-'}`);
    console.log(`  session_wallet: ${x.session_wallet}`);
    console.log(`  owner_wallet  : ${x.owner_wallet}`);
    console.log(`  started_at  : ${x.started_at && x.started_at.toISOString()}`);
    console.log(`  ended_at    : ${x.ended_at ? x.ended_at.toISOString() : '-'}`);
    console.log(`  base=${x.sym}  startingBal=${x.start}  currentBal=${x.cur}  requested=${x.req}`);
  }
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
