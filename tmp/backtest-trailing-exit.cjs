/*
 * Path-based trailing-exit backtest over real shadow-decision trajectories.
 *
 * For each closed position (session_id, mint, entryPriceUsd) we pull the ORDERED
 * series of pnl_bps marks across its life, then simulate exit policies on the real
 * path (not a max-favorable approximation):
 *
 *   - trailing lock-in: once peak pnl >= trigger, exit when pnl gives back >= giveback from peak
 *   - hard stop: exit if pnl <= -stop
 *   - else: exit at last observed mark (final)
 *
 * Cost model reflects the NEW fee policy: per-trade platform fee REMOVED.
 * Only round-trip slippage is charged per trade (SLIP_BPS). The 0.33% session
 * performance fee is applied once at the end on net session profit.
 */
require('dotenv').config();
const pg = require('pg');

const SLIP_BPS = 15;                 // measured round-trip slippage (entry+exit price impact)
const SESSION_PERF_FEE_PCT = 0.33;   // charged once at session end on positive net profit
const TRUSTED_CLASSES = ['sol_beta', 'major', 'trend_liquid'];

const databaseUrl = process.env.DATABASE_PRIVATE_URL?.trim();
if (!databaseUrl) throw new Error('DATABASE_PRIVATE_URL is required');
const url = new URL(databaseUrl);
url.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: url.toString(), ssl: { rejectUnauthorized: false } });

function simulate(path, { trigger, giveback, stop }) {
  // path: ordered array of pnl_bps marks
  let peak = -Infinity;
  for (const p of path) {
    if (p <= -stop) return -stop;            // hard stop hit
    if (p > peak) peak = p;
    if (peak >= trigger && (peak - p) >= giveback) {
      return p;                              // trailing lock-in fires at current mark
    }
  }
  return path.length ? path[path.length - 1] : 0; // no trigger -> final mark
}

async function main() {
  const { rows } = await pool.query(`
    SELECT session_id, mint,
           evaluation->>'entryPriceUsd' AS k,
           evaluation->>'tokenClass'    AS cls,
           pnl_bps,
           decided_at
    FROM exit_shadow_decisions
    WHERE created_at > now() - interval '72 hours'
      AND evaluation->>'entryPriceUsd' IS NOT NULL
      AND pnl_bps IS NOT NULL
    ORDER BY session_id, mint, (evaluation->>'entryPriceUsd'), decided_at ASC
  `);

  // group into positions
  const positions = new Map();
  for (const r of rows) {
    const key = `${r.session_id}|${r.mint}|${r.k}`;
    if (!positions.has(key)) positions.set(key, { cls: r.cls, path: [] });
    positions.get(key).path.push(Number(r.pnl_bps));
  }

  const all = [...positions.values()].filter((p) => TRUSTED_CLASSES.includes(p.cls));
  console.log(`positions (trusted classes): ${all.length}`);

  // baseline = current behavior (exit at final mark), cost = slippage only (fee removed)
  const baseNets = all.map((p) => (p.path[p.path.length - 1] ?? 0) - SLIP_BPS);
  report('BASELINE (final mark, fee removed)', baseNets);

  const triggers = [25, 30, 40, 50, 60];
  const givebacks = [10, 15, 20, 25];
  const stops = [60, 75, 90, 120];

  const results = [];
  for (const trigger of triggers) {
    for (const giveback of givebacks) {
      for (const stop of stops) {
        const nets = all.map((p) => simulate(p.path, { trigger, giveback, stop }) - SLIP_BPS);
        const avg = nets.reduce((a, b) => a + b, 0) / nets.length;
        const wins = nets.filter((n) => n > 0).length;
        results.push({ trigger, giveback, stop, avg, winPct: (100 * wins) / nets.length, nets });
      }
    }
  }
  results.sort((a, b) => b.avg - a.avg);
  console.log('\nTOP 8 CONFIGS (by avg net bps/trade, slippage-only cost):');
  console.log('trigger giveback stop |  avgNet  win%');
  for (const r of results.slice(0, 8)) {
    console.log(
      `  ${String(r.trigger).padStart(3)}    ${String(r.giveback).padStart(3)}    ${String(r.stop).padStart(3)} | ${r.avg.toFixed(1).padStart(6)}  ${r.winPct.toFixed(0)}%`,
    );
  }

  // session-level performance-fee impact on the best config
  const best = results[0];
  const grossSessionProfit = best.nets.reduce((a, b) => a + b, 0); // sum bps across all trades (proxy)
  const perfFee = grossSessionProfit > 0 ? grossSessionProfit * (SESSION_PERF_FEE_PCT / 100) : 0;
  console.log(`\nBest config: trigger=${best.trigger} giveback=${best.giveback} stop=${best.stop}`);
  console.log(`  avg net/trade (slippage only): ${best.avg.toFixed(1)} bps`);
  console.log(`  sum across ${best.nets.length} trades: ${grossSessionProfit.toFixed(0)} bps`);
  console.log(`  0.33% session perf fee on that: ${perfFee.toFixed(2)} bps total (negligible per-trade)`);

  await pool.end();
}

function report(label, nets) {
  const avg = nets.reduce((a, b) => a + b, 0) / nets.length;
  const wins = nets.filter((n) => n > 0).length;
  console.log(`${label}: n=${nets.length} avgNet=${avg.toFixed(1)}bps win%=${((100 * wins) / nets.length).toFixed(0)}`);
}

main().catch((e) => { console.error(e); pool.end(); process.exit(1); });
