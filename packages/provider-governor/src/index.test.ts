import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBucketState,
  computeBudgetState,
  getExponentialBackoffDelayMs,
  getUtcMonthWindow,
} from './index.js';

test('computeBucketState grants token when capacity is available', () => {
  const state = computeBucketState({
    availableTokens: 5,
    elapsedMs: 0,
    maxTokens: 10,
    refillRatePerSec: 5,
  });

  assert.equal(state.granted, true);
  assert.equal(state.availableTokens, 4);
  assert.equal(state.waitMs, 0);
});

test('computeBucketState refills tokens over elapsed time', () => {
  const state = computeBucketState({
    availableTokens: 0,
    elapsedMs: 500,
    maxTokens: 10,
    refillRatePerSec: 4,
  });

  assert.equal(state.granted, true);
  assert.equal(state.availableTokens, 1);
  assert.equal(state.waitMs, 0);
});

test('computeBucketState returns wait time when bucket is empty', () => {
  const state = computeBucketState({
    availableTokens: 0.25,
    elapsedMs: 0,
    maxTokens: 10,
    refillRatePerSec: 2,
  });

  assert.equal(state.granted, false);
  assert.equal(state.availableTokens, 0.25);
  assert.equal(state.waitMs, 375);
});

test('getExponentialBackoffDelayMs applies bounded jitter', () => {
  const delay = getExponentialBackoffDelayMs(3, {
    initialDelayMs: 1000,
    maxDelayMs: 30_000,
    jitterRatio: 0.25,
    random: () => 1,
  });

  assert.equal(delay, 5000);
});

test('computeBudgetState reports normal pressure under projected monthly budget', () => {
  const now = new Date('2026-06-15T00:00:00.000Z');
  const { periodStart, periodEnd } = getUtcMonthWindow(now);
  const state = computeBudgetState({
    usedUnits: 100,
    reserveUnits: 10,
    monthlyLimitUnits: 1_000,
    now,
    periodStart,
    periodEnd,
  });

  assert.equal(state.granted, true);
  assert.equal(state.pressure, 'normal');
  assert.equal(state.usedUnits, 110);
});

test('computeBudgetState throttles when projected burn is too high', () => {
  const now = new Date('2026-06-03T00:00:00.000Z');
  const { periodStart, periodEnd } = getUtcMonthWindow(now);
  const state = computeBudgetState({
    usedUnits: 300,
    reserveUnits: 1,
    monthlyLimitUnits: 1_000,
    now,
    periodStart,
    periodEnd,
  });

  assert.equal(state.granted, true);
  assert.equal(state.pressure, 'throttle');
  assert.ok(state.projectedUsageRatio > 1.1);
});

test('computeBudgetState halts when the monthly limit would be exceeded', () => {
  const now = new Date('2026-06-30T00:00:00.000Z');
  const { periodStart, periodEnd } = getUtcMonthWindow(now);
  const state = computeBudgetState({
    usedUnits: 999,
    reserveUnits: 2,
    monthlyLimitUnits: 1_000,
    now,
    periodStart,
    periodEnd,
  });

  assert.equal(state.granted, false);
  assert.equal(state.pressure, 'halt');
  assert.equal(state.remainingUnits, 0);
});
