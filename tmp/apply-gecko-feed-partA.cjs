// Part A worker wiring: GeckoTerminal shared candle feed.
// Disk-edit via literal split/join (offset-immune; index.ts editor buffer is stale).
const fs = require('fs');
const path = 'services/worker/src/index.ts';
let src = fs.readFileSync(path, 'utf8');

const L = (...lines) => lines.join('\n');
const edits = [];

// 1) import the feed factory
edits.push({
  name: 'import',
  old: `import { createMonthlyBudgetGovernor, createSharedTokenBucket, getExponentialBackoffDelayMs } from '@roguezero/provider-governor';`,
  new: L(
    `import { createMonthlyBudgetGovernor, createSharedTokenBucket, getExponentialBackoffDelayMs } from '@roguezero/provider-governor';`,
    `import { createGeckoTerminalCandleFeed } from './geckoTerminalCandles.js';`,
  ),
});

// 2) construct the gecko rate bucket + feed right after the helius limiter
const heliusLimiterBlock = L(
  `const heliusLimiter = createSharedTokenBucket({`,
  `  pool: sharedRatePool,`,
  `  key: 'helius-rpc',`,
  `  maxTokens: HELIUS_RPC_BURST,`,
  `  refillRatePerSec: HELIUS_RPC_RPS,`,
  `});`,
);
const geckoFeedBlock = L(
  ``,
  `// â”€â”€ GeckoTerminal shared 1-min candle feed â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€`,
  `// One fleet-wide feed (never one fetch per bot). Routed through its own governor`,
  `// bucket so the free ~30 req/min GeckoTerminal ceiling is never breached. Feeds`,
  `// real 1-min candle history into the ATR cost gate, the entry scorer, and the`,
  `// ATR exit stops -- all of which were previously blind on the thin live tape.`,
  `const GECKO_CANDLES_ENABLED = process.env.WORKER_GECKO_CANDLES_ENABLED !== 'false';`,
  `const GECKO_CANDLE_REFRESH_MS = Math.max(60_000, Number(process.env.WORKER_GECKO_CANDLE_REFRESH_MS ?? 300_000));`,
  `const GECKO_CANDLE_RPM = Math.max(1, Math.min(28, Number(process.env.WORKER_GECKO_CANDLE_RPM ?? 20)));`,
  `const geckoCandleLimiter = createSharedTokenBucket({`,
  `  pool: sharedRatePool,`,
  `  key: 'geckoterminal-ohlcv',`,
  `  maxTokens: Math.max(1, Math.min(5, GECKO_CANDLE_RPM)),`,
  `  refillRatePerSec: GECKO_CANDLE_RPM / 60,`,
  `});`,
  `const geckoCandleFeed = createGeckoTerminalCandleFeed({`,
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
  `  log: (entry) => console.warn(JSON.stringify({`,
  `    level: 'warn', service: 'roguezero-worker', ...entry, ts: new Date().toISOString(),`,
  `  })),`,
  `});`,
);
edits.push({
  name: 'gecko-feed',
  old: heliusLimiterBlock,
  new: heliusLimiterBlock + '\n' + geckoFeedBlock,
});

// 3) define the refresh tick + start function just before boot()
const bootAnchor = `const boot = async () => {`;
const geckoLoopBlock = L(
  `const runGeckoCandleRefreshTick = async (): Promise<void> => {`,
  `  if (!GECKO_CANDLES_ENABLED) return;`,
  `  const mints = (tokenUniverseActiveMints.length ? tokenUniverseActiveMints : tokenUniverseMints)`,
  `    .filter((mint) => mint && mint !== SOL_MINT);`,
  `  if (mints.length === 0) return;`,
  `  try {`,
  `    const result = await geckoCandleFeed.refreshMints(mints);`,
  `    const coverage = geckoCandleFeed.getCoverage();`,
  `    console.log(JSON.stringify({`,
  `      level: 'info', service: 'roguezero-worker', kind: 'gecko_candle_refresh',`,
  `      requested: mints.length, refreshed: result.refreshed, failed: result.failed,`,
  `      freshMints: coverage.freshMints, ts: new Date().toISOString(),`,
  `    }));`,
  `  } catch (error) {`,
  `    console.warn(JSON.stringify({`,
  `      level: 'warn', service: 'roguezero-worker', kind: 'gecko_candle_refresh_failed',`,
  `      error: error instanceof Error ? error.message : String(error), ts: new Date().toISOString(),`,
  `    }));`,
  `  }`,
  `};`,
  ``,
  `const startGeckoCandleLoop = (): void => {`,
  `  if (!GECKO_CANDLES_ENABLED) {`,
  `    console.log('[worker] gecko candle feed disabled by env');`,
  `    return;`,
  `  }`,
  `  console.log('[worker] gecko candle feed enabled', JSON.stringify({`,
  `    refreshMs: GECKO_CANDLE_REFRESH_MS, rpm: GECKO_CANDLE_RPM,`,
  `  }));`,
  `  setTimeout(() => {`,
  `    void runGeckoCandleRefreshTick();`,
  `    setInterval(() => { void runGeckoCandleRefreshTick(); }, GECKO_CANDLE_REFRESH_MS);`,
  `  }, 10_000);`,
  `};`,
  ``,
  ``,
);
edits.push({
  name: 'gecko-loop',
  old: bootAnchor,
  new: geckoLoopBlock + bootAnchor,
});

// 4) start the loop in boot()
const startAnchor = L(
  `  startPriceLoops();`,
  `  startTokenAdmissionSchedule();`,
);
edits.push({
  name: 'gecko-start',
  old: startAnchor,
  new: L(
    `  startPriceLoops();`,
    `  startTokenAdmissionSchedule();`,
    `  startGeckoCandleLoop();`,
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
console.log('Part A wiring applied.');
