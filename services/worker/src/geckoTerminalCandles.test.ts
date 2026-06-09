import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createGeckoTerminalCandleFeed,
  parseOhlcvList,
  selectTopPoolAddress,
} from './geckoTerminalCandles.js';

// ── selectTopPoolAddress ─────────────────────────────────────────────────────
test('selectTopPoolAddress reads data[0].attributes.address', () => {
  const json = { data: [{ attributes: { address: 'POOLADDR111' } }, { attributes: { address: 'second' } }] };
  assert.equal(selectTopPoolAddress(json), 'POOLADDR111');
});

test('selectTopPoolAddress falls back to prefixed id', () => {
  const json = { data: [{ id: 'solana_POOLFROMID' }] };
  assert.equal(selectTopPoolAddress(json), 'POOLFROMID');
});

test('selectTopPoolAddress returns null on empty/invalid', () => {
  assert.equal(selectTopPoolAddress({ data: [] }), null);
  assert.equal(selectTopPoolAddress({}), null);
  assert.equal(selectTopPoolAddress(null), null);
});

// ── parseOhlcvList ───────────────────────────────────────────────────────────
test('parseOhlcvList sorts ascending and maps close price', () => {
  const json = {
    data: { attributes: { ohlcv_list: [
      [200, 2, 3, 1, 2.5, 100], // newest first as GT returns
      [100, 1, 2, 0.5, 1.5, 90],
    ] } },
  };
  const points = parseOhlcvList(json);
  assert.equal(points.length, 2);
  assert.equal(points[0].ts, 100);
  assert.equal(points[0].usdPrice, 1.5);
  assert.equal(points[1].ts, 200);
  assert.equal(points[1].usdPrice, 2.5);
  assert.equal(points[0].sampledAt, new Date(100 * 1000).toISOString());
});

test('parseOhlcvList drops non-finite and non-positive rows', () => {
  const json = {
    data: { attributes: { ohlcv_list: [
      [100, 1, 2, 0.5, 1.5, 90],
      [110, 1, 2, 0.5, 0, 90],       // close 0 -> drop
      [120, 1, 2, 0.5, 'x', 90],     // non-finite -> drop
      ['bad', 1, 2, 0.5, 3, 90],     // bad ts -> drop
      [130],                          // too short -> drop
    ] } },
  };
  const points = parseOhlcvList(json);
  assert.deepEqual(points.map((p) => p.ts), [100]);
});

test('parseOhlcvList returns empty for malformed payload', () => {
  assert.deepEqual(parseOhlcvList(null), []);
  assert.deepEqual(parseOhlcvList({ data: {} }), []);
});

// ── feed: refresh + getters ──────────────────────────────────────────────────
const makeOhlcv = (count: number, startTs = 1_000_000) => ({
  data: { attributes: { ohlcv_list: Array.from({ length: count }, (_, i) => {
    const ts = startTs + (count - 1 - i) * 60; // newest-first
    return [ts, 1, 1.1, 0.9, 1 + i * 0.001, 100];
  }) } },
});

test('refreshMints fetches pool then ohlcv and exposes tape', async () => {
  const urls: string[] = [];
  let acquired = 0;
  const feed = createGeckoTerminalCandleFeed({
    acquire: async () => { acquired += 1; },
    sleep: async () => undefined,
    now: () => 5_000_000_000,
    callSpacingMs: 0,
    fetchJson: async (url) => {
      urls.push(url);
      if (url.includes('/pools?page=1')) return { data: [{ attributes: { address: 'POOL_MINTA' } }] };
      if (url.includes('/ohlcv/minute')) return makeOhlcv(150);
      return null;
    },
  });

  const result = await feed.refreshMints(['MINTA']);
  assert.deepEqual(result, { refreshed: 1, failed: 0, skipped: 0 });
  assert.equal(acquired, 2); // one pool call + one ohlcv call, both governed
  assert.equal(feed.getTape('MINTA').length, 150);
  assert.equal(feed.getCloses('MINTA').length, 150);
  assert.ok(urls.some((u) => u.includes('/tokens/MINTA/pools')));
  assert.ok(urls.some((u) => u.includes('/pools/POOL_MINTA/ohlcv/minute')));
});

test('refreshMints trims to maxCandlesPerMint keeping newest', async () => {
  const feed = createGeckoTerminalCandleFeed({
    acquire: async () => undefined,
    sleep: async () => undefined,
    now: () => 5_000_000_000,
    callSpacingMs: 0,
    maxCandlesPerMint: 50,
    fetchJson: async (url) => {
      if (url.includes('/pools?page=1')) return { data: [{ attributes: { address: 'P' } }] };
      return makeOhlcv(200);
    },
  });
  await feed.refreshMints(['M']);
  const tape = feed.getTape('M');
  assert.equal(tape.length, 50);
  // newest retained: ascending, last ts must be the global newest
  assert.equal(tape[tape.length - 1].ts, 1_000_000 + 199 * 60);
});

test('refreshMints counts failure when no pool', async () => {
  const feed = createGeckoTerminalCandleFeed({
    acquire: async () => undefined,
    sleep: async () => undefined,
    callSpacingMs: 0,
    fetchJson: async (url) => (url.includes('/pools?page=1') ? { data: [] } : null),
  });
  const result = await feed.refreshMints(['NOPOOL']);
  assert.deepEqual(result, { refreshed: 0, failed: 1, skipped: 0 });
  assert.equal(feed.hasFreshCandles('NOPOOL'), false);
});

