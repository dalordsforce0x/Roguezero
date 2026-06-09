const fs = require('fs');
const path = 'services/worker/src/index.ts';
const dir = 'tmp/cap';
const raw = fs.readFileSync(path, 'latin1');
const hadCRLF = raw.includes('\r\n');
let lf = raw.replace(/\r\n/g, '\n');

const edits = [
  ['a_old.txt', 'a_new.txt'],
  ['b_old.txt', 'b_new.txt'],
  ['c_old.txt', 'c_new.txt'],
];

for (const [oldF, newF] of edits) {
  const oldStr = fs.readFileSync(`${dir}/${oldF}`, 'latin1').replace(/\r\n/g, '\n').replace(/\n$/, '');
  const newStr = fs.readFileSync(`${dir}/${newF}`, 'latin1').replace(/\r\n/g, '\n').replace(/\n$/, '');
  const count = lf.split(oldStr).length - 1;
  if (count !== 1) {
    console.error(`FAIL ${oldF}: expected exactly 1 match, found ${count}`);
    process.exit(1);
  }
  lf = lf.replace(oldStr, newStr);
  console.log(`OK ${oldF} -> ${newF}`);
}

const out = hadCRLF ? lf.replace(/\n/g, '\r\n') : lf;
fs.writeFileSync(path, out, 'latin1');
console.log('WROTE', path, 'CRLF=', hadCRLF);
