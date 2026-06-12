'use strict';
const fs = require('fs');
const t = fs.readFileSync('services/worker/src/index.ts', 'latin1');
const start = t.indexOf('executeTrade = async');
const seg = t.slice(start, start + 95000);
const re = /'(entry_[a-z_]+|volatility_size_below_min_trade|[a-z_]*cooldown[a-z_]*|sell-impact[^']*)'/g;
const order = [];
const seen = new Set();
let m;
while ((m = re.exec(seg)) !== null) {
  const at = m.index + start;
  if (!seen.has(m[1])) { seen.add(m[1]); order.push({ reason: m[1], at }); }
}
for (const o of order) console.log(String(o.at).padStart(7), o.reason);
