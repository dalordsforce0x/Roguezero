const fs = require('fs');
const path = 'services/worker/src/index.ts';
let s = fs.readFileSync(path, 'latin1');
const CR = '\r\n';

function replaceOnce(hay, oldStr, newStr, label) {
  let i = 0, c = 0;
  while ((i = hay.indexOf(oldStr, i)) !== -1) { c++; i += oldStr.length; }
  if (c !== 1) { console.error(`ABORT ${label}: occurrences=${c}`); process.exit(1); }
  return hay.replace(oldStr, newStr);
}

const oldStr = [
  "  'route_stability_impact_too_high',",
  "  'route_stability_impact_unstable',",
  "  'route_stability_output_unstable',",
  ']);',
].join(CR);
const newStr = [
  "  'route_stability_impact_too_high',",
  "  'route_stability_impact_unstable',",
  "  'route_stability_output_unstable',",
  "  'entry_token_unpriced',",
  ']);',
].join(CR);

s = replaceOnce(s, oldStr, newStr, 'cooldown-reason');
fs.writeFileSync(path, s, 'latin1');
console.log('APPLIED cooldown-reason. length=', s.length);
