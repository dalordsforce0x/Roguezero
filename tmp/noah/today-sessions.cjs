require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const p = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const DAY = '2026-06-09T00:00:00Z';
const SESSIONS = [
  { name: 'Noah',  id: 'edd46e65-b21d-4d99-911d-99842d62b428', wallet: 'Fu23Ra8SWUUNqpjR2mKqydx37WAykGpDbKBKaxkHAsaW' },
  { name: 'b1019831', id: 'b1019831-6779-45d1-baf0-693ca610c93a', wallet: 'tzM97zpSQpsXUoZHgvTxj7X4sXd3bf1hrT2LmtxpKg7' },
  { name: 'a51f955c', id: 'a51f955c-2fb2-4acb-bb9d-9500ed35b928', wallet: '8FvnRY4KsLGptz2HwmhUzTeEHQrrgfS8Sy343CG9anjC' },
];
(async () => {
  for (const s of SESSIONS) {
    console.log(`\n========== ${s.name}  (${s.id.slice(0,8)})  wallet ${s.wallet.slice(0,6)}.. ==========`);

    // session pnl/funding snapshot
    const sn = await p.query(
      `select status, started_at,
              funding->>'realizedPnlUsd' rp, funding->>'unrealizedPnlUsd' up,
              funding->>'capturedFeesUsd' cf, funding->>'fundingTokenSymbol' base,
              user_control->'profitHandling'->>'mode' mode,
              user_control->'profitHandling'->>'payoutToken' payout
       from sessions where id = $1`, [s.id]);
    const r = sn.rows[0];
    console.log(`  base=${r.base}  mode=${r.mode}/${r.payout}  realizedPnlUsd=${r.rp}  unrealizedPnlUsd=${r.up}  fees=${r.cf}`);

    // today's swap executions by status
    const byStat = await p.query(
      `select status, count(*) n from swap_executions where taker = $1 and created_at >= $2 group by status order by n desc`,
      [s.wallet, DAY]);
    const stat = byStat.rows.map(x => `${x.status}=${x.n}`).join('  ') || '(no trades today)';
    console.log(`  TODAY trades: ${stat}`);

    // today's confirmed: in/out mints, first/last time
    const conf = await p.query(
      `select input_mint, output_mint, count(*) n, min(created_at) first, max(created_at) last
       from swap_executions where taker = $1 and created_at >= $2 and status='confirmed'
       group by input_mint, output_mint order by n desc limit 8`, [s.wallet, DAY]);
    if (conf.rows.length) {
      console.log('  TODAY confirmed legs:');
      conf.rows.forEach(x => console.log(`    ${x.input_mint.slice(0,5)}..->${x.output_mint.slice(0,5)}..  n=${x.n}  ${x.first.toISOString().slice(11,16)}-${x.last.toISOString().slice(11,16)}Z`));
    }

    // most recent 3 trades overall today (any status)
    const recent = await p.query(
      `select status, input_mint, output_mint, created_at from swap_executions
       where taker = $1 and created_at >= $2 order by created_at desc limit 3`, [s.wallet, DAY]);
    if (recent.rows.length) {
      console.log('  Last 3 today:');
      recent.rows.forEach(x => console.log(`    ${x.created_at.toISOString().slice(11,19)}Z  ${x.status}  ${x.input_mint.slice(0,5)}..->${x.output_mint.slice(0,5)}..`));
    }
  }
  await p.end();
})().catch(e => { console.error(e.message); process.exit(1); });
