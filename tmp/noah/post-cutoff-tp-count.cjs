require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const p = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const CUTOFF = '2026-06-09T17:05:00Z';
(async () => {
  // exit reason counts per user since cutoff (confirmed only)
  const r = await p.query(
    `SELECT COALESCE(u.username,s.user_id) username,
            COALESCE(e.metadata->>'exitReason', e.metadata->>'entryStrategy','reconcile') tag,
            count(*) n
     FROM swap_executions e
     JOIN sessions s ON s.session_wallet=e.taker
     LEFT JOIN rz_users u ON u.id::text=s.user_id
     WHERE e.created_at >= $1 AND e.status='confirmed'
     GROUP BY 1,2 ORDER BY 1, n DESC`, [CUTOFF]);
  console.log('Confirmed actions per bot since 17:05 cutoff:');
  let cur='';
  for (const x of r.rows) {
    if (x.username!==cur){ console.log(`\n${x.username}:`); cur=x.username; }
    console.log(`   ${x.tag.padEnd(20)} ${x.n}`);
  }

  // realized pnl per active session (funding json) now
  const pnl = await p.query(
    `SELECT COALESCE(u.username,s.user_id) username, s.id,
            (s.funding->>'realizedPnlUsd')::numeric realized,
            (s.funding->>'unrealizedPnlUsd')::numeric unreal
     FROM sessions s LEFT JOIN rz_users u ON u.id::text=s.user_id
     WHERE s.status='active' ORDER BY 1`);
  console.log('\n\nCurrent session realized / unrealized PnL (whole session, includes pre-cutoff baseline):');
  for (const x of pnl.rows)
    console.log(`   ${String(x.username).padEnd(14)} realized $${Number(x.realized).toFixed(2)}  unrealized $${Number(x.unreal||0).toFixed(2)}`);
  await p.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
