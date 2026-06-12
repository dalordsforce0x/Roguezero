const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
const c = fs.readFileSync(file, 'utf8');

// 1. Show strategies.js import
const stratIdx = c.indexOf("from './strategies.js'");
const importStart = c.lastIndexOf('import', stratIdx);
console.log('=== strategies.js import ===');
console.log(c.substring(importStart, stratIdx + 30));

// 2. Show runtime-config import
const rcIdx = c.indexOf("from '@roguezero/runtime-config'");
if (rcIdx >= 0) {
  const rcStart = c.lastIndexOf('import', rcIdx);
  console.log('\n=== runtime-config import ===');
  console.log(c.substring(rcStart, rcIdx + 40));
} else {
  console.log('\nruntime-config import NOT FOUND');
}

// 3. Check what runtime-config exports
const rcFile = path.join(__dirname, '..', 'packages', 'runtime-config', 'src', 'index.ts');
const rc = fs.readFileSync(rcFile, 'utf8');
console.log('\n=== getPerformanceFeeConfig in runtime-config ===');
const pfIdx = rc.indexOf('getPerformanceFeeConfig');
if (pfIdx >= 0) {
  console.log('Found at position', pfIdx);
  const exportLine = rc.lastIndexOf('\n', pfIdx);
  console.log(rc.substring(exportLine, pfIdx + 50));
} else {
  console.log('NOT FOUND in runtime-config');
}
