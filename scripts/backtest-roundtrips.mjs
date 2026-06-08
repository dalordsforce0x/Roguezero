#!/usr/bin/env node
// Backtest: realized round-trip returns from confirmed swap_executions.
//
// We never persisted the pre-entry price tape, so we cannot exactly replay the
// entry-quality SHAPE score historically. But we DO have, for every confirmed
// trade over the last ~4 days: entry price (USDC in / tokens out), exit price
// (USDC out / tokens in), entry priceImpact, strategy, and timing. That is enough
// to measure the REAL outcome distribution and correlate it with the entry
// features we actually have — no waiting on the shadow pipeline.
//
// Method:
//   - entry  = confirmed USDC -> token  (lot: qtyAtomic tokens at entryPrice)
//   - exit   = confirmed token -> USDC  (consumes open lots FIFO per taker+mint)
//   - price is decimals-free: USDC_atomic / token_atomic (decimals cancel in the
//     return ratio since both legs use the same atomic token unit).
//   - realized return bps = (exitPrice / entryPrice - 1) * 10000
//
// Usage: node scripts/backtest-roundtrips.mjs [--taker <pubkey>] [--since <iso>]

import pg from 'pg';
import 'dotenv/config';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const filterTaker = getArg('--taker');
const since = getArg('--since');

const databaseUrl = process.env.DATABASE_PRIVATE_URL?.trim();
if (!databaseUrl) {
  console.error('DATABASE_PRIVATE_URL is required');
  process.exit(1);
}
const connectionString = databaseUrl.replace('sslmode=require', 'uselibpqcompat=true&sslmode=require');

const pool = new pg.Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 60000,
  query_timeout: 60000,
});

const num = (v) => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const pct = (a, b) => (b > 0 ? (100 * a / b).toFixed(1) + '%' : 'n/a');

const quantiles = (sorted, qs) => qs.map((q) => {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[idx];
});

