require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const p = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const DAY = '2026-06-09T00:00:00Z';
const NOAH = 'edd46e65-b21d-4d99-911d-99842d62b428';
(async () => {
  console.log('=== null-band trades: by class + reason ===');
  const a = await p.query(
    `select coalesce(token_class,'?') tc, coalesce(symbol,'?') sym, current_reason,
            count(*) n, round(avg(pnl_bps)::numeric,1) avg_pnl, round(sum(pnl_bps)::numeric,0) total
     from exit_shadow_decisions
     where created_at >= $1 and current_should_exit = true and session_id = $2
       and pnl_bps is not null and entry_quality_band is null
     group by tc, sym, current_reason order by total`,
    [DAY, NOAH]);
  a.rows.forEach(x => console.log(`  ${String(x.tc).padEnd(9)} ${String(x.sym).padEnd(7)} ${String(x.current_reason||'?').padEnd(16)} n=${x.n} avg=${x.avg_pnl} total=${x.total}`));

  console.log('\n=== major-class trades: by band + symbol ===');
  const b = await p.query(
    `select coalesce(entry_quality_band,'(null)') band, coalesce(symbol,'?') sym,
            count(*) n, round(avg(pnl_bps)::numeric,1) avg_pnl, round(sum(pnl_bps)::numeric,0) total
     from exit_shadow_decisions
     where created_at >= $1 and current_should_exit = true and session_id = $2
       and pnl_bps is not null and token_class = 'major'
     group by band, sym order by total`,
    [DAY, NOAH]);
  b.rows.forEach(x => console.log(`  band=${String(x.band).padEnd(8)} ${String(x.sym).padEnd(7)} n=${x.n} avg=${x.avg_pnl} total=${x.total}`));

  console.log('\n=== overlap: null-band AND major? ===');
  const c = await p.query(
    `select count(*) n, round(sum(pnl_bps)::numeric,0) total
     from exit_shadow_decisions
     where created_at >= $1 and current_should_exit = true and session_id = $2
       and pnl_bps is not null and entry_quality_band is null and token_class='major'`,
    [DAY, NOAH]);
  console.log(`  null-band & major: n=${c.rows[0].n} total=${c.rows[0].total}`);
  await p.end();
})().catch(e => { console.error(e.message); process.exit(1); });
