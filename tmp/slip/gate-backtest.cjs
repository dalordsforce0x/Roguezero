/*
 * Backtest: sell-impact entry gate.
 * Real pnl paths (exit_shadow_decisions) + ASYMMETRIC real cost per token
 * (buyImp + sellImp from confirmed swaps). Per-trade platform fee REMOVED.
 * Tests: keep only positions whose token sell-impact <= threshold. Find the
 * threshold that maximizes net expectancy without over-shrinking the book.
 */
require('dotenv').config();
const pg = require('pg');
const url = new URL(process.env.DATABASE_PRIVATE_URL.trim());
url.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: url.toString(), ssl: { rejectUnauthorized: false } });

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = 'So11111111111111111111111111111111111111112';
const isBase = (m) => m === USDC || m === SOL;

// best exit (from prior work): hold to final mark with -120 hard stop
function simulate(path, stop = 120) {
  for (const p of path) if (p <= -stop) return -stop;
  return path.length ? path[path.length - 1] : 0;
}
const avg = (a) => a.length ? a.reduce((p, c) => p + c, 0) / a.length : 0;

async function main() {
  // per-mint buy & sell impact (bps), from confirmed swaps
  const swaps = (await pool.query(`
    SELECT input_mint, output_mint,
           (build_response->>'priceImpactPct')::numeric*10000 AS impact_bps
    FROM swap_executions
    WHERE status='confirmed' AND created_at > now() - interval '72 hours'
      AND build_response->>'priceImpactPct' IS NOT NULL
  `)).rows;
  const buy = new Map(), sell = new Map();
  for (const r of swaps) {
    const b = isBase(r.input_mint) && !isBase(r.output_mint);
    const s = !isBase(r.input_mint) && isBase(r.output_mint);
    const mint = b ? r.output_mint : s ? r.input_mint : null;
    if (!mint) continue;
    const m = b ? buy : sell;
    if (!m.has(mint)) m.set(mint, []);
    m.get(mint).push(Number(r.impact_bps));
  }
  const buyImp = (m) => buy.has(m) ? avg(buy.get(m)) : 5;
  const sellImp = (m) => sell.has(m) ? avg(sell.get(m)) : 40; // unknown => assume costly

  // real pnl paths
  const { rows } = await pool.query(`
    SELECT session_id, mint, symbol,
           evaluation->>'entryPriceUsd' AS k, pnl_bps
    FROM exit_shadow_decisions
    WHERE created_at > now() - interval '72 hours'
      AND evaluation->>'entryPriceUsd' IS NOT NULL AND pnl_bps IS NOT NULL
    ORDER BY session_id, mint, (evaluation->>'entryPriceUsd'), decided_at ASC
  `);
  const pos = new Map();
  for (const r of rows) {
    const key = `${r.session_id}|${r.mint}|${r.k}`;
    if (!pos.has(key)) pos.set(key, { mint: r.mint, symbol: r.symbol, path: [] });
    pos.get(key).path.push(Number(r.pnl_bps));
  }
  const all = [...pos.values()];

  const evalUniverse = (keep) => {
    const sel = all.filter((p) => keep(p.mint));
    const nets = sel.map((p) => simulate(p.path) - buyImp(p.mint) - sellImp(p.mint));
    const total = nets.reduce((a, b) => a + b, 0);
    const wins = nets.filter((x) => x > 0).length;
    return { n: nets.length, avgNet: avg(nets), winPct: nets.length ? 100 * wins / nets.length : 0, total };
  };

  console.log('=== Baseline (trade everything, asymmetric real cost) ===');
  const base = evalUniverse(() => true);
  console.log(`  n=${base.n} avgNet=${base.avgNet.toFixed(1)}bps win%=${base.winPct.toFixed(0)} total=${base.total.toFixed(0)}bps`);

  console.log('\n=== Sell-impact entry gate (block mint if sellImp > T) ===');
  console.log('  T(bps)  kept  avgNet  win%   totalNet');
  for (const T of [60, 40, 30, 20, 15, 12, 10, 8, 6]) {
    const r = evalUniverse((m) => sellImp(m) <= T);
    console.log(`  ${String(T).padStart(5)}  ${String(r.n).padStart(4)}  ${r.avgNet.toFixed(1).padStart(6)}  ${r.winPct.toFixed(0).padStart(3)}%  ${r.total.toFixed(0).padStart(8)}`);
  }

  // round-trip cost gate (buy+sell <= T) as alternative
  console.log('\n=== Round-trip cost gate (block if buyImp+sellImp > T) ===');
  console.log('  T(bps)  kept  avgNet  win%   totalNet');
  for (const T of [60, 40, 30, 20, 15, 12, 10]) {
    const r = evalUniverse((m) => (buyImp(m) + sellImp(m)) <= T);
    console.log(`  ${String(T).padStart(5)}  ${String(r.n).padStart(4)}  ${r.avgNet.toFixed(1).padStart(6)}  ${r.winPct.toFixed(0).padStart(3)}%  ${r.total.toFixed(0).padStart(8)}`);
  }

  await pool.end();
}
main().catch((e) => { console.error(e); pool.end(); process.exit(1); });
