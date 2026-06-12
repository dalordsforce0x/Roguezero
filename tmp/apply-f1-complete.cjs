/**
 * F1: Admin fee toggle — all three layers.
 */
const fs = require('fs');
const path = require('path');

// ══════════════════════════════════════════════════════════════════════════════
// 1. WORKER — read from runtime control + check in fee gate
// ══════════════════════════════════════════════════════════════════════════════
const workerFile = path.join(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let w = fs.readFileSync(workerFile, 'utf8');
let we = 0;

function wReplace(label, old, replacement) {
  if (!w.includes(old)) {
    console.error(`FATAL [worker]: [${label}] not found`);
    console.error('Looking for:', JSON.stringify(old.substring(0, 100)));
    process.exit(1);
  }
  w = w.replace(old, replacement);
  we++;
  console.log(`  [w${we}] ${label}`);
}

if (!w.includes('livePerformanceFeeEnabled')) {
  // a. Variable declaration
  wReplace('var decl',
    'let liveEntriesEnabled: boolean = true;\r\nlet liveMaintenanceReason: string | null = null;',
    'let liveEntriesEnabled: boolean = true;\r\nlet liveMaintenanceReason: string | null = null;\r\nlet livePerformanceFeeEnabled = true;'
  );

  // b. Read from DB state (after maintenanceReason line)
  wReplace('read from state',
    "  liveMaintenanceReason = typeof result.rows[0]?.state?.maintenanceReason === 'string'\r\n    ? result.rows[0].state.maintenanceReason.slice(0, 160)\r\n    : null;",
    "  liveMaintenanceReason = typeof result.rows[0]?.state?.maintenanceReason === 'string'\r\n    ? result.rows[0].state.maintenanceReason.slice(0, 160)\r\n    : null;\r\n  livePerformanceFeeEnabled = result.rows[0]?.state?.performanceFeeEnabled !== false;"
  );

  // c. Check in fee gate (sweepFunds)
  wReplace('fee gate check',
    '    && WORKER_PERFORMANCE_FEE_BPS > 0\r\n    && isFeatureActiveForSession(session, WORKER_PERFORMANCE_FEE_ENABLED,',
    '    && WORKER_PERFORMANCE_FEE_BPS > 0\r\n    && livePerformanceFeeEnabled\r\n    && isFeatureActiveForSession(session, WORKER_PERFORMANCE_FEE_ENABLED,'
  );
}
fs.writeFileSync(workerFile, w);
console.log(`Worker: ${we} edits`);

// ══════════════════════════════════════════════════════════════════════════════
// 2. ADMIN DB — hydrateRuntimeControl + snapshot + setter
// ══════════════════════════════════════════════════════════════════════════════
const dbFile = path.join(__dirname, '..', 'apps', 'admin', 'src', 'lib', 'db.ts');
let d = fs.readFileSync(dbFile, 'utf8');
let de = 0;

function dReplace(label, old, replacement) {
  if (!d.includes(old)) {
    console.error(`FATAL [db]: [${label}] not found`);
    console.error('Looking for:', JSON.stringify(old.substring(0, 100)));
    process.exit(1);
  }
  d = d.replace(old, replacement);
  de++;
  console.log(`  [d${de}] ${label}`);
}

if (!d.includes('performanceFeeEnabled')) {
  // a. Parse in hydrateRuntimeControl
  dReplace('hydrate parse',
    "  const entriesEnabled = row?.state?.entriesEnabled === false ? false : true;\r\n",
    "  const entriesEnabled = row?.state?.entriesEnabled === false ? false : true;\r\n  const performanceFeeEnabled = row?.state?.performanceFeeEnabled === false ? false : true;\r\n"
  );

  // b. Return in hydrate result
  dReplace('hydrate return',
    '    entriesEnabled,\r\n    maintenanceReason,',
    '    entriesEnabled,\r\n    performanceFeeEnabled,\r\n    maintenanceReason,'
  );

  // c. Include in snapshot
  dReplace('snapshot return',
    '    entriesEnabled: control.entriesEnabled,\r\n    maintenanceReason: control.maintenanceReason,',
    '    entriesEnabled: control.entriesEnabled,\r\n    performanceFeeEnabled: control.performanceFeeEnabled,\r\n    maintenanceReason: control.maintenanceReason,'
  );

  // d. Add setter function after setLiveRuntimeEntriesEnabled
  // Find the end of that function
  const setEntriesEnd = d.indexOf('return getLiveRuntimeControlSnapshot();\r\n}', d.indexOf('setLiveRuntimeEntriesEnabled'));
  if (setEntriesEnd < 0) {
    console.error('FATAL: cannot find end of setLiveRuntimeEntriesEnabled');
    process.exit(1);
  }
  const insertAt = d.indexOf('\r\n', setEntriesEnd + 'return getLiveRuntimeControlSnapshot();\r\n}'.length);
  const setter = `

export async function setLiveRuntimePerformanceFee(enabled: boolean) {
  await runtimeControlReady();

  await getPool().query(
    \`INSERT INTO runtime_control_settings (control_key, state, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (control_key)
     DO UPDATE SET state = runtime_control_settings.state || EXCLUDED.state,
                   updated_at = NOW()\`,
    [RUNTIME_CONTROL_KEY, JSON.stringify({ performanceFeeEnabled: enabled })],
  );

  return getLiveRuntimeControlSnapshot();
}`;
  d = d.substring(0, insertAt) + setter + d.substring(insertAt);
  de++;
  console.log(`  [d${de}] added setLiveRuntimePerformanceFee function`);
}
fs.writeFileSync(dbFile, d);
console.log(`DB: ${de} edits`);

// ══════════════════════════════════════════════════════════════════════════════
// 3. ADMIN API ROUTE — accept performanceFeeEnabled
// ══════════════════════════════════════════════════════════════════════════════
const routeFile = path.join(__dirname, '..', 'apps', 'admin', 'src', 'app', 'api', 'runtime-control', 'route.ts');
let r = fs.readFileSync(routeFile, 'utf8');
let re = 0;

function rReplace(label, old, replacement) {
  if (!r.includes(old)) {
    console.error(`FATAL [route]: [${label}] not found`);
    console.error('Looking for:', JSON.stringify(old.substring(0, 100)));
    process.exit(1);
  }
  r = r.replace(old, replacement);
  re++;
  console.log(`  [r${re}] ${label}`);
}

if (!r.includes('performanceFeeEnabled')) {
  // a. Import
  rReplace('import setter',
    "  setLiveRuntimeSpeedProfile,\r\n} from '@/lib/db';",
    "  setLiveRuntimeSpeedProfile,\r\n  setLiveRuntimePerformanceFee,\r\n} from '@/lib/db';"
  );

  // b. Body type
  rReplace('body type',
    '      maintenanceReason?: unknown;\r\n',
    '      maintenanceReason?: unknown;\r\n      performanceFeeEnabled?: unknown;\r\n'
  );

  // c. Handler — insert after entriesEnabled handler
  rReplace('handler',
    "    if (typeof body.entriesEnabled === 'boolean') {\r\n      const snapshot = await setLiveRuntimeEntriesEnabled(body.entriesEnabled, body.maintenanceReason);\r\n      return NextResponse.json(snapshot);\r\n    }",
    "    if (typeof body.entriesEnabled === 'boolean') {\r\n      const snapshot = await setLiveRuntimeEntriesEnabled(body.entriesEnabled, body.maintenanceReason);\r\n      return NextResponse.json(snapshot);\r\n    }\r\n\r\n    if (typeof body.performanceFeeEnabled === 'boolean') {\r\n      const snapshot = await setLiveRuntimePerformanceFee(body.performanceFeeEnabled);\r\n      return NextResponse.json(snapshot);\r\n    }"
  );
}
fs.writeFileSync(routeFile, r);
console.log(`Route: ${re} edits`);

console.log('\nF1 backend + API complete. UI toggle next.');
