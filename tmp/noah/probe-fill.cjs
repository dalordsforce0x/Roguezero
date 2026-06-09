require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const p = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
(async () => {
  const r = await p.query(
    `select id, input_mint, output_mint, amount,
            jsonb_typeof(build_response) bt, jsonb_typeof(confirmation) ct,
            build_response, confirmation, metadata
     from swap_executions
     where status='confirmed' and taker='8FvnRY4KsLGptz2HwmhUzTeEHQrrgfS8Sy343CG9anjC'
     order by created_at desc limit 1`);
  const row = r.rows[0];
  console.log('input_mint', row.input_mint);
  console.log('output_mint', row.output_mint);
  console.log('amount', row.amount);
  console.log('--- build_response keys ---');
  console.log(row.build_response ? Object.keys(row.build_response) : null);
  console.log(JSON.stringify(row.build_response, null, 2).slice(0, 1500));
  console.log('--- confirmation keys ---');
  console.log(row.confirmation ? Object.keys(row.confirmation) : null);
  console.log(JSON.stringify(row.confirmation, null, 2).slice(0, 1200));
  console.log('--- metadata ---');
  console.log(JSON.stringify(row.metadata, null, 2).slice(0, 1200));
  await p.end();
})().catch(e => { console.error(e.message); process.exit(1); });
