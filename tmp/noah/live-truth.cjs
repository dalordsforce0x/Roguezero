require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });

// CURRENT live sessions
const LIVE = {
  'RogueCEO': { id:'299c83d6-fff0-4a2b-a46e-265b5fd8855e' },
  'Foxy':     { id:'b1019831-6779-45d1-baf0-693ca610c93a' },
  'Noah':     { id:'edd46e65-b21d-4d99-911d-99842d62b428' },
};

(async () => {
  for (const [name, b] of Object.entries(LIVE)) {
    // session wallet for trade lookup
    const s = await pool.query(
      `SELECT session_wallet, status, started_at,
              (funding->>'realizedPnlUsd')::double precision realized,
              (funding->>'unrealizedPnlUsd')::double precision unreal,
              (funding->>'capturedFeesUsd')::double precision fees,
              funding->>'fundingTokenSymbol' sym
         FROM sessions WHERE id=$1`, [b.id]);
    const x = s.rows[0];
    const wallet = x.session_wallet;
    const since = x.started_at.toISOString();

    const ex = await pool.query(
      `SELECT status, COUNT(*) n FROM swap_executions
        WHERE taker=$1 AND created_at>=$2 GROUP BY status`, [wallet, since]);
    const conf = ex.rows.find(r=>r.status==='confirmed')?.n || 0;
    const fail = ex.rows.find(r=>r.status==='failed')?.n || 0;

    const er = await pool.query(
      `SELECT metadata->>'exitReason' reason, COUNT(*) n FROM swap_executions
        WHERE taker=$1 AND created_at>=$2 AND status='confirmed'
          AND metadata->>'exitReason' IS NOT NULL GROUP BY reason ORDER BY n DESC`, [wallet, since]);
    const exits = er.rows.map(r=>`${r.reason}:${r.n}`).join(' ') || '(none)';

    const real = x.realized ?? 0, un = x.unreal ?? 0;
    console.log(`${name.padEnd(9)} ${x.status} base=${x.sym} since=${since.slice(5,19)}`);
    console.log(`  realized=$${real.toFixed(2)} unreal=$${un.toFixed(2)} fees=$${(x.fees??0).toFixed(2)} | conf=${conf} fail=${fail}`);
    console.log(`  exits: ${exits}\n`);
  }
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
