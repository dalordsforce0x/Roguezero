require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });

const FOXY_WALLET = 'tzM97zpSQpsXUoZHgvTxj7X4sXd3bf1hrT2LmtxpKg7';
// deploy SUCCESS boot ~17:33Z; use a generous window
const SINCE = "2026-06-09T17:34:00Z";

(async () => {
  // swap_executions by status since boot
  const ex = await pool.query(
    `SELECT status, COUNT(*) n
       FROM swap_executions
      WHERE taker=$1 AND created_at >= $2
      GROUP BY status ORDER BY n DESC`,
    [FOXY_WALLET, SINCE]
  );
  console.log('=== Foxy swap_executions since', SINCE, '===');
  for (const r of ex.rows) console.log(`${r.status.padEnd(22)} ${r.n}`);

  // exit reasons / kinds since boot
  const k = await pool.query(
    `SELECT COALESCE(metadata->>'exitReason', metadata->>'entryStrategy', 'other') kind,
            status, COUNT(*) n
       FROM swap_executions
      WHERE taker=$1 AND created_at >= $2
      GROUP BY kind, status ORDER BY n DESC`,
    [FOXY_WALLET, SINCE]
  );
  console.log('\n=== Foxy by kind/status ===');
  for (const r of k.rows) console.log(`${String(r.kind).padEnd(28)} ${String(r.status).padEnd(20)} ${r.n}`);

  // last 15 raw
  const last = await pool.query(
    `SELECT created_at, status, input_mint, output_mint,
            COALESCE(metadata->>'exitReason', metadata->>'entryStrategy','') tag
       FROM swap_executions
      WHERE taker=$1 AND created_at >= $2
      ORDER BY created_at DESC LIMIT 15`,
    [FOXY_WALLET, SINCE]
  );
  console.log('\n=== Foxy last 15 ===');
  for (const r of last.rows) {
    const dir = (r.input_mint||'').slice(0,4)+'->'+(r.output_mint||'').slice(0,4);
    console.log(`${r.created_at.toISOString().slice(11,19)} ${String(r.status).padEnd(20)} ${dir.padEnd(12)} ${r.tag}`);
  }
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
