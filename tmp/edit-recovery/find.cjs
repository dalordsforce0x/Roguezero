const fs = require('fs');
const cp = require('child_process');
const needles = process.argv.slice(2);
const files = cp.execSync('git ls-files services/worker/src packages/session-schema/src', { encoding: 'utf8' })
  .split('\n').filter(Boolean);
for (const f of files) {
  let s;
  try { s = fs.readFileSync(f, 'latin1'); } catch { continue; }
  const L = s.split('\n');
  L.forEach((l, i) => {
    for (const n of needles) {
      if (l.indexOf(n) !== -1) {
        console.log(f + ':' + (i + 1) + ': ' + l.trim().replace(/[^\x20-\x7e]/g, '?'));
        break;
      }
    }
  });
}
