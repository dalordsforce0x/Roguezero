const fs = require('fs');
const s = fs.readFileSync('services/worker/src/index.ts', 'latin1');
function all(k) { const r = []; let i = s.indexOf(k); while (i >= 0) { r.push(i); i = s.indexOf(k, i + 1); } return r; }
const sites = all("'take_profit' | 'stop_loss'");
console.log('union sites:', sites);
sites.forEach(idx => console.log('@', idx, ':', s.slice(idx - 80, idx + 120).replace(/\r|\n/g, ' ')));
