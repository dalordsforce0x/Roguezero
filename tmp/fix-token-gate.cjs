const fs = require('fs');
const f = 'services/worker/src/index.ts';
let src = fs.readFileSync(f, 'utf8');

// Fix 1: per-token gate — regime !== 'bullish' -> regime === 'bearish'
const old1 = "tokenEntrySignal.status !== 'ready' || tokenEntrySignal.regime !== 'bullish'";
const new1 = "tokenEntrySignal.status !== 'ready' || tokenEntrySignal.regime === 'bearish'";
if (!src.includes(old1)) { console.error('PATCH1 anchor not found'); process.exit(1); }
src = src.replace(old1, new1);

// Fix 1b: log message
src = src.replace(
  'entry blocked: token signal not bullish for',
  'entry blocked: token signal bearish for'
);

// Fix 2: parser — split on comma or whitespace
const old2 = "return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));";
const new2 = "return new Set(raw.split(/[,\\s]+/).map((s) => s.trim()).filter(Boolean));";
if (!src.includes(old2)) { console.error('PATCH2 anchor not found'); process.exit(1); }
src = src.replace(old2, new2);

// Fix 2b: comment
src = src.replace(
  '// Restrict entries to these token classes (comma-separated).',
  '// Restrict entries to these token classes (comma or space separated).'
);

fs.writeFileSync(f, src);
console.log('All patches applied');
