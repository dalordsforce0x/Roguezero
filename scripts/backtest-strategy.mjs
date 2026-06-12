#!/usr/bin/env node
// Strategy Backtester — pulls historical candles and tests supertrend + exit params.
//
// Usage:
//   node scripts/backtest-strategy.mjs [--tokens JUP,JTO,ORCA,KMNO] [--days 30] [--interval 5m]
//
// Outputs optimal parameters based on historical data for the token set.

import 'dotenv/config';

const COINGECKO_API_KEY = (process.env.COINGECKO_API_KEY ?? '').trim();
const COINGECKO_API_PLAN = (process.env.COINGECKO_API_PLAN ?? (COINGECKO_API_KEY ? 'demo' : 'none')).trim().toLowerCase();
const COINGECKO_BASE_URL = (
  COINGECKO_API_PLAN === 'pro' ? 'https://pro-api.coingecko.com/api/v3' : 'https://api.coingecko.com/api/v3'
).replace(/\/$/, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };

const TOKEN_IDS_INPUT = getArg('--tokens', 'jupiter-exchange-solana,jito-governance-token,orca,kamino,render-token,helium,bonk,popcat-solana');
const DAYS = Number(getArg('--days', '30'));
const INTERVAL = getArg('--interval', '5m'); // CoinGecko OHLC granularity

// CoinGecko coingecko_id -> symbol map for display
const TOKEN_IDS = TOKEN_IDS_INPUT.split(',').map(s => s.trim());

