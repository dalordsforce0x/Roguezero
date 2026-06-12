const fs = require('fs');
const path = 'services/worker/src/index.ts';
let s = fs.readFileSync(path, 'latin1');
const hadCRLF = s.includes('\r\n');
let t = s.replace(/\r\n/g, '\n');

const edits = [
  {
    old: `      trailingStopBps: Math.max(positionExitPolicy.trailingStopBps, costFloorBps),
      atrBps: null,
      costFloorBps,
      mode: 'fallback',`,
    neu: `      trailingStopBps: Math.max(positionExitPolicy.trailingStopBps, positionExitPolicy.trailingStopFloorBps),
      atrBps: null,
      costFloorBps,
      mode: 'fallback',`,
  },
  {
    old: `    trailingStopBps: Math.max(
      costFloorBps,
      Math.round(atrBps * exitProfile.trailingStopMult),
    ),`,
    neu: `    trailingStopBps: Math.max(
      positionExitPolicy.trailingStopFloorBps,
      Math.round(atrBps * exitProfile.trailingStopMult),
    ),`,
  },
];

for (const e of edits) {
  const count = t.split(e.old).length - 1;
  if (count !== 1) {
    console.error(`ABORT: expected exactly 1 match, found ${count} for:\n${e.old}`);
    process.exit(1);
  }
  t = t.replace(e.old, e.neu);
}

if (hadCRLF) t = t.replace(/\n/g, '\r\n');
fs.writeFileSync(path, t, 'latin1');
console.log('Worker trailing-stop decouple applied: 2 edits OK');
