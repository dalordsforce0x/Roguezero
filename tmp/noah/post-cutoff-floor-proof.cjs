require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const p = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const CUTOFF = '2026-06-09T17:05:00Z';
const NOAH = 'edd46e65-b21d-4d99-911d-99842d62b428';
(async () => {
  // What thresholds/cost-floor is the live engine now using? Inspect evaluation json keys.
  const sample = await p.query(
    `select evaluation, current_should_exit, current_exit_reason, pnl_bps, token_class, created_at
     from exit_shadow_decisions
     where session_id=$1 and created_at >= $2
     order by created_at desc limit 1`, [NOAH, CUTOFF]);
  if (sample.rows[0]) {
    console.log('latest evaluation keys:', Object.keys(sample.rows[0].evaluation || {}).join(', '));
    const e = sample.rows[0].evaluation || {};
    console.log('costFloorBps / takeProfit / stopLoss in eval:',
      e.exitCostFloorBps, e.takeProfitBps, e.stopLossBps);
  } else {
    console.log('No Noah exit decisions since cutoff yet.');
  }

  // Cost floor values seen post-cutoff (proves 120 -> ~55)
  const floors = await p.query(
    `select distinct (evaluation->>'exitCostFloorBps')::numeric f
     from exit_shadow_decisions
     where session_id=$1 and created_at >= $2 and evaluation->>'exitCostFloorBps' is not null
     order by f`, [NOAH, CUTOFF]);
  console.log('\nDistinct cost-floor values post-cutoff (Noah):', floors.rows.map(r=>r.f).join(', ') || 'none yet');

  // Compare to pre-cutoff floors today
  const pre = await p.query(
    `select distinct (evaluation->>'exitCostFloorBps')::numeric f
     from exit_shadow_decisions
     where session_id=$1 and created_at >= '2026-06-09T00:00:00Z' and created_at < $2
       and evaluation->>'exitCostFloorBps' is not null order by f`, [NOAH, CUTOFF]);
  console.log('Distinct cost-floor values PRE-cutoff today (Noah):', pre.rows.map(r=>r.f).join(', ') || 'none');

  // Any take-profit exits firing post-cutoff?
  const tp = await p.query(
    `select current_exit_reason, count(*) n, round(avg(pnl_bps)::numeric,1) avg_pnl
     from exit_shadow_decisions
     where session_id=$1 and created_at >= $2 and current_should_exit=true
     group by current_exit_reason order by n desc`, [NOAH, CUTOFF]);
  console.log('\nNoah exit reasons post-cutoff:');
  for (const r of tp.rows) console.log(`  ${r.current_exit_reason}: ${r.n} (avg pnl ${r.avg_pnl} bps)`);
  await p.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
