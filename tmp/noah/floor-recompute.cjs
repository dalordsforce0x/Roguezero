require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const p = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const NOAH = 'edd46e65-b21d-4d99-911d-99842d62b428';
(async () => {
  // 1. Live session config: maxSlippageBps, platformFeeBps, edgeSafetyBuffer, exit policy floor
  const s = await p.query(
    `select risk_limits->>'maxSlippageBps' max_slip,
            service_control->>'platformFeeBps' fee,
            funding->>'fundingMint' base,
            status
     from sessions where id=$1`, [NOAH]);
  console.log('Noah live config:', JSON.stringify(s.rows[0]));

  // 2. SOL major stop floor over time today (pre vs post 16:04Z fee removal)
  const r = await p.query(
    `select case when created_at < '2026-06-09T16:04:00Z' then 'pre-fee-removal' else 'post-fee-removal' end win,
            count(*) n,
            round(avg((thresholds->>'stopLossBps')::numeric),0) avg_stop,
            round(avg((thresholds->>'takeProfitBps')::numeric),0) avg_tp,
            round(avg((thresholds->>'costFloorBps')::numeric),0) avg_floor,
            round(avg((thresholds->>'atrBps')::numeric),1) avg_atr,
            round(avg(max_favorable_bps)::numeric,0) avg_mfe,
            round(avg(pnl_bps)::numeric,0) avg_pnl
     from exit_shadow_decisions
     where created_at >= '2026-06-09T00:00:00Z' and current_should_exit=true and session_id=$1
       and token_class='major' and pnl_bps is not null
     group by win order by win`, [NOAH]);
  console.log('\nSOL major stop/TP floor pre vs post fee removal:');
  r.rows.forEach(x => console.log(`  ${x.win}: n=${x.n} stop=${x.avg_stop} tp=${x.avg_tp} floor=${x.avg_floor} atr=${x.avg_atr} mfe=${x.avg_mfe} pnl=${x.avg_pnl}`));

  // 3. How often did ANY SOL major position reach the TP floor? (mfe >= floor)
  const t = await p.query(
    `select count(*) total,
            count(*) filter (where max_favorable_bps >= (thresholds->>'takeProfitBps')::numeric) reached_tp,
            count(*) filter (where max_favorable_bps >= (thresholds->>'costFloorBps')::numeric) reached_floor
     from exit_shadow_decisions
     where created_at >= '2026-06-09T00:00:00Z' and current_should_exit=true and session_id=$1
       and token_class='major' and pnl_bps is not null and thresholds->>'takeProfitBps' is not null`, [NOAH]);
  console.log('\nSOL major TP reachability:', JSON.stringify(t.rows[0]));
  await p.end();
})().catch(e => { console.error(e.message); process.exit(1); });
