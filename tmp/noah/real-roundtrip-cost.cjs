require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const p = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const NOAH_WALLET = 'Fu23Ra8SWUUNqpjR2mKqydx37WAykGpDbKBKaxkHAsaW';
(async () => {
  // What fields does build_response carry?
  const sample = await p.query(
    `select build_response from swap_executions
     where status='confirmed' and build_response is not null
     order by created_at desc limit 1`);
  console.log('build_response keys:', sample.rows[0] ? Object.keys(sample.rows[0].build_response) : 'none');
  console.log('sample:', JSON.stringify(sample.rows[0]?.build_response).slice(0, 600));

  // Price impact distribution across recent confirmed swaps (all sessions)
  const r = await p.query(
    `select
       count(*) n,
       round(percentile_cont(0.5) within group (order by (build_response->>'priceImpactPct')::numeric * 10000)::numeric,1) p50_bps,
       round(percentile_cont(0.9) within group (order by (build_response->>'priceImpactPct')::numeric * 10000)::numeric,1) p90_bps,
       round(percentile_cont(0.99) within group (order by (build_response->>'priceImpactPct')::numeric * 10000)::numeric,1) p99_bps,
       round(max((build_response->>'priceImpactPct')::numeric * 10000)::numeric,1) max_bps
     from swap_executions
     where status='confirmed' and created_at >= now() - interval '24 hours'
       and build_response->>'priceImpactPct' is not null`);
  console.log('\nPrice impact per leg (last 24h, all bots):', JSON.stringify(r.rows[0]));
  await p.end();
})().catch(e => { console.error(e.message); process.exit(1); });
