require('dotenv').config();
const pg = require('pg');
const u = new URL(process.env.DATABASE_PRIVATE_URL.trim());
u.searchParams.delete('sslmode');
const p = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const DAY = '2026-06-09T00:00:00Z';
const NOAH = 'edd46e65-b21d-4d99-911d-99842d62b428';
(async () => {
  // For closed positions that ended in a LOSS, where did they PEAK (mfe)?
  // If a floor had been <= their peak, a take-profit could have banked a win.
  const r = await p.query(
    `with pos as (
       select evaluation->>'entryPriceUsd' entry, token_class,
              (array_agg(pnl_bps order by created_at desc))[1] final_pnl,
              max(max_favorable_bps) mfe
       from exit_shadow_decisions
       where created_at >= $1 and session_id=$2 and current_should_exit=true
         and evaluation->>'entryPriceUsd' is not null and pnl_bps is not null
       group by entry, token_class)
     select * from pos`,
    [DAY, NOAH]);
  const all = r.rows.map(x => ({ tc: x.token_class, pnl: Number(x.final_pnl), mfe: Number(x.mfe) }));
  const losers = all.filter(x => x.pnl <= 0);
  console.log(`Total closed: ${all.length}, losers: ${losers.length}`);

  // For each candidate floor, how many losers peaked >= floor (could have banked instead)?
  console.log('\nIf take-profit floor = X, how many of the ' + losers.length + ' losers peaked high enough to bank +X instead of losing?');
  console.log('floor   losersSavable   bankedBps(if all taken)   netSwing');
  for (const F of [40,50,60,70,80,90,100,120]) {
    const savable = losers.filter(x => x.mfe >= F);
    const lostNow = savable.reduce((s,x)=>s+x.pnl,0);       // what they actually lost
    const bankedInstead = savable.length * F;                 // what +F would bank
    const swing = bankedInstead - lostNow;                    // improvement
    console.log(`  ${String(F).padStart(3)}    ${String(savable.length).padStart(3)}/${losers.length}        +${String(bankedInstead).padStart(5)}              ${swing>=0?'+':''}${swing} bps`);
  }

  // mfe distribution of losers
  const mfes = losers.map(x=>x.mfe).sort((a,b)=>a-b);
  const q = (p)=> mfes[Math.floor(mfes.length*p)];
  console.log(`\nLoser peak(mfe) distribution: min=${mfes[0]} p25=${q(0.25)} p50=${q(0.5)} p75=${q(0.75)} max=${mfes[mfes.length-1]}`);
  await p.end();
})().catch(e => { console.error(e.message); process.exit(1); });
