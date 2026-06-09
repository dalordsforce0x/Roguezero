require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const p = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const CUTOFF = '2026-06-09T16:04:00Z';
(async () => {
  console.log('=== profit-exit fee bps BEFORE cutoff (' + CUTOFF + ') ===');
  const before = await p.query(
    `select platform_fee_bps fee, count(*) n
     from swap_executions
     where status='confirmed' and created_at < $1
       and (exit_reason in ('take_profit','trailing_stop'))
     group by platform_fee_bps order by platform_fee_bps`, [CUTOFF]);
  before.rows.forEach(r => console.log(`  feeBps=${r.fee}  n=${r.n}`));

  console.log('=== ALL confirmed trades AFTER cutoff (any reason) ===');
  const after = await p.query(
    `select platform_fee_bps fee, coalesce(exit_reason,'(entry)') reason, count(*) n
     from swap_executions
     where status='confirmed' and created_at >= $1
     group by platform_fee_bps, exit_reason order by n desc`, [CUTOFF]);
  if (after.rows.length === 0) console.log('  (no confirmed trades yet since cutoff)');
  after.rows.forEach(r => console.log(`  feeBps=${r.fee}  reason=${r.reason}  n=${r.n}`));
  await p.end();
})().catch(e => { console.error(e.message); process.exit(1); });
