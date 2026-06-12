require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const p = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const DAY = '2026-06-09T00:00:00Z';
const NOAH = 'edd46e65-b21d-4d99-911d-99842d62b428';
(async () => {
  // For each distinct SOL position (identified by entry price), get hold time and outcome
  const r = await p.query(
    `select evaluation->>'entryPriceUsd' entry,
            evaluation->>'strategy' strat,
            min(created_at) first_seen,
            max(created_at) last_seen,
            extract(epoch from (max(created_at)-min(created_at))) hold_secs,
            count(*) evals,
            min(pnl_bps) worst_pnl,
            max(max_favorable_bps) peak_up,
            min(max_adverse_bps) worst_down,
            (array_agg(current_reason order by created_at desc))[1] final_reason,
            (array_agg(pnl_bps order by created_at desc))[1] final_pnl
     from exit_shadow_decisions
     where created_at >= $1 and session_id = $2 and token_class='major'
       and evaluation->>'entryPriceUsd' is not null
     group by entry, strat
     order by first_seen`,
    [DAY, NOAH]);
  console.log(`SOL positions today: ${r.rows.length}\n`);
  console.log('entry$   strat            heldFor   peakUp  worstDown  finalPnl  exitReason');
  for (const x of r.rows) {
    const held = x.hold_secs >= 60 ? `${(x.hold_secs/60).toFixed(1)}min` : `${Math.round(x.hold_secs)}s`;
    console.log(`${Number(x.entry).toFixed(2)}  ${String(x.strat).padEnd(15)} ${held.padStart(7)}   ${String(x.peak_up).padStart(5)}   ${String(x.worst_down).padStart(7)}   ${String(x.final_pnl).padStart(6)}  ${x.final_reason}`);
  }

  // Hold time summary
  const h = await p.query(
    `select round(avg(hold_secs)::numeric,0) avg_s, round(min(hold_secs)::numeric,0) min_s, round(max(hold_secs)::numeric,0) max_s
     from (select extract(epoch from (max(created_at)-min(created_at))) hold_secs
           from exit_shadow_decisions
           where created_at >= $1 and session_id=$2 and token_class='major'
             and evaluation->>'entryPriceUsd' is not null
           group by evaluation->>'entryPriceUsd') q`,
    [DAY, NOAH]);
  console.log(`\nHold time: avg ${(h.rows[0].avg_s/60).toFixed(1)}min  min ${h.rows[0].min_s}s  max ${(h.rows[0].max_s/60).toFixed(1)}min`);
  await p.end();
})().catch(e => { console.error(e.message); process.exit(1); });
