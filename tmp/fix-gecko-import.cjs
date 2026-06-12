const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let c = fs.readFileSync(file, 'utf8');
c = c.replace(
  "import { createGeckoTerminalCandleFeed } from './geckoTerminalCandles.js';",
  "import { createGeckoTerminalCandleFeed, type GeckoTerminalCandleFeed } from './geckoTerminalCandles.js';"
);
fs.writeFileSync(file, c);
console.log('GeckoTerminalCandleFeed type import added');
