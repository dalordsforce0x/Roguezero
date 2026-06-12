require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const p = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const sym = m => m === SOL ? 'SOL' : m === USDC ? 'USDC' : (m ? m.slice(0,4) : '?');
(async () => {
  // Exact admin Recent Trade Ledger query (top 40)
  const r = await p.query(
    `SELECT
       COALESCE(u.username, s.user_id) AS username,
       s.id AS session_id,
       CASE WHEN e.status='failed' AND e.last_error->>'stage'='worker_cancel' THEN 'skipped' ELSE e.status END AS status,
       e.input_mint, e.output_mint, e.amount, e.signature,
       e.last_error, e.metadata, e.created_at, e.confirmed_at, e.submitted_at
     FROM swap_executions e
     JOIN sessions s ON s.session_wallet = e.taker
     LEFT JOIN rz_users u ON u.id::text = s.user_id
     ORDER BY e.created_at DESC
     LIMIT 40`);
  console.log(`Recent Trade Ledger (latest 40) — now ${new Date().toISOString().slice(11,19)}Z\n`);
  console.log('TIME      USER         STATUS     ROUTE         ENTRY/EXIT                  ERR');
  for (const x of r.rows) {
    const m = x.metadata || {};
    const tag = m.exitReason ? `exit·${m.exitReason}` : m.entryStrategy ? `entry·${m.entryStrategy}` : 'reconcile';
    const err = x.last_error ? (x.last_error.code || x.last_error.stage || x.last_error.message || 'err') : '';
    const t = (x.confirmed_at || x.submitted_at || x.created_at).toISOString().slice(11,19);
    console.log(
      `${t}  ${String(x.username).slice(0,11).padEnd(11)}  ${String(x.status).padEnd(9)}  ` +
      `${(sym(x.input_mint)+'->'+sym(x.output_mint)).padEnd(12)}  ${String(tag).slice(0,26).padEnd(26)}  ${String(err).slice(0,22)}`);
  }
  await p.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
