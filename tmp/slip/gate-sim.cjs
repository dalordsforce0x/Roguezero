/*
 * Backtest the EXACT entry gate we intend to ship:
 *   block entry if |signalMomentumBps| <= (buyImpact + perTokenSellImpact + safetyBuffer)
 * Compare forward returns of ALLOWED vs BLOCKED entries. The gate is only worth
 * shipping if BLOCKED entries have materially worse forward returns than ALLOWED.
 */
require('dotenv').config();
const pg = require('pg');
const url = new URL(process.env.DATABASE_PRIVATE_URL.trim());
url.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: url.toString(), ssl: { rejectUnauthorized: false } });

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = 'So11111111111111111111111111111111111111112';
const isBase = (m) => m === USDC || m === SOL;
const avg = (a) => a.length ? a.reduce((p, c) => p + c, 0) / a.length : 0;
function forwardFinal(path, stop = 120) { for (const p of path) if (p <= -stop) return -stop; return path.length ? path[path.length - 1] : 0; }

async function main() {
  const swaps = (await pool.query(`
    SELECT input_mint, output_mint, (build_response->>'priceImpactPct')::numeric*10000 AS i
    FROM swap_executions WHERE status='confirmed' AND created_at > now() - interval '7 days'
      AND build_response->>'priceImpactPct' IS NOT NULL`)).rows;
  const sell = new Map(), buy = new Map();
  for (const r of swaps) {
    const s = !isBase(r.input_mint) && isBase(r.output_mint);
    const b = isBase(r.input_mint) && !isBase(r.output_mint);
    if (s) { const m=r.input_mint; if(!sell.has(m))sell.set(m,[]); sell.get(m).push(Number(r.i)); }
    if (b) { const m=r.output_mint; if(!buy.has(m))buy.set(m,[]); buy.get(m).push(Number(r.i)); }
  }
  const sellImp = (m) => sell.has(m) ? avg(sell.get(m)) : null;
  const buyImp = (m) => buy.has(m) ? avg(buy.get(m)) : 5;

  const { rows } = await pool.query(`
    SELECT session_id, mint, symbol, evaluation->>'entryPriceUsd' AS k,
           evaluation->>'signalMomentumBps' AS mom, evaluation->>'strategy' AS strat, pnl_bps
    FROM exit_shadow_decisions
    WHERE created_at > now() - interval '7 days'
      AND evaluation->>'entryPriceUsd' IS NOT NULL AND pnl_bps IS NOT NULL
    ORDER BY session_id, mint, (evaluation->>'entryPriceUsd'), decided_at ASC`);
  const pos = new Map();
  for (const r of rows) { const key=`${r.session_id}|${r.mint}|${r.k}`; if(!pos.has(key))pos.set(key,{e:r,path:[]}); pos.get(key).path.push(Number(r.pnl_bps)); }
  const all = [...pos.values()].map((p) => ({
    mint: p.e.mint, sym: p.e.symbol,
    mom: p.e.mom != null ? Math.abs(Number(p.e.mom)) : null,
    strat: p.e.strat, fwd: forwardFinal(p.path),
  })).filter((p) => p.mom != null);

  console.log(`entries with momentum: ${all.length}\n`);

  // momentum distribution
  const moms = all.map(p => p.mom).sort((a,b)=>a-b);
  const q=(p)=>moms[Math.floor(p*(moms.length-1))];
  console.log(`|momentumBps| dist: min=${moms[0].toFixed(0)} p25=${q(.25).toFixed(0)} med=${q(.5).toFixed(0)} p75=${q(.75).toFixed(0)} max=${moms[moms.length-1].toFixed(0)}`);
  const sis = all.map(p => sellImp(p.mint)).filter(x=>x!=null).sort((a,b)=>a-b);
  console.log(`perTokenSellImpact dist: p25=${sis[Math.floor(.25*sis.length)].toFixed(0)} med=${sis[Math.floor(.5*sis.length)].toFixed(0)} p75=${sis[Math.floor(.75*sis.length)].toFixed(0)} max=${sis[sis.length-1].toFixed(0)}\n`);

  for (const buffer of [0, 5, 10]) {
    console.log(`=== safetyBuffer=${buffer} ===`);
    const allowed = [], blocked = [];
    for (const p of all) {
      const si = sellImp(p.mint);
      const cost = buyImp(p.mint) + (si == null ? 40 : si) + buffer; // unknown sell => assume costly
      (p.mom > cost ? allowed : blocked).push(p);
    }
    const fa = allowed.map(p=>p.fwd), fb = blocked.map(p=>p.fwd);
    console.log(`  ALLOWED n=${allowed.length} fwdAvg=${avg(fa).toFixed(1)}bps win%=${(100*fa.filter(x=>x>0).length/(fa.length||1)).toFixed(0)} total=${fa.reduce((a,b)=>a+b,0).toFixed(0)}`);
    console.log(`  BLOCKED n=${blocked.length} fwdAvg=${avg(fb).toFixed(1)}bps win%=${(100*fb.filter(x=>x>0).length/(fb.length||1)).toFixed(0)} total=${fb.reduce((a,b)=>a+b,0).toFixed(0)}`);
    // net of allowed after round-trip cost
    const net = allowed.map(p => p.fwd - buyImp(p.mint) - (sellImp(p.mint) ?? 40));
    console.log(`  ALLOWED net (after real RT cost): avg=${avg(net).toFixed(1)}bps total=${net.reduce((a,b)=>a+b,0).toFixed(0)}\n`);
  }
  await pool.end();
}
main().catch((e) => { console.error(e); pool.end(); process.exit(1); });
