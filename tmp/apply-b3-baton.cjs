/**
 * Apply B3: Wire recommendStrategy into baton pass (multi-line replacement)
 */
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let c = fs.readFileSync(file, 'utf8');

if (c.includes('regime.recommended')) {
  console.log('B3 already applied, skipping');
  process.exit(0);
}

const old = [
  '    const nextScannerStrategy = getNextStrategyInSequence(',
  '      tradePlan.entryStrategy ?? tradePlan.scannerStrategy,',
  '      enabledStrategies,',
  '    );',
].join('\r\n');

const replacement = [
  '    // B3: Regime-based strategy selection instead of blind round-robin.',
  '    // recommendStrategy picks based on Bollinger bandwidth + price slope.',
  '    // Falls back to round-robin if recommended strategy not in enabled set.',
  '    const regime = recommendStrategy(sharedMarketTape.solUsdPyth);',
  '    const recommendedKey = regime.recommended;',
  '    const enabledSet = new Set(enabledStrategies);',
  '    const nextScannerStrategy = enabledSet.has(recommendedKey)',
  '      ? recommendedKey',
  '      : getNextStrategyInSequence(',
  '        tradePlan.entryStrategy ?? tradePlan.scannerStrategy,',
  '        enabledStrategies,',
  '      );',
].join('\r\n');

if (!c.includes(old)) {
  console.error('FATAL: cannot find baton pass target');
  process.exit(1);
}

c = c.replace(old, replacement);
fs.writeFileSync(file, c);
console.log('B3 baton pass wired: recommendStrategy now drives strategy selection');
