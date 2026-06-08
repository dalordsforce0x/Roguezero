#!/usr/bin/env node
// Entry-shape calibration from historical trades + reconstructed 1-min candles.
//
// We cannot bit-exactly replay the live 3-second entry-quality score (we never
// persisted the 3s tape, and no free provider serves 3s history). But the loss
// signature is sub-2-minute, so we reconstruct each entry's 1-MINUTE price path
// over the ~15 minutes BEFORE entry (GeckoTerminal, free) and measure WHERE the
// entry sat in that window. This tests the same thesis — "did we buy a local top
// / chase a vertical run-up?" — at a coarser timescale, and tells us which entry
// primitive predicts the fast-fail so we can set the live gate threshold.
//
// Output: for each shape primitive, fast-fail rate + mean return by bucket.
//
// Usage: node scripts/calibrate-entry-shape.mjs [--min-entries 3] [--window 15]

import pg from 'pg';
import 'dotenv/config';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = 'So11111111111111111111111111111111111111112';

const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const MIN_ENTRIES = Number(getArg('--min-entries', '3'));
const WINDOW_MIN = Number(getArg('--window', '15'));   // minutes of pre-entry context
const FAST_FAIL_MIN = 2;                                // hold < this = "fast fail"

const databaseUrl = process.env.DATABASE_PRIVATE_URL?.trim();
if (!databaseUrl) { console.error('DATABASE_PRIVATE_URL is required'); process.exit(1); }
const connectionString = databaseUrl.replace('sslmode=require', 'uselibpqcompat=true&sslmode=require');
const pool = new pg.Pool({ connectionString, ssl: { rejectUnauthorized: false }, statement_timeout: 60000 });

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, b) => (b > 0 ? (100 * a / b).toFixed(0) + '%' : 'n/a');
const mean = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);

// ---- GeckoTerminal (free, no key) -----------------------------------------
const GT = 'https://api.geckoterminal.com/api/v2/networks/solana';
const poolCache = new Map();   // mint -> pool address (or null)
const ohlcvCache = new Map();  // mint -> sorted [{t, c}] ascending

async function gtFetch(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: { accept: 'application/json' } });
    if (r.status === 429) { await sleep(3000 * (i + 1)); continue; }
    if (!r.ok) return null;
    return r.json();
  }
  return null;
}

async function getTopPool(mint) {
  if (poolCache.has(mint)) return poolCache.get(mint);
  await sleep(1200);
  const j = await gtFetch(`${GT}/tokens/${mint}/pools?page=1`);
  const top = j?.data?.[0];
  const id = top?.attributes?.address || (top?.id ? String(top.id).replace('solana_', '') : null);
  poolCache.set(mint, id ?? null);
  return id ?? null;
}

// Fetch 1-min OHLCV covering [fromTs, toTs] (unix sec), newest-first, paginate back.
async function getOhlcv(mint, fromTs, toTs) {
  if (ohlcvCache.has(mint)) return ohlcvCache.get(mint);
  const poolAddr = await getTopPool(mint);
  if (!poolAddr) { ohlcvCache.set(mint, []); return []; }
  const all = new Map(); // t -> close
  let before = toTs + 60;
  for (let page = 0; page < 8; page++) {
    await sleep(1200);
    const url = `${GT}/pools/${poolAddr}/ohlcv/minute?aggregate=1&before_timestamp=${before}&limit=1000&currency=usd`;
    const j = await gtFetch(url);
    const list = j?.data?.attributes?.ohlcv_list || [];
    if (list.length === 0) break;
    for (const row of list) {
      const t = Number(row[0]); const c = Number(row[4]);
      if (Number.isFinite(t) && Number.isFinite(c)) all.set(t, c);
    }
    const oldest = Math.min(...list.map((r) => Number(r[0])));
    if (oldest <= fromTs) break;
    before = oldest;
  }
  const sorted = [...all.entries()].map(([t, c]) => ({ t, c })).sort((a, b) => a.t - b.t);
  ohlcvCache.set(mint, sorted);
  return sorted;
}