// ─── CoinGecko Fetcher ─────────────────────────────────────────────────────
function coingeckoHeaders() {
  const headers = { accept: 'application/json' };
  if (COINGECKO_API_KEY) {
    headers[COINGECKO_API_PLAN === 'pro' ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key'] = COINGECKO_API_KEY;
  }
  return headers;
}

async function fetchOHLC(coingeckoId, days) {
  // CoinGecko /coins/{id}/ohlc returns [timestamp, open, high, low, close]
  // days<=1: 30min candles, days<=30: 4h candles, days>30: 4-day candles
  // For 5m granularity we need the /coins/{id}/market_chart endpoint with interval param (Pro only)
  // Fallback: use /ohlc with days=30 → 4h candles (acceptable for initial backtest)
  const url = `${COINGECKO_BASE_URL}/coins/${coingeckoId}/ohlc?vs_currency=usd&days=${days}`;
  const res = await fetch(url, { headers: coingeckoHeaders(), signal: AbortSignal.timeout(30000) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`CoinGecko OHLC ${coingeckoId}: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  // Returns array of [timestamp, open, high, low, close]
  return data.map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
}

// ─── Indicators ─────────────────────────────────────────────────────────────
function computeATR(candles, period) {
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const cur = candles[i];
    const tr = Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c));
    trs.push(tr);
  }
  // Simple moving average for first ATR, then EMA-style
  const atrs = new Array(trs.length).fill(0);
  let sum = 0;
  for (let i = 0; i < Math.min(period, trs.length); i++) sum += trs[i];
  atrs[period - 1] = sum / period;
  for (let i = period; i < trs.length; i++) {
    atrs[i] = (atrs[i - 1] * (period - 1) + trs[i]) / period;
  }
  return atrs;
}

function computeSupertrend(candles, atrPeriod, multiplier) {
  const atrs = computeATR(candles, atrPeriod);
  const signals = []; // { t, direction: 'long'|'short', price }

  let upperBand = 0, lowerBand = 0;
  let prevUpperBand = 0, prevLowerBand = 0;
  let direction = 1; // 1 = up (bullish), -1 = down (bearish)

  for (let i = atrPeriod; i < candles.length; i++) {
    const atrIdx = i - 1; // ATR is offset by 1 since it starts from index 1
    const atr = atrs[atrIdx] || 0;
    if (atr === 0) continue;

    const candle = candles[i];
    const hl2 = (candle.h + candle.l) / 2;

    const basicUpperBand = hl2 + multiplier * atr;
    const basicLowerBand = hl2 - multiplier * atr;

    // Upper band: take min of current basic and previous final (if prev close was above prev upper)
    upperBand = (basicUpperBand < prevUpperBand || candles[i - 1].c > prevUpperBand)
      ? basicUpperBand : prevUpperBand;

    // Lower band: take max of current basic and previous final (if prev close was below prev lower)
    lowerBand = (basicLowerBand > prevLowerBand || candles[i - 1].c < prevLowerBand)
      ? basicLowerBand : prevLowerBand;

    const prevDirection = direction;

    if (candle.c > upperBand) direction = 1;
    else if (candle.c < lowerBand) direction = -1;

    // Signal on direction change
    if (direction !== prevDirection) {
      signals.push({
        t: candle.t,
        direction: direction === 1 ? 'long' : 'short',
        price: candle.c,
        idx: i,
      });
    }

    prevUpperBand = upperBand;
    prevLowerBand = lowerBand;
  }

  return signals;
}

// ─── Backtester ─────────────────────────────────────────────────────────────
function backtest(candles, signals, params) {
  const { stopLossBps, takeProfitBps, trailingStopBps, antiChurnCandles } = params;
  const trades = [];
  let position = null; // { entryPrice, entryIdx, highSinceEntry }

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];

    // Check for entry signals at this candle
    const signal = signals.find(s => s.idx === i && s.direction === 'long');
    if (signal && !position) {
      position = { entryPrice: candle.c, entryIdx: i, highSinceEntry: candle.c };
      continue;
    }

    // Check for exit signal (reversal)
    const exitSignal = signals.find(s => s.idx === i && s.direction === 'short');

    if (position) {
      position.highSinceEntry = Math.max(position.highSinceEntry, candle.h);
      const pnlBps = Math.round((candle.c / position.entryPrice - 1) * 10000);
      const holdCandles = i - position.entryIdx;
      const drawdownFromHigh = Math.round((candle.c / position.highSinceEntry - 1) * 10000);

      let exitReason = null;

      // Anti-churn: don't exit within N candles of entry
      if (holdCandles >= antiChurnCandles) {
        if (pnlBps >= takeProfitBps) exitReason = 'take_profit';
        else if (pnlBps <= -stopLossBps) exitReason = 'stop_loss';
        else if (trailingStopBps > 0 && pnlBps > 0 && drawdownFromHigh <= -trailingStopBps) exitReason = 'trailing_stop';
        else if (exitSignal) exitReason = 'signal_reversal';
      }

      if (exitReason) {
        trades.push({
          entryPrice: position.entryPrice,
          exitPrice: candle.c,
          pnlBps,
          holdCandles,
          exitReason,
        });
        position = null;
      }
    }
  }

  // Close open position at end
  if (position) {
    const lastCandle = candles[candles.length - 1];
    const pnlBps = Math.round((lastCandle.c / position.entryPrice - 1) * 10000);
    trades.push({
      entryPrice: position.entryPrice,
      exitPrice: lastCandle.c,
      pnlBps,
      holdCandles: candles.length - 1 - position.entryIdx,
      exitReason: 'end_of_data',
    });
  }

  return trades;
}

function evaluateParams(candles, atrPeriod, multiplier, exitParams) {
  const signals = computeSupertrend(candles, atrPeriod, multiplier);
  const trades = backtest(candles, signals, exitParams);

  if (trades.length === 0) return null;

  const wins = trades.filter(t => t.pnlBps > 0);
  const losses = trades.filter(t => t.pnlBps <= 0);
  const totalPnlBps = trades.reduce((s, t) => s + t.pnlBps, 0);
  const avgPnl = totalPnlBps / trades.length;
  const winRate = wins.length / trades.length;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlBps, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlBps, 0) / losses.length : 0;
  const maxDrawdown = Math.min(...trades.map(t => t.pnlBps));
  const profitFactor = avgLoss !== 0 ? Math.abs(avgWin * wins.length) / Math.abs(avgLoss * losses.length) : Infinity;

  // Account for costs: ~50 bps round-trip (35 bps fee + slippage + gas)
  const costBps = 50;
  const netPnlBps = totalPnlBps - trades.length * costBps;
  const netAvgPnl = netPnlBps / trades.length;

  return {
    trades: trades.length,
    winRate,
    avgPnl,
    avgWin,
    avgLoss,
    maxDrawdown,
    profitFactor,
    totalPnlBps,
    netPnlBps,
    netAvgPnl,
    tradesPerDay: trades.length / (DAYS || 30),
  };
}

// ─── Parameter Sweep ────────────────────────────────────────────────────────
const PARAM_GRID = {
  atrPeriod: [7, 10, 14, 20],
  multiplier: [1.5, 2.0, 2.5, 3.0, 3.5],
  stopLossBps: [100, 150, 200, 250, 300],
  takeProfitBps: [150, 200, 300, 400, 500],
  trailingStopBps: [0, 50, 75, 100],
  antiChurnCandles: [1, 2, 3, 5],
};

async function main() {
  console.log('='.repeat(70));
  console.log('STRATEGY BACKTESTER — Supertrend Parameter Optimization');
  console.log(`Tokens: ${TOKEN_IDS.join(', ')}`);
  console.log(`Days: ${DAYS}, Interval: OHLC (4h candles from CoinGecko)`);
  console.log('='.repeat(70));

  // Fetch candle data
  const tokenCandles = new Map();
  for (const id of TOKEN_IDS) {
    try {
      console.log(`Fetching ${id}...`);
      const candles = await fetchOHLC(id, DAYS);
      if (candles.length < 30) {
        console.log(`  ⚠ Only ${candles.length} candles, skipping`);
        continue;
      }
      tokenCandles.set(id, candles);
      console.log(`  ✓ ${candles.length} candles`);
      await sleep(1500); // Rate limit
    } catch (e) {
      console.log(`  ✗ ${e.message}`);
    }
  }

  if (tokenCandles.size === 0) {
    console.error('No candle data fetched. Check API key / network.');
    process.exit(1);
  }

  // Run parameter sweep
  console.log('\n' + '='.repeat(70));
  console.log('Running parameter sweep...');
  console.log('='.repeat(70));

  const results = [];
  let combos = 0;
  const totalCombos = PARAM_GRID.atrPeriod.length * PARAM_GRID.multiplier.length *
    PARAM_GRID.stopLossBps.length * PARAM_GRID.takeProfitBps.length *
    PARAM_GRID.trailingStopBps.length * PARAM_GRID.antiChurnCandles.length;
  console.log(`Total parameter combinations: ${totalCombos}`);

  for (const atrPeriod of PARAM_GRID.atrPeriod) {
    for (const multiplier of PARAM_GRID.multiplier) {
      for (const stopLossBps of PARAM_GRID.stopLossBps) {
        for (const takeProfitBps of PARAM_GRID.takeProfitBps) {
          for (const trailingStopBps of PARAM_GRID.trailingStopBps) {
            for (const antiChurnCandles of PARAM_GRID.antiChurnCandles) {
              combos++;
              // Aggregate across all tokens
              let totalNetPnl = 0;
              let totalTrades = 0;
              let totalWins = 0;
              let tokenCount = 0;
              let worstDrawdown = 0;

              for (const [tokenId, candles] of tokenCandles) {
                const result = evaluateParams(candles, atrPeriod, multiplier, {
                  stopLossBps, takeProfitBps, trailingStopBps, antiChurnCandles,
                });
                if (!result || result.trades < 3) continue;
                totalNetPnl += result.netPnlBps;
                totalTrades += result.trades;
                totalWins += Math.round(result.winRate * result.trades);
                worstDrawdown = Math.min(worstDrawdown, result.maxDrawdown);
                tokenCount++;
              }

              if (tokenCount >= 3 && totalTrades >= 10) {
                results.push({
                  atrPeriod, multiplier, stopLossBps, takeProfitBps, trailingStopBps, antiChurnCandles,
                  netPnlBps: totalNetPnl,
                  trades: totalTrades,
                  winRate: totalWins / totalTrades,
                  avgNetPnl: totalNetPnl / totalTrades,
                  worstDrawdown,
                  tokens: tokenCount,
                });
              }
            }
          }
        }
      }
    }
  }

  if (combos % 1000 === 0) process.stdout.write('.');

  console.log(`\n\nEvaluated ${combos} combinations, ${results.length} valid results.`);

  // Sort by net PnL
  results.sort((a, b) => b.netPnlBps - a.netPnlBps);

  // Top 20
  console.log('\n' + '='.repeat(70));
  console.log('TOP 20 PARAMETER SETS (by net PnL after costs):');
  console.log('='.repeat(70));
  console.log(
    'Rank'.padEnd(5) +
    'ATR'.padEnd(5) +
    'Mult'.padEnd(6) +
    'SL'.padEnd(6) +
    'TP'.padEnd(6) +
    'Trail'.padEnd(7) +
    'Hold'.padEnd(6) +
    'NetPnL'.padEnd(9) +
    'Trades'.padEnd(8) +
    'WinRate'.padEnd(9) +
    'AvgNet'.padEnd(8) +
    'MaxDD'.padEnd(8) +
    'Tokens'
  );
  console.log('-'.repeat(70));

  for (let i = 0; i < Math.min(20, results.length); i++) {
    const r = results[i];
    console.log(
      String(i + 1).padEnd(5) +
      String(r.atrPeriod).padEnd(5) +
      r.multiplier.toFixed(1).padEnd(6) +
      String(r.stopLossBps).padEnd(6) +
      String(r.takeProfitBps).padEnd(6) +
      String(r.trailingStopBps).padEnd(7) +
      String(r.antiChurnCandles).padEnd(6) +
      String(r.netPnlBps).padEnd(9) +
      String(r.trades).padEnd(8) +
      (r.winRate * 100).toFixed(1).padEnd(9) +
      r.avgNetPnl.toFixed(1).padEnd(8) +
      String(r.worstDrawdown).padEnd(8) +
      String(r.tokens)
    );
  }

  // Also show worst 5 to understand what doesn't work
  console.log('\n' + '='.repeat(70));
  console.log('WORST 5 (avoid these):');
  console.log('='.repeat(70));
  const worst = results.slice(-5).reverse();
  for (const r of worst) {
    console.log(
      `  ATR=${r.atrPeriod} mult=${r.multiplier} SL=${r.stopLossBps} TP=${r.takeProfitBps} ` +
      `trail=${r.trailingStopBps} hold=${r.antiChurnCandles} → net=${r.netPnlBps}bps ` +
      `trades=${r.trades} win=${(r.winRate * 100).toFixed(1)}%`
    );
  }

  // Current params comparison
  console.log('\n' + '='.repeat(70));
  console.log('CURRENT LIVE PARAMS FOR COMPARISON:');
  console.log('='.repeat(70));

  const currentParams = { stopLossBps: 55, takeProfitBps: 180, trailingStopBps: 5, antiChurnCandles: 2 };
  const currentATR = 10;
  const currentMult = 3.0;

  let currentNetPnl = 0, currentTrades = 0, currentWins = 0, currentTokens = 0;
  for (const [tokenId, candles] of tokenCandles) {
    const result = evaluateParams(candles, currentATR, currentMult, currentParams);
    if (!result || result.trades < 1) continue;
    currentNetPnl += result.netPnlBps;
    currentTrades += result.trades;
    currentWins += Math.round(result.winRate * result.trades);
    currentTokens++;
  }

  if (currentTrades > 0) {
    console.log(`  ATR=10 mult=3.0 SL=55 TP=180 trail=5 hold=2`);
    console.log(`  Net PnL: ${currentNetPnl} bps across ${currentTrades} trades`);
    console.log(`  Win Rate: ${(currentWins / currentTrades * 100).toFixed(1)}%`);
    console.log(`  Avg Net: ${(currentNetPnl / currentTrades).toFixed(1)} bps/trade`);
  } else {
    console.log('  (no trades produced with current params on this data)');
  }

  // Recommendation
  if (results.length > 0) {
    const best = results[0];
    console.log('\n' + '='.repeat(70));
    console.log('RECOMMENDATION:');
    console.log('='.repeat(70));
    console.log(`  Supertrend: ATR period = ${best.atrPeriod}, multiplier = ${best.multiplier}`);
    console.log(`  Exit: stopLoss = ${best.stopLossBps} bps, takeProfit = ${best.takeProfitBps} bps`);
    console.log(`  Trailing stop: ${best.trailingStopBps} bps`);
    console.log(`  Min hold: ${best.antiChurnCandles} candles before exit allowed`);
    console.log(`  Expected: ${best.avgNetPnl.toFixed(1)} bps/trade net, ${(best.winRate * 100).toFixed(1)}% win rate`);
    console.log(`  Improvement over current: ${best.netPnlBps - currentNetPnl} bps total`);
  }

  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
