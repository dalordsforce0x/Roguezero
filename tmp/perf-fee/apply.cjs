const fs = require('fs');
const path = require('path');

const target = path.join('services', 'worker', 'src', 'index.ts');
const dir = path.join('tmp', 'perf-fee');

const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n');

const edits = [
  ['a_old.txt', 'a_new.txt', 'runtime-config import'],
  ['b_old.txt', 'b_new.txt', 'performance-fee constants'],
  ['c_old.txt', 'c_new.txt', 'session-end fee sweep logic'],
];

let raw = fs.readFileSync(target, 'utf8');
const hadCRLF = raw.includes('\r\n');
let s = raw.replace(/\r\n/g, '\n');

for (const [oldF, newF, label] of edits) {
  const oldStr = read(oldF);
  const newStr = read(newF);
  const count = s.split(oldStr).length - 1;
  if (count !== 1) {
    throw new Error(`[${label}] expected exactly 1 match, found ${count} -- aborting, no write`);
  }
  s = s.replace(oldStr, newStr);
  console.log(`[${label}] applied (1 match)`);
}

const out = hadCRLF ? s.replace(/\n/g, '\r\n') : s;
fs.writeFileSync(target, out, 'utf8');
console.log('WROTE', target, 'CRLF=', hadCRLF);
