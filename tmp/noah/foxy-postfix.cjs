require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });

const FOXY = 'tzM97zpSQpsXUoZHgvTxj7X4sXd3bf1hrT2LmtxpKg7';
const BOOT = "2026-06-09T17:54:00Z";

(async () => {
  const now = await pool.query(`SELECT now() at time zone 'UTC' as utc`);
  console.log('DB now (UTC):', now.rows[0].utc.toISOString());

  const st = await pool.query(
    `SELECT status, COUNT(*) n FROM swap_executions
      WHERE taker=$1 AND created_at>=$2 GROUP BY status ORDER BY n DESC`,
    [FOXY, BOOT]
  );
  console.log(`\n=== Foxy POST-FIX (since ${BOOT.slice(11,19)}Z) ===`);
  if (!st.rows.length) console.log('  (no activity yet)');
  for (const r of st.rows) console.log(`  ${String(r.status).padEnd(10)} ${r.n}`);

  const last = await pool.query(
    `SELECT created_at, status, input_mint, output_mint,
            COALESCE(metadata->>'exitReason', metadata->>'entryStrategy','') tag,
            metadata->>'sizingReason' sizing
       FROM swap_executions WHERE taker=$1 AND created_at>=$2
      ORDER BY created_at DESC LIMIT 15`,
    [FOXY, BOOT]
  );
  console.log('\n  last 15:');
  for (const r of last.rows) {
    const dir = (r.input_mint||'').slice(0,4)+'->'+(r.output_mint||'').slice(0,4);
    console.log(`  ${r.created_at.toISOString().slice(11,19)} ${String(r.status).padEnd(10)} ${dir.padEnd(12)} ${r.tag} ${r.sizing||''}`);
  }
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
