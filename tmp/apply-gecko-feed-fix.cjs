// Fix gecko feed: trusted-only mints + 429 retry + smaller burst.
const fs = require('fs');
const path = 'services/worker/src/index.ts';
let src = fs.readFileSync(path, 'utf8');
const L = (...lines) => lines.join('\n');
const edits = [];

// 1) smaller startup burst (429 triggers after ~4 rapid calls) — cap burst at 2
edits.push({
  name: 'burst',
  old: L(
    `const geckoCandleLimiter = createSharedTokenBucket({`,
    `  pool: sharedRatePool,`,
    `  key: 'geckoterminal-ohlcv',`,
    `  maxTokens: Math.max(1, Math.min(5, GECKO_CANDLE_RPM)),`,
    `  refillRatePerSec: GECKO_CANDLE_RPM / 60,`,
    `});`,
  ),
  new: L(
    `const geckoCandleLimiter = createSharedTokenBucket({`,
    `  pool: sharedRatePool,`,
    `  key: 'geckoterminal-ohlcv',`,
    `  // Small burst: GeckoTerminal 429s after ~4 rapid calls, so cap the burst at 2`,
    `  // and let the refill rate (RPM/60) carry the steady-state spacing.`,
    `  maxTokens: 2,`,
    `  refillRatePerSec: GECKO_CANDLE_RPM / 60,`,
    `});`,
  ),
});

// 2) 429-aware retry/backoff in the injected fetchJson (proven gtFetch pattern)
edits.push({
  name: 'fetch-retry',
  old: L(
    `  acquire: () => geckoCandleLimiter.acquire(),`,
    `  fetchJson: async (url) => {`,
    `    try {`,
    `      const res = await fetch(url, { headers: { accept: 'application/json' } });`,
    `      if (!res.ok) return null;`,
    `      return await res.json();`,
    `    } catch {`,
    `      return null;`,
    `    }`,
    `  },`,
  ),
  new: L(
    `  acquire: () => geckoCandleLimiter.acquire(),`,
    `  fetchJson: async (url) => {`,
    `    // Retry on 429 with linear backoff (cloud egress IPs get rate-limited more`,
    `    // aggressively than residential). Non-429 errors fail fast -> null -> the`,
    `    // feed falls back to the live tape for that mint.`,
    `    for (let attempt = 0; attempt < 3; attempt += 1) {`,
    `      try {`,
    `        const res = await fetch(url, { headers: { accept: 'application/json' } });`,
    `        if (res.status === 429) {`,
    `          await new Promise((resolve) => setTimeout(resolve, 3000 * (attempt + 1)));`,
    `          continue;`,
    `        }`,
    `        if (!res.ok) return null;`,
    `        return await res.json();`,
    `      } catch {`,
    `        return null;`,
    `      }`,
    `    }`,
    `    return null;`,
    `  },`,
  ),
});

// 3) feed only the trusted liquid majors (gates apply to these; GeckoTerminal
//    indexes these). Excludes pump.fun tokens that always return no_pool.
edits.push({
  name: 'trusted-mints',
  old: L(
    `const runGeckoCandleRefreshTick = async (): Promise<void> => {`,
    `  if (!GECKO_CANDLES_ENABLED) return;`,
    `  const mints = (tokenUniverseActiveMints.length ? tokenUniverseActiveMints : tokenUniverseMints)`,
    `    .filter((mint) => mint && mint !== SOL_MINT);`,
    `  if (mints.length === 0) return;`,
  ),
  new: L(
    `const runGeckoCandleRefreshTick = async (): Promise<void> => {`,
    `  if (!GECKO_CANDLES_ENABLED) return;`,
    `  // Only the trusted liquid majors: these are the mints the entry-quality / shape`,
    `  // / ATR gates actually apply to, AND the only ones GeckoTerminal indexes with`,
    `  // real 1-min OHLCV. Feeding the full universe (incl. pump.fun) just burns the`,
    `  // rate budget on tokens that always return no_pool.`,
    `  const mints = TRUSTED_ENTRY_UNIVERSE_MINTS`,
    `    .filter((mint) => mint && mint !== SOL_MINT && !STABLE_ENTRY_TARGET_MINTS.has(mint));`,
    `  if (mints.length === 0) return;`,
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
console.log('Gecko feed fixes applied.');
