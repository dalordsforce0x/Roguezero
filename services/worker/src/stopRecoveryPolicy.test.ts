import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSessionSolSweepLamports,
  getResidualTokenAccounts,
  hasResidualWalletState,
  isBrickedResidualWallet,
  type WalletSweepSnapshot,
} from './stopRecoveryPolicy.js';

const TX_FEE_LAMPORTS = 5_000;

test('computeSessionSolSweepLamports never drains SOL when valued residual tokens may remain', () => {
  const solToSweep = computeSessionSolSweepLamports({
    solBalance: 2_039_280,
    ownerAtaCreationCost: 0,
    txFeeLamports: TX_FEE_LAMPORTS,
    mayLeaveResidualState: true,
  });

  assert.equal(solToSweep, 0);
});

test('computeSessionSolSweepLamports drains only spendable SOL when no residual token risk remains', () => {
  const solToSweep = computeSessionSolSweepLamports({
    solBalance: 2_039_280,
    ownerAtaCreationCost: 0,
    txFeeLamports: TX_FEE_LAMPORTS,
    mayLeaveResidualState: false,
  });

  assert.equal(solToSweep, 2_034_280);
});

test('computeSessionSolSweepLamports never returns a negative transfer amount', () => {
  const solToSweep = computeSessionSolSweepLamports({
    solBalance: 1_000,
    ownerAtaCreationCost: 0,
    txFeeLamports: TX_FEE_LAMPORTS,
    mayLeaveResidualState: false,
  });

  assert.equal(solToSweep, 0);
});

test('isBrickedResidualWallet identifies zero-gas token residual that must not loop in stopping', () => {
  const snapshot: WalletSweepSnapshot = {
    solBalance: 0,
    tokenProgramAccounts: ['AbYg67jNv8iqEWco6Gh9m91SsFLG2sBKHyKiihvJj1P4'],
    token2022Accounts: [],
  };

  assert.equal(hasResidualWalletState(snapshot), true);
  assert.deepEqual(getResidualTokenAccounts(snapshot), ['AbYg67jNv8iqEWco6Gh9m91SsFLG2sBKHyKiihvJj1P4']);
  assert.equal(isBrickedResidualWallet(snapshot, TX_FEE_LAMPORTS), true);
});

test('isBrickedResidualWallet treats residual SOL without tokens as retryable/normal sweep state', () => {
  const snapshot: WalletSweepSnapshot = {
    solBalance: 1_000,
    tokenProgramAccounts: [],
    token2022Accounts: [],
  };

  assert.equal(hasResidualWalletState(snapshot), true);
  assert.equal(isBrickedResidualWallet(snapshot, TX_FEE_LAMPORTS), false);
});

test('isBrickedResidualWallet treats fee-capable token residual as retryable instead of unrecoverable', () => {
  const snapshot: WalletSweepSnapshot = {
    solBalance: TX_FEE_LAMPORTS,
    tokenProgramAccounts: ['token-account'],
    token2022Accounts: [],
  };

  assert.equal(isBrickedResidualWallet(snapshot, TX_FEE_LAMPORTS), false);
});
