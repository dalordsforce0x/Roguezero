require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const p = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const DAY = '2026-06-09T00:00:00Z';
const NOAH = 'edd46e65-b21d-4d99-911d-99842d62b428';
(async () => {
  // Outcome by entry_quality_band
  console.log('=== Noah today: outcome by entry_quality_band (should_exit closes) ===');
  const r = await p.query(
    `select coalesce(entry_quality_band,'(null)') band,
            count(*) n,
            round(avg(pnl_bps)::numeric,1) avg_pnl,
            count(*) filter (where pnl_bps>0) wins,
            count(*) filter (where pnl_bps<=0) losses,
            round(avg(entry_quality_score)::numeric,1) avg_score,
            round(avg(max_adverse_bps)::numeric,1) avg_mae
     from exit_shadow_decisions
     where created_at >= $1 and current_should_exit = true and session_id = $2 and pnl_bps is not null
     group by band order by avg_pnl`,
    [DAY, NOAH]);
  r.rows.forEach(x => console.log(`  band=${String(x.band).padEnd(10)} n=${String(x.n).padStart(3)} avgPnL=${String(x.avg_pnl).padStart(7)} wins=${x.wins} losses=${x.losses} score~${x.avg_score} mae~${x.avg_mae}`));

  // Outcome by score buckets
  console.log('\n=== by entry_quality_score bucket ===');
  const b = await p.query(
    `select width_bucket(entry_quality_score, 0, 100, 5) bucket,
            min(entry_quality_score) lo, max(entry_quality_score) hi,
            count(*) n, round(avg(pnl_bps)::numeric,1) avg_pnl,
            count(*) filter (where pnl_bps>0) wins, count(*) filter (where pnl_bps<=0) losses
     from exit_shadow_decisions
     where created_at >= $1 and current_should_exit = true and session_id = $2
       and pnl_bps is not null and entry_quality_score is not null
     group by bucket order by bucket`,
    [DAY, NOAH]);
  if (!b.rows.length) console.log('  (no entry_quality_score populated)');
  b.rows.forEach(x => console.log(`  score ${x.lo}-${x.hi}: n=${x.n} avgPnL=${x.avg_pnl} wins=${x.wins} losses=${x.losses}`));

  // token_class outcome
  console.log('\n=== by token_class ===');
  const t = await p.query(
    `select coalesce(token_class,'(null)') tc, count(*) n,
            round(avg(pnl_bps)::numeric,1) avg_pnl,
            count(*) filter (where pnl_bps>0) wins, count(*) filter (where pnl_bps<=0) losses,
            round(sum(pnl_bps)::numeric,0) total
     from exit_shadow_decisions
     where created_at >= $1 and current_should_exit = true and session_id = $2 and pnl_bps is not null
     group by tc order by total`,
    [DAY, NOAH]);
  t.rows.forEach(x => console.log(`  ${String(x.tc).padEnd(12)} n=${String(x.n).padStart(3)} avgPnL=${String(x.avg_pnl).padStart(7)} total=${String(x.total).padStart(6)} wins=${x.wins} losses=${x.losses}`));
  await p.end();
})().catch(e => { console.error(e.message); process.exit(1); });
