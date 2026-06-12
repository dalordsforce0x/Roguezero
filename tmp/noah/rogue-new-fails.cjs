require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });

(async () => {
  const s = await pool.query(`SELECT session_wallet FROM sessions WHERE id=$1`, ['299c83d6-fff0-4a2b-a46e-265b5fd8855e']);
  const wallet = s.rows[0].session_wallet;
  console.log('RogueCEO new wallet:', wallet);

  const ex = await pool.query(
    `SELECT created_at, status, input_mint, output_mint,
            COALESCE(metadata->>'exitReason', metadata->>'entryStrategy','') tag,
            last_error->>'stage' stage, last_error->>'reason' reason, last_error->>'message' msg
       FROM swap_executions WHERE taker=$1
      ORDER BY created_at DESC LIMIT 12`, [wallet]);
  console.log('\nlast 12:');
  for (const r of ex.rows) {
    const dir = (r.input_mint||'').slice(0,4)+'->'+(r.output_mint||'').slice(0,4);
    console.log(`  ${r.created_at.toISOString().slice(11,19)} ${String(r.status).padEnd(10)} ${dir.padEnd(12)} ${r.tag} | stage=${r.stage||'-'} reason=${r.reason||'-'} ${r.msg?('msg:'+r.msg.slice(0,60)):''}`);
  }
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
