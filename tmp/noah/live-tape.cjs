require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });

const BOTS = {
  'Foxy':     'tzM97zpSQpsXUoZHgvTxj7X4sXd3bf1hrT2LmtxpKg7',
  'Noah':     'Fu23Ra8SWUUNqpjR2mKqydx37WAykGpDbKBKaxkHAsaW',
  'RogueCEO': '8FvnRY4KsLGptz2HwmhUzTeEHQrrgfS8Sy343CG9anjC',
};
const SINCE = "2026-06-09T17:34:00Z";

(async () => {
  for (const [name, wallet] of Object.entries(BOTS)) {
    const st = await pool.query(
      `SELECT status, COUNT(*) n FROM swap_executions
        WHERE taker=$1 AND created_at>=$2 GROUP BY status ORDER BY n DESC`,
      [wallet, SINCE]
    );
    const conf = st.rows.find(r=>r.status==='confirmed')?.n || 0;
    const fail = st.rows.find(r=>r.status==='failed')?.n || 0;
    console.log(`\n=== ${name} (since ${SINCE.slice(11,19)}Z) === confirmed=${conf} failed=${fail}`);

    const last = await pool.query(
      `SELECT created_at, status, input_mint, output_mint,
              COALESCE(metadata->>'exitReason', metadata->>'entryStrategy','') tag
         FROM swap_executions WHERE taker=$1 AND created_at>=$2
        ORDER BY created_at DESC LIMIT 8`,
      [wallet, SINCE]
    );
    for (const r of last.rows) {
      const dir = (r.input_mint||'').slice(0,4)+'->'+(r.output_mint||'').slice(0,4);
      console.log(`  ${r.created_at.toISOString().slice(11,19)} ${String(r.status).padEnd(10)} ${dir.padEnd(12)} ${r.tag}`);
    }
  }
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
