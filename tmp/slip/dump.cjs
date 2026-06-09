require('dotenv').config();
const pg = require('pg');
const url = new URL(process.env.DATABASE_PRIVATE_URL.trim());
url.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: url.toString(), ssl: { rejectUnauthorized: false } });

(async () => {
  const r = (await pool.query(`
    SELECT input_mint, output_mint, taker, build_response, confirmation, metadata
    FROM swap_executions
    WHERE status='confirmed' AND created_at > now() - interval '72 hours'
      AND metadata->>'exitReason' IS NOT NULL
    ORDER BY created_at DESC LIMIT 1
  `)).rows[0];
  console.log('=== build_response ===');
  console.log(JSON.stringify(r.build_response, null, 1).slice(0, 1500));
  console.log('\n=== confirmation.meta (balances) ===');
  const meta = r.confirmation?.meta || {};
  console.log('preTokenBalances:', JSON.stringify(meta.preTokenBalances));
  console.log('postTokenBalances:', JSON.stringify(meta.postTokenBalances));
  console.log('\ntaker:', r.taker);
  console.log('metadata:', JSON.stringify(r.metadata));
  await pool.end();
})().catch((e) => { console.error(e); pool.end(); process.exit(1); });
