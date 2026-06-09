require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const TAKER='Fu23Ra8SWUUNqpjR2mKqydx37WAykGpDbKBKaxkHAsaW';
const SOL='So11111111111111111111111111111111111111112', USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const lbl=(m)=> m===SOL?'SOL':(m===USDC?'USDC':m.slice(0,6)+'…');
(async()=>{
  const {rows}=await pool.query(`
    select created_at,input_mint,output_mint,
      build_response->>'inAmount' in_amt, build_response->>'outAmount' out_amt
    from swap_executions where taker=$1 and status='confirmed' and build_response is not null
    order by created_at asc`,[TAKER]);
  const openLots={}; const byMint={};
  for(const r of rows){
    const inA=Number(r.in_amt||0),outA=Number(r.out_amt||0),im=r.input_mint,om=r.output_mint;
    if(im===USDC&&om!==USDC){(openLots[om]||=[]).push({usdc:inA,qty:outA,ts:r.created_at});}
    else if(om===USDC&&im!==USDC){
      const lots=openLots[im]||[]; let rem=inA,cost=0,mq=0;
      while(rem>0&&lots.length){const lot=lots[0];const take=Math.min(rem,lot.qty);const f=take/lot.qty;cost+=lot.usdc*f;mq+=take;lot.qty-=take;lot.usdc-=lot.usdc*f;rem-=take;if(lot.qty<=1)lots.shift();}
      if(mq>0){const recv=outA*(mq/inA);const net=(recv-cost)/1e6;const holdMs=Date.now();
        const b=byMint[im]||={n:0,net:0,wins:0,losses:0,gw:0,gl:0};
        b.n++;b.net+=net;if(net>=0){b.wins++;b.gw+=net;}else{b.losses++;b.gl+=net;}byMint[im]=b;}
    }
  }
  console.log('=== per-token round-trip PnL (USDC, after platform fee, before gas) ===');
  const arr=Object.entries(byMint).map(([m,b])=>({m,...b})).sort((a,b)=>a.net-b.net);
  for(const b of arr){
    console.log(`${lbl(b.m).padEnd(8)} trips=${String(b.n).padStart(3)}  net=${(b.net>=0?'+':'')+b.net.toFixed(3)}  wr=${(100*b.wins/b.n).toFixed(0)}%  avgW=${(b.gw/Math.max(1,b.wins)).toFixed(4)}  avgL=${(b.gl/Math.max(1,b.losses)).toFixed(4)}`);
  }
  // hold time: median seconds between open and close per round trip (recompute simple)
  const opens={}; const holds=[];
  for(const r of rows){const im=r.input_mint,om=r.output_mint;
    if(im===USDC&&om!==USDC){(opens[om]||=[]).push(new Date(r.created_at).getTime());}
    else if(om===USDC&&im!==USDC){const q=opens[im];if(q&&q.length){const t0=q.shift();holds.push((new Date(r.created_at).getTime()-t0)/1000);}}}
  holds.sort((a,b)=>a-b);
  const med=holds[Math.floor(holds.length/2)]||0;
  console.log(`\nmedian hold time: ${med.toFixed(0)}s  (${(med/60).toFixed(1)} min)  n=${holds.length}`);
  console.log(`hold p10=${holds[Math.floor(holds.length*0.1)]?.toFixed(0)}s p90=${holds[Math.floor(holds.length*0.9)]?.toFixed(0)}s`);
  await pool.end();
})().catch(e=>{console.error(e);process.exit(1);});
