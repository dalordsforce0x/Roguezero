// Part B: candle-backed price tape into scorer/shape/ATR + anti-churn min-hold.
const fs = require('fs');
const path = 'services/worker/src/index.ts';
let src = fs.readFileSync(path, 'utf8');
const L = (...lines) => lines.join('\n');
const edits = [];

// 1) env knobs appended to the gecko config block (Part A inserted this line)
edits.push({
  name: 'env-knobs',
  old: `const GECKO_CANDLE_RPM = Math.max(1, Math.min(28, Number(process.env.WORKER_GECKO_CANDLE_RPM ?? 20)));`,
  new: L(
    `const GECKO_CANDLE_RPM = Math.max(1, Math.min(28, Number(process.env.WORKER_GECKO_CANDLE_RPM ?? 20)));`,
    `const GECKO_CANDLE_MIN_SAMPLES = Math.max(5, Number(process.env.WORKER_GECKO_CANDLE_MIN_SAMPLES ?? 30));`,
    `// Anti-churn: backtest showed sub-2-min stop_loss exits are ~all losers (-146bps,`,
    `// 3.4% win) -- we stop out inside entry-slippage noise. Hold past the window unless`,
    `// the loss is a genuine blowout past the hard floor.`,
    `const WORKER_ANTI_CHURN_MIN_HOLD_MS = Math.max(0, Number(process.env.WORKER_ANTI_CHURN_MIN_HOLD_MS ?? 120_000));`,
    `const WORKER_ANTI_CHURN_HARD_STOP_BPS = Math.max(0, Number(process.env.WORKER_ANTI_CHURN_HARD_STOP_BPS ?? 250));`,
  ),
});

// 2) candle-backed tape helper, right after getMomentumTapeForMint
edits.push({
  name: 'tape-helper',
  old: L(
    `const getMomentumTapeForMint = (mint: string): readonly MarketTapePoint[] => {`,
    `  if (mint === SOL_MINT) {`,
    `    return sharedMarketTape.solUsdPyth;`,
    `  }`,
    `  return jupiterMomentumTapeByMint.get(mint) ?? [];`,
    `};`,
  ),
  new: L(
    `const getMomentumTapeForMint = (mint: string): readonly MarketTapePoint[] => {`,
    `  if (mint === SOL_MINT) {`,
    `    return sharedMarketTape.solUsdPyth;`,
    `  }`,
    `  return jupiterMomentumTapeByMint.get(mint) ?? [];`,
    `};`,
    ``,
    `// Prefer real 1-min GeckoTerminal candle history for shape/ATR decisions on`,
    `// non-SOL majors. The live Jupiter tape for these tokens is a thin ~60s drift`,
    `// poll -- too short to build an ATR (needs ~120 samples) or a meaningful shape,`,
    `// so the scorer/cost gate were blind and failed open. Candles give the exact`,
    `// 1-min series the entry-shape calibration proved predictive. Falls back to the`,
    `// live tape when candles are missing/stale so behavior is never worse than before.`,
    `const getCandleBackedPriceTape = (`,
    `  mint: string,`,
    `): readonly { usdPrice: number; sampledAt: string }[] => {`,
    `  if (mint === SOL_MINT) {`,
    `    return sharedMarketTape.solUsdPyth;`,
    `  }`,
    `  if (GECKO_CANDLES_ENABLED && geckoCandleFeed.hasFreshCandles(mint)) {`,
    `    const candles = geckoCandleFeed.getTape(mint);`,
    `    if (candles.length >= GECKO_CANDLE_MIN_SAMPLES) {`,
    `      return candles;`,
    `    }`,
    `  }`,
    `  return getMomentumTapeForMint(mint);`,
    `};`,
  ),
});

