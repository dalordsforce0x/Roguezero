require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const p = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const CUTOFF = '2026-06-09T16:04:00Z';
(async () => {
  console.log('=== confirmed BEFORE cutoff by feeBps ===');
  const b = await p.query("select platform_fee_bps fee, count(*) n from swap_executions where status='confirmed' and created_at < \ group by platform_fee_bps order by platform_fee_bps", [CUTOFF]);
  b.rows.forEach(r => console.log('  feeBps=' + r.fee + '  n=' + r.n));
  console.log('=== confirmed AFTER cutoff by feeBps ===');
  const a = await p.query("select platform_fee_bps fee, count(*) n from swap_executions where status='confirmed' and created_at >= \ group by platform_fee_bps order by platform_fee_bps", [CUTOFF]);
  if (a.rows.length === 0) console.log('  (none yet)');
  a.rows.forEach(r => console.log('  feeBps=' + r.fee + '  n=' + r.n));
  await p.end();
})().catch(e => { console.error(e.message); process.exit(1); });