async function main() {
  const params = [];
  let where = "status = 'confirmed' AND (input_mint = $1 OR output_mint = $1)";
  params.push(USDC);
  if (filterTaker) { params.push(filterTaker); where += ` AND taker = $${params.length}`; }
  if (since) { params.push(since); where += ` AND confirmed_at >= $${params.length}`; }

  const { rows } = await pool.query(
    `SELECT id, taker, input_mint, output_mint, confirmed_at,
            build_response->>'inAmount'  AS in_amt,
            build_response->>'outAmount' AS out_amt,
            build_response->>'priceImpactPct' AS impact_pct,
            metadata->>'entryStrategy' AS entry_strategy,
            metadata->>'exitReason'   AS exit_reason
       FROM swap_executions
      WHERE ${where}
      ORDER BY confirmed_at ASC`,
    params,
  );

  // Open lots keyed by taker:mint -> FIFO queue of { qty, entryPrice, time, impactBps, strategy }
  const lots = new Map();
  const trips = [];
  let skippedEntries = 0;
  let unmatchedExits = 0;

  for (const r of rows) {
    const inAmt = num(r.in_amt);
    const outAmt = num(r.out_amt);
    if (inAmt === null || outAmt === null || inAmt <= 0 || outAmt <= 0) { continue; }

    if (r.input_mint === USDC && r.output_mint !== USDC) {
      // ENTRY: USDC -> token. entryPrice = usdcAtomic / tokenAtomic
      const key = `${r.taker}:${r.output_mint}`;
      const entryPrice = inAmt / outAmt;
      const impactBps = r.impact_pct !== null ? Math.round(Number(r.impact_pct) * 10000) : null;
      if (!lots.has(key)) lots.set(key, []);
      lots.get(key).push({
        qty: outAmt,
        entryPrice,
        time: new Date(r.confirmed_at).getTime(),
        impactBps,
        strategy: r.entry_strategy || 'unknown',
        mint: r.output_mint,
      });
    } else if (r.output_mint === USDC && r.input_mint !== USDC) {
      // EXIT: token -> USDC. exitPrice = usdcAtomic / tokenAtomic
      const key = `${r.taker}:${r.input_mint}`;
      const exitPrice = outAmt / inAmt;
      let remaining = inAmt;
      const queue = lots.get(key);
      if (!queue || queue.length === 0) { unmatchedExits += 1; continue; }
      const exitTime = new Date(r.confirmed_at).getTime();
      while (remaining > 0 && queue.length > 0) {
        const lot = queue[0];
        const matched = Math.min(remaining, lot.qty);
        const retBps = Math.round((exitPrice / lot.entryPrice - 1) * 10000);
        const holdMin = (exitTime - lot.time) / 60000;
        const costUsdc = matched * lot.entryPrice;       // USDC atomic
        const pnlUsdc = matched * (exitPrice - lot.entryPrice); // USDC atomic
        trips.push({
          taker: r.taker,
          mint: lot.mint,
          retBps,
          holdMin,
          impactBps: lot.impactBps,
          strategy: lot.strategy,
          exitReason: r.exit_reason || 'unknown',
          costUsd: costUsdc / 1e6,
          pnlUsd: pnlUsdc / 1e6,
        });
        lot.qty -= matched;
        remaining -= matched;
        if (lot.qty <= lot.qty * 1e-9) queue.shift();
      }
    }
  }

  // Leftover open lots (still holding) — count them
  let openLots = 0;
  for (const q of lots.values()) openLots += q.length;

  if (trips.length === 0) {
    console.log('No completed round-trips found.');
    await pool.end();
    return;
  }

  const rets = trips.map((t) => t.retBps).sort((a, b) => a - b);
  const wins = trips.filter((t) => t.retBps > 0).length;
  const totalPnl = trips.reduce((s, t) => s + t.pnlUsd, 0);
  const totalCost = trips.reduce((s, t) => s + t.costUsd, 0);
  const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
  const [p10, p25, p50, p75, p90] = quantiles(rets, [0.1, 0.25, 0.5, 0.75, 0.9]);

  console.log('='.repeat(70));
  console.log(`ROUND-TRIP BACKTEST  (USDC-quoted, FIFO)`);
  console.log(`source rows: ${rows.length} confirmed USDC legs` + (filterTaker ? `  taker=${filterTaker}` : '') + (since ? `  since=${since}` : ''));
  console.log('='.repeat(70));
  console.log(`completed round-trips : ${trips.length}`);
  console.log(`still-open lots        : ${openLots}`);
  console.log(`unmatched exits        : ${unmatchedExits}`);
  console.log('-'.repeat(70));
  console.log(`win rate               : ${pct(wins, trips.length)}  (${wins}/${trips.length})`);
  console.log(`mean return            : ${mean.toFixed(1)} bps`);
  console.log(`median (p50)           : ${p50} bps`);
  console.log(`p10 / p25 / p75 / p90  : ${p10} / ${p25} / ${p75} / ${p90} bps`);
  console.log(`realized PnL (sum)     : $${totalPnl.toFixed(4)}  on $${totalCost.toFixed(2)} deployed  (${(10000*totalPnl/totalCost).toFixed(1)} bps net)`);
  console.log('NOTE: returns are GROSS of the 35bps platform fee + gas. Honest break-even ~50bps.');

  // Break down by entry strategy
  console.log('-'.repeat(70));
  console.log('BY ENTRY STRATEGY:');
  const byStrat = {};
  for (const t of trips) {
    (byStrat[t.strategy] ??= []).push(t);
  }
  for (const [s, ts] of Object.entries(byStrat).sort((a, b) => b[1].length - a[1].length)) {
    const r = ts.map((x) => x.retBps).sort((a, b) => a - b);
    const m = r.reduce((x, y) => x + y, 0) / r.length;
    const w = ts.filter((x) => x.retBps > 0).length;
    console.log(`  ${s.padEnd(16)} n=${String(ts.length).padStart(4)}  win=${pct(w, ts.length).padStart(6)}  mean=${m.toFixed(0).padStart(5)}bps  median=${r[Math.floor(r.length/2)]}bps`);
  }

  // Break down by entry priceImpact bucket
  console.log('-'.repeat(70));
  console.log('BY ENTRY PRICE-IMPACT (liquidity proxy):');
  const buckets = [
    ['impact=0 (deep)', (b) => b === 0],
    ['1-25bps', (b) => b > 0 && b <= 25],
    ['26-75bps', (b) => b > 25 && b <= 75],
    ['76-200bps', (b) => b > 75 && b <= 200],
    ['>200bps (thin)', (b) => b > 200],
    ['unknown', (b) => b === null],
  ];
  for (const [label, fn] of buckets) {
    const ts = trips.filter((t) => fn(t.impactBps));
    if (ts.length === 0) continue;
    const r = ts.map((x) => x.retBps).sort((a, b) => a - b);
    const m = r.reduce((x, y) => x + y, 0) / r.length;
    const w = ts.filter((x) => x.retBps > 0).length;
    console.log(`  ${label.padEnd(16)} n=${String(ts.length).padStart(4)}  win=${pct(w, ts.length).padStart(6)}  mean=${m.toFixed(0).padStart(5)}bps`);
  }

  // Break down by hold time
  console.log('-'.repeat(70));
  console.log('BY HOLD TIME:');
  const holdBuckets = [
    ['<2min', (h) => h < 2],
    ['2-10min', (h) => h >= 2 && h < 10],
    ['10-60min', (h) => h >= 10 && h < 60],
    ['>60min', (h) => h >= 60],
  ];
  for (const [label, fn] of holdBuckets) {
    const ts = trips.filter((t) => fn(t.holdMin));
    if (ts.length === 0) continue;
    const r = ts.map((x) => x.retBps).sort((a, b) => a - b);
    const m = r.reduce((x, y) => x + y, 0) / r.length;
    const w = ts.filter((x) => x.retBps > 0).length;
    console.log(`  ${label.padEnd(16)} n=${String(ts.length).padStart(4)}  win=${pct(w, ts.length).padStart(6)}  mean=${m.toFixed(0).padStart(5)}bps`);
  }

  // Break down by exit reason
  console.log('-'.repeat(70));
  console.log('BY EXIT REASON:');
  const byReason = {};
  for (const t of trips) (byReason[t.exitReason] ??= []).push(t);
  for (const [reason, ts] of Object.entries(byReason).sort((a, b) => b[1].length - a[1].length)) {
    const r = ts.map((x) => x.retBps).sort((a, b) => a - b);
    const m = r.reduce((x, y) => x + y, 0) / r.length;
    const w = ts.filter((x) => x.retBps > 0).length;
    console.log(`  ${reason.padEnd(16)} n=${String(ts.length).padStart(4)}  win=${pct(w, ts.length).padStart(6)}  mean=${m.toFixed(0).padStart(5)}bps`);
  }
  console.log('='.repeat(70));

  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