// ---- Shape primitives over the pre-entry window ----------------------------
function computeShape(window, entryPrice) {
  // window: ascending [{t,c}] strictly before entry. entryPrice = price we paid.
  if (window.length < 5) return null;
  const closes = window.map((p) => p.c);
  const high = Math.max(...closes, entryPrice);
  const low = Math.min(...closes, entryPrice);
  const first = closes[0];
  const range = high - low;
  const last3 = closes.slice(-3);
  const surgeBase = last3[0] ?? closes[closes.length - 1];
  return {
    // How far below the recent high did we buy? (0 = bought the high)
    pullbackFromHighBps: high > 0 ? Math.round(((high - entryPrice) / high) * 10000) : 0,
    // Where in the range did we buy? 0=bottom, 10000=top. High = bought local top.
    rangePositionBps: range > 0 ? Math.round(((entryPrice - low) / range) * 10000) : 5000,
    // How vertical was the last ~3 min into entry? High = chased a spike.
    recentSurgeBps: surgeBase > 0 ? Math.round(((entryPrice - surgeBase) / surgeBase) * 10000) : 0,
    // Net momentum across the whole window.
    priorMomentumBps: first > 0 ? Math.round(((entryPrice - first) / first) * 10000) : 0,
    samples: window.length,
  };
}

// ---- Load entries with per-entry outcomes (FIFO) ---------------------------
async function loadEntries() {
  const { rows } = await pool.query(
    `SELECT id, taker, input_mint, output_mint, confirmed_at,
            build_response->>'inAmount'  AS in_amt,
            build_response->>'outAmount' AS out_amt,
            build_response->>'priceImpactPct' AS impact_pct,
            metadata->>'entryStrategy' AS entry_strategy,
            metadata->>'exitReason'   AS exit_reason
       FROM swap_executions
      WHERE status='confirmed' AND (input_mint=$1 OR output_mint=$1)
      ORDER BY confirmed_at ASC`, [USDC]);

  const lots = new Map();   // taker:mint -> queue of entry lots
  const entries = [];       // entry records with outcome
  let nextId = 0;

  for (const r of rows) {
    const inAmt = num(r.in_amt); const outAmt = num(r.out_amt);
    if (!inAmt || !outAmt || inAmt <= 0 || outAmt <= 0) continue;

    if (r.input_mint === USDC && r.output_mint !== USDC) {
      const key = `${r.taker}:${r.output_mint}`;
      const entry = {
        id: nextId++, mint: r.output_mint, taker: r.taker,
        ts: new Date(r.confirmed_at).getTime(),
        entryPrice: inAmt / outAmt,
        qty: outAmt,
        impactBps: r.impact_pct !== null ? Math.round(Number(r.impact_pct) * 10000) : null,
        strategy: r.entry_strategy || 'unknown',
        // outcome (filled on first exit match)
        firstExitTs: null, retBps: null, stopLoss: false, matched: false,
      };
      if (!lots.has(key)) lots.set(key, []);
      lots.get(key).push(entry);
      entries.push(entry);
    } else if (r.output_mint === USDC && r.input_mint !== USDC) {
      const key = `${r.taker}:${r.input_mint}`;
      const exitPrice = outAmt / inAmt;
      const exitTs = new Date(r.confirmed_at).getTime();
      let remaining = inAmt;
      const queue = lots.get(key);
      if (!queue) continue;
      while (remaining > 0 && queue.length > 0) {
        const lot = queue[0];
        const m = Math.min(remaining, lot.qty);
        if (!lot.matched) {
          lot.matched = true;
          lot.firstExitTs = exitTs;
          lot.retBps = Math.round((exitPrice / lot.entryPrice - 1) * 10000);
          lot.stopLoss = (r.exit_reason === 'stop_loss');
        }
        lot.qty -= m; remaining -= m;
        if (lot.qty <= 1e-6) queue.shift();
      }
    }
  }
  return entries.filter((e) => e.matched && e.mint !== SOL); // SOL = base rotation, exclude from token-chase calibration
}

// ---- Bucketed correlation printer ------------------------------------------
function report(title, recs, valueFn, buckets) {
  console.log('-'.repeat(72));
  console.log(title);
  for (const [label, fn] of buckets) {
    const sub = recs.filter((r) => { const v = valueFn(r); return v !== null && fn(v); });
    if (sub.length === 0) { console.log(`  ${label.padEnd(20)} n=   0`); continue; }
    const rets = sub.map((r) => r.retBps);
    const ff = sub.filter((r) => r.holdMin < FAST_FAIL_MIN).length;
    const sl = sub.filter((r) => r.stopLoss).length;
    const win = sub.filter((r) => r.retBps > 0).length;
    console.log(`  ${label.padEnd(20)} n=${String(sub.length).padStart(4)}  win=${pct(win, sub.length).padStart(4)}  mean=${mean(rets).toFixed(0).padStart(5)}bps  fastfail=${pct(ff, sub.length).padStart(4)}  stoploss=${pct(sl, sub.length).padStart(4)}`);
  }
}

