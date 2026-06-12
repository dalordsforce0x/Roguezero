const fs = require('fs');
const s = fs.readFileSync('services/worker/src/index.ts', 'latin1');
const eol = s.includes('\r\n') ? '\r\n' : '\n';
const lines = s.split(eol);
// 1-based inclusive ranges
function dump(a, b, out) {
  const seg = lines.slice(a - 1, b).join(eol);
  fs.writeFileSync(out, seg, 'latin1');
  console.log(out + ' -> lines ' + a + '..' + b + ' (' + seg.length + ' chars)');
}
dump(6875, 6898, 'tmp/edit-recovery/fix1-old.txt');
dump(7002, 7034, 'tmp/edit-recovery/fix2-old.txt');
console.log('EOL=' + (eol === '\r\n' ? 'CRLF' : 'LF'));
