import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSolInputEntryPriceUsd,
  computeTokenToSolRealizedPnlUsd,
  computeTokenToUsdcRealizedPnlUsd,
} from './pnlAccounting.js';

test('SOL→token entry cost basis uses SOL/USD, not bought-token mark price', () => {
  const spentLamports = 22_979_321; // 0.022979321 SOL
  const outputAtomic = 9_854_154; // 9.854154 JUP at 6 decimals
  const outputDecimals = 6;
  const actualSolUsd = 176.25;
  const boughtTokenMarkUsd = 0.16555815524659753;

  const correctEntry = computeSolInputEntryPriceUsd({
    spentLamports,
    outputAtomic,
    outputDecimals,
    solUsdPrice: actualSolUsd,
  });
  const bogusEntryIfTokenMarkWereUsedAsSolUsd = computeSolInputEntryPriceUsd({
    spentLamports,
    outputAtomic,
    outputDecimals,
    solUsdPrice: boughtTokenMarkUsd,
  });

  assert.ok(correctEntry !== null);
  assert.ok(bogusEntryIfTokenMarkWereUsedAsSolUsd !== null);
  assert.equal(Number(correctEntry.toFixed(6)), 0.411005);
  assert.equal(Number(bogusEntryIfTokenMarkWereUsedAsSolUsd.toFixed(6)), 0.000386);
  assert.ok(correctEntry > boughtTokenMarkUsd, 'this sample is a losing/high-cost entry, not phantom profit');
});

test('token→SOL realized PnL uses SOL/USD proceeds, not sold-token mark as SOL price', () => {
  const pnl = computeTokenToSolRealizedPnlUsd({
    receivedLamports: 20_000_000, // 0.02 SOL
    soldAtomic: 9_854_154, // 9.854154 tokens
    soldDecimals: 6,
    entryPriceUsd: 0.411081,
    solUsdPrice: 176.25,
  });

  assert.ok(pnl !== null);
  assert.equal(Number(pnl.toFixed(6)), -0.525855);
});

test('SOL-denominated accounting refuses missing or invalid SOL/USD instead of fabricating zero-cost PnL', () => {
  assert.equal(computeSolInputEntryPriceUsd({
    spentLamports: 20_000_000,
    outputAtomic: 10_000_000,
    outputDecimals: 6,
    solUsdPrice: 0,
  }), null);

  assert.equal(computeTokenToSolRealizedPnlUsd({
    receivedLamports: 20_000_000,
    soldAtomic: 10_000_000,
    soldDecimals: 6,
    entryPriceUsd: 0.4,
    solUsdPrice: Number.NaN,
  }), null);
});

test('token→USDC realized PnL honors non-6-decimal token quantities', () => {
  const pnl = computeTokenToUsdcRealizedPnlUsd({
    receivedUsdcAtomic: 38_000_000, // $38.00
    soldAtomic: 61_214, // 0.00061214 WBTC at 8 decimals
    soldDecimals: 8,
    entryPriceUsd: 62_635.99176658935,
  });

  assert.ok(pnl !== null);
  assert.equal(Number(pnl.toFixed(6)), -0.341996);
});

test('token→USDC PnL would be wildly wrong if an 8-decimal token defaulted to 6 decimals', () => {
  const correct = computeTokenToUsdcRealizedPnlUsd({
    receivedUsdcAtomic: 38_000_000,
    soldAtomic: 61_214,
    soldDecimals: 8,
    entryPriceUsd: 62_635.99176658935,
  });
  const wrongDefaultSix = computeTokenToUsdcRealizedPnlUsd({
    receivedUsdcAtomic: 38_000_000,
    soldAtomic: 61_214,
    soldDecimals: 6,
    entryPriceUsd: 62_635.99176658935,
  });

  assert.ok(correct !== null);
  assert.ok(wrongDefaultSix !== null);
  assert.ok(Math.abs(wrongDefaultSix) > Math.abs(correct) * 1000);
});
