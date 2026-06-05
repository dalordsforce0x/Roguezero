import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAtrFromTape,
  getNextStrategyInSequence,
  getStrategyScanOrder,
  type PriceSample,
} from './strategies.js';

const buildTape = (prices: number[]): PriceSample[] => prices.map((usdPrice, index) => ({
  usdPrice,
  sampledAt: new Date(Date.UTC(2026, 5, 4, 0, 0, index)).toISOString(),
}));

test('computeAtrFromTape returns ATR USD and bps from enough samples', () => {
  const prices = Array.from({ length: 60 }, (_, index) => 100 + Math.sin(index / 3) * 2 + index * 0.05);
  const atr = computeAtrFromTape(buildTape(prices), {
    candleSamples: 5,
    atrPeriod: 5,
    multiplier: 3,
  });

  assert.ok(atr, 'ATR should be computed once tape has enough candles');
  assert.ok(atr.atrUsd > 0);
  assert.ok(atr.atrBps > 0);
  assert.equal(atr.candleCount, 12);
});

test('computeAtrFromTape returns null while tape is warming up', () => {
  const atr = computeAtrFromTape(buildTape([100, 101, 102, 103]), {
    candleSamples: 5,
    atrPeriod: 5,
    multiplier: 3,
  });

  assert.equal(atr, null);
});

test('getStrategyScanOrder starts from current strategy and wraps in fixed sequence', () => {
  assert.deepEqual(
    getStrategyScanOrder('mean_reversion', ['momentum', 'mean_reversion', 'supertrend']),
    ['mean_reversion', 'supertrend', 'momentum'],
  );
});

test('getNextStrategyInSequence advances after a strategy opens a trade', () => {
  assert.equal(getNextStrategyInSequence('momentum', ['momentum', 'mean_reversion', 'supertrend']), 'mean_reversion');
  assert.equal(getNextStrategyInSequence('mean_reversion', ['momentum', 'mean_reversion', 'supertrend']), 'supertrend');
  assert.equal(getNextStrategyInSequence('supertrend', ['momentum', 'mean_reversion', 'supertrend']), 'momentum');
});

test('strategy scan skips disabled strategies without changing global order', () => {
  assert.deepEqual(getStrategyScanOrder('momentum', ['momentum', 'supertrend']), ['momentum', 'supertrend']);
  assert.equal(getNextStrategyInSequence('momentum', ['momentum', 'supertrend']), 'supertrend');
});
