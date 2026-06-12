#!/usr/bin/env node
// Multi-Timeframe Strategy Backtester
// Uses OKX public API (no key needed) for 5m, 15m, 1H, 4H candles.
// Tests supertrend parameters across all timeframes and tokens to find optimal config.
//
// Usage:
//   node scripts/backtest-multi-tf.mjs [--tokens JUP,JTO,ORCA,KMNO,BONK,WIF,RENDER,HNT,SOL,PYTH]
//                                      [--timeframes 5m,15m,1H,4H]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };

const TOKEN_SYMS = getArg('--tokens', 'JUP,JTO,ORCA,KMNO,BONK,WIF,RENDER,HNT,SOL,PYTH').split(',');
const TIMEFRAMES = getArg('--timeframes', '5m,15m,1H,4H').split(',');
const MAX_CANDLES = Number(getArg('--candles', '300')); // OKX max per request

// ─── OKX Fetcher ────────────────────────────────────────────────────────────
async function fetchOKXCandles(symbol, timeframe, limit = 300) {
  const instId = `${symbol}-USDT`;
  const url = `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${timeframe}&limit=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`OKX ${instId} ${timeframe}: ${res.status}`);
  const json = await res.json();
  if (!json.data || json.data.length === 0) throw new Error(`OKX ${instId} ${timeframe}: no data`);
  // OKX returns: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]
  // Sorted newest-first, reverse for chronological
  return json.data.reverse().map(d => ({
    t: Number(d[0]),
    o: Number(d[1]),
    h: Number(d[2]),
    l: Number(d[3]),
    c: Number(d[4]),
    v: Number(d[5]),
  }));
}

// ─── Indicators ─────────────────────────────────────────────────────────────
function computeATR(candles, period) {
  const atrs = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c)
    );
    if (i < period) {
      atrs[i] = (atrs[i - 1] * (i - 1) + tr) / i;
    } else if (i === period) {
      let sum = tr;
      for (let j = 1; j < period; j++) sum += Math.max(
        candles[i - j].h - candles[i - j].l,
        Math.abs(candles[i - j].h - candles[i - j - 1].c),
        Math.abs(candles[i - j].l - candles[i - j - 1].c)
      );
      atrs[i] = sum / period;
    } else {
      atrs[i] = (atrs[i - 1] * (period - 1) + tr) / period;
    }
  }
  return atrs;
}

function computeSupertrend(candles, atrPeriod, multiplier) {
  const atrs = computeATR(candles, atrPeriod);
  const signals = [];
  let upperBand = Infinity, lowerBand = -Infinity;
  let prevUpper = Infinity, prevLower = -Infinity;
  let direction = 1;

  for (let i = atrPeriod + 1; i < candles.length; i++) {
    const atr = atrs[i];
    if (atr === 0) continue;
    const hl2 = (candles[i].h + candles[i].l) / 2;
    const basicUpper = hl2 + multiplier * atr;
    const basicLower = hl2 - multiplier * atr;

    upperBand = (basicUpper < prevUpper || candles[i - 1].c > prevUpper) ? basicUpper : prevUpper;
    lowerBand = (basicLower > prevLower || candles[i - 1].c < prevLower) ? basicLower : prevLower;

    const prevDir = direction;
    if (candles[i].c > upperBand) direction = 1;
    else if (candles[i].c < lowerBand) direction = -1;

    if (direction !== prevDir) {
      signals.push({ idx: i, direction: direction === 1 ? 'long' : 'short', price: candles[i].c });
    }
    prevUpper = upperBand;
    prevLower = lowerBand;
  }
  return signals;
}

// ─── Backtester ─────────────────────────────────────────────────────────────
function backtest(candles, signals, params) {
  const { stopLossBps, takeProfitBps, trailingStopBps, minHoldCandles } = params;
  const trades = [];
  let pos = null;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const longSignal = signals.find(s => s.idx === i && s.direction === 'long');
    const shortSignal = signals.find(s => s.idx === i && s.direction === 'short');

    if (longSignal && !pos) {
      pos = { entry: c.c, idx: i, high: c.c };
      continue;
    }

    if (!pos) continue;

    pos.high = Math.max(pos.high, c.h);
    const pnlBps = Math.round((c.c / pos.entry - 1) * 10000);
    const hold = i - pos.idx;
    const trailDrop = pos.high > pos.entry ? Math.round((c.c / pos.high - 1) * 10000) : 0;

    let reason = null;
    if (hold >= minHoldCandles) {
      if (pnlBps >= takeProfitBps) reason = 'take_profit';
      else if (pnlBps <= -stopLossBps) reason = 'stop_loss';
      else if (trailingStopBps > 0 && pnlBps > 50 && trailDrop <= -trailingStopBps) reason = 'trailing_stop';
      else if (shortSignal) reason = 'signal_reversal';
    }

    if (reason) {
      trades.push({ pnlBps, hold, reason });
      pos = null;
    }
  }
  if (pos) {
    const pnl = Math.round((candles[candles.length - 1].c / pos.entry - 1) * 10000);
    trades.push({ pnlBps: pnl, hold: candles.length - 1 - pos.idx, reason: 'eod' });
    pos = null;
  }
  return trades;
}

function score(trades) {
  if (trades.length < 3) return null;
  const COST_BPS = 50; // 35 fee + ~15 slippage+gas
  const wins = trades.filter(t => t.pnlBps - COST_BPS > 0);
  const net = trades.reduce((s, t) => s + t.pnlBps - COST_BPS, 0);
  const winRate = wins.length / trades.length;
  const avgNet = net / trades.length;
  const maxDD = Math.min(...trades.map(t => t.pnlBps));
  const avgHold = trades.reduce((s, t) => s + t.hold, 0) / trades.length;
  // Sortino-like: reward / downside risk
  const losses = trades.filter(t => t.pnlBps - COST_BPS < 0).map(t => t.pnlBps - COST_BPS);
  const downDev = losses.length > 0 ? Math.sqrt(losses.reduce((s, v) => s + v * v, 0) / losses.length) : 1;
  const sortino = avgNet / (downDev || 1);

  return { trades: trades.length, winRate, avgNet, net, maxDD, avgHold, sortino };
}

// ─── Parameter Grid ─────────────────────────────────────────────────────────
const GRID = {
  atrPeriod: [7, 10, 14, 20],
  multiplier: [1.5, 2.0, 2.5, 3.0, 3.5],
  stopLossBps: [75, 100, 150, 200, 250, 300],
  takeProfitBps: [100, 150, 200, 300, 400, 500],
  trailingStopBps: [0, 50, 75, 100, 150],
  minHoldCandles: [1, 2, 3, 5, 8],
};

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log('═'.repeat(80));
  console.log('  MULTI-TIMEFRAME STRATEGY BACKTESTER (OKX data, no API key needed)');
  console.log('═'.repeat(80));
  console.log(`  Tokens: ${TOKEN_SYMS.join(', ')}`);
  console.log(`  Timeframes: ${TIMEFRAMES.join(', ')}`);
  console.log(`  Candles per request: ${MAX_CANDLES}`);
  console.log('');

  // Fetch all data first
  const data = new Map(); // key: "SYMBOL:TF" -> candles[]
  for (const sym of TOKEN_SYMS) {
    for (const tf of TIMEFRAMES) {
      const key = `${sym}:${tf}`;
      try {
        const candles = await fetchOKXCandles(sym, tf, MAX_CANDLES);
        if (candles.length >= 50) {
          data.set(key, candles);
          process.stdout.write(`  ✓ ${key} (${candles.length})\n`);
        } else {
          process.stdout.write(`  ⚠ ${key} only ${candles.length} candles, skip\n`);
        }
      } catch (e) {
        process.stdout.write(`  ✗ ${key}: ${e.message}\n`);
      }
      await sleep(200); // OKX rate limit: 20 req/2s
    }
  }

  console.log(`\n  Loaded ${data.size} token/timeframe combos.\n`);

  // Run per-timeframe sweeps
  for (const tf of TIMEFRAMES) {
    const tfData = [...data.entries()].filter(([k]) => k.endsWith(`:${tf}`));
    if (tfData.length < 3) {
      console.log(`  Skipping ${tf}: only ${tfData.length} tokens (need >=3)`);
      continue;
    }

    console.log('═'.repeat(80));
    console.log(`  TIMEFRAME: ${tf}  (${tfData.length} tokens, ${tfData[0][1].length} candles each)`);
    console.log('═'.repeat(80));

    // Data coverage info
    const sampleCandles = tfData[0][1];
    const startDate = new Date(sampleCandles[0].t).toISOString().slice(0, 16);
    const endDate = new Date(sampleCandles[sampleCandles.length - 1].t).toISOString().slice(0, 16);
    console.log(`  Data range: ${startDate} → ${endDate}`);
    console.log('');

    const results = [];
    let combos = 0;

    for (const atrPeriod of GRID.atrPeriod) {
      for (const multiplier of GRID.multiplier) {
        for (const stopLossBps of GRID.stopLossBps) {
          for (const takeProfitBps of GRID.takeProfitBps) {
            for (const trailingStopBps of GRID.trailingStopBps) {
              for (const minHoldCandles of GRID.minHoldCandles) {
                combos++;
                let aggNet = 0, aggTrades = 0, aggWins = 0, worstDD = 0, tokenCount = 0;
                let avgSortino = 0;

                for (const [key, candles] of tfData) {
                  const signals = computeSupertrend(candles, atrPeriod, multiplier);
                  const trades = backtest(candles, signals, { stopLossBps, takeProfitBps, trailingStopBps, minHoldCandles });
                  const s = score(trades);
                  if (!s) continue;
                  aggNet += s.net;
                  aggTrades += s.trades;
                  aggWins += Math.round(s.winRate * s.trades);
                  worstDD = Math.min(worstDD, s.maxDD);
                  avgSortino += s.sortino;
                  tokenCount++;
                }

                if (tokenCount >= 3 && aggTrades >= 10) {
                  results.push({
                    atrPeriod, multiplier, stopLossBps, takeProfitBps, trailingStopBps, minHoldCandles,
                    net: aggNet,
                    trades: aggTrades,
                    winRate: aggWins / aggTrades,
                    avgNet: aggNet / aggTrades,
                    maxDD: worstDD,
                    sortino: avgSortino / tokenCount,
                    tokens: tokenCount,
                  });
                }
              }
            }
          }
        }
      }
    }

    // Sort by Sortino (risk-adjusted return)
    results.sort((a, b) => b.sortino - a.sortino);

    console.log(`  Evaluated ${combos.toLocaleString()} combos → ${results.length.toLocaleString()} valid\n`);

    if (results.length === 0) { console.log('  No valid results.\n'); continue; }

    // Top 15 by Sortino
    console.log('  TOP 15 (by Sortino ratio — risk-adjusted):');
    console.log('  ' + '-'.repeat(78));
    console.log(
      '  ' +
      '#'.padEnd(4) +
      'ATR'.padEnd(5) +
      'Mult'.padEnd(6) +
      'SL'.padEnd(5) +
      'TP'.padEnd(5) +
      'Trail'.padEnd(6) +
      'Hold'.padEnd(5) +
      'Sortino'.padEnd(8) +
      'Net'.padEnd(8) +
      'Trades'.padEnd(7) +
      'Win%'.padEnd(7) +
      'Avg/Tr'.padEnd(8) +
      'MaxDD'.padEnd(7) +
      'Tok'
    );
    console.log('  ' + '-'.repeat(78));
    for (let i = 0; i < Math.min(15, results.length); i++) {
      const r = results[i];
      console.log(
        '  ' +
        String(i + 1).padEnd(4) +
        String(r.atrPeriod).padEnd(5) +
        r.multiplier.toFixed(1).padEnd(6) +
        String(r.stopLossBps).padEnd(5) +
        String(r.takeProfitBps).padEnd(5) +
        String(r.trailingStopBps).padEnd(6) +
        String(r.minHoldCandles).padEnd(5) +
        r.sortino.toFixed(3).padEnd(8) +
        String(r.net).padEnd(8) +
        String(r.trades).padEnd(7) +
        (r.winRate * 100).toFixed(1).padEnd(7) +
        r.avgNet.toFixed(1).padEnd(8) +
        String(r.maxDD).padEnd(7) +
        String(r.tokens)
      );
    }

    // Current params comparison
    console.log('\n  CURRENT LIVE PARAMS:');
    const curSignals = {};
    let curNet = 0, curTrades = 0, curWins = 0;
    for (const [key, candles] of tfData) {
      const signals = computeSupertrend(candles, 10, 3.0);
      const trades = backtest(candles, signals, { stopLossBps: 55, takeProfitBps: 180, trailingStopBps: 5, minHoldCandles: 2 });
      const s = score(trades);
      if (!s) continue;
      curNet += s.net;
      curTrades += s.trades;
      curWins += Math.round(s.winRate * s.trades);
    }
    if (curTrades > 0) {
      console.log(`  ATR=10 mult=3.0 SL=55 TP=180 trail=5 hold=2 → net=${curNet}bps, ${curTrades} trades, ${(curWins/curTrades*100).toFixed(1)}% win`);
    } else {
      console.log('  (no trades with current params)');
    }

    // Best by pure net PnL (different perspective)
    const byNet = [...results].sort((a, b) => b.net - a.net);
    console.log(`\n  BEST BY NET PnL: ATR=${byNet[0].atrPeriod} mult=${byNet[0].multiplier} SL=${byNet[0].stopLossBps} TP=${byNet[0].takeProfitBps} trail=${byNet[0].trailingStopBps} hold=${byNet[0].minHoldCandles} → net=${byNet[0].net}bps, ${byNet[0].trades} trades, ${(byNet[0].winRate*100).toFixed(1)}% win`);

    // Improvement
    if (curTrades > 0 && results.length > 0) {
      const best = results[0];
      console.log(`\n  ➜ Sortino-best improvement over current: ${best.net - curNet}bps net, +${((best.winRate - curWins/curTrades)*100).toFixed(1)}pp win rate`);
    }
    console.log('');
  }

  // Cross-timeframe summary
  console.log('═'.repeat(80));
  console.log('  CROSS-TIMEFRAME SUMMARY');
  console.log('═'.repeat(80));
  console.log('  For this bot (entering/exiting within minutes to hours):');
  console.log('  • 5m:  Most granular. If profitable here, the bot can scalp.');
  console.log('  • 15m: Sweet spot for noise filtering while keeping trade frequency.');
  console.log('  • 1H:  Fewer signals but higher quality. Good for swing component.');
  console.log('  • 4H:  Trend confirmation only. Too slow for primary signals.');
  console.log('');
  console.log('  RECOMMENDATION: Use the 15m or 1H optimal params as the primary');
  console.log('  trading timeframe. The current bot fires too often on noise.');
  console.log('');
}

main().catch(e => { console.error(e); process.exit(1); });