test('refreshMints counts failure on empty ohlcv', async () => {
  const feed = createGeckoTerminalCandleFeed({
    acquire: async () => undefined,
    sleep: async () => undefined,
    callSpacingMs: 0,
    fetchJson: async (url) => {
      if (url.includes('/pools?page=1')) return { data: [{ attributes: { address: 'P' } }] };
      return { data: { attributes: { ohlcv_list: [] } } };
    },
  });
  const result = await feed.refreshMints(['EMPTY']);
  assert.deepEqual(result, { refreshed: 0, failed: 1, skipped: 0 });
});

test('refreshMints skips duplicates and empties', async () => {
  let poolCalls = 0;
  const feed = createGeckoTerminalCandleFeed({
    acquire: async () => undefined,
    sleep: async () => undefined,
    callSpacingMs: 0,
    fetchJson: async (url) => {
      if (url.includes('/pools?page=1')) { poolCalls += 1; return { data: [{ attributes: { address: 'P' } }] }; }
      return makeOhlcv(130);
    },
  });
  const result = await feed.refreshMints(['M', 'M', '']);
  assert.equal(result.refreshed, 1);
  assert.equal(result.skipped, 2);
  assert.equal(poolCalls, 1);
});

test('pool address is cached within TTL across refreshes', async () => {
  let poolCalls = 0;
  let clock = 1_000;
  const feed = createGeckoTerminalCandleFeed({
    acquire: async () => undefined,
    sleep: async () => undefined,
    callSpacingMs: 0,
    poolTtlMs: 60_000,
    now: () => clock,
    fetchJson: async (url) => {
      if (url.includes('/pools?page=1')) { poolCalls += 1; return { data: [{ attributes: { address: 'P' } }] }; }
      return makeOhlcv(130);
    },
  });
  await feed.refreshMints(['M']);
  clock += 30_000; // within TTL
  await feed.refreshMints(['M']);
  assert.equal(poolCalls, 1);
  clock += 60_000; // past TTL
  await feed.refreshMints(['M']);
  assert.equal(poolCalls, 2);
});

test('null pool result is retried after the short null TTL, not held for the full pool TTL', async () => {
  let poolCalls = 0;
  let clock = 1_000;
  let poolExists = false;
  const feed = createGeckoTerminalCandleFeed({
    acquire: async () => undefined,
    sleep: async () => undefined,
    callSpacingMs: 0,
    poolTtlMs: 24 * 60 * 60 * 1000,
    nullPoolTtlMs: 5_000,
    now: () => clock,
    fetchJson: async (url) => {
      if (url.includes('/pools?page=1')) {
        poolCalls += 1;
        // Simulate a transient failure (e.g. 429 -> null) on the first lookup,
        // then a real pool once the token recovers.
        return poolExists ? { data: [{ attributes: { address: 'P' } }] } : null;
      }
      return makeOhlcv(130);
    },
  });
  await feed.refreshMints(['M']);
  assert.equal(poolCalls, 1);
  assert.equal(feed.hasFreshCandles('M'), false);

  // Within the short null TTL: do NOT re-hit the API yet.
  clock += 2_000;
  await feed.refreshMints(['M']);
  assert.equal(poolCalls, 1);

  // Past the short null TTL (but far within the 24h pool TTL): retry. The token
  // now has a pool, so candles populate instead of being stuck for 24h.
  poolExists = true;
  clock += 5_000;
  await feed.refreshMints(['M']);
  assert.equal(poolCalls, 2);
  assert.equal(feed.hasFreshCandles('M'), true);
});

test('hasFreshCandles respects freshness TTL', async () => {
  let clock = 1_000;
  const feed = createGeckoTerminalCandleFeed({
    acquire: async () => undefined,
    sleep: async () => undefined,
    callSpacingMs: 0,
    now: () => clock,
    fetchJson: async (url) => {
      if (url.includes('/pools?page=1')) return { data: [{ attributes: { address: 'P' } }] };
      return makeOhlcv(130);
    },
  });
  await feed.refreshMints(['M']);
  assert.equal(feed.hasFreshCandles('M', 10_000), true);
  clock += 20_000;
  assert.equal(feed.hasFreshCandles('M', 10_000), false);
});

test('getCoverage reports fresh mint count', async () => {
  const feed = createGeckoTerminalCandleFeed({
    acquire: async () => undefined,
    sleep: async () => undefined,
    callSpacingMs: 0,
    now: () => 1_000,
    fetchJson: async (url) => {
      if (url.includes('/pools?page=1')) return { data: [{ attributes: { address: 'P' } }] };
      return makeOhlcv(130);
    },
  });
  await feed.refreshMints(['A', 'B']);
  const cov = feed.getCoverage(60_000);
  assert.equal(cov.mints, 2);
  assert.equal(cov.freshMints, 2);
});

test('refreshMint failure does not throw out of refreshMints', async () => {
  const feed = createGeckoTerminalCandleFeed({
    acquire: async () => { throw new Error('bucket boom'); },
    sleep: async () => undefined,
    callSpacingMs: 0,
    fetchJson: async () => null,
  });
  const result = await feed.refreshMints(['M']);
  assert.deepEqual(result, { refreshed: 0, failed: 1, skipped: 0 });
});
