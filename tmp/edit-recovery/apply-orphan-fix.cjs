const fs = require('fs');
const path = 'services/worker/src/index.ts';
const s = fs.readFileSync(path, 'latin1');

function loadCRLF(p) {
  // Editor/disk uses CRLF. The staged files were written by create_file which
  // may use LF; normalize the staged text to CRLF so it matches disk exactly.
  return fs.readFileSync(p, 'latin1').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
}

const fix1Old = loadCRLF('tmp/edit-recovery/fix1-old.txt');
const fix1New = loadCRLF('tmp/edit-recovery/fix1-new.txt');
const fix2Old = loadCRLF('tmp/edit-recovery/fix2-old.txt');
const fix2New = loadCRLF('tmp/edit-recovery/fix2-new.txt');

function countOcc(hay, needle) {
  let i = 0, c = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { c++; i += needle.length; }
  return c;
}

const c1 = countOcc(s, fix1Old);
const c2 = countOcc(s, fix2Old);
console.log('fix1 old occurrences:', c1);
console.log('fix2 old occurrences:', c2);
if (c1 !== 1) { console.error('ABORT: fix1 old text not unique'); process.exit(1); }
if (c2 !== 1) { console.error('ABORT: fix2 old text not unique'); process.exit(1); }

let next = s.replace(fix1Old, fix1New).replace(fix2Old, fix2New);
if (next === s) { console.error('ABORT: no change applied'); process.exit(1); }

fs.writeFileSync(path, next, 'latin1');
console.log('APPLIED. new length:', next.length, 'old length:', s.length);
