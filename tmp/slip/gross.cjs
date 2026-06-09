require('dotenv').config();
const pg = require('pg');
const url = new URL(process.env.DATABASE_PRIVATE_URL.trim());
url.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: url.toString(), ssl: { rejectUnauthorized: false } });

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = 'So11111111111111111111111111111111111111112';
const isBase = (m) => m === USDC || m === SOL;
const avg = (a) => a.length ? a.reduce((p, c) => p + c, 0) / a.length : 0;

// exit variants to test whether ANY exit makes gross positive
function holdFinal(path, stop) { for (const p of path) if (p <= -stop) return -stop; return path.length ? path[path.length - 1] : 0; }
function maxFav(path) { return path.length ? Math.max(...path) : 0; } // perfect exit ceiling
function firstMark(path) { return path.length ? path[0] : 0; }

async function main() {
  const swaps = (await pool.query(`
    SELECT input_mint, output_mint, (build_response->>'priceImpactPct')::numeric*10000 AS i
    FROM swap_executions WHERE status='confirmed' AND created_at > now() - interval '72 hours'
      AND build_response->>'priceImpactPct' IS NOT NULL`)).rows;
  const sell = new Map();
  for (const r of swaps) { const s = !isBase(r.input_mint) && isBase(r.output_mint); if (!s) continue; const m = r.input_mint; if (!sell.has(m)) sell.set(m, []); sell.get(m).push(Number(r.i)); }
  const sellImp = (m) => sell.has(m) ? avg(sell.get(m)) : 40;

  const { rows } = await pool.query(`
    SELECT session_id, mint, symbol, evaluation->>'entryPriceUsd' AS k, pnl_bps
    FROM exit_shadow_decisions
    WHERE created_at > now() - interval '72 hours'
      AND evaluation->>'entryPriceUsd' IS NOT NULL AND pnl_bps IS NOT NULL
    ORDER BY session_id, mint, (evaluation->>'entryPriceUsd'), decided_at ASC`);
  const pos = new Map();
  for (const r of rows) { const key = `${r.session_id}|${r.mint}|${r.k}`; if (!pos.has(key)) pos.set(key, { mint: r.mint, path: [] }); pos.get(key).path.push(Number(r.pnl_bps)); }
  const all = [...pos.values()];
  const deep = all.filter((p) => sellImp(p.mint) <= 8); // cheapest-to-exit universe

  const report = (label, set) => {
    const grossHF = set.map((p) => holdFinal(p.path, 120));
    const grossMax = set.map((p) => maxFav(p.path));
    const grossFirst = set.map((p) => firstMark(p.path));
    console.log(`${label} (n=${set.length}):`);
    console.log(`   GROSS hold-final/-120 stop: avg=${avg(grossHF).toFixed(1)}bps win%=${(100*grossHF.filter(x=>x>0).length/set.length).toFixed(0)}`);
    console.log(`   GROSS first-mark:           avg=${avg(grossFirst).toFixed(1)}bps win%=${(100*grossFirst.filter(x=>x>0).length/set.length).toFixed(0)}`);
    console.log(`   GROSS perfect-exit ceiling: avg=${avg(grossMax).toFixed(1)}bps  (max-favorable, unachievable upper bound)`);
  };
  report('ALL tokens', all);
  console.log('');
  report('DEEP tokens (sellImp<=8: JUP/WBTC/mSOL/RAY/Bonk/KMNO...)', deep);

  await pool.end();
}
main().catch((e) => { console.error(e); pool.end(); process.exit(1); });
