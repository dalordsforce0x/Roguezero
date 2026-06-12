require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });

const BOTS = {
  'Foxy':     { wallet:'tzM97zpSQpsXUoZHgvTxj7X4sXd3bf1hrT2LmtxpKg7', session:'b1019831-6779-45d1-baf0-693ca610c93a' },
  'Noah':     { wallet:'Fu23Ra8SWUUNqpjR2mKqydx37WAykGpDbKBKaxkHAsaW', session:'edd46e65-b21d-4d99-911d-99842d62b428' },
  'RogueCEO': { wallet:'8FvnRY4KsLGptz2HwmhUzTeEHQrrgfS8Sy343CG9anjC', session:'a51f955c-2fb2-4acb-bb9d-9500ed35b928' },
};
// real cutoff of FIFTH deploy (floor/fee fix) ~17:05Z; SIXTH ~17:33; SEVENTH ~17:54
const SINCE_FIX = "2026-06-09T17:05:00Z";

(async () => {
  // discover columns that hold realized pnl on positions
  const posCols = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='positions' ORDER BY ordinal_position`);
  console.log('positions cols:', posCols.rows.map(r=>r.column_name).join(', '));

  for (const [name, b] of Object.entries(BOTS)) {
    // confirmed/failed since fixes
    const ex = await pool.query(
      `SELECT status, COUNT(*) n FROM swap_executions
        WHERE taker=$1 AND created_at>=$2 GROUP BY status ORDER BY n DESC`,
      [b.wallet, SINCE_FIX]);
    const conf = ex.rows.find(r=>r.status==='confirmed')?.n || 0;
    const fail = ex.rows.find(r=>r.status==='failed')?.n || 0;

    // exit reasons since fixes
    const er = await pool.query(
      `SELECT metadata->>'exitReason' reason, COUNT(*) n FROM swap_executions
        WHERE taker=$1 AND created_at>=$2 AND status='confirmed'
          AND metadata->>'exitReason' IS NOT NULL GROUP BY reason ORDER BY n DESC`,
      [b.wallet, SINCE_FIX]);
    const exits = er.rows.map(r=>`${r.reason}:${r.n}`).join(' ') || '(none)';

    console.log(`\n=== ${name} ===`);
    console.log(`  since fixes (17:05Z): confirmed=${conf} failed=${fail}`);
    console.log(`  exits: ${exits}`);
  }
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
