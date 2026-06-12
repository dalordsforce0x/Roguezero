// Fix: replace isExit with tradePlan.direction === 'exit_long' in worker
const fs = require('fs');
const path = require('path');
const filePath = path.join(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let src = fs.readFileSync(filePath, 'utf8');

const old = "tipTier:                getFleetTipTier(isExit),";
const fix = "tipTier:                getFleetTipTier(tradePlan.direction === 'exit_long'),";

if (src.includes(old)) {
  src = src.replace(old, fix);
  fs.writeFileSync(filePath, src);
  console.log('Fixed: isExit -> tradePlan.direction === exit_long');
} else {
  console.log('Pattern not found — may already be fixed');
}
