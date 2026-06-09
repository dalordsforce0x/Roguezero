require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const SOL='So11111111111111111111111111111111111111112', USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const lbl=(m)=> m===SOL?'SOL':(m===USDC?'USDC':m.slice(0,6)+'…');

(async()=>{
  // All active sessions, their wallets, funding, pnl
  const s = await pool.query(`
    select id, owner_wallet, session_wallet, status,
      user_control->'profitHandling' ph,
      funding->>'fundingTokenSymbol' sym,
      funding->>'realizedPnlUsd' rp, funding->>'unrealizedPnlUsd' up,
      funding->>'capturedFeesUsd' cf,
      funding->>'startingBalanceAtomic' start, funding->>'currentBalanceAtomic' bal,
      started_at
    from sessions where status='active' order by started_at asc nulls last`);
  console.log('=== ACTIVE SESSIONS ===');
  for(const r of s.rows){
    console.log(`\n${r.id.slice(0,8)} owner=${r.owner_wallet.slice(0,6)} wallet=${r.session_wallet.slice(0,6)} base=${r.sym} mode=${JSON.stringify(r.ph)}`);
    console.log(`  realizedPnl=$${r.rp}  unrealized=$${r.up}  fees=$${r.cf}  start=${r.start} bal=${r.bal}  started=${r.started_at?.toISOString?.()||r.started_at}`);

    // most recent 8 trades for this wallet
    const t = await pool.query(`
      select created_at, input_mint, output_mint, status,
        coalesce(last_error::text,'') err
      from swap_executions where taker=$1 order by created_at desc limit 8`, [r.session_wallet]);
    const now=Date.now();
    if(!t.rows.length){ console.log('  no trades on record'); continue; }
    const last=t.rows[0];
    const agoMin=((now-new Date(last.created_at).getTime())/60000).toFixed(1);
    console.log(`  LAST TRADE: ${agoMin} min ago`);
    for(const x of t.rows){
      const reason = x.err ? (()=>{try{return JSON.parse(x.err).reason}catch{return x.err.slice(0,40)}})() : '';
      console.log(`   ${x.created_at.toISOString()}  ${lbl(x.input_mint)}->${lbl(x.output_mint)}  ${x.status}${reason?'  ['+reason+']':''}`);
    }

    // current on-chain-ish: open token holdings inferred from net position (last 24h)
  }
  await pool.end();
})().catch(e=>{console.error(e);process.exit(1);});
