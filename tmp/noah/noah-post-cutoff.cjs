require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });

const TAKER = 'Fu23Ra8SWUUNqpjR2mKqydx37WAykGpDbKBKaxkHAsaW';
const CUTOFF = '2026-06-09T14:49:44Z';

(async () => {
  // overall counts post-cutoff
  const counts = await pool.query(`
    select status, count(*) as n
    from swap_executions
    where taker = $1 and created_at > $2
    group by status order by n desc
  `, [TAKER, CUTOFF]);
  console.log('=== status counts (post-cutoff) ===');
  counts.rows.forEach(r => console.log(`${r.status}: ${r.n}`));

  // failure reasons
  const fails = await pool.query(`
    select coalesce(last_error::text,'(none)') as reason, count(*) as n
    from swap_executions
    where taker = $1 and created_at > $2 and status not in ('confirmed','submitted')
    group by reason order by n desc limit 15
  `, [TAKER, CUTOFF]);
  console.log('\n=== failure reasons ===');
  fails.rows.forEach(r => console.log(`${r.n}\t${r.reason}`));

  // mint pair flow
  const pairs = await pool.query(`
    select input_mint, output_mint, status, count(*) as n
    from swap_executions
    where taker = $1 and created_at > $2
    group by input_mint, output_mint, status order by n desc limit 25
  `, [TAKER, CUTOFF]);
  const SOL='So11111111111111111111111111111111111111112';
  const USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const lbl=(m)=> m===SOL?'SOL':(m===USDC?'USDC':m.slice(0,6)+'…');
  console.log('\n=== mint pair flow ===');
  pairs.rows.forEach(r => console.log(`${r.n}\t${lbl(r.input_mint)} -> ${lbl(r.output_mint)}\t${r.status}`));

  // confirmed trades timeline (last 20)
  const tl = await pool.query(`
    select created_at, input_mint, output_mint, status,
           build_response->>'priceImpactPct' as impact
    from swap_executions
    where taker = $1 and created_at > $2
    order by created_at desc limit 20
  `, [TAKER, CUTOFF]);
  console.log('\n=== last 20 executions ===');
  tl.rows.forEach(r => console.log(`${r.created_at.toISOString()}  ${lbl(r.input_mint)}->${lbl(r.output_mint)}  ${r.status}  imp=${r.impact ?? '-'}`));

  // current Noah funding snapshot
  const f = await pool.query(`select funding->>'realizedPnlUsd' rp, funding->>'unrealizedPnlUsd' up, funding->>'capturedFeesUsd' cf, funding->>'currentBalanceAtomic' bal, funding->>'startingBalanceAtomic' start, funding->>'fundingTokenSymbol' sym, status from sessions where id='edd46e65-b21d-4d99-911d-99842d62b428'`);
  console.log('\n=== Noah funding snapshot ===');
  console.log(JSON.stringify(f.rows[0]));

  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
