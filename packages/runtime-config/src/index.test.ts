import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSolEntryCapLamports,
  computeTradeAmountLamports,
  getHeliusRpcUrl,
  getRuntimeSpeedProfile,
  getWorkerFundingThresholds,
  getWorkerSizingPolicy,
} from './index.js';

const baseEnv = {
  SOLANA_NETWORK: 'mainnet-beta',
  HELIUS_API_KEY: 'test-api-key',
  HELIUS_RPC_URL: 'https://mainnet.helius-rpc.com/?api-key=test-api-key',
  JUPITER_API_KEY: 'jupiter-key',
  JUPITER_PLATFORM_FEE_BPS: '35',
  JUPITER_FEE_ACCOUNT_SOL: '8B3zcBMcjpAJeR7ksEeJMiiNrW6dEf1oL3YK2GnQwGGK',
  JUPITER_FEE_ACCOUNT_USDC: 'AYE7gjGL2GrPHmQXieipTfT66CPvzWYu2onkGPWByJmo',
  JUPITER_FEE_ACCOUNT_USDT: 'zo5WxSQEj2feo5JTSoeEbmFdzD5QNdyKZRABpjabeW7',
  KEYAUTH_APP_NAME: 'RogueZero',
  KEYAUTH_OWNER_ID: 'owner',
  KEYAUTH_APP_SECRET: 'secret',
  DATABASE_PROVIDER: 'tigerdata',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/postgres',
  NEXT_PUBLIC_APP_NAME: 'RogueZero',
  NEXT_PUBLIC_SOLANA_NETWORK: 'mainnet-beta',
} satisfies NodeJS.ProcessEnv;

test('getHeliusRpcUrl uses Gatekeeper when enabled', () => {
  assert.equal(
    getHeliusRpcUrl({ ...baseEnv, HELIUS_GATEKEEPER_ENABLED: 'true' }),
    'https://beta.helius-rpc.com/?api-key=test-api-key',
  );
});

test('getHeliusRpcUrl falls back to configured RPC URL when Gatekeeper is disabled', () => {
  assert.equal(getHeliusRpcUrl(baseEnv), baseEnv.HELIUS_RPC_URL);
});

test('computeTradeAmountLamports sizes trade from tradable balance after reserve', () => {
  const thresholds = getWorkerFundingThresholds({
    ...baseEnv,
    WORKER_MAX_ROUTE_SETUP_LAMPORTS: '4078560',
    WORKER_OPERATING_BUFFER_LAMPORTS: '1722879',
    WORKER_TX_FEE_LAMPORTS: '5000',
  });
  const policy = getWorkerSizingPolicy({
    ...baseEnv,
    WORKER_TRADE_FRACTION_BPS: '1000',
    WORKER_MIN_TRADE_LAMPORTS: '1000000',
    WORKER_MAX_TRADE_LAMPORTS: '50000000',
    WORKER_MAX_ROUTE_SETUP_LAMPORTS: '4078560',
    WORKER_OPERATING_BUFFER_LAMPORTS: '1722879',
    WORKER_TX_FEE_LAMPORTS: '5000',
  });

  const decision = computeTradeAmountLamports({
    balanceLamports: 80_000_000,
    thresholds,
    policy,
  });

  assert.equal(decision.skip, false);
  if (!decision.skip) {
    assert.equal(decision.reserveLamports, 5_806_439);
    assert.equal(decision.tradableLamports, 74_193_561);
    assert.equal(decision.targetLamports, 7_419_356);
    assert.equal(decision.amountLamports, 7_419_356);
  }
});

test('computeTradeAmountLamports skips when sized amount is below minimum trade floor', () => {
  const thresholds = getWorkerFundingThresholds({
    ...baseEnv,
    WORKER_MAX_ROUTE_SETUP_LAMPORTS: '4078560',
    WORKER_OPERATING_BUFFER_LAMPORTS: '1722879',
    WORKER_TX_FEE_LAMPORTS: '5000',
  });
  const policy = getWorkerSizingPolicy({
    ...baseEnv,
    WORKER_TRADE_FRACTION_BPS: '1000',
    WORKER_MIN_TRADE_LAMPORTS: '1000000',
    WORKER_MAX_ROUTE_SETUP_LAMPORTS: '4078560',
    WORKER_OPERATING_BUFFER_LAMPORTS: '1722879',
    WORKER_TX_FEE_LAMPORTS: '5000',
  });

  const decision = computeTradeAmountLamports({
    balanceLamports: 15_000_000,
    thresholds,
    policy,
  });

  assert.equal(decision.skip, true);
  if (decision.skip) {
    assert.equal(decision.reason, 'below_min_viable');
    assert.equal(decision.reserveLamports, 5_806_439);
    assert.equal(decision.tradableLamports, 9_193_561);
    assert.equal(decision.targetLamports, 919_356);
    assert.equal(decision.sizedLamports, 919_356);
  }
});

test('computeTradeAmountLamports skips when balance cannot cover reserve', () => {
  const thresholds = getWorkerFundingThresholds({
    ...baseEnv,
    WORKER_MAX_ROUTE_SETUP_LAMPORTS: '4078560',
    WORKER_OPERATING_BUFFER_LAMPORTS: '1722879',
    WORKER_TX_FEE_LAMPORTS: '5000',
  });
  const policy = getWorkerSizingPolicy({
    ...baseEnv,
    WORKER_TRADE_FRACTION_BPS: '1000',
    WORKER_MIN_TRADE_LAMPORTS: '1000000',
    WORKER_MAX_ROUTE_SETUP_LAMPORTS: '4078560',
    WORKER_OPERATING_BUFFER_LAMPORTS: '1722879',
    WORKER_TX_FEE_LAMPORTS: '5000',
  });

  const decision = computeTradeAmountLamports({
    balanceLamports: 5_000_000,
    thresholds,
    policy,
  });

  assert.equal(decision.skip, true);
  if (decision.skip) {
    assert.equal(decision.reason, 'insufficient_balance');
    assert.equal(decision.reserveLamports, 5_806_439);
    assert.equal(decision.tradableLamports, 0);
    assert.equal(decision.targetLamports, 0);
    assert.equal(decision.sizedLamports, 0);
  }
});

test('getRuntimeSpeedProfile derives entry caps and capacity', () => {
  const glide = getRuntimeSpeedProfile('glide', baseEnv);
  const pulse = getRuntimeSpeedProfile('pulse', baseEnv);
  const surge = getRuntimeSpeedProfile('surge', baseEnv);

  assert.equal(glide.maxSolEntryUsd, 1500);
  assert.equal(glide.concurrentCapacity, 120);
  assert.equal(pulse.maxSolEntryUsd, 4500);
  assert.equal(pulse.concurrentCapacity, 60);
  assert.equal(surge.maxSolEntryUsd, 10000);
  assert.equal(surge.concurrentCapacity, 40);
  assert.equal(computeSolEntryCapLamports({ profileName: 'surge', solUsdPrice: 200, env: baseEnv }), 50_000_000_000);
});
