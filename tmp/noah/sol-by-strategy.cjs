require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const p = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const DAY = '2026-06-09T00:00:00Z';
const NOAH = 'edd46e65-b21d-4d99-911d-99842d62b428';
(async () => {
  // Final PnL per SOL position, grouped by strategy
  const r = await p.query(
    `with positions as (
       select evaluation->>'entryPriceUsd' entry,
              evaluation->>'strategy' strat,
              (array_agg(pnl_bps order by created_at desc))[1] final_pnl,
              extract(epoch from (max(created_at)-min(created_at)))/60 hold_min
       from exit_shadow_decisions
       where created_at >= $1 and session_id=$2 and token_class='major'
         and evaluation->>'entryPriceUsd' is not null
       group by entry, strat)
     select strat,
            count(*) n,
            count(*) filter (where final_pnl>0) wins,
            count(*) filter (where final_pnl<=0) losses,
            round(sum(final_pnl)::numeric,0) total_bps,
            round(avg(final_pnl)::numeric,1) avg_bps,
            round(avg(hold_min)::numeric,1) avg_hold_min
     from positions group by strat order by total_bps`,
    [DAY, NOAH]);
  console.log('SOL by strategy (final realized per position):');
  console.log('strategy         positions  wins  losses  totalBps  avgBps  avgHold');
  for (const x of r.rows) {
    console.log(`${String(x.strat).padEnd(15)}  ${String(x.n).padStart(8)}  ${String(x.wins).padStart(4)}  ${String(x.losses).padStart(6)}  ${String(x.total_bps).padStart(7)}  ${String(x.avg_bps).padStart(6)}  ${x.avg_hold_min}min`);
  }
  await p.end();
})().catch(e => { console.error(e.message); process.exit(1); });
