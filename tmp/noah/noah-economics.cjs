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
  const { rows } = await pool.query(`
    select created_at, input_mint, output_mint,
           platform_fee_bps,
           build_response->>'inAmount'  as in_amt,
           build_response->>'outAmount' as out_amt,
           (build_response->'routePlan'->0->'swapInfo'->>'outAmount') as route_out,
           build_response->>'priceImpactPct' as impact
    from swap_executions
    where taker = $1 and status = 'confirmed' and build_response is not null
    order by created_at asc
  `, [TAKER]);

  // Net flow accounting across all confirmed trades
  let usdcIn=0, usdcOut=0, solIn=0, solOut=0; // *In = received, *Out = spent
  let platformFeeUsdc=0; // approx fee paid in USDC-equiv (35bps of the USDC leg)
  let nLegs=0;
  // round trips: match USDC->X open with next X->USDC close (FIFO per mint)
  const openLots = {}; // mint -> array of {usdcSpent, qtyAtomic, ts}
  const roundTrips = [];

  for (const r of rows) {
    const inA = Number(r.in_amt||0), outA = Number(r.out_amt||0), routeOut = Number(r.route_out||outA);
    const im=r.input_mint, om=r.output_mint;
    nLegs++;
    // platform fee = routeOut - outA, in units of output mint
    const feeAtomic = Math.max(0, routeOut - outA);
    if (im===USDC){ usdcOut += inA; } if (om===USDC){ usdcIn += outA; if(feeAtomic) platformFeeUsdc += feeAtomic; }
    if (im===SOL){ solOut += inA; } if (om===SOL){ solIn += outA; }

    if (im===USDC && om!==USDC){ // open position in om
      (openLots[om] ||= []).push({ usdcSpent: inA, qty: outA, ts: r.created_at });
    } else if (om===USDC && im!==USDC){ // close position in im
      const lots = openLots[im] || [];
      let remaining = inA; // qty of im we're selling
      let usdcReceived = outA;
      // FIFO match
      let costBasisUsdc = 0, matchedQty = 0;
      while (remaining > 0 && lots.length){
        const lot = lots[0];
        const take = Math.min(remaining, lot.qty);
        const frac = take / lot.qty;
        costBasisUsdc += lot.usdcSpent * frac;
        matchedQty += take;
        lot.qty -= take; lot.usdcSpent -= lot.usdcSpent*frac; remaining -= take;
        if (lot.qty <= 1) lots.shift();
      }
      if (matchedQty>0){
        // pro-rate usdcReceived by matchedQty/inA
        const recv = usdcReceived * (matchedQty/inA);
        roundTrips.push({ mint: im, costUsdc: costBasisUsdc/1e6, proceedsUsdc: recv/1e6, ts: r.created_at, netUsdc: (recv-costBasisUsdc)/1e6 });
      }
    }
  }

  console.log(`=== Noah all-time confirmed legs: ${nLegs} ===`);
  console.log(`USDC spent (buys):    ${(usdcOut/1e6).toFixed(4)}`);
  console.log(`USDC received(sells): ${(usdcIn/1e6).toFixed(4)}`);
  console.log(`net USDC delta:       ${((usdcIn-usdcOut)/1e6).toFixed(4)}`);
  console.log(`SOL spent (lamports): ${solOut}  (${(solOut/1e9).toFixed(5)} SOL)`);
  console.log(`SOL recv  (lamports): ${solIn}   (${(solIn/1e9).toFixed(5)} SOL)`);
  console.log(`net SOL delta:        ${((solIn-solOut)/1e9).toFixed(6)} SOL`);
  console.log(`platform fee paid (USDC legs only): ~${(platformFeeUsdc/1e6).toFixed(4)} USDC`);

  console.log(`\n=== completed round trips: ${roundTrips.length} ===`);
  let wins=0, losses=0, grossWin=0, grossLoss=0, totNet=0;
  for (const rt of roundTrips){
    totNet += rt.netUsdc;
    if (rt.netUsdc>=0){ wins++; grossWin+=rt.netUsdc; } else { losses++; grossLoss+=rt.netUsdc; }
  }
  console.log(`wins: ${wins}  losses: ${losses}  win-rate: ${(100*wins/Math.max(1,roundTrips.length)).toFixed(1)}%`);
  console.log(`sum net (after platform fee, before gas): ${totNet.toFixed(4)} USDC`);
  console.log(`avg win: ${(grossWin/Math.max(1,wins)).toFixed(4)}  avg loss: ${(grossLoss/Math.max(1,losses)).toFixed(4)}`);

  console.log(`\n=== last 15 round trips (mint | cost | proceeds | net USDC) ===`);
  roundTrips.slice(-15).forEach(rt => console.log(`${rt.ts.toISOString()}  ${lbl(rt.mint)}  cost=${rt.costUsdc.toFixed(4)}  proc=${rt.proceedsUsdc.toFixed(4)}  net=${rt.netUsdc>=0?'+':''}${rt.netUsdc.toFixed(4)}`));

  // gas: count confirmed legs, estimate gas drag
  console.log(`\n=== gas drag estimate ===`);
  console.log(`confirmed legs: ${nLegs}. At ~5000 base + ~priority lamports/leg, gas is paid in SOL separately (NOT in quote amounts above).`);

  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
