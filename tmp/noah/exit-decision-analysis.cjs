require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const p = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const DAY = '2026-06-09T00:00:00Z';
const SESSIONS = {
  'edd46e65-b21d-4d99-911d-99842d62b428': 'Noah',
  'b1019831-6779-45d1-baf0-693ca610c93a': 'b1019831',
  'a51f955c-2fb2-4acb-bb9d-9500ed35b928': 'a51f955c',
};
(async () => {
  // 1. By exit decision: when current_should_exit true, what reason + pnl distribution
  console.log('=== exit_shadow_decisions today: by current_reason (where should_exit) ===');
  const r = await p.query(
    `select session_id, current_reason,
            count(*) n,
            round(avg(pnl_bps)::numeric,1) avg_pnl,
            round(avg(max_favorable_bps)::numeric,1) avg_mfe,
            round(avg(max_adverse_bps)::numeric,1) avg_mae,
            round(min(pnl_bps)::numeric,1) worst,
            round(max(pnl_bps)::numeric,1) best
     from exit_shadow_decisions
     where created_at >= $1 and current_should_exit = true
       and session_id = any($2)
     group by session_id, current_reason
     order by session_id, n desc`,
    [DAY, Object.keys(SESSIONS)]);
  let cur = null;
  for (const x of r.rows) {
    if (x.session_id !== cur) { cur = x.session_id; console.log(`\n  -- ${SESSIONS[x.session_id]} --`); }
    console.log(`    ${(x.current_reason||'(none)').padEnd(20)} n=${String(x.n).padStart(4)}  avgPnL=${String(x.avg_pnl).padStart(7)}bps  MFE=${String(x.avg_mfe).padStart(6)}  MAE=${String(x.avg_mae).padStart(7)}  [${x.worst}..${x.best}]`);
  }

  // 2. Overall winners vs losers: how far did winners run (MFE) vs where exited (pnl)
  console.log('\n=== winner clipping: trades that went green (MFE>0) — did we capture it? ===');
  const w = await p.query(
    `select session_id,
            count(*) filter (where pnl_bps > 0) wins,
            count(*) filter (where pnl_bps <= 0) losses,
            round(avg(pnl_bps) filter (where pnl_bps > 0)::numeric,1) avg_win,
            round(avg(pnl_bps) filter (where pnl_bps <= 0)::numeric,1) avg_loss,
            round(avg(max_favorable_bps) filter (where pnl_bps > 0)::numeric,1) win_mfe,
            round(avg(max_favorable_bps) filter (where pnl_bps <= 0)::numeric,1) loss_mfe,
            round(avg(max_adverse_bps) filter (where pnl_bps <= 0)::numeric,1) loss_mae
     from exit_shadow_decisions
     where created_at >= $1 and current_should_exit = true and session_id = any($2)
     group by session_id`,
    [DAY, Object.keys(SESSIONS)]);
  w.rows.forEach(x => {
    console.log(`  ${SESSIONS[x.session_id]}: wins=${x.wins} losses=${x.losses}  avgWin=${x.avg_win}bps avgLoss=${x.avg_loss}bps  | winners reached MFE=${x.win_mfe} but exited at ${x.avg_win}  | losers MFE=${x.loss_mfe} ran to MAE=${x.loss_mae}`);
  });
  await p.end();
})().catch(e => { console.error(e.message); process.exit(1); });
