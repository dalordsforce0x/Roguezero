/*
 * Final backtest: real per-symbol round-trip slippage (from confirmed swap price
 * impact, last 72h) applied to each position's real pnl path. Per-trade platform
 * fee REMOVED (new model). Identifies the exact net-profitable universe.
 */
require('dotenv').config();
const pg = require('pg');

const databaseUrl = process.env.DATABASE_PRIVATE_URL?.trim();
if (!databaseUrl) throw new Error('DATABASE_PRIVATE_URL is required');
const url = new URL(databaseUrl);
url.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: url.toString(), ssl: { rejectUnauthorized: false } });

// best exit from v2: hold to final mark with a -120 hard stop
function simulate(path, stop = 120) {
  for (const p of path) if (p <= -stop) return -stop;
  return path.length ? path[path.length - 1] : 0;
}

async function main() {
  // real per-mint round-trip slippage (avg leg impact * 2)
  const slipRows = (await pool.query(`
    WITH legs AS (
      SELECT CASE WHEN input_mint='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
                  THEN output_mint ELSE input_mint END AS mint,
             ((build_response->>'priceImpactPct')::numeric)*10000 AS impact
      FROM swap_executions
      WHERE status='confirmed' AND created_at > now() - interval '72 hours'
        AND build_response->>'priceImpactPct' IS NOT NULL
    )
    SELECT mint, avg(impact) AS avg_impact FROM legs GROUP BY mint
  `)).rows;
  const slipByMint = new Map(slipRows.map((r) => [r.mint, Number(r.avg_impact) * 2]));
  const slipFor = (mint) => slipByMint.get(mint) ?? 30; // unknown -> conservative 30

  const { rows } = await pool.query(`
    SELECT session_id, mint, symbol,
           evaluation->>'entryPriceUsd' AS k,
           evaluation->>'tokenClass'    AS cls,
           pnl_bps
    FROM exit_shadow_decisions
    WHERE created_at > now() - interval '72 hours'
      AND evaluation->>'entryPriceUsd' IS NOT NULL
      AND pnl_bps IS NOT NULL
    ORDER BY session_id, mint, (evaluation->>'entryPriceUsd'), decided_at ASC
  `);

  const positions = new Map();
  for (const r of rows) {
    const key = `${r.session_id}|${r.mint}|${r.k}`;
    if (!positions.has(key)) positions.set(key, { mint: r.mint, cls: r.cls, symbol: r.symbol, path: [] });
    positions.get(key).path.push(Number(r.pnl_bps));
  }
  const trusted = ['sol_beta', 'major', 'trend_liquid'];
  const all = [...positions.values()].filter((p) => trusted.includes(p.cls));

  // per-symbol net economics with REAL slippage
  const bySym = new Map();
  for (const p of all) {
    const sym = (p.symbol || '?').toUpperCase();
    const gross = simulate(p.path);
    const net = gross - slipFor(p.mint);
    if (!bySym.has(sym)) bySym.set(sym, { mint: p.mint, nets: [], grosses: [] });
    bySym.get(sym).nets.push(net);
    bySym.get(sym).grosses.push(gross);
  }

  console.log('symbol     n   avgGross  rtSlip  avgNet  win%   totalNet');
  const symStats = [];
  for (const [sym, d] of bySym) {
    const n = d.nets.length;
    const avgNet = d.nets.reduce((a, b) => a + b, 0) / n;
    const avgGross = d.grosses.reduce((a, b) => a + b, 0) / n;
    const wins = d.nets.filter((x) => x > 0).length;
    const total = d.nets.reduce((a, b) => a + b, 0);
    symStats.push({ sym, n, avgGross, rtSlip: slipFor(d.mint), avgNet, winPct: (100 * wins) / n, total });
  }
  symStats.sort((a, b) => b.avgNet - a.avgNet);
  for (const s of symStats) {
    console.log(
      `${s.sym.padEnd(9)} ${String(s.n).padStart(2)}  ${s.avgGross.toFixed(1).padStart(7)}  ${s.rtSlip.toFixed(1).padStart(5)}  ${s.avgNet.toFixed(1).padStart(6)}  ${s.winPct.toFixed(0).padStart(3)}%  ${s.total.toFixed(0).padStart(7)}`,
    );
  }

  // build profitable universe (avgNet > 0 AND n >= 3 for significance) and show portfolio result
  const profitable = new Set(symStats.filter((s) => s.avgNet > 0 && s.n >= 3).map((s) => s.sym));
  const portfolio = all.filter((p) => profitable.has((p.symbol || '?').toUpperCase()));
  const pnets = portfolio.map((p) => simulate(p.path) - slipFor(p.mint));
  const pAvg = pnets.reduce((a, b) => a + b, 0) / (pnets.length || 1);
  const pWin = pnets.filter((x) => x > 0).length;
  console.log(`\nPROFITABLE UNIVERSE (avgNet>0, n>=3): ${[...profitable].join(', ')}`);
  console.log(`  positions=${pnets.length}  avgNet=${pAvg.toFixed(1)}bps  win%=${((100 * pWin) / (pnets.length || 1)).toFixed(0)}  totalNet=${pnets.reduce((a, b) => a + b, 0).toFixed(0)}bps`);

  await pool.end();
}

main().catch((e) => { console.error(e); pool.end(); process.exit(1); });
