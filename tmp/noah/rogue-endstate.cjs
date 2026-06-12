require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });

const ROGUE = 'a51f955c-2fb2-4acb-bb9d-9500ed35b928';
const ROGUE_WALLET = '8FvnRY4KsLGptz2HwmhUzTeEHQrrgfS8Sy343CG9anjC';

(async () => {
  const r = await pool.query(
    `SELECT status, stop_reason, started_at, ended_at,
            funding->>'currentBalanceAtomic' cur,
            funding->>'startingBalanceAtomic' start,
            funding->>'fundingTokenSymbol' sym,
            service_control->'healthState' health,
            service_control->'residualRecovery' residual
       FROM sessions WHERE id=$1`, [ROGUE]);
  const x = r.rows[0];
  console.log('status      :', x.status);
  console.log('stop_reason :', x.stop_reason);
  console.log('started_at  :', x.started_at && x.started_at.toISOString());
  console.log('ended_at    :', x.ended_at && x.ended_at.toISOString());
  console.log('balance cur :', x.cur, x.sym);
  console.log('balance strt:', x.start);
  console.log('healthState :', JSON.stringify(x.health));
  console.log('residual    :', JSON.stringify(x.residual));

  // any executions AFTER the stop finalize (17:55:16)?
  const after = await pool.query(
    `SELECT created_at, status, input_mint, output_mint,
            COALESCE(metadata->>'exitReason', metadata->>'entryStrategy','') tag
       FROM swap_executions WHERE taker=$1 AND created_at > '2026-06-09T17:55:16Z'
      ORDER BY created_at ASC`, [ROGUE_WALLET]);
  console.log('\nexecutions AFTER finalize (17:55:16):', after.rows.length);
  for (const a of after.rows) {
    const dir = (a.input_mint||'').slice(0,4)+'->'+(a.output_mint||'').slice(0,4);
    console.log(`  ${a.created_at.toISOString().slice(11,19)} ${a.status} ${dir} ${a.tag}`);
  }
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
