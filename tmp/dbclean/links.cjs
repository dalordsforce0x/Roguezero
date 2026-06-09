require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const p = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const KEEP_WALLETS = [
  'Fu23Ra8SWUUNqpjR2mKqydx37WAykGpDbKBKaxkHAsaW',
  'tzM97zpSQpsXUoZHgvTxj7X4sXd3bf1hrT2LmtxpKg7',
  '8FvnRY4KsLGptz2HwmhUzTeEHQrrgfS8Sy343CG9anjC',
];
async function cols(p, t) {
  const r = await p.query(`select column_name from information_schema.columns where table_name=$1 order by ordinal_position`, [t]);
  return r.rows.map(x => x.column_name);
}
(async () => {
  for (const t of ['exit_shadow_decisions', 'market_scanner_runs', 'market_candidates', 'token_admission_candidates']) {
    console.log(`\n=== ${t} columns ===`);
    console.log('  ' + (await cols(p, t)).join(', '));
  }

  console.log('\n=== swap_executions: keep vs delete (by taker) ===');
  const seKeep = await p.query('select count(*) n from swap_executions where taker = any($1)', [KEEP_WALLETS]);
  const seAll = await p.query('select count(*) n from swap_executions');
  console.log(`  KEEP (active wallets): ${seKeep.rows[0].n}`);
  console.log(`  DELETE (everything else): ${seAll.rows[0].n - seKeep.rows[0].n}`);

  // exit_shadow_decisions link check — try session_id then taker
  const esCols = await cols(p, 'exit_shadow_decisions');
  console.log('\n=== exit_shadow_decisions link ===');
  if (esCols.includes('session_id')) {
    const k = await p.query(`select count(*) n from exit_shadow_decisions where session_id in (select id from sessions where status='active')`);
    const a = await p.query('select count(*) n from exit_shadow_decisions');
    console.log(`  via session_id -> KEEP ${k.rows[0].n}, DELETE ${a.rows[0].n - k.rows[0].n}`);
  } else if (esCols.includes('taker')) {
    const k = await p.query('select count(*) n from exit_shadow_decisions where taker = any($1)', [KEEP_WALLETS]);
    const a = await p.query('select count(*) n from exit_shadow_decisions');
    console.log(`  via taker -> KEEP ${k.rows[0].n}, DELETE ${a.rows[0].n - k.rows[0].n}`);
  } else {
    console.log('  no session_id/taker column — needs manual mapping');
  }

  await p.end();
})().catch(e => { console.error(e.message); process.exit(1); });
