const fs = require('fs');
const f = 'apps/admin/src/lib/db.ts';
let c = fs.readFileSync(f, 'utf8');
c = c.replace(
  '    entriesEnabled?: unknown;\n    maintenanceReason?: unknown;\n  } | null;',
  '    entriesEnabled?: unknown;\n    performanceFeeEnabled?: unknown;\n    maintenanceReason?: unknown;\n  } | null;'
);
fs.writeFileSync(f, c);
console.log('Added performanceFeeEnabled to admin RuntimeControlRow type');
