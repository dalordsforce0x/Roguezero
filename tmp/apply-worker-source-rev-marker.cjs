const fs = require('fs');
const path = require('path');
const file = path.resolve('services/worker/src/index.ts');
let text = fs.readFileSync(file, 'utf8');
const oldText = "const WORKER_SOURCE_REV = 'exit-telemetry-shadow-v1-2026-06-06';";
const newText = "const WORKER_SOURCE_REV = 'entry-reject-cooldown-v1-2026-06-07';";
const count = text.split(oldText).length - 1;
if (count !== 1) {
  throw new Error(`expected 1 source rev marker, found ${count}`);
}
text = text.replace(oldText, newText);
fs.writeFileSync(file, text);
console.log('worker source rev marker updated');
