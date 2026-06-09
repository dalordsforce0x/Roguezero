// Disk-edit applier for the entry-quality live gate + momentum disable.
// Literal split(old).join(new); asserts each old occurs exactly once before
// applying. Reads old/new from sibling .txt files (perfect literal fidelity for
// backticks / ${...}). Trailing single newline is stripped uniformly so files
// created with or without a final newline match consistently.
const fs = require('fs');
const path = require('path');

const TARGET = path.resolve(__dirname, '../../../services/worker/src/index.ts');
const DIR = __dirname;

const stripBom = (s) => s.replace(/^\uFEFF/, '');
const stripOne = (s) => s.replace(/\n$/, '');
const read = (name) => stripOne(stripBom(fs.readFileSync(path.join(DIR, name), 'utf8')));

const edits = [
  ['old1.txt', 'new1.txt'],
  ['old2.txt', 'new2.txt'],
  ['old3.txt', 'new3.txt'],
  ['old4.txt', 'new4.txt'],
  ['old5.txt', 'new5.txt'],
];

let src = fs.readFileSync(TARGET, 'utf8');

for (const [oldName, newName] of edits) {
  const oldStr = read(oldName);
  const newStr = read(newName);
  const count = src.split(oldStr).length - 1;
  if (count !== 1) {
    console.error(`ABORT: ${oldName} matched ${count} times (expected 1). No changes written.`);
    process.exit(1);
  }
  src = src.split(oldStr).join(newStr);
  console.log(`OK: applied ${oldName} -> ${newName}`);
}

fs.writeFileSync(TARGET, src);
console.log('All 5 edits applied to', TARGET);
