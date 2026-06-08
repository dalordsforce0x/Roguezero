// Fix: multi-row VALUES insert into exit_shadow_decisions fails Postgres parameter
// type inference ("column id is of type uuid but expression is of type integer").
// Add explicit per-column casts so each placeholder is unambiguously typed.
// Run: node tmp/fix-exit-shadow-history-casts.cjs
const fs = require('fs');
const path = require('path');

const file = path.resolve(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let src = fs.readFileSync(file, 'utf8');

const oldBlock = `    const cols = 21;
    const valuesSql = rows
      .map((_, rowIndex) => {
        const base = rowIndex * cols;
        const placeholders = Array.from({ length: cols }, (_, c) => \`$\${base + c + 1}\`);
        return \`(\${placeholders.join(', ')})\`;
      })
      .join(', ');`;

const newBlock = `    const cols = 21;
    const columnCasts = [
      '::uuid', '::uuid', '::text', '::text', '::text', '::text',
      '::boolean', '::text',
      '::text', '::text', '::int', '::int',
      '::text', '::text', '::text',
      '::int', '::int', '::int', '::int',
      '::jsonb', '::jsonb',
    ];
    const valuesSql = rows
      .map((_, rowIndex) => {
        const base = rowIndex * cols;
        const placeholders = Array.from({ length: cols }, (_, c) => \`$\${base + c + 1}\${columnCasts[c]}\`);
        return \`(\${placeholders.join(', ')})\`;
      })
      .join(', ');`;

if (src.includes('const columnCasts = [')) {
  console.log('already fixed');
} else {
  if (!src.includes(oldBlock)) throw new Error('insert block anchor not found');
  src = src.replace(oldBlock, newBlock);
  fs.writeFileSync(file, src, 'utf8');
  console.log('applied: explicit column casts');
}
