#!/usr/bin/env node
/**
 * Backtester: validates all 3 RogueZero strategies against historical data
 * using ACTUAL live parameters AND a realistic round-trip cost.
 *
 * Data: CoinGecko OHLC (4h candles over 30 days, free tier).
 * Tokens: the exact tokens our bots are currently trading.
 *
 * Usage:
 *   node scripts/backtest-live-params.mjs [--days 30] [--cost 120]
 */

import 'dotenv/config';

const COINGECKO_BASE_URL = 'https://api.coingecko.com/api/v3';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const DAYS = Number(getArg('--days', '30'));
const ROUND_TRIP_COST_BPS = Number(getArg('--cost', '120')); // proven from live data

// CoinGecko IDs for the tokens our bots actually trade
const TOKENS = [
  { id: 'jupiter-exchange-solana', symbol: 'JUP', mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' },
  { id: 'jito-governance-token', symbol: 'JTO', mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL' },
  { id: 'orca', symbol: 'ORCA', mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE' },
  { id: 'kamino', symbol: 'KMNO', mint: 'KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS' },
  { id: 'helium', symbol: 'HNT', mint: 'hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux' },
  { id: 'pyth-network', symbol: 'PYTH', mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3' },
  { id: 'raydium', symbol: 'RAY', mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R' },
  { id: 'render-token', symbol: 'RENDER', mint: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof' },
  { id: 'drift-protocol', symbol: 'DRIFT', mint: 'DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7' },
  { id: 'solana', symbol: 'SOL', mint: 'So11111111111111111111111111111111111111112' },
  { id: 'marinade', symbol: 'MSOL', mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So' },
  { id: 'bonk', symbol: 'BONK', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
];

// ─── ACTUAL LIVE PARAMETERS (from runtime-config defaults) ──────────────────
const LIVE_PARAMS = {
  // Signal
  momentumLookbackSamples: 2,
  momentumThresholdBps: 2,

  // Bollinger (mean_reversion)
  bollingerLength: 20,
  bollingerStdMult: 2.0,
  bollingerMinBandWidth: 0.006,
  bollingerEntryThreshold: 0.0,
  bollingerExitThreshold: 0.5,

  // Supertrend
  supertrendCandleSamples: 14,
  supertrendAtrPeriod: 14,
  supertrendMultiplier: 3.0,

  // Exit thresholds
  takeProfitBps: 30,
  stopLossBps: 20,
  trailingStopBps: 15,
  atrTakeProfitMultiplier: 1.8,
  atrStopLossMultiplier: 1.0,
  atrTrailingStopMultiplier: 0.8,
  exitCostFloorBps: 60,

  // TP time decay
  tpDecayStartMs: 90_000,
  tpDecayFullMs: 900_000,
};

// ─── Data Fetching ──────────────────────────────────────────────────────────
async function fetchOHLC(coingeckoId, days) {
  const url = `${COINGECKO_BASE_URL}/coins/${coingeckoId}/ohlc?vs_currency=usd&days=${days}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`CoinGecko ${coingeckoId}: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
}

// ─── Indicators ──────────────────────────────────────────────────────────────

// Momentum: simple price change over lookback
function computeMomentumSignal(prices, idx, lookback, thresholdBps) {
  if (idx < lookback) return { regime: 'flat', momentumBps: 0 };
  const prior = prices[idx - lookback];
  const current = prices[idx];
  if (prior <= 0) return { regime: 'flat', momentumBps: 0 };
  const momentumBps = Math.round(((current - prior) / prior) * 10000);
  if (momentumBps > thresholdBps) return { regime: 'bullish', momentumBps };
  if (momentumBps < -thresholdBps) return { regime: 'bearish', momentumBps };
  return { regime: 'flat', momentumBps };
}

// Bollinger Bands
function computeBollinger(prices, idx, length, stdMult) {
  if (idx < length) return null;
  const window = prices.slice(idx - length + 1, idx + 1);
  const sma = window.reduce((s, p) => s + p, 0) / length;
  if (sma <= 0) return null;
  const variance = window.reduce((s, p) => s + (p - sma) ** 2, 0) / length;
  const std = Math.sqrt(variance);
  const upper = sma + stdMult * std;
  const lower = sma - stdMult * std;
  const range = upper - lower;
  const bbp = range > 0 ? (prices[idx] - lower) / range : 0.5;
  const bandWidth = (upper - lower) / sma;
  return { sma, upper, lower, bbp, bandWidth };
}

function bollingerSignal(prices, idx, params) {
  const bb = computeBollinger(prices, idx, params.bollingerLength, params.bollingerStdMult);
  if (!bb) return { regime: 'flat', momentumBps: 0 };
  if (bb.bandWidth < params.bollingerMinBandWidth) return { regime: 'flat', momentumBps: 0 };
  if (bb.bbp < params.bollingerEntryThreshold) return { regime: 'bullish', momentumBps: Math.round((0.5 - bb.bbp) * 5000) };
  if (bb.bbp > params.bollingerExitThreshold) return { regime: 'bearish', momentumBps: Math.round((bb.bbp - 0.5) * -5000) };
  return { regime: 'flat', momentumBps: 0 };
}

// Supertrend
function computeATR(candles, period) {
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const cur = candles[i];
    trs.push(Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c)));
  }
  const atrs = new Array(trs.length).fill(0);
  let sum = 0;
  for (let i = 0; i < Math.min(period, trs.length); i++) sum += trs[i];
  if (period <= trs.length) atrs[period - 1] = sum / period;
  for (let i = period; i < trs.length; i++) {
    atrs[i] = (atrs[i - 1] * (period - 1) + trs[i]) / period;
  }
  return { trs, atrs };
}

function supertrendAtCandle(candles, atrPeriod, multiplier) {
  // Returns per-candle direction array
  const { atrs } = computeATR(candles, atrPeriod);
  const directions = new Array(candles.length).fill(0); // 1=up, -1=down
  let upperBand = 0, lowerBand = 0;
  let prevUpper = 0, prevLower = 0;
  let dir = 1;

  for (let i = atrPeriod; i < candles.length; i++) {
    const atr = atrs[i - 1] || 0;
    if (atr === 0) { directions[i] = dir; continue; }
    const c = candles[i];
    const hl2 = (c.h + c.l) / 2;
    const bU = hl2 + multiplier * atr;
    const bL = hl2 - multiplier * atr;
    upperBand = (bU < prevUpper || candles[i - 1].c > prevUpper) ? bU : prevUpper;
    lowerBand = (bL > prevLower || candles[i - 1].c < prevLower) ? bL : prevLower;
    if (c.c > upperBand) dir = 1;
    else if (c.c < lowerBand) dir = -1;
    directions[i] = dir;
    prevUpper = upperBand;
    prevLower = lowerBand;
  }
  return directions;
}

// ─── Strategy Backtester ────────────────────────────────────────────────────

function backtestStrategy(candles, strategy, params, costBps) {
  const prices = candles.map(c => c.c);
  const trades = [];
  let position = null; // { entryPrice, entryIdx, highSinceEntry }

  // Pre-compute supertrend directions
  const stDirs = strategy === 'supertrend'
    ? supertrendAtCandle(candles, params.supertrendAtrPeriod, params.supertrendMultiplier)
    : null;

  for (let i = 1; i < candles.length; i++) {
    const price = prices[i];
    if (price <= 0) continue;

    // ── Entry check ──
    if (!position) {
      let signal;
      if (strategy === 'momentum') {
        signal = computeMomentumSignal(prices, i, params.momentumLookbackSamples, params.momentumThresholdBps);
      } else if (strategy === 'mean_reversion') {
        signal = bollingerSignal(prices, i, params);
      } else {
        // supertrend: enter on flip to bullish
        const prevDir = stDirs[i - 1];
        const curDir = stDirs[i];
        signal = {
          regime: curDir === 1 && prevDir === -1 ? 'bullish' : (curDir === 1 ? 'flat' : 'bearish'),
          momentumBps: 0,
        };
      }

      if (signal.regime === 'bullish') {
        position = { entryPrice: price, entryIdx: i, highSinceEntry: price };
      }
      continue;
    }

    // ── Exit check ──
    position.highSinceEntry = Math.max(position.highSinceEntry, candles[i].h);
    const pnlBps = Math.round((price / position.entryPrice - 1) * 10000);
    const holdCandles = i - position.entryIdx;
    const drawdownFromHigh = Math.round((price / position.highSinceEntry - 1) * 10000);

    // Compute ATR-based thresholds (rough approximation using recent candles)
    const recentCandles = candles.slice(Math.max(0, i - 20), i + 1);
    let atrBps = 0;
    if (recentCandles.length > 5) {
      const trs = [];
      for (let j = 1; j < recentCandles.length; j++) {
        trs.push(Math.max(
          recentCandles[j].h - recentCandles[j].l,
          Math.abs(recentCandles[j].h - recentCandles[j - 1].c),
          Math.abs(recentCandles[j].l - recentCandles[j - 1].c),
        ));
      }
      const avgTr = trs.reduce((s, t) => s + t, 0) / trs.length;
      atrBps = price > 0 ? Math.round((avgTr / price) * 10000) : 0;
    }

    // Dynamic thresholds (matching worker logic)
    const effectiveTP = Math.max(
      params.exitCostFloorBps,
      atrBps > 0 ? Math.round(atrBps * params.atrTakeProfitMultiplier) : params.takeProfitBps,
    );
    const effectiveSL = atrBps > 0
      ? Math.max(params.stopLossBps, Math.round(atrBps * params.atrStopLossMultiplier))
      : params.stopLossBps;
    const effectiveTrail = Math.max(
      params.exitCostFloorBps,
      atrBps > 0 ? Math.round(atrBps * params.atrTrailingStopMultiplier) : params.trailingStopBps,
    );

    let exitReason = null;

    // Take profit
    if (pnlBps >= effectiveTP) exitReason = 'take_profit';
    // Stop loss
    else if (pnlBps <= -effectiveSL) exitReason = 'stop_loss';
    // Trailing stop (only when in profit)
    else if (pnlBps > 0 && drawdownFromHigh <= -effectiveTrail) exitReason = 'trailing_stop';
    // Signal reversal
    else if (strategy === 'supertrend' && stDirs[i] === -1 && stDirs[i - 1] === 1) exitReason = 'signal_reversal';

    if (exitReason) {
      const netPnlBps = pnlBps - costBps; // subtract round-trip cost
      trades.push({
        entryPrice: position.entryPrice,
        exitPrice: price,
        grossPnlBps: pnlBps,
        netPnlBps,
        holdCandles,
        exitReason,
        effectiveTP,
        effectiveSL,
        atrBps,
      });
      position = null;
    }
  }

  // Close open position at end
  if (position) {
    const price = prices[prices.length - 1];
    const pnlBps = Math.round((price / position.entryPrice - 1) * 10000);
    trades.push({
      entryPrice: position.entryPrice,
      exitPrice: price,
      grossPnlBps: pnlBps,
      netPnlBps: pnlBps - costBps,
      holdCandles: candles.length - 1 - position.entryIdx,
      exitReason: 'end_of_data',
      effectiveTP: 0,
      effectiveSL: 0,
      atrBps: 0,
    });
  }

  return trades;
}

function summarizeTrades(trades) {
  if (trades.length === 0) return null;
  const wins = trades.filter(t => t.netPnlBps > 0);
  const losses = trades.filter(t => t.netPnlBps <= 0);
  const totalNet = trades.reduce((s, t) => s + t.netPnlBps, 0);
  const totalGross = trades.reduce((s, t) => s + t.grossPnlBps, 0);
  const byReason = {};
  for (const t of trades) {
    byReason[t.exitReason] = (byReason[t.exitReason] || 0) + 1;
  }
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: (wins.length / trades.length * 100).toFixed(1),
    totalGrossBps: totalGross,
    totalNetBps: totalNet,
    avgNetBps: (totalNet / trades.length).toFixed(1),
    avgGrossBps: (totalGross / trades.length).toFixed(1),
    avgWinBps: wins.length > 0 ? (wins.reduce((s, t) => s + t.netPnlBps, 0) / wins.length).toFixed(1) : '0',
    avgLossBps: losses.length > 0 ? (losses.reduce((s, t) => s + t.netPnlBps, 0) / losses.length).toFixed(1) : '0',
    maxDrawdown: Math.min(...trades.map(t => t.netPnlBps)),
    exitReasons: byReason,
  };
}

// ─── Parameter sweep ─────────────────────────────────────────────────────────
function paramSweep(candles, strategy, costBps) {
  const sweepParams = {
    stopLossBps: [20, 50, 80, 100, 150, 200, 300],
    takeProfitBps: [30, 60, 100, 150, 200, 300, 500],
    trailingStopBps: [0, 15, 50, 100, 150],
    atrStopLossMultiplier: [1.0, 1.5, 2.0, 3.0],
    atrTakeProfitMultiplier: [1.0, 1.5, 1.8, 2.5, 3.0],
  };

  const results = [];
  for (const sl of sweepParams.stopLossBps) {
    for (const tp of sweepParams.takeProfitBps) {
      for (const trail of sweepParams.trailingStopBps) {
        for (const atrSL of sweepParams.atrStopLossMultiplier) {
          for (const atrTP of sweepParams.atrTakeProfitMultiplier) {
            const params = {
              ...LIVE_PARAMS,
              stopLossBps: sl,
              takeProfitBps: tp,
              trailingStopBps: trail,
              atrStopLossMultiplier: atrSL,
              atrTakeProfitMultiplier: atrTP,
            };
            const trades = backtestStrategy(candles, strategy, params, costBps);
            const summary = summarizeTrades(trades);
            if (summary && summary.trades >= 3) {
              results.push({ sl, tp, trail, atrSL, atrTP, ...summary });
            }
          }
        }
      }
    }
  }
  return results;
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('='.repeat(80));
  console.log('ROGUEZERO STRATEGY BACKTESTER — ALL 3 STRATEGIES');
  console.log(`Days: ${DAYS} | Round-trip cost: ${ROUND_TRIP_COST_BPS} bps | Tokens: ${TOKENS.length}`);
  console.log('='.repeat(80));

  // ── Phase 1: Fetch data ──
  const tokenCandles = new Map();
  for (const token of TOKENS) {
    try {
      process.stdout.write(`  Fetching ${token.symbol}...`);
      const candles = await fetchOHLC(token.id, DAYS);
      if (candles.length < 20) {
        console.log(` only ${candles.length} candles, skip`);
        continue;
      }
      tokenCandles.set(token.symbol, candles);
      console.log(` ${candles.length} candles`);
      await sleep(6500); // free tier: ~10 req/min
    } catch (e) {
      console.log(` FAIL: ${e.message}`);
    }
  }

  if (tokenCandles.size === 0) {
    console.error('\nNo data. Exiting.');
    process.exit(1);
  }

  // ── Phase 2: Test CURRENT LIVE params on each strategy ──
  console.log('\n' + '='.repeat(80));
  console.log('PHASE 2: CURRENT LIVE PARAMS vs HISTORICAL DATA');
  console.log(`  SL=${LIVE_PARAMS.stopLossBps} TP=${LIVE_PARAMS.takeProfitBps} Trail=${LIVE_PARAMS.trailingStopBps}`);
  console.log(`  ATR SL mult=${LIVE_PARAMS.atrStopLossMultiplier} ATR TP mult=${LIVE_PARAMS.atrTakeProfitMultiplier}`);
  console.log(`  Cost floor=${LIVE_PARAMS.exitCostFloorBps} bps`);
  console.log('='.repeat(80));

  for (const strategy of ['momentum', 'mean_reversion', 'supertrend']) {
    console.log(`\n── Strategy: ${strategy.toUpperCase()} ──`);
    let allTrades = [];
    for (const [symbol, candles] of tokenCandles) {
      const trades = backtestStrategy(candles, strategy, LIVE_PARAMS, ROUND_TRIP_COST_BPS);
      const s = summarizeTrades(trades);
      if (s) {
        console.log(
          `  ${symbol.padEnd(8)} ${String(s.trades).padStart(4)} trades | ` +
          `win ${s.winRate.padStart(5)}% | gross ${String(s.totalGrossBps).padStart(6)} bps | ` +
          `net ${String(s.totalNetBps).padStart(6)} bps | avgNet ${s.avgNetBps.padStart(6)} bps | ` +
          `exits: ${Object.entries(s.exitReasons).map(([k, v]) => `${k}=${v}`).join(' ')}`
        );
        allTrades.push(...trades);
      } else {
        console.log(`  ${symbol.padEnd(8)} no trades`);
      }
    }
    const total = summarizeTrades(allTrades);
    if (total) {
      console.log(`  ${'TOTAL'.padEnd(8)} ${String(total.trades).padStart(4)} trades | ` +
        `win ${total.winRate.padStart(5)}% | gross ${String(total.totalGrossBps).padStart(6)} bps | ` +
        `net ${String(total.totalNetBps).padStart(6)} bps | avgNet ${total.avgNetBps.padStart(6)} bps`);
      console.log(`  Exit breakdown: ${Object.entries(total.exitReasons).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    }
  }

  // ── Phase 3: Parameter sweep to find best params ──
  console.log('\n' + '='.repeat(80));
  console.log('PHASE 3: PARAMETER SWEEP — Finding what actually works');
  console.log(`  Testing ${7 * 7 * 5 * 4 * 5} parameter combos × 3 strategies`);
  console.log('='.repeat(80));

  for (const strategy of ['momentum', 'mean_reversion', 'supertrend']) {
    console.log(`\n── Sweep: ${strategy.toUpperCase()} ──`);

    // Aggregate across all tokens
    const combinedCandles = [];
    // Run per-token and aggregate
    const paramScores = new Map();

    for (const [symbol, candles] of tokenCandles) {
      const results = paramSweep(candles, strategy, ROUND_TRIP_COST_BPS);
      for (const r of results) {
        const key = `${r.sl}|${r.tp}|${r.trail}|${r.atrSL}|${r.atrTP}`;
        const existing = paramScores.get(key) || { ...r, totalNetBps: 0, totalTrades: 0, totalWins: 0, tokens: 0 };
        existing.totalNetBps += r.totalNetBps;
        existing.totalTrades += r.trades;
        existing.totalWins += r.wins;
        existing.tokens++;
        paramScores.set(key, existing);
      }
    }

    // Sort by net PnL per trade (not total — avoids bias toward high-churn params)
    const sorted = [...paramScores.values()]
      .filter(r => r.totalTrades >= 10 && r.tokens >= 3)
      .sort((a, b) => (b.totalNetBps / b.totalTrades) - (a.totalNetBps / a.totalTrades));

    if (sorted.length === 0) {
      console.log('  No valid results (need >= 10 trades across >= 3 tokens)');
      continue;
    }

    console.log('  TOP 10 (by avg net PnL/trade):');
    console.log('  ' + 'Rank'.padEnd(5) + 'SL'.padEnd(6) + 'TP'.padEnd(6) + 'Trail'.padEnd(7) +
      'ATR_SL'.padEnd(7) + 'ATR_TP'.padEnd(7) + 'NetBps'.padEnd(9) + 'Trades'.padEnd(8) +
      'AvgNet'.padEnd(8) + 'WinRate'.padEnd(9) + 'Tokens');
    console.log('  ' + '-'.repeat(72));

    for (let i = 0; i < Math.min(10, sorted.length); i++) {
      const r = sorted[i];
      const avgNet = (r.totalNetBps / r.totalTrades).toFixed(1);
      const winRate = (r.totalWins / r.totalTrades * 100).toFixed(1);
      console.log(
        '  ' + String(i + 1).padEnd(5) +
        String(r.sl).padEnd(6) +
        String(r.tp).padEnd(6) +
        String(r.trail).padEnd(7) +
        r.atrSL.toFixed(1).padEnd(7) +
        r.atrTP.toFixed(1).padEnd(7) +
        String(r.totalNetBps).padEnd(9) +
        String(r.totalTrades).padEnd(8) +
        avgNet.padEnd(8) +
        winRate.padEnd(9) +
        String(r.tokens)
      );
    }

    // Show worst 3
    console.log('\n  WORST 3:');
    const worst = sorted.slice(-3);
    for (const r of worst) {
      const avgNet = (r.totalNetBps / r.totalTrades).toFixed(1);
      console.log(
        `    SL=${r.sl} TP=${r.tp} trail=${r.trail} atrSL=${r.atrSL} atrTP=${r.atrTP} → ` +
        `net=${r.totalNetBps} trades=${r.totalTrades} avgNet=${avgNet}`
      );
    }

    // Compare current params
    const currentKey = `${LIVE_PARAMS.stopLossBps}|${LIVE_PARAMS.takeProfitBps}|${LIVE_PARAMS.trailingStopBps}|${LIVE_PARAMS.atrStopLossMultiplier}|${LIVE_PARAMS.atrTakeProfitMultiplier}`;
    const currentResult = paramScores.get(currentKey);
    console.log('\n  CURRENT LIVE PARAMS:');
    if (currentResult) {
      const avgNet = (currentResult.totalNetBps / currentResult.totalTrades).toFixed(1);
      const winRate = (currentResult.totalWins / currentResult.totalTrades * 100).toFixed(1);
      console.log(
        `    SL=${LIVE_PARAMS.stopLossBps} TP=${LIVE_PARAMS.takeProfitBps} trail=${LIVE_PARAMS.trailingStopBps} → ` +
        `net=${currentResult.totalNetBps} trades=${currentResult.totalTrades} avgNet=${avgNet} win=${winRate}%`
      );
    } else {
      console.log('    (not enough trades in sweep to evaluate)');
    }

    if (sorted.length > 0) {
      const best = sorted[0];
      console.log(`\n  BEST for ${strategy}: SL=${best.sl} TP=${best.tp} trail=${best.trail} ` +
        `atrSL=${best.atrSL} atrTP=${best.atrTP}`);
      console.log(`  Expected: ${(best.totalNetBps / best.totalTrades).toFixed(1)} bps/trade net, ` +
        `${(best.totalWins / best.totalTrades * 100).toFixed(1)}% win rate, ${best.totalTrades} trades`);
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('DONE. Use these results to update WORKER_* env vars.');
  console.log('='.repeat(80));
}

main().catch(e => { console.error(e); process.exit(1); });
