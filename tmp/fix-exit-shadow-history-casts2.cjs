// Fix: the earlier apply script lost the `$` prefix on SQL placeholders, so the
// generated VALUES used integer literals (1,2,3...) instead of parameters ($1,$2...).
// That caused "column id is of type uuid but expression is of type integer".
// Restore `$` + add explicit per-column casts for unambiguous typing.
// Run: node tmp/fix-exit-shadow-history-casts2.cjs
const fs = require('fs');
const path = require('path');

const file = path.resolve(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let src = fs.readFileSync(file, 'utf8');
let changed = false;

// A) Insert the columnCasts array right before the valuesSql builder.
const oldB = '    const cols = 21;\n    const valuesSql = rows';
const castsArray = [
  '    const cols = 21;',
  '    const columnCasts = [',
  "      '::uuid', '::uuid', '::text', '::text', '::text', '::text',",
  "      '::boolean', '::text',",
  "      '::text', '::text', '::int', '::int',",
  "      '::text', '::text', '::text',",
  "      '::int', '::int', '::int', '::int',",
  "      '::jsonb', '::jsonb',",
  '    ];',
  '    const valuesSql = rows',
].join('\n');
if (!src.includes('const columnCasts = [')) {
  if (!src.includes(oldB)) throw new Error('casts anchor not found');
  src = src.replace(oldB, castsArray);
  changed = true;
}

// B) Restore the `$` prefix and append the per-column cast to each placeholder.
const oldA = '        const placeholders = Array.from({ length: cols }, (_, c) => `${base + c + 1}`);';
const newA = '        const placeholders = Array.from({ length: cols }, (_, c) => `$${base + c + 1}${columnCasts[c]}`);';
if (src.includes(oldA)) {
  src = src.replace(oldA, newA);
  changed = true;
} else if (!src.includes(newA)) {
  throw new Error('placeholder line anchor not found');
}

if (changed) {
  fs.writeFileSync(file, src, 'utf8');
  console.log('applied: $ prefix + column casts');
} else {
  console.log('already fixed');
}