// 3) exit ATR uses candle-backed tape for non-SOL
edits.push({
  name: 'exit-atr',
  old: L(
    `    const atr = computeAtrFromTape(`,
    `      mint === SOL_MINT`,
    `        ? sharedMarketTape.solUsdPyth`,
    `        : getMomentumTapeForMint(mint),`,
    `      strategyConfig.supertrend,`,
    `    );`,
  ),
  new: L(
    `    const atr = computeAtrFromTape(`,
    `      mint === SOL_MINT`,
    `        ? sharedMarketTape.solUsdPyth`,
    `        : getCandleBackedPriceTape(mint),`,
    `      strategyConfig.supertrend,`,
    `    );`,
  ),
});

// 4) entry-quality scorer prices use candle-backed tape
edits.push({
  name: 'scorer-prices',
  old: `      const entryQualityPrices = getMomentumTapeForMint(selectedEntryMint).map((sample) => sample.usdPrice);`,
  new: `      const entryQualityPrices = getCandleBackedPriceTape(selectedEntryMint).map((sample) => sample.usdPrice);`,
});

// 5) trending shape gate prices use candle-backed tape
edits.push({
  name: 'shape-prices',
  old: `        prices: getMomentumTapeForMint(selectedEntryMint).map((sample) => sample.usdPrice),`,
  new: `        prices: getCandleBackedPriceTape(selectedEntryMint).map((sample) => sample.usdPrice),`,
});

// 6) evaluateExitTrigger: compute position age
edits.push({
  name: 'exit-age',
  old: L(
    `  const thresholds = computeDynamicExitThresholds(session, positionState, signalSnapshot);`,
    ``,
    `  if (pnlBps !== null && pnlBps >= thresholds.takeProfitBps) {`,
  ),
  new: L(
    `  const thresholds = computeDynamicExitThresholds(session, positionState, signalSnapshot);`,
    `  const exitEntryAtMs = positionState.entryAt ? Date.parse(positionState.entryAt) : NaN;`,
    `  const positionAgeMs = Number.isFinite(exitEntryAtMs)`,
    `    ? Math.max(0, Date.now() - exitEntryAtMs)`,
    `    : Number.POSITIVE_INFINITY;`,
    ``,
    `  if (pnlBps !== null && pnlBps >= thresholds.takeProfitBps) {`,
  ),
});

// 7) anti-churn min-hold guard on stop_loss
edits.push({
  name: 'anti-churn-stop',
  old: L(
    `  if (pnlBps !== null && pnlBps <= -thresholds.stopLossBps) {`,
    `    return {`,
    `      shouldExit: true,`,
    `      reason: 'stop_loss',`,
    `      markPriceUsd,`,
    `      pnlBps,`,
    `      trailingDrawdownBps,`,
    `      thresholds,`,
    `    };`,
    `  }`,
  ),
  new: L(
    `  if (pnlBps !== null && pnlBps <= -thresholds.stopLossBps) {`,
    `    // Anti-churn: suppress the stop inside the min-hold window unless the loss is a`,
    `    // genuine blowout past the hard floor. Recovering positions then exit via`,
    `    // take_profit/trailing; true disasters still cut immediately.`,
    `    const withinAntiChurnHold = WORKER_ANTI_CHURN_MIN_HOLD_MS > 0`,
    `      && positionAgeMs < WORKER_ANTI_CHURN_MIN_HOLD_MS`,
    `      && pnlBps > -WORKER_ANTI_CHURN_HARD_STOP_BPS;`,
    `    if (!withinAntiChurnHold) {`,
    `      return {`,
    `        shouldExit: true,`,
    `        reason: 'stop_loss',`,
    `        markPriceUsd,`,
    `        pnlBps,`,
    `        trailingDrawdownBps,`,
    `        thresholds,`,
    `      };`,
    `    }`,
    `  }`,
  ),
});

for (const e of edits) {
  const count = src.split(e.old).length - 1;
  if (count !== 1) {
    console.error(`FAIL ${e.name}: expected 1 occurrence, found ${count}`);
    process.exit(1);
  }
  src = src.split(e.old).join(e.new);
  console.log(`OK ${e.name}`);
}

fs.writeFileSync(path, src, 'utf8');
console.log('Part B wiring applied.');
