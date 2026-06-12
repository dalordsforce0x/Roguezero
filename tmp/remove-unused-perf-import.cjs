const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let c = fs.readFileSync(file, 'utf8');

// Remove getPerformanceFeeConfig from import
c = c.replace(
  '  getWorkerSizingPolicy,\r\n  getPerformanceFeeConfig,\r\n  normalizeRuntimeSpeedProfileName,',
  '  getWorkerSizingPolicy,\r\n  normalizeRuntimeSpeedProfileName,'
);

// Remove const performanceFeeConfig line
c = c.replace(
  'const performanceFeeConfig = getPerformanceFeeConfig(process.env);\r\n',
  ''
);

fs.writeFileSync(file, c);
console.log('Removed unused getPerformanceFeeConfig import and const');
