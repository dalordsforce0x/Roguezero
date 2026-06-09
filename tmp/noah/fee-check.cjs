require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const TAKER='Fu23Ra8SWUUNqpjR2mKqydx37WAykGpDbKBKaxkHAsaW';
const SOL='So11111111111111111111111111111111111111112', USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const lbl=(m)=> m===SOL?'SOL':(m===USDC?'USDC':m.slice(0,6)+'…');
(async()=>{
  // platform_fee_bps distribution over time (did per-trade fee get turned off?)
  const fee = await pool.query(`
    select date_trunc('hour', created_at) hr, platform_fee_bps, count(*) n
    from swap_executions where taker=$1 and status='confirmed'
    group by hr, platform_fee_bps order by hr desc limit 20`, [TAKER]);
  console.log('=== platform_fee_bps by hour (confirmed) ===');
  fee.rows.forEach(r=>console.log(`${r.hr.toISOString()}  feeBps=${r.platform_fee_bps}  n=${r.n}`));

  // overall fee bps distribution all-time
  const dist = await pool.query(`
    select platform_fee_bps, count(*) n from swap_executions where taker=$1 and status='confirmed'
    group by platform_fee_bps order by n desc`, [TAKER]);
  console.log('\n=== all-time fee bps distribution ===');
  dist.rows.forEach(r=>console.log(`feeBps=${r.platform_fee_bps}  n=${r.n}`));

  // Noah recent activity since worker restart (after 15:25 deploy)
  const recent = await pool.query(`
    select created_at, input_mint, output_mint, status, platform_fee_bps,
      coalesce(last_error::text,'') err
    from swap_executions where taker=$1 and created_at > '2026-06-09T15:25:00Z'
    order by created_at desc limit 20`, [TAKER]);
  console.log('\n=== Noah trades since 15:25 deploy ===');
  if(!recent.rows.length) console.log('  NONE since deploy');
  recent.rows.forEach(x=>{
    const reason = x.err?(()=>{try{return JSON.parse(x.err).reason}catch{return x.err.slice(0,30)}})():'';
    console.log(`${x.created_at.toISOString()}  ${lbl(x.input_mint)}->${lbl(x.output_mint)}  ${x.status} fee=${x.platform_fee_bps}${reason?' ['+reason+']':''}`);
  });

  // Noah funding now
  const f = await pool.query(`select funding->>'realizedPnlUsd' rp, funding->>'unrealizedPnlUsd' up, funding->>'capturedFeesUsd' cf, funding->>'currentBalanceAtomic' bal, funding->>'startingBalanceAtomic' start, status from sessions where id='edd46e65-b21d-4d99-911d-99842d62b428'`);
  console.log('\n=== Noah funding snapshot ===');
  console.log(JSON.stringify(f.rows[0]));
  await pool.end();
})().catch(e=>{console.error(e);process.exit(1);});
