/**
 * F1: Admin fee toggle — wire performanceFeeEnabled into runtime control.
 * 
 * Worker changes:
 * 1. Add livePerformanceFeeEnabled variable
 * 2. Read it from runtime_control_settings.state.performanceFeeEnabled
 * 3. Check it in the sweepFunds fee gate
 * 
 * Admin API changes:
 * 4. Accept performanceFeeEnabled in PATCH /api/runtime-control
 * 5. Return it in GET /api/runtime-control snapshot
 * 
 * Admin UI changes:
 * 6. Add toggle button in Rate Limits tab
 */
const fs = require('fs');
const path = require('path');

// ── 1. Worker: add livePerformanceFeeEnabled variable ──
const workerFile = path.join(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let w = fs.readFileSync(workerFile, 'utf8');
let we = 0;

function wReplace(label, old, replacement) {
  if (!w.includes(old)) {
    console.error(`FATAL [worker]: cannot find target for [${label}]`);
    console.error('Looking for:', JSON.stringify(old.substring(0, 120)));
    process.exit(1);
  }
  w = w.replace(old, replacement);
  we++;
  console.log(`  [w${we}] ${label}`);
}

// Add variable declaration after liveMaintenanceReason
if (!w.includes('livePerformanceFeeEnabled')) {
  wReplace(
    'add livePerformanceFeeEnabled var',
    'let liveEntriesEnabled = true;\r\nlet liveMaintenanceReason: string | null = null;',
    'let liveEntriesEnabled = true;\r\nlet liveMaintenanceReason: string | null = null;\r\nlet livePerformanceFeeEnabled = true;'
  );

  // Read from runtime control state
  wReplace(
    'read performanceFeeEnabled from state',
    "  liveMaintenanceReason = typeof result.rows[0]?.state?.maintenanceReason === 'string'\r\n    ? result.rows[0].state.maintenanceReason.slice(0, 160)\r\n    : null;",
    "  liveMaintenanceReason = typeof result.rows[0]?.state?.maintenanceReason === 'string'\r\n    ? result.rows[0].state.maintenanceReason.slice(0, 160)\r\n    : null;\r\n  livePerformanceFeeEnabled = result.rows[0]?.state?.performanceFeeEnabled !== false;"
  );

  // Add livePerformanceFeeEnabled check to the fee gate in sweepFunds
  wReplace(
    'add admin toggle check to fee gate',
    '    && WORKER_PERFORMANCE_FEE_BPS > 0\r\n    && isFeatureActiveForSession(session, WORKER_PERFORMANCE_FEE_ENABLED,',
    '    && WORKER_PERFORMANCE_FEE_BPS > 0\r\n    && livePerformanceFeeEnabled\r\n    && isFeatureActiveForSession(session, WORKER_PERFORMANCE_FEE_ENABLED,'
  );
}

fs.writeFileSync(workerFile, w);
console.log(`Worker: ${we} edits applied`);

// ── 2. Admin API: accept performanceFeeEnabled in PATCH ──
const routeFile = path.join(__dirname, '..', 'apps', 'admin', 'src', 'app', 'api', 'runtime-control', 'route.ts');
let r = fs.readFileSync(routeFile, 'utf8');
let re = 0;

function rReplace(label, old, replacement) {
  if (!r.includes(old)) {
    console.error(`FATAL [route]: cannot find target for [${label}]`);
    console.error('Looking for:', JSON.stringify(old.substring(0, 120)));
    process.exit(1);
  }
  r = r.replace(old, replacement);
  re++;
  console.log(`  [r${re}] ${label}`);
}

if (!r.includes('performanceFeeEnabled')) {
  // Add to body type
  rReplace(
    'add to body type',
    '      maintenanceReason?: unknown;',
    '      maintenanceReason?: unknown;\n      performanceFeeEnabled?: unknown;'
  );

  // Add handler before the modeSource check
  rReplace(
    'add PATCH handler for performanceFeeEnabled',
    "    if (typeof body.entriesEnabled === 'boolean') {\n      const snapshot = await setLiveRuntimeEntriesEnabled(body.entriesEnabled, body.maintenanceReason);\n      return NextResponse.json(snapshot);\n    }",
    "    if (typeof body.entriesEnabled === 'boolean') {\n      const snapshot = await setLiveRuntimeEntriesEnabled(body.entriesEnabled, body.maintenanceReason);\n      return NextResponse.json(snapshot);\n    }\n\n    if (typeof body.performanceFeeEnabled === 'boolean') {\n      const snapshot = await setLiveRuntimePerformanceFee(body.performanceFeeEnabled);\n      return NextResponse.json(snapshot);\n    }"
  );

  // Add import
  rReplace(
    'add setLiveRuntimePerformanceFee import',
    "  setLiveRuntimeSpeedProfile,\n} from '@/lib/db';",
    "  setLiveRuntimeSpeedProfile,\n  setLiveRuntimePerformanceFee,\n} from '@/lib/db';"
  );
}

fs.writeFileSync(routeFile, r);
console.log(`Route: ${re} edits applied`);

// ── 3. Admin DB: add setLiveRuntimePerformanceFee + include in snapshot ──
const dbFile = path.join(__dirname, '..', 'apps', 'admin', 'src', 'lib', 'db.ts');
let d = fs.readFileSync(dbFile, 'utf8');
let de = 0;

function dReplace(label, old, replacement) {
  if (!d.includes(old)) {
    console.error(`FATAL [db]: cannot find target for [${label}]`);
    console.error('Looking for:', JSON.stringify(old.substring(0, 120)));
    process.exit(1);
  }
  d = d.replace(old, replacement);
  de++;
  console.log(`  [d${de}] ${label}`);
}

if (!d.includes('performanceFeeEnabled')) {
  // Add to snapshot return
  dReplace(
    'add performanceFeeEnabled to snapshot',
    '    entriesEnabled: control.entriesEnabled,\n    maintenanceReason: control.maintenanceReason,',
    '    entriesEnabled: control.entriesEnabled,\n    maintenanceReason: control.maintenanceReason,\n    performanceFeeEnabled: control.performanceFeeEnabled ?? true,'
  );

  // Check if getRuntimeControlState reads the field
  // The runtime control state is parsed from the DB JSON, so we need to add it there
  // Find where entriesEnabled is read from state
  const entriesPattern = "control.entriesEnabled";
  if (d.includes("entriesEnabled: state?.entriesEnabled")) {
    dReplace(
      'add performanceFeeEnabled to state parsing',
      '    entriesEnabled: state?.entriesEnabled !== false,',
      '    entriesEnabled: state?.entriesEnabled !== false,\n    performanceFeeEnabled: state?.performanceFeeEnabled !== false,'
    );
  }

  // Add the setter function before the last export
  const setterFn = `
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
}
`;

  // Insert after setLiveRuntimeEntriesEnabled function
  const insertAfter = 'return getLiveRuntimeControlSnapshot();\n}\n';
  const lastIdx = d.lastIndexOf(insertAfter);
  if (lastIdx >= 0) {
    d = d.substring(0, lastIdx + insertAfter.length) + setterFn + d.substring(lastIdx + insertAfter.length);
    de++;
    console.log(`  [d${de}] added setLiveRuntimePerformanceFee function`);
  } else {
    console.error('WARN: could not find insertion point for setter function');
  }
}

fs.writeFileSync(dbFile, d);
console.log(`DB: ${de} edits applied`);

console.log('\nF1 backend wiring done. UI toggle still needed.');
