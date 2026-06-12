require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });

const ROGUE = 'a51f955c-2fb2-4acb-bb9d-9500ed35b928';
const ROGUE_WALLET = '8FvnRY4KsLGptz2HwmhUzTeEHQrrgfS8Sy343CG9anjC';

(async () => {
  const s = await pool.query(
    `SELECT status, funding->>'stopReason' stop_reason, funding->>'pauseReason' pause_reason,
            funding FROM sessions WHERE id=$1`, [ROGUE]);
  const f = s.rows[0];
  console.log('RogueCEO status:', f.status);
  console.log('stopReason:', f.stop_reason, ' pauseReason:', f.pause_reason);
  console.log('funding keys:', Object.keys(f.funding).join(', '));

  // last 12 executions for RogueCEO
  const ex = await pool.query(
    `SELECT created_at, status, input_mint, output_mint,
            COALESCE(metadata->>'exitReason', metadata->>'entryStrategy','') tag,
            last_error->>'message' err
       FROM swap_executions WHERE taker=$1
      ORDER BY created_at DESC LIMIT 12`, [ROGUE_WALLET]);
  console.log('\nRogueCEO last 12 executions:');
  for (const r of ex.rows) {
    const dir = (r.input_mint||'').slice(0,4)+'->'+(r.output_mint||'').slice(0,4);
    console.log(`  ${r.created_at.toISOString().slice(11,19)} ${String(r.status).padEnd(10)} ${dir.padEnd(12)} ${r.tag} ${r.err?('ERR:'+r.err.slice(0,40)):''}`);
  }
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
