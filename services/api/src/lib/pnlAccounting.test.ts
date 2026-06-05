import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSolInputEntryPriceUsd,
  computeTokenToSolRealizedPnlUsd,
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
