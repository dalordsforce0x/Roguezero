require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const p = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const FOXY = 'tzM97zpSQpsXUoZHgvTxj7X4sXd3bf1hrT2LmtxpKg7';
const SOL='So11111111111111111111111111111111111111112', USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
(async () => {
  // 1) cross-tab: for Foxy, what exit reasons co-occur with reserve_shortfall cancel?
  const r = await p.query(
    `SELECT
       e.metadata->>'exitReason' exit_reason,
       e.last_error->>'reason' cancel_reason,
       e.status,
       count(*) n
     FROM swap_executions e
     WHERE e.taker=$1 AND e.created_at >= now() - interval '3 hours'
     GROUP BY 1,2,3 ORDER BY n DESC`, [FOXY]);
  console.log('Foxy last 3h — exitReason x cancelReason x status:');
  for (const x of r.rows)
    console.log(`  ${String(x.exit_reason||'-').padEnd(16)} ${String(x.cancel_reason||'-').padEnd(36)} ${String(x.status).padEnd(10)} ${x.n}`);

  // 2) Does ANY SOL->USDC exit ever fully confirm for Foxy, or is the position trapped?
  const c = await p.query(
    `SELECT status, count(*) n,
            sum(case when last_error->>'reason'='post_exit_reserve_shortfall_retry' then 1 else 0 end) reserve_cancels
     FROM swap_executions
     WHERE taker=$1 AND input_mint=$2 AND output_mint=$3 AND created_at >= now() - interval '3 hours'
     GROUP BY status ORDER BY n DESC`, [FOXY, SOL, USDC]);
  console.log('\nFoxy SOL->USDC exits last 3h:');
  for (const x of c.rows) console.log(`  ${x.status.padEnd(10)} n=${x.n} reserve_cancels=${x.reserve_cancels}`);

  // 3) Is the reserve shortfall ALSO happening on non-trailing exits (stop_loss) historically?
  const h = await p.query(
    `SELECT e.metadata->>'exitReason' exit_reason, count(*) n
     FROM swap_executions e
     WHERE e.taker=$1 AND e.last_error->>'reason'='post_exit_reserve_shortfall_retry'
       AND e.created_at >= now() - interval '24 hours'
     GROUP BY 1 ORDER BY n DESC`, [FOXY]);
  console.log('\nFoxy reserve_shortfall cancels by exit reason (24h):');
  for (const x of h.rows) console.log(`  ${String(x.exit_reason||'-').padEnd(16)} ${x.n}`);

  // 4) Foxy current SOL balance / position size
  await p.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
