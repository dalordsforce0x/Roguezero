import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSessionServiceControl, type SessionServiceControl } from '@roguezero/session-schema';

const baseServiceControl: SessionServiceControl = {
  executionVenue: 'jupiter',
  rpcProvider: 'helius',
  platformFeeBps: 30,
  strategyUniverse: [
    { key: 'momentum', version: '1.0.0', enabled: true },
    { key: 'mean_reversion', version: '1.0.0', enabled: true },
    { key: 'supertrend', version: '1.0.0', enabled: true },
  ],
  rotationState: {
    activeStrategy: 'momentum',
    queuedStrategy: 'momentum',
    rotationIntervalMinutes: 15,
    lastRotatedAt: null,
    lockedUntil: null,
  },
  schedulingState: {
    lastTradeAttemptedAt: null,
    lastTradeSubmittedAt: null,
    lastDecisionAt: null,
    lastDecisionOutcome: null,
    lastDecisionReason: null,
    lastBlockedAt: null,
    lastBlockedReason: null,
    blockedReasonCounts: {},
    lastProfitTransferAt: null,
    transferredProfitUsd: 0,
    collectedPerformanceFeeUsd: 0,
    pendingProfitPayout: null,
    recentStopLossLocks: {},
  },
  lastSignal: {
    at: '2026-05-29T19:00:00.000Z',
    source: 'pyth-hermes',
    signal: 'momentum',
    status: 'ready',
    regime: 'bullish',
    lookbackSamples: 3,
    thresholdBps: 1,
    momentumBps: 5,
    guardReason: null,
  },
  positionState: {
    status: 'long_sol',
    positionMint: 'So11111111111111111111111111111111111111112',
    positionSymbol: 'SOL',
    entryStrategy: 'momentum',
    entryPriceUsd: 100,
    entryAt: '2026-05-29T19:00:00.000Z',
    quantityAtomic: '1000000',
    tokenDecimals: 9,
    highWaterPriceUsd: 101,
    lastMarkedPriceUsd: 101,
    lastMarkedAt: '2026-05-29T19:00:05.000Z',
    lastComputedAtrUsd: null,
    lastComputedAtrBps: null,
    atrComputedAt: null,
    maxFavorableBps: null,
    maxAdverseBps: null,
    maxFavorableAt: null,
    maxAdverseAt: null,
    entryQualityScore: null,
    entryQualityBand: null,
    entryCostBps: null,
    measuredExitImpactBps: null,
    pendingExitReason: null,
    partialExitDone: false,
    exitReason: null,
  },
};

test('mergeSessionServiceControl preserves cleared exit reason during later mark updates', () => {
  const merged = mergeSessionServiceControl(baseServiceControl, {
    positionState: {
      highWaterPriceUsd: 102,
      lastMarkedPriceUsd: 102,
      lastMarkedAt: '2026-05-29T19:00:10.000Z',
    },
  });

  assert.equal(merged.positionState?.status, 'long_sol');
  assert.equal(merged.positionState?.exitReason, null);
  assert.equal(merged.positionState?.highWaterPriceUsd, 102);
  assert.equal(merged.positionState?.lastMarkedPriceUsd, 102);
  assert.equal(merged.lastSignal?.status, 'ready');
});

test('mergeSessionServiceControl updates nested state without clobbering unrelated snapshots', () => {
  const merged = mergeSessionServiceControl(baseServiceControl, {
    positionState: {
      pendingExitReason: 'stop_loss',
    },
    schedulingState: {
      lastTradeSubmittedAt: '2026-05-29T19:01:00.000Z',
    },
  });

  assert.equal(merged.positionState?.pendingExitReason, 'stop_loss');
  assert.equal(merged.positionState?.exitReason, null);
  assert.equal(merged.positionState?.entryPriceUsd, 100);
  assert.equal(merged.schedulingState?.lastTradeAttemptedAt, null);
  assert.equal(merged.schedulingState?.lastTradeSubmittedAt, '2026-05-29T19:01:00.000Z');
  assert.equal(merged.lastSignal?.momentumBps, 5);
});
