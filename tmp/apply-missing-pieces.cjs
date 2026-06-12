/**
 * Add missing imports, consts, and implementations that didn't get written
 * because reapply-all-edits.cjs crashed before its writeFileSync.
 */
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let c = fs.readFileSync(file, 'utf8');
let edits = 0;

function mustReplace(label, old, replacement) {
  if (!c.includes(old)) {
    console.error(`FATAL: cannot find target for [${label}]`);
    console.error('Looking for:', JSON.stringify(old.substring(0, 100)));
    process.exit(1);
  }
  c = c.replace(old, replacement);
  edits++;
  console.log(`  [${edits}] ${label}`);
}

// 1. Import getPerformanceFeeConfig
if (!c.includes('getPerformanceFeeConfig')) {
  mustReplace(
    'import getPerformanceFeeConfig',
    '  getWorkerSizingPolicy,\r\n  normalizeRuntimeSpeedProfileName,',
    '  getWorkerSizingPolicy,\r\n  getPerformanceFeeConfig,\r\n  normalizeRuntimeSpeedProfileName,'
  );
}

// 2. Add performanceFeeConfig const
if (!c.includes('const performanceFeeConfig')) {
  mustReplace(
    'performanceFeeConfig const',
    'const sizingPolicy = getWorkerSizingPolicy(process.env);\r\n',
    'const sizingPolicy = getWorkerSizingPolicy(process.env);\r\nconst performanceFeeConfig = getPerformanceFeeConfig(process.env);\r\n'
  );
}

// 3. Add geckoFeed initialization + computeRelativeVolume
if (!c.includes('const geckoFeed')) {
  const geckoBlock = [
    '',
    '// B2: GeckoTerminal shared 1-min OHLCV candle feed for volume confirmation.',
    'const geckoFeed: GeckoTerminalCandleFeed = createGeckoTerminalCandleFeed({',
    '  fetchJson: async (url: string) => {',
    '    try {',
    '      const res = await fetch(url);',
    '      if (!res.ok) return null;',
    '      return await res.json();',
    '    } catch {',
    '      return null;',
    '    }',
    '  },',
    '  acquire: async () => {},',
    '  log: (entry) => {',
    "    if (entry.event === 'error' || entry.event === 'warn') {",
    "      console.log(JSON.stringify({ source: 'geckoFeed', ...entry }));",
    '    }',
    '  },',
    '});',
    '',
    '// RVOL: current candle volume / avg(last N). > 1.0 = above-average volume.',
    'const computeRelativeVolume = (mint: string, lookback = 20): number | null => {',
    '  const volumes = geckoFeed.getVolumes(mint);',
    '  if (volumes.length < lookback + 1) return null;',
    '  const currentVolume = volumes[volumes.length - 1];',
    '  const avgVolume = volumes.slice(-lookback - 1, -1).reduce((s, v) => s + v, 0) / lookback;',
    '  if (avgVolume <= 0) return null;',
    '  return currentVolume / avgVolume;',
    '};',
    '',
  ].join('\r\n');

  mustReplace(
    'geckoFeed + computeRelativeVolume',
    'const jupiterMomentumTapeByMint = new Map<string, MarketTapePoint[]>();\r\n\r\ntype PersistedMarketTapeRow',
    'const jupiterMomentumTapeByMint = new Map<string, MarketTapePoint[]>();\r\n' + geckoBlock + 'type PersistedMarketTapeRow'
  );
}

// 4. Add geckoFeed.refreshMints in price loop
if (!c.includes('geckoFeed.refreshMints')) {
  mustReplace(
    'geckoFeed.refreshMints',
    '    await applyTokenUniverseAutoSort();\r\n\r\n    await persistMarketTapeState();',
    '    await applyTokenUniverseAutoSort();\r\n\r\n    // B2: Refresh GeckoTerminal candles for active mints.\r\n    if (tokenUniverseActiveMints.length > 0) {\r\n      void geckoFeed.refreshMints(tokenUniverseActiveMints).catch(() => {});\r\n    }\r\n\r\n    await persistMarketTapeState();'
  );
}

// 5. Add GeckoTerminalCandleFeed type import if missing
if (!c.includes('GeckoTerminalCandleFeed')) {
  mustReplace(
    'GeckoTerminalCandleFeed type import',
    "import { createGeckoTerminalCandleFeed } from './geckoTerminalCandles.js';",
    "import { createGeckoTerminalCandleFeed, type GeckoTerminalCandleFeed } from './geckoTerminalCandles.js';"
  );
}

fs.writeFileSync(file, c);
console.log(`\nDone: ${edits} edits applied successfully.`);
