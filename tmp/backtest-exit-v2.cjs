/*
 * Comprehensive path-based backtest. Goal: find ANY configuration that is net
 * profitable after real slippage (per-trade platform fee REMOVED per new model),
 * or prove none exists for this strategy/universe.
 *
 * Tests, on the real ordered pnl_bps path per position:
 *   - exit policies: hold-to-final, hard-stop variants, trailing lock-in, no-stop trailing
 *   - universe filters: all trusted classes vs only proven-positive symbols
 */
require('dotenv').config();
const pg = require('pg');

const SLIP_BPS = 15;
const databaseUrl = process.env.DATABASE_PRIVATE_URL?.trim();
if (!databaseUrl) throw new Error('DATABASE_PRIVATE_URL is required');
const url = new URL(databaseUrl);
url.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: url.toString(), ssl: { rejectUnauthorized: false } });

// policy: { trigger, giveback, stop }  stop=null => no hard stop
function simulate(path, { trigger, giveback, stop }) {
  let peak = -Infinity;
  for (const p of path) {
    if (stop != null && p <= -stop) return -stop;
    if (p > peak) peak = p;
    if (trigger != null && peak >= trigger && (peak - p) >= giveback) return p;
  }
  return path.length ? path[path.length - 1] : 0;
}

function stats(nets) {
  const n = nets.length;
  const avg = nets.reduce((a, b) => a + b, 0) / n;
  const wins = nets.filter((x) => x > 0).length;
  const total = nets.reduce((a, b) => a + b, 0);
  return { n, avg, winPct: (100 * wins) / n, total };
}

async function main() {
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
    if (!positions.has(key)) positions.set(key, { cls: r.cls, symbol: r.symbol, path: [] });
    positions.get(key).path.push(Number(r.pnl_bps));
  }
  const trusted = ['sol_beta', 'major', 'trend_liquid'];
  const all = [...positions.values()].filter((p) => trusted.includes(p.cls));

  // proven-positive symbols from per-symbol expectancy
  const provenPos = new Set(['JTO', 'JUP', 'POPCAT', 'HNT', 'WBTC']);
  const filtered = all.filter((p) => provenPos.has((p.symbol || '').toUpperCase()));

  const policies = [
    { name: 'hold-to-final (no stop)', trigger: null, giveback: 0, stop: null },
    { name: 'final + stop120', trigger: null, giveback: 0, stop: 120 },
    { name: 'trail50/10 + stop120', trigger: 50, giveback: 10, stop: 120 },
    { name: 'trail50/10 no-stop', trigger: 50, giveback: 10, stop: null },
    { name: 'trail40/15 no-stop', trigger: 40, giveback: 15, stop: null },
    { name: 'trail30/10 no-stop', trigger: 30, giveback: 10, stop: null },
    { name: 'trail60/15 no-stop', trigger: 60, giveback: 15, stop: null },
    { name: 'trail80/20 no-stop', trigger: 80, giveback: 20, stop: null },
    { name: 'trail100/25 no-stop', trigger: 100, giveback: 25, stop: null },
  ];

  const runSet = (label, set) => {
    console.log(`\n=== ${label} (n=${set.length}) ===`);
    console.log('policy                       | avgNet  win%  totalBps');
    const out = [];
    for (const pol of policies) {
      const nets = set.map((p) => simulate(p.path, pol) - SLIP_BPS);
      const s = stats(nets);
      out.push({ pol: pol.name, ...s });
    }
    out.sort((a, b) => b.avg - a.avg);
    for (const r of out) {
      console.log(`${r.pol.padEnd(28)} | ${r.avg.toFixed(1).padStart(6)} ${r.winPct.toFixed(0).padStart(4)}% ${r.total.toFixed(0).padStart(8)}`);
    }
  };

  runSet('ALL TRUSTED CLASSES', all);
  runSet('PROVEN-POSITIVE SYMBOLS ONLY (JTO/JUP/POPCAT/HNT/WBTC)', filtered);

  await pool.end();
}

main().catch((e) => { console.error(e); pool.end(); process.exit(1); });
