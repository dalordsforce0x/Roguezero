require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });

const TAKER = 'Fu23Ra8SWUUNqpjR2mKqydx37WAykGpDbKBKaxkHAsaW';
const SOL='So11111111111111111111111111111111111111112';
const USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const lbl=(m)=> m===SOL?'SOL':(m===USDC?'USDC':m.slice(0,6)+'…');

(async () => {
  // Pull ALL confirmed trades all-time with quote amounts + fee info
  const { rows } = await pool.query(`
    select created_at, input_mint, output_mint, amount,
           platform_fee_bps, fee_token_symbol,
           build_response->'quote'->>'inAmount'  as in_amt,
           build_response->'quote'->>'outAmount' as out_amt,
           build_response->>'priceImpactPct' as impact
    from swap_executions
    where taker = $1 and status = 'confirmed'
    order by created_at asc
  `, [TAKER]);

  console.log(`confirmed trades all-time: ${rows.length}`);

  // Column probe: what fields does build_response actually have on one row?
  const probe = await pool.query(`
    select jsonb_pretty(build_response) bp
    from swap_executions
    where taker=$1 and status='confirmed' and build_response is not null
    order by created_at desc limit 1
  `, [TAKER]);
  console.log('\n=== sample build_response ===');
  console.log((probe.rows[0]?.bp || '(none)').slice(0, 1500));

  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
