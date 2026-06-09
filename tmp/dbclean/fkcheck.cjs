require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const p = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
(async () => {
  console.log('=== FKs that REFERENCE swap_executions (would block delete) ===');
  const fk = await p.query(`
    select tc.table_name as child, kcu.column_name as child_col
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu on tc.constraint_name = kcu.constraint_name
    join information_schema.constraint_column_usage ccu on tc.constraint_name = ccu.constraint_name
    where tc.constraint_type = 'FOREIGN KEY' and ccu.table_name = 'swap_executions'`);
  if (fk.rows.length === 0) console.log('  (none — safe to delete)');
  fk.rows.forEach(r => console.log(`  ${r.child}.${r.child_col} -> swap_executions`));

  console.log('\n=== status breakdown of the 2919 DELETE rows ===');
  const KEEP = ['Fu23Ra8SWUUNqpjR2mKqydx37WAykGpDbKBKaxkHAsaW','tzM97zpSQpsXUoZHgvTxj7X4sXd3bf1hrT2LmtxpKg7','8FvnRY4KsLGptz2HwmhUzTeEHQrrgfS8Sy343CG9anjC'];
  const br = await p.query('select status, count(*) n from swap_executions where not (taker = any($1)) group by status order by n desc', [KEEP]);
  br.rows.forEach(r => console.log(`  ${r.status}: ${r.n}`));
  await p.end();
})().catch(e => { console.error(e.message); process.exit(1); });
