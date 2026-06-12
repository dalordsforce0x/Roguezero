const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let c = fs.readFileSync(file, 'utf8');

// Add recommendStrategy to strategies.js import
const old = "  getNextStrategyInSequence,\r\n  getStrategyScanOrder,";
const replacement = "  getNextStrategyInSequence,\r\n  getStrategyScanOrder,\r\n  recommendStrategy,";
if (!c.includes(old)) {
  console.error('FATAL: strategies import target not found');
  process.exit(1);
}
c = c.replace(old, replacement);
fs.writeFileSync(file, c);
console.log('Added recommendStrategy to strategies.js import');
