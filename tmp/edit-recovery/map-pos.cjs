const fs = require('fs');
const s = fs.readFileSync('services/worker/src/index.ts', 'latin1');
function all(k) { const r = []; let i = s.indexOf(k); while (i >= 0) { r.push(i); i = s.indexOf(k, i + 1); } return r; }
console.log("status: 'long' ->", all("status: 'long'"));
const defM = all('const refreshPositionsMarks');
console.log('refreshPositionsMarks def ->', defM);
console.log('refreshPositionsMarks( calls ->', all('refreshPositionsMarks(').filter(x => !defM.includes(x)));
console.log('orphan retrack loop start markers ->', all('reconciledPositions[mint] ='));
// Where does executeTrade call the orphan re-track? find 'reconciledPositions' first use
console.log('reconciledPositions decl ->', all('const reconciledPositions'));
