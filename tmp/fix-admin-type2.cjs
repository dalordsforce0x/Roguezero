const fs = require('fs');
const f = 'apps/admin/src/lib/db.ts';
let c = fs.readFileSync(f, 'utf8');

// Find exact bytes
const target = 'entriesEnabled?: unknown;';
const idx = c.indexOf(target);
if (idx < 0) { console.error('target not found'); process.exit(1); }

// Find end of line after entriesEnabled
const eol = c.indexOf('\n', idx);
// Insert performanceFeeEnabled after that line
const insertion = '    performanceFeeEnabled?: unknown;\r\n';
if (c.includes('performanceFeeEnabled?: unknown')) {
  console.log('Already present, skipping');
  process.exit(0);
}
c = c.substring(0, eol + 1) + insertion + c.substring(eol + 1);
fs.writeFileSync(f, c);
console.log('Added performanceFeeEnabled to RuntimeControlRow type');
