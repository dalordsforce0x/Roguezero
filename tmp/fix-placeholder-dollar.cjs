// Root cause: String.replace() collapses `$$` -> `$` in the replacement string,
// so the placeholder lost its parameter `$` prefix. Use split/join (no $ substitution).
// Run: node tmp/fix-placeholder-dollar.cjs
const fs = require('fs');
const path = require('path');

const file = path.resolve(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let src = fs.readFileSync(file, 'utf8');

const oldA = '        const placeholders = Array.from({ length: cols }, (_, c) => `${base + c + 1}${columnCasts[c]}`);';
const newA = '        const placeholders = Array.from({ length: cols }, (_, c) => `$${base + c + 1}${columnCasts[c]}`);';

if (src.includes(newA)) {
  console.log('already correct');
} else if (src.includes(oldA)) {
  src = src.split(oldA).join(newA);
  fs.writeFileSync(file, src, 'utf8');
  console.log('applied: restored $ prefix via split/join');
} else {
  throw new Error('placeholder line not found');
}
