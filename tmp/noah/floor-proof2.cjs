require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const p = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const CUTOFF = '2026-06-09T17:05:00Z';
const NOAH = 'edd46e65-b21d-4d99-911d-99842d62b428';
(async () => {
  // honest_floor_bps distribution before vs after cutoff (the binding floor)
  const post = await p.query(
    `select min(honest_floor_bps) mn, max(honest_floor_bps) mx,
            round(avg(honest_floor_bps)::numeric,1) av, count(*) n
     from exit_shadow_decisions
     where session_id=$1 and created_at >= $2 and honest_floor_bps is not null`, [NOAH, CUTOFF]);
  const pre = await p.query(
    `select min(honest_floor_bps) mn, max(honest_floor_bps) mx,
            round(avg(honest_floor_bps)::numeric,1) av, count(*) n
     from exit_shadow_decisions
     where session_id=$1 and created_at >= '2026-06-09T00:00:00Z' and created_at < $2
       and honest_floor_bps is not null`, [NOAH, CUTOFF]);
  console.log('honest_floor_bps PRE-cutoff :', JSON.stringify(pre.rows[0]));
  console.log('honest_floor_bps POST-cutoff:', JSON.stringify(post.rows[0]));

  // thresholds: take-profit target values post vs pre
  const tpPost = await p.query(
    `select distinct (thresholds->>'takeProfitBps')::numeric t
     from exit_shadow_decisions where session_id=$1 and created_at >= $2
       and thresholds->>'takeProfitBps' is not null order by t`, [NOAH, CUTOFF]);
  const tpPre = await p.query(
    `select min((thresholds->>'takeProfitBps')::numeric) mn, max((thresholds->>'takeProfitBps')::numeric) mx
     from exit_shadow_decisions where session_id=$1
       and created_at >= '2026-06-09T00:00:00Z' and created_at < $2
       and thresholds->>'takeProfitBps' is not null`, [NOAH, CUTOFF]);
  console.log('\ntakeProfitBps PRE  min/max:', JSON.stringify(tpPre.rows[0]));
  console.log('takeProfitBps POST distinct:', tpPost.rows.map(r=>r.t).join(', ') || 'none yet');

  // exit reasons post-cutoff
  const reasons = await p.query(
    `select current_reason, count(*) n, round(avg(pnl_bps)::numeric,1) avg_pnl
     from exit_shadow_decisions where session_id=$1 and created_at >= $2 and current_should_exit=true
     group by current_reason order by n desc`, [NOAH, CUTOFF]);
  console.log('\nNoah EXIT-signalled reasons post-cutoff:');
  for (const r of reasons.rows) console.log(`  ${r.current_reason}: ${r.n} (avg pnl ${r.avg_pnl})`);
  if (!reasons.rows.length) console.log('  (no exits signalled yet)');
  await p.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
