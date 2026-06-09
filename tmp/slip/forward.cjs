/*
 * Forward-return predictiveness of ENTRY-time features.
 * For each position (session|mint|entryPrice), take the FIRST observation's
 * entry features and measure the FORWARD outcome (causal: reaches +20 before
 * -60 => win; final pnl bps). Group by feature buckets. If winners and losers
 * are indistinguishable at entry, the signal has no edge.
 */
require('dotenv').config();
const pg = require('pg');
const url = new URL(process.env.DATABASE_PRIVATE_URL.trim());
url.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: url.toString(), ssl: { rejectUnauthorized: false } });
const avg = (a) => a.length ? a.reduce((p, c) => p + c, 0) / a.length : 0;

function forwardFinal(path, stop = 120) { for (const p of path) if (p <= -stop) return -stop; return path.length ? path[path.length - 1] : 0; }

async function main() {
  const { rows } = await pool.query(`
    SELECT session_id, mint, symbol,
           evaluation->>'entryPriceUsd'      AS k,
           evaluation->>'signalMomentumBps'  AS mom,
           evaluation->>'signalRegime'       AS regime,
           evaluation->>'signalStatus'       AS status,
           evaluation->>'tokenClass'         AS cls,
           evaluation->>'strategy'           AS strat,
           pnl_bps, decided_at
    FROM exit_shadow_decisions
    WHERE created_at > now() - interval '7 days'
      AND evaluation->>'entryPriceUsd' IS NOT NULL AND pnl_bps IS NOT NULL
    ORDER BY session_id, mint, (evaluation->>'entryPriceUsd'), decided_at ASC`);

  const pos = new Map();
  for (const r of rows) {
    const key = `${r.session_id}|${r.mint}|${r.k}`;
    if (!pos.has(key)) pos.set(key, { entry: r, path: [] });
    pos.get(key).path.push(Number(r.pnl_bps));
  }
  const all = [...pos.values()].map((p) => ({
    mom: p.entry.mom != null ? Number(p.entry.mom) : null,
    regime: p.entry.regime, status: p.entry.status, cls: p.entry.cls, strat: p.entry.strat,
    fwd: forwardFinal(p.path),
  }));
  console.log(`positions: ${all.length} (7d)\n`);

  const bucketReport = (name, keyFn) => {
    const g = new Map();
    for (const p of all) { const k = keyFn(p); if (k == null) continue; if (!g.has(k)) g.set(k, []); g.get(k).push(p.fwd); }
    console.log(`-- forward return by ${name} --`);
    const entries = [...g.entries()].sort((a, b) => avg(b[1]) - avg(a[1]));
    for (const [k, v] of entries) {
      const win = 100 * v.filter((x) => x > 0).length / v.length;
      console.log(`   ${String(k).padEnd(16)} n=${String(v.length).padStart(3)}  fwdAvg=${avg(v).toFixed(1).padStart(6)}bps  win%=${win.toFixed(0)}`);
    }
    console.log('');
  };

  // momentum quantile buckets
  const moms = all.filter((p) => p.mom != null).map((p) => p.mom).sort((a, b) => a - b);
  if (moms.length) {
    const q = (p) => moms[Math.floor(p * (moms.length - 1))];
    const edges = [q(0.2), q(0.4), q(0.6), q(0.8)];
    const lab = (m) => m <= edges[0] ? '1.momLow' : m <= edges[1] ? '2.mom-' : m <= edges[2] ? '3.momMid' : m <= edges[3] ? '4.mom+' : '5.momHigh';
    bucketReport('entry momentum quintile', (p) => p.mom != null ? lab(p.mom) : null);
  }
  bucketReport('entry signalRegime', (p) => p.regime);
  bucketReport('entry signalStatus', (p) => p.status);
  bucketReport('tokenClass', (p) => p.cls);
  bucketReport('strategy', (p) => p.strat);

  // correlation: entry momentum vs forward return
  const pm = all.filter((p) => p.mom != null);
  if (pm.length > 5) {
    const mx = avg(pm.map((p) => p.mom)), my = avg(pm.map((p) => p.fwd));
    let num = 0, dx = 0, dy = 0;
    for (const p of pm) { num += (p.mom - mx) * (p.fwd - my); dx += (p.mom - mx) ** 2; dy += (p.fwd - my) ** 2; }
    const corr = num / (Math.sqrt(dx * dy) || 1);
    console.log(`corr(entry momentum, forward return) = ${corr.toFixed(3)}  (n=${pm.length})  [~0 => no predictive power]`);
  }
  await pool.end();
}
main().catch((e) => { console.error(e); pool.end(); process.exit(1); });
