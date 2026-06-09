require('dotenv').config();
const pg = require('pg');
const url = new URL(process.env.DATABASE_PRIVATE_URL.trim());
url.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: url.toString(), ssl: { rejectUnauthorized: false } });

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = 'So11111111111111111111111111111111111111112';
const isBase = (m) => m === USDC || m === SOL;
const avg = (a) => a.length ? a.reduce((p, c) => p + c, 0) / a.length : 0;

// causal exit: walk path; if hits +tp first -> take tp; if hits -stop first -> take -stop; else final
function causalTPSL(path, tp, stop) {
  for (const p of path) {
    if (p >= tp) return tp;
    if (p <= -stop) return -stop;
  }
  return path.length ? path[path.length - 1] : 0;
}

async function main() {
  const swaps = (await pool.query(`
    SELECT input_mint, output_mint, (build_response->>'priceImpactPct')::numeric*10000 AS i
    FROM swap_executions WHERE status='confirmed' AND created_at > now() - interval '72 hours'
      AND build_response->>'priceImpactPct' IS NOT NULL`)).rows;
  const sell = new Map(), buy = new Map();
  for (const r of swaps) {
    const s = !isBase(r.input_mint) && isBase(r.output_mint);
    const b = isBase(r.input_mint) && !isBase(r.output_mint);
    if (s) { const m=r.input_mint; if(!sell.has(m))sell.set(m,[]); sell.get(m).push(Number(r.i)); }
    if (b) { const m=r.output_mint; if(!buy.has(m))buy.set(m,[]); buy.get(m).push(Number(r.i)); }
  }
  const sellImp = (m) => sell.has(m) ? avg(sell.get(m)) : 40;
  const buyImp = (m) => buy.has(m) ? avg(buy.get(m)) : 5;

  const { rows } = await pool.query(`
    SELECT session_id, mint, evaluation->>'entryPriceUsd' AS k, pnl_bps
    FROM exit_shadow_decisions
    WHERE created_at > now() - interval '72 hours'
      AND evaluation->>'entryPriceUsd' IS NOT NULL AND pnl_bps IS NOT NULL
    ORDER BY session_id, mint, (evaluation->>'entryPriceUsd'), decided_at ASC`);
  const pos = new Map();
  for (const r of rows) { const key=`${r.session_id}|${r.mint}|${r.k}`; if(!pos.has(key))pos.set(key,{mint:r.mint,path:[]}); pos.get(key).path.push(Number(r.pnl_bps)); }
  const all = [...pos.values()];
  const deep = all.filter((p) => sellImp(p.mint) <= 8);
  const cost = (p) => buyImp(p.mint) + sellImp(p.mint);

  const sweep = (set, label) => {
    console.log(`\n=== ${label} (n=${set.length}) causal TP/SL sweep ===`);
    console.log('   tp   stop  grossAvg gWin%  netAvg nWin%  netTotal');
    for (const tp of [20, 30, 40, 50, 60, 80]) {
      for (const stop of [60, 90, 120]) {
        const gross = set.map((p) => causalTPSL(p.path, tp, stop));
        const net = set.map((p, i) => gross[i] - cost(p));
        const gw = 100*gross.filter(x=>x>0).length/set.length;
        const nw = 100*net.filter(x=>x>0).length/set.length;
        console.log(`  ${String(tp).padStart(3)}  ${String(stop).padStart(4)}  ${avg(gross).toFixed(1).padStart(7)}  ${gw.toFixed(0).padStart(3)}  ${avg(net).toFixed(1).padStart(6)}  ${nw.toFixed(0).padStart(3)}  ${net.reduce((a,b)=>a+b,0).toFixed(0).padStart(7)}`);
      }
    }
  };
  sweep(deep, 'DEEP tokens (sellImp<=8)');
  sweep(all, 'ALL tokens');
  await pool.end();
}
main().catch((e) => { console.error(e); pool.end(); process.exit(1); });