async function main() {
  console.log('Loading entries + pairing outcomes (FIFO)...');
  const entries = await loadEntries();
  // group by mint, keep mints with enough entries
  const byMint = new Map();
  for (const e of entries) { (byMint.get(e.mint) ?? byMint.set(e.mint, []).get(e.mint)).push(e); }
  const mints = [...byMint.entries()].filter(([, es]) => es.length >= MIN_ENTRIES).sort((a, b) => b[1].length - a[1].length);
  const covered = mints.reduce((s, [, es]) => s + es.length, 0);
  console.log(`matched entries: ${entries.length}  |  mints>=${MIN_ENTRIES}: ${mints.length} covering ${covered} entries`);
  console.log(`Reconstructing 1-min windows (GeckoTerminal, throttled)...`);

  const recs = [];
  let done = 0;
  for (const [mint, es] of mints) {
    const minTs = Math.floor(Math.min(...es.map((e) => e.ts)) / 1000) - WINDOW_MIN * 60 - 120;
    const maxTs = Math.floor(Math.max(...es.map((e) => e.ts)) / 1000);
    const candles = await getOhlcv(mint, minTs, maxTs);
    const sym = mint.slice(0, 4);
    if (candles.length === 0) { console.log(`  [skip] ${sym}.. no candles`); continue; }
    for (const e of es) {
      const entrySec = Math.floor(e.ts / 1000);
      const window = candles.filter((p) => p.t < entrySec && p.t >= entrySec - WINDOW_MIN * 60);
      const shape = computeShape(window, e.entryPrice);
      if (!shape) continue;
      recs.push({
        ...e, ...shape,
        holdMin: (e.firstExitTs - e.ts) / 60000,
      });
    }
    done++;
    console.log(`  [${done}/${mints.length}] ${sym}.. entries=${es.length} candles=${candles.length}`);
  }

  console.log('='.repeat(72));
  console.log(`ENTRY-SHAPE CALIBRATION  —  ${recs.length} entries with reconstructed 1-min context`);
  console.log(`(fast-fail = exited in < ${FAST_FAIL_MIN} min; returns GROSS of ~50bps honest break-even)`);
  console.log('='.repeat(72));
  if (recs.length === 0) { await pool.end(); return; }

  const overall = {
    win: recs.filter((r) => r.retBps > 0).length,
    ff: recs.filter((r) => r.holdMin < FAST_FAIL_MIN).length,
    sl: recs.filter((r) => r.stopLoss).length,
  };
  console.log(`BASELINE  n=${recs.length}  win=${pct(overall.win, recs.length)}  mean=${mean(recs.map((r) => r.retBps)).toFixed(0)}bps  fastfail=${pct(overall.ff, recs.length)}  stoploss=${pct(overall.sl, recs.length)}`);

  report('BY RANGE POSITION AT ENTRY (0=bottom of 15m range, 10000=top):', recs, (r) => r.rangePositionBps, [
    ['0-2500 (bottom)', (v) => v <= 2500],
    ['2500-5000', (v) => v > 2500 && v <= 5000],
    ['5000-7500', (v) => v > 5000 && v <= 7500],
    ['7500-9000', (v) => v > 7500 && v <= 9000],
    ['9000-10000 (top)', (v) => v > 9000],
  ]);

  report('BY PULLBACK FROM 15m HIGH (0=bought the high):', recs, (r) => r.pullbackFromHighBps, [
    ['0-10bps (at high)', (v) => v <= 10],
    ['10-50bps', (v) => v > 10 && v <= 50],
    ['50-150bps', (v) => v > 50 && v <= 150],
    ['150-400bps', (v) => v > 150 && v <= 400],
    ['>400bps (deep)', (v) => v > 400],
  ]);

  report('BY RECENT SURGE (last ~3min into entry; high=chased a spike):', recs, (r) => r.recentSurgeBps, [
    ['<0 (dip)', (v) => v < 0],
    ['0-25bps', (v) => v >= 0 && v <= 25],
    ['25-100bps', (v) => v > 25 && v <= 100],
    ['100-300bps', (v) => v > 100 && v <= 300],
    ['>300bps (vertical)', (v) => v > 300],
  ]);

  report('BY PRIOR MOMENTUM (net move across 15m window):', recs, (r) => r.priorMomentumBps, [
    ['<-100bps (falling)', (v) => v < -100],
    ['-100..0', (v) => v >= -100 && v < 0],
    ['0-100bps', (v) => v >= 0 && v <= 100],
    ['100-400bps', (v) => v > 100 && v <= 400],
    ['>400bps (ran up)', (v) => v > 400],
  ]);

  console.log('='.repeat(72));
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
